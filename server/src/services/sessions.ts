import { createHash } from 'node:crypto';
import { getDb, now } from '../db/index.js';
import { config } from '../config.js';
import { randomToken } from './passwords.js';
import type { UserRow } from '../repos/users.js';

/**
 * Server-side sessions.
 *
 * The cookie holds a random token; the database stores only its SHA-256, so a
 * leaked database backup cannot be replayed as a login. Sessions are revocable
 * centrally, which matters once the app is reachable from outside the office.
 */

export const COOKIE_NAME = 'bs_session';

const HASH = (token: string): string => createHash('sha256').update(token).digest('hex');

export interface SessionRow {
  id: string;
  user_id: number;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  user_agent: string | null;
}

export function createSession(userId: number, userAgent: string | null): string {
  const token = randomToken(32);
  const ts = now();
  const expiresAt = ts + Math.max(1, config.sessionDays) * 86_400_000;

  getDb()
    .prepare(
      `INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at, user_agent)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(HASH(token), userId, ts, ts, expiresAt, (userAgent ?? '').slice(0, 200) || null);

  return token;
}

export interface ResolvedSession {
  session: SessionRow;
  user: UserRow;
}

export function resolveSession(token: string | undefined): ResolvedSession | null {
  if (!token) return null;

  const row = getDb()
    .prepare(
      `SELECT s.*, u.id AS u_id
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.id = ? AND s.expires_at > ? AND u.active = 1`,
    )
    .get(HASH(token), now()) as (SessionRow & { u_id: number }) | undefined;

  if (!row) return null;

  const user = getDb().prepare('SELECT * FROM users WHERE id = ?').get(row.user_id) as UserRow | undefined;
  if (!user) return null;

  // Sliding expiry, written at most once a minute to keep writes off the hot path.
  const ts = now();
  if (ts - row.last_seen_at > 60_000) {
    const expiresAt = ts + Math.max(1, config.sessionDays) * 86_400_000;
    getDb()
      .prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?')
      .run(ts, expiresAt, row.id);
    getDb().prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(ts, user.id);
  }

  return { session: row, user };
}

export function destroySession(token: string | undefined): void {
  if (!token) return;
  getDb().prepare('DELETE FROM sessions WHERE id = ?').run(HASH(token));
}

/** Used after a password change, and by the admin "sign out everywhere" action. */
export function destroyAllSessionsFor(userId: number): void {
  getDb().prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function purgeExpiredSessions(): number {
  const result = getDb().prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now());
  return result.changes;
}

export function sessionCountFor(userId: number): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND expires_at > ?')
    .get(userId, now()) as { n: number };
  return row.n;
}

export interface CookieOptions {
  httpOnly: true;
  sameSite: 'lax';
  path: '/';
  secure: boolean;
  maxAge: number;
}

export function cookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax', // 'lax' still sends the cookie on plain download navigations
    path: '/',
    secure: config.publicMode, // HTTPS-only once we are on the internet
    maxAge: Math.max(1, config.sessionDays) * 86_400,
  };
}

// --- one-time setup / reset links ------------------------------------------

const SETUP_TOKEN_HOURS = 72;

export function createSetupToken(userId: number): string {
  const token = randomToken(32);
  const ts = now();

  const db = getDb();
  const write = db.transaction(() => {
    // Only the newest link should work.
    db.prepare('DELETE FROM setup_tokens WHERE user_id = ?').run(userId);
    db.prepare(
      'INSERT INTO setup_tokens (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    ).run(HASH(token), userId, ts, ts + SETUP_TOKEN_HOURS * 3600_000);
  });
  write();

  return token;
}

export function resolveSetupToken(token: string | undefined): UserRow | null {
  if (!token) return null;

  const row = getDb()
    .prepare('SELECT * FROM setup_tokens WHERE id = ? AND used_at IS NULL AND expires_at > ?')
    .get(HASH(token), now()) as { user_id: number } | undefined;
  if (!row) return null;

  const user = getDb().prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(row.user_id) as
    | UserRow
    | undefined;
  return user ?? null;
}

export function consumeSetupToken(token: string): void {
  getDb().prepare('UPDATE setup_tokens SET used_at = ? WHERE id = ?').run(now(), HASH(token));
}

export function setupLinkFor(token: string): string {
  const base = config.publicUrl || '';
  return `${base}/#/setup?token=${encodeURIComponent(token)}`;
}
