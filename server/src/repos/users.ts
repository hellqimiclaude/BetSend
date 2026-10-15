import { getDb, now } from '../db/index.js';
import { nameKey, normalizeName } from '../util/names.js';
import { displayNameFromEmail, emailKey, normalizeEmail } from '../util/email.js';

export interface UserRow {
  id: number;
  name: string;
  name_key: string;
  source: 'self' | 'admin';
  created_at: number;
  last_seen_at: number | null;
  active: number;
  /** Null until the person has set a password — they cannot sign in yet. */
  password_hash: string | null;
  password_set_at: number | null;
  is_admin: number;
  /** The work email address: the identity people sign in with. */
  email: string | null;
  email_key: string | null;
  /** Set when they followed the link sent to that address. */
  email_verified_at: number | null;
}

export function findByName(raw: string): UserRow | undefined {
  return getDb()
    .prepare('SELECT * FROM users WHERE name_key = ?')
    .get(nameKey(raw)) as UserRow | undefined;
}

export function findByEmail(raw: string): UserRow | undefined {
  const key = emailKey(raw);
  if (!key) return undefined;
  return getDb().prepare('SELECT * FROM users WHERE email_key = ?').get(key) as UserRow | undefined;
}

export function findById(id: number): UserRow | undefined {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
}

export function listUsers(includeInactive = false): UserRow[] {
  const sql = includeInactive
    ? 'SELECT * FROM users ORDER BY name COLLATE NOCASE'
    : 'SELECT * FROM users WHERE active = 1 ORDER BY name COLLATE NOCASE';
  return getDb().prepare(sql).all() as UserRow[];
}

export interface NewUser {
  email: string;
  /** Defaults to one derived from the address, e.g. j.johnson@ -> J.Johnson. */
  name?: string;
  source?: 'self' | 'admin';
}

/**
 * Create (or revive) an account keyed on its work email address.
 *
 * The display name only has to be unique enough to read; two people called
 * J.Smith are told apart by their addresses, so a clash just gets a suffix
 * rather than being refused.
 */
export function createUser(input: NewUser): UserRow {
  const db = getDb();
  const email = normalizeEmail(input.email);
  const key = emailKey(email);

  const existing = findByEmail(email);
  if (existing) {
    if (!existing.active) {
      db.prepare('UPDATE users SET active = 1, source = ? WHERE id = ?').run(
        input.source ?? 'admin',
        existing.id,
      );
      return findById(existing.id)!;
    }
    return existing;
  }

  const wanted = normalizeName(input.name || displayNameFromEmail(email)) || displayNameFromEmail(email);
  let name = wanted;
  let suffix = 2;
  while (db.prepare('SELECT 1 FROM users WHERE name_key = ?').get(nameKey(name))) {
    name = `${wanted} (${suffix++})`;
  }

  const info = db
    .prepare(
      `INSERT INTO users (name, name_key, source, created_at, active, email, email_key)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
    )
    .run(name, nameKey(name), input.source ?? 'admin', now(), email, key);
  return findById(Number(info.lastInsertRowid))!;
}

export function markEmailVerified(id: number): void {
  getDb()
    .prepare('UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?')
    .run(now(), id);
}

export function setEmail(id: number, raw: string): void {
  getDb()
    .prepare('UPDATE users SET email = ?, email_key = ?, email_verified_at = NULL WHERE id = ?')
    .run(normalizeEmail(raw), emailKey(raw), id);
}

/** Accounts an admin still has to fill an address in for. */
export function countWithoutEmail(): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM users WHERE active = 1 AND (email_key IS NULL OR email_key = \'\')')
    .get() as { n: number };
  return row.n;
}

/** Bulk import from the admin page, keyed on email address. */
export function importUsers(
  people: { email: string; key: string; name: string }[],
): { added: string[]; existing: string[] } {
  const db = getDb();
  const added: string[] = [];
  const existing: string[] = [];

  const run = db.transaction(() => {
    for (const person of people) {
      const found = findByEmail(person.email);
      if (found) {
        if (!found.active) {
          db.prepare('UPDATE users SET active = 1 WHERE id = ?').run(found.id);
          added.push(person.email);
        } else {
          existing.push(person.email);
        }
        continue;
      }
      createUser({ email: person.email, name: person.name, source: 'admin' });
      added.push(person.email);
    }
  });
  run();

  return { added, existing };
}

/**
 * Users are soft-deleted: their transfers and download history stay intact, the
 * name just stops appearing in the directory.
 */
export function deactivateUser(id: number): void {
  getDb().prepare('UPDATE users SET active = 0 WHERE id = ?').run(id);
}

export function touchLastSeen(id: number): void {
  getDb().prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now(), id);
}

export function countUsers(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM users WHERE active = 1').get() as { n: number };
  return row.n;
}

export function setPassword(id: number, passwordHash: string): void {
  getDb()
    .prepare('UPDATE users SET password_hash = ?, password_set_at = ? WHERE id = ?')
    .run(passwordHash, now(), id);
}

export function setAdmin(id: number, isAdmin: boolean): void {
  getDb().prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(isAdmin ? 1 : 0, id);
}

/** How many people have not finished setting up an account yet. */
export function countWithoutPassword(): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM users WHERE active = 1 AND password_hash IS NULL')
    .get() as { n: number };
  return row.n;
}
