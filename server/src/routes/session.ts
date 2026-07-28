import type { FastifyInstance, FastifyReply } from 'fastify';
import { config } from '../config.js';
import { getSettings } from '../services/settings.js';
import { badRequest, forbidden, unauthorized } from '../util/errors.js';
import { validateName, normalizeName } from '../util/names.js';
import { createUser, findByName, setPassword, touchLastSeen } from '../repos/users.js';
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
  destroyAllSessionsFor,
  destroySession,
  resolveSetupToken,
} from '../services/sessions.js';
import { clientIp, currentUser, optionalUser, sessionToken } from './auth.js';
import { clear, hit, LOGIN_LIMIT, SETUP_LIMIT } from '../services/ratelimit.js';
import { toUserView } from '../views.js';

function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(COOKIE_NAME, token, cookieOptions());
}

export default async function sessionRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Sign in with a name and password.
   *
   * Failures are deliberately vague — "that name and password do not match" —
   * so the endpoint cannot be used to discover who works here. Unknown names
   * still pay the cost of a hash comparison so timing does not leak either.
   */
  app.post('/api/session', async (request, reply) => {
    const body = (request.body ?? {}) as { name?: unknown; password?: unknown };
    const rawName = typeof body.name === 'string' ? body.name : '';
    const password = typeof body.password === 'string' ? body.password : '';

    if (!rawName || !password) {
      throw badRequest('Please enter your name and password.', 'missing_credentials');
    }

    const name = normalizeName(rawName);
    const ipLimit = hit(`login-ip:${clientIp(request)}`, LOGIN_LIMIT);
    const nameLimit = hit(`login-name:${name.toLowerCase()}`, LOGIN_LIMIT);
    if (!ipLimit.allowed || !nameLimit.allowed) {
      const retryAfter = Math.max(ipLimit.retryAfter, nameLimit.retryAfter);
      reply.header('Retry-After', String(retryAfter));
      throw forbidden(
        `Too many sign-in attempts. Please wait ${Math.ceil(retryAfter / 60)} minutes.`,
        'rate_limited',
      );
    }

    const user = findByName(name);
    if (!user || !user.active || !user.password_hash) {
      await burnTime(password); // keep unknown-name and wrong-password indistinguishable
      throw unauthorized('That name and password do not match.', 'bad_credentials');
    }

    if (!(await verifyPassword(password, user.password_hash))) {
      throw unauthorized('That name and password do not match.', 'bad_credentials');
    }

    clear(`login-ip:${clientIp(request)}`);
    clear(`login-name:${name.toLowerCase()}`);

    const token = createSession(user.id, request.headers['user-agent'] ?? null);
    setSessionCookie(reply, token);
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
   * Check a setup link before showing the form, so an expired link says so
   * instead of failing after the person has typed a password twice.
   */
  app.get('/api/setup/check', async (request) => {
    const token = ((request.query as Record<string, string>).token ?? '').trim();
    const user = resolveSetupToken(token);
    if (!user) {
      throw badRequest('That setup link has expired or has already been used.', 'bad_setup_token');
    }
    return { name: user.name, isReset: Boolean(user.password_hash) };
  });

  /**
   * Set a first password.
   *
   * Two ways in, chosen by the admin:
   *   invite — a one-time link the admin generated (the default once public)
   *   claim  — anyone whose name is already on the imported staff list
   */
  app.post('/api/setup', async (request, reply) => {
    const body = (request.body ?? {}) as { token?: unknown; name?: unknown; password?: unknown };
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';

    const limit = hit(`setup:${clientIp(request)}`, SETUP_LIMIT);
    if (!limit.allowed) {
      throw forbidden('Too many attempts. Please try again later.', 'rate_limited');
    }

    const settings = getSettings();
    let user = token ? resolveSetupToken(token) : null;

    if (token && !user) {
      throw badRequest('That setup link has expired or has already been used.', 'bad_setup_token');
    }

    if (!user) {
      // No token — only allowed in claim mode.
      if (settings.signupMode !== 'claim') {
        throw forbidden(
          'You need a setup link from whoever runs BetSend before you can create a password.',
          'invite_required',
        );
      }

      const check = validateName(typeof body.name === 'string' ? body.name : '');
      if (!check.ok) throw badRequest(check.error!, 'invalid_name');

      const existing = findByName(check.value);
      if (existing?.password_hash) {
        throw forbidden(
          `${check.value} already has a password. Sign in instead, or ask for a reset link.`,
          'already_claimed',
        );
      }

      if (!existing) {
        if (settings.registrationMode === 'list') {
          throw forbidden(
            `${check.value} is not on the staff list. Ask whoever runs BetSend to add you.`,
            'not_on_list',
          );
        }
        user = createUser(check.value, 'self');
      } else {
        user = existing;
      }
    }

    const strength = checkPasswordStrength(password, user.name);
    if (!strength.ok) throw badRequest(strength.error!, 'weak_password');

    setPassword(user.id, await hashPassword(password));
    if (token) consumeSetupToken(token);

    // A password change signs out every other device.
    destroyAllSessionsFor(user.id);

    const sessionCookie = createSession(user.id, request.headers['user-agent'] ?? null);
    setSessionCookie(reply, sessionCookie);
    logEvent('session.password_set', null, user.id);

    const fresh = findByName(user.name)!;
    return { user: toUserView(fresh), unread: unreadCount(fresh.id) };
  });

  /** Change your own password. Requires the current one. */
  app.post('/api/session/password', async (request, reply) => {
    const user = currentUser(request);
    const body = (request.body ?? {}) as { currentPassword?: unknown; newPassword?: unknown };
    const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
    const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';

    if (!(await verifyPassword(currentPassword, user.password_hash))) {
      throw unauthorized('Your current password is not correct.', 'bad_credentials');
    }

    const strength = checkPasswordStrength(newPassword, user.name);
    if (!strength.ok) throw badRequest(strength.error!, 'weak_password');

    setPassword(user.id, await hashPassword(newPassword));
    destroyAllSessionsFor(user.id);

    const token = createSession(user.id, request.headers['user-agent'] ?? null);
    setSessionCookie(reply, token);
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
