import { getDb, now } from '../db/index.js';
import { nameKey, normalizeName } from '../util/names.js';

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
}

export function findByName(raw: string): UserRow | undefined {
  return getDb()
    .prepare('SELECT * FROM users WHERE name_key = ?')
    .get(nameKey(raw)) as UserRow | undefined;
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

export function createUser(raw: string, source: 'self' | 'admin'): UserRow {
  const name = normalizeName(raw);
  const key = nameKey(raw);
  const db = getDb();

  const existing = db.prepare('SELECT * FROM users WHERE name_key = ?').get(key) as UserRow | undefined;
  if (existing) {
    // Re-activate a previously removed name rather than creating a duplicate.
    if (!existing.active) {
      db.prepare('UPDATE users SET active = 1, source = ? WHERE id = ?').run(source, existing.id);
      return findById(existing.id)!;
    }
    return existing;
  }

  const info = db
    .prepare('INSERT INTO users (name, name_key, source, created_at, active) VALUES (?, ?, ?, ?, 1)')
    .run(name, key, source, now());
  return findById(Number(info.lastInsertRowid))!;
}

/** Bulk import from the admin page. Returns per-name outcomes. */
export function importUsers(names: { value: string; key: string }[]): { added: string[]; existing: string[] } {
  const db = getDb();
  const added: string[] = [];
  const existing: string[] = [];

  const run = db.transaction(() => {
    for (const n of names) {
      const found = db.prepare('SELECT id, active FROM users WHERE name_key = ?').get(n.key) as
        | { id: number; active: number }
        | undefined;
      if (found) {
        if (!found.active) {
          db.prepare('UPDATE users SET active = 1 WHERE id = ?').run(found.id);
          added.push(n.value);
        } else {
          existing.push(n.value);
        }
        continue;
      }
      db.prepare('INSERT INTO users (name, name_key, source, created_at, active) VALUES (?, ?, ?, ?, 1)').run(
        n.value,
        n.key,
        'admin',
        now(),
      );
      added.push(n.value);
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
