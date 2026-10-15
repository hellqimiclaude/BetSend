import type { FastifyInstance, FastifyReply } from 'fastify';
import { config } from '../config.js';
import { getSettings } from '../services/settings.js';
import { badRequest, forbidden, unauthorized } from '../util/errors.js';
import { isAllowedDomain, validateEmail } from '../util/email.js';
import { createUser, findByEmail, markEmailVerified, setPassword, touchLastSeen } from '../repos/users.js';
import { logEvent, unreadCount } from '../repos/transfers.js';
import {
  burnTime,
  checkPasswordStrength,
  hashPassword,
  MIN_PASSWORD_LENGTH,
  verifyPassword,
} from '../services/passwords.js';
import {
  COOKIE_NAME,
  consumeSetupToken,
  cookieOptions,
  createSession,
  createSetupToken,
  destroyAllSessionsFor,
  destroySession,
  resolveSetupToken,
  setupLinkFor,
} from '../services/sessions.js';
import { mailConfigured, resetPasswordMessage, send, verifyAddressMessage } from '../services/mail.js';
import { clientIp, currentUser, optionalUser, sessionToken } from './auth.js';
import { clear, hit, LOGIN_LIMIT, SETUP_LIMIT } from '../services/ratelimit.js';
import { toUserView } from '../views.js';

function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(COOKIE_NAME, token, cookieOptions());
}

