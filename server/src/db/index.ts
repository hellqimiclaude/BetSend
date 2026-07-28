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
  ];

  for (const [name, definition] of additions) {
    if (!userColumns.has(name)) {
      db.exec(`ALTER TABLE users ADD COLUMN ${name} ${definition}`);
    }
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
