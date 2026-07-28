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

  instance = db;
  return db;
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