export default async function sessionRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Sign in with a work email address and password.
   *
   * Failures are deliberately vague so the endpoint cannot be used to discover
   * who works here, and an unknown address still pays the cost of a hash
   * comparison so timing does not leak either.
   */
  app.post('/api/session', async (request, reply) => {
    const body = (request.body ?? {}) as { email?: unknown; password?: unknown };
    const rawEmail = typeof body.email === 'string' ? body.email : '';
    const password = typeof body.password === 'string' ? body.password : '';

    if (!rawEmail || !password) {
      throw badRequest('Please enter your email address and password.', 'missing_credentials');
    }

    const check = validateEmail(rawEmail);
    const ipLimit = hit(`login-ip:${clientIp(request)}`, LOGIN_LIMIT);
    const addressLimit = hit(`login-email:${check.key || rawEmail.toLowerCase()}`, LOGIN_LIMIT);
    if (!ipLimit.allowed || !addressLimit.allowed) {
      const retryAfter = Math.max(ipLimit.retryAfter, addressLimit.retryAfter);
      reply.header('Retry-After', String(retryAfter));
      throw forbidden(
        `Too many sign-in attempts. Please wait ${Math.ceil(retryAfter / 60)} minutes.`,
        'rate_limited',
      );
    }

    const user = check.ok ? findByEmail(check.value) : undefined;
    if (!user || !user.active || !user.password_hash) {
      await burnTime(password);
      throw unauthorized('That email and password do not match.', 'bad_credentials');
    }
    if (!(await verifyPassword(password, user.password_hash))) {
      throw unauthorized('That email and password do not match.', 'bad_credentials');
    }

    clear(`login-ip:${clientIp(request)}`);
    clear(`login-email:${check.key}`);

    setSessionCookie(reply, createSession(user.id, request.headers['user-agent'] ?? null));
    touchLastSeen(user.id);
    logEvent('session.login', null, user.id);

    return { user: toUserView(user), unread: unreadCount(user.id) };
  });

  app.delete('/api/session', async (request, reply) => {
    const user = optionalUser(request);
    destroySession(sessionToken(request));
    reply.clearCookie(COOKIE_NAME, { path: '/' });
    if (user) logEvent('session.logout', null, user.id);
    return { ok: true };
  });

  /**
   * Register with a work email address.
   *
   * Nothing is revealed about whether the address already has an account: the
   * response is the same either way and the detail goes to the mailbox, which
   * only its owner can read. Being able to receive mail on an allowed domain
   * is what proves somebody works here.
   */
  app.post('/api/register', async (request) => {
    const body = (request.body ?? {}) as { email?: unknown };
    const check = validateEmail(typeof body.email === 'string' ? body.email : '');
    if (!check.ok) throw badRequest(check.error!, 'invalid_email');

    const limit = hit(`register:${clientIp(request)}`, SETUP_LIMIT);
    if (!limit.allowed) {
      throw forbidden('Too many attempts. Please try again later.', 'rate_limited');
    }

    if (!isAllowedDomain(check.value, config.emailDomains)) {
      // Worth being specific: this is a typo nine times out of ten, and the
      // allowed domains are hardly a secret to the people who work here.
      throw forbidden(
        `BetSend is only for ${config.emailDomains.map((d) => '@' + d).join(' or ')} addresses.`,
        'domain_not_allowed',
      );
    }

    if (!mailConfigured()) {
      throw badRequest(
        'This server cannot send email yet, so it cannot verify your address. Ask whoever runs BetSend to set up the mail relay.',
        'mail_not_configured',
      );
    }

    const settings = getSettings();
    const existing = findByEmail(check.value);

    if (!existing && settings.registrationMode === 'list') {
      // Say nothing: an attacker should not learn who is on the staff list.
      logEvent('register.rejected', null, null, check.value);
      return { ok: true };
    }

    const user = existing ?? createUser({ email: check.value, source: 'self' });
    if (!user.active) {
      logEvent('register.rejected', null, user.id, 'inactive');
      return { ok: true };
    }

    const token = createSetupToken(user.id);
    await send(verifyAddressMessage(user.email!, setupLinkFor(token)));
    logEvent(existing?.password_hash ? 'register.existing' : 'register.invited', null, user.id);

    return { ok: true };
  });

  /** Ask for a reset link. Always succeeds, whatever the address. */
  app.post('/api/password/forgot', async (request) => {
    const body = (request.body ?? {}) as { email?: unknown };
    const check = validateEmail(typeof body.email === 'string' ? body.email : '');

    const limit = hit(`forgot:${clientIp(request)}`, SETUP_LIMIT);
    if (!limit.allowed) {
      throw forbidden('Too many attempts. Please try again later.', 'rate_limited');
    }

    if (check.ok && mailConfigured()) {
      const user = findByEmail(check.value);
      if (user?.active && user.email) {
        const token = createSetupToken(user.id);
        await send(resetPasswordMessage(user.email, setupLinkFor(token)));
        logEvent('password.reset_sent', null, user.id);
      }
    }

    // Identical response whether or not that address exists.
    return { ok: true };
  });

  /** Check a setup or reset link before showing the form. */
  app.get('/api/setup/check', async (request) => {
    const token = ((request.query as Record<string, string>).token ?? '').trim();
    const user = resolveSetupToken(token);
    if (!user) {
      throw badRequest('That link has expired or has already been used.', 'bad_setup_token');
    }
    return { name: user.name, email: user.email, isReset: Boolean(user.password_hash) };
  });

  /**
   * Set a password from a link. The link is the proof of identity — following
   * it means the person can read mail at that address.
   */
  app.post('/api/setup', async (request, reply) => {
    const body = (request.body ?? {}) as { token?: unknown; password?: unknown; name?: unknown };
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';

    const limit = hit(`setup:${clientIp(request)}`, SETUP_LIMIT);
    if (!limit.allowed) throw forbidden('Too many attempts. Please try again later.', 'rate_limited');

    const user = resolveSetupToken(token);
    if (!user) throw badRequest('That link has expired or has already been used.', 'bad_setup_token');

    const strength = checkPasswordStrength(password, [user.name, user.email ?? '']);
    if (!strength.ok) throw badRequest(strength.error!, 'weak_password');

    setPassword(user.id, await hashPassword(password));
    markEmailVerified(user.id);
    consumeSetupToken(token);
    destroyAllSessionsFor(user.id); // a password change signs other devices out

    if (config.requireAdminApproval && !user.password_set_at) {
      logEvent('register.awaiting_approval', null, user.id);
      throw forbidden(
        'Your password is set. An administrator still has to approve the account before you can sign in.',
        'awaiting_approval',
      );
    }

    setSessionCookie(reply, createSession(user.id, request.headers['user-agent'] ?? null));
    logEvent('session.password_set', null, user.id);

    const fresh = findByEmail(user.email ?? '')!;
    return { user: toUserView(fresh), unread: unreadCount(fresh.id) };
  });

  /** Change your own password, knowing the current one. */
  app.post('/api/session/password', async (request, reply) => {
    const user = currentUser(request);
    const body = (request.body ?? {}) as { currentPassword?: unknown; newPassword?: unknown };
    const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
    const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';

    if (!(await verifyPassword(currentPassword, user.password_hash))) {
      throw unauthorized('Your current password is not correct.', 'bad_credentials');
    }

    const strength = checkPasswordStrength(newPassword, [user.name, user.email ?? '']);
    if (!strength.ok) throw badRequest(strength.error!, 'weak_password');

    setPassword(user.id, await hashPassword(newPassword));
    destroyAllSessionsFor(user.id);
    setSessionCookie(reply, createSession(user.id, request.headers['user-agent'] ?? null));
    logEvent('session.password_changed', null, user.id);

    return { ok: true };
  });

  app.get('/api/session', async (request) => {
    const user = currentUser(request);
    return { user: toUserView(user), unread: unreadCount(user.id) };
  });

  app.get('/api/session/limits', async () => ({
    minPasswordLength: MIN_PASSWORD_LENGTH,
    publicMode: config.publicMode,
  }));
}
