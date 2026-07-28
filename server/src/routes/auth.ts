import type { FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { findByName, touchLastSeen, type UserRow } from '../repos/users.js';
import { forbidden, unauthorized } from '../util/errors.js';

/**
 * There are no passwords — this is a trusted LAN tool. The browser sends the
 * identity the user picked in `X-User`; the server only checks that the name is
 * a known, active user. Admin routes additionally require the shared token.
 */
export function currentUser(request: FastifyRequest): UserRow {
  const header = request.headers['x-user'];
  const name = Array.isArray(header) ? header[0] : header;
  const fromQuery = (request.query as Record<string, string> | undefined)?.user;
  const candidate = (name || fromQuery || '').trim();

  if (!candidate) {
    throw unauthorized('Please choose who you are first.', 'no_identity');
  }
  const user = findByName(candidate);
  if (!user || !user.active) {
    throw unauthorized('That name is not in the directory any more. Please pick your name again.', 'unknown_identity');
  }
  touchLastSeen(user.id);
  return user;
}

export function requireAdmin(request: FastifyRequest): void {
  const header = request.headers['x-admin-token'];
  const token = Array.isArray(header) ? header[0] : header;
  const fromQuery = (request.query as Record<string, string> | undefined)?.token;
  const provided = token || fromQuery || '';

  if (!config.adminToken || provided !== config.adminToken) {
    throw forbidden('That admin token is not correct.', 'bad_admin_token');
  }
}
