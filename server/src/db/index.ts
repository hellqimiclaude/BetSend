import fs from 'node:fs';
import Database from 'better-sqlite3';
import { config, ensureDirs } from '../config.js';

export type DB = Database.Database;

let instance: DB | null = null;

export function getDb(): DB {
  if (instance) return instance;

  ensureDirs();
  const db = new Database(config.dbPath);

  // WAL keeps readers non-blocking while an upload commit is writing.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  const schemaUrl = new URL('./schema.sql', import.meta.url);
  db.exec(fs.readFileSync(schemaUrl, 'utf8'));
  migrate(db);

  instance = db;
  return db;
}

/**
 * `CREATE TABLE IF NOT EXISTS` never alters an existing table, so columns added
 * after a database already exists have to be applied by hand. Each step checks
 * before it acts, so this is safe to run on every boot.
 */
function migrate(db: DB): void {
  const columns = (table: string): Set<string> =>
    new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name),
    );

  const userColumns = columns('users');
  const additions: [string, string][] = [
    ['password_hash', 'TEXT'],
    ['password_set_at', 'INTEGER'],
    ['is_admin', 'INTEGER NOT NULL DEFAULT 0'],
    ['email', 'TEXT'],
    ['email_key', 'TEXT'],
    ['email_verified_at', 'INTEGER'],
  ];

  for (const [name, definition] of additions) {
    if (!userColumns.has(name)) {
      db.exec(`ALTER TABLE users ADD COLUMN ${name} ${definition}`);
    }
  }

  // The unique index lives in schema.sql, but on an older database the column
  // it covers has only just been added, so create it after the ALTERs.
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email_key) WHERE email_key IS NOT NULL',
  );

  // Everything already in a database that predates peer transfers went
  // through the server, which is exactly what the default says.
  if (!columns('transfers').has('delivery')) {
    db.exec("ALTER TABLE transfers ADD COLUMN delivery TEXT NOT NULL DEFAULT 'server'");
  }
}

export function closeDb(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}

export function now(): number {
  return Date.now();
}
