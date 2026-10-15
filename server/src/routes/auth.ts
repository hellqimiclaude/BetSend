import type { FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { touchLastSeen, type UserRow } from '../repos/users.js';
import { forbidden, unauthorized } from '../util/errors.js';
import { COOKIE_NAME, resolveSession } from '../services/sessions.js';
import { ADMIN_LIMIT, hit } from '../services/ratelimit.js';

/**
 * Identity comes from a signed-in session cookie.
 *
 * Downloads are plain <a> navigations, which cannot carry headers — the cookie
 * travels with them automatically, which is why identity lives there rather
 * than in a header or a query parameter.
 */
export function sessionToken(request: FastifyRequest): string | undefined {
  const cookies = (request as FastifyRequest & { cookies?: Record<string, string> }).cookies;
  return cookies?.[COOKIE_NAME];
}

/**
 * Read one cookie out of a raw `Cookie:` header.
 *
 * Needed where Fastify's parsed cookies are not available: the WebSocket
 * upgrade and the tus naming hook both see only a bare Node request.
 */
export function readCookieHeader(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    const raw = part.slice(index + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return undefined;
}

/** Resolve the signed-in user from a raw `Cookie:` header, or null. */
export function resolveSessionFromHeaders(cookieHeader: string | undefined): UserRow | null {
  const resolved = resolveSession(readCookieHeader(cookieHeader, COOKIE_NAME));
  return resolved ? resolved.user : null;
}

/** The signed-in user, or null. Use when being signed out is a valid state. */
export function optionalUser(request: FastifyRequest): UserRow | null {
  const resolved = resolveSession(sessionToken(request));
  return resolved ? resolved.user : null;
}

/** The signed-in user, or a 401 the browser turns into "please sign in". */
export function currentUser(request: FastifyRequest): UserRow {
  const user = optionalUser(request);
  if (!user) {
    throw unauthorized('Please sign in to continue.', 'not_signed_in');
  }
  touchLastSeen(user.id);
  return user;
}

export function clientIp(request: FastifyRequest): string {
  return request.ip || 'unknown';
}

/**
 * Admin access. Either the shared admin token from the config, or a signed-in
 * account flagged as an admin. Token attempts are rate limited per IP because
 * once this is on the internet it is a guessable secret.
 */
export function requireAdmin(request: FastifyRequest): void {
  const user = optionalUser(request);
  if (user?.is_admin) return;

  const header = request.headers['x-admin-token'];
  const provided = (Array.isArray(header) ? header[0] : header) || '';

  if (!config.adminToken || !provided) {
    throw forbidden('Admin access is required here.', 'admin_required');
  }

  const limit = hit(`admin:${clientIp(request)}`, ADMIN_LIMIT);
  if (!limit.allowed) {
    throw forbidden(
      `Too many attempts. Please wait ${Math.ceil(limit.retryAfter / 60)} minutes and try again.`,
      'rate_limited',
    );
  }

  if (provided !== config.adminToken) {
    throw forbidden('That admin token is not correct.', 'bad_admin_token');
  }
}
