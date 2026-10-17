import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

/**
 * A consistent copy of the database while the server is running.
 *
 * Copying betsend.db in Explorer is not safe: SQLite is in WAL mode, so
 * recent writes live in betsend.db-wal until a checkpoint folds them in, and
 * a plain copy can miss them or catch a half-written page. SQLite's own
 * backup API handles a live database properly.
 */

export interface BackupResult {
  destination: string;
  bytes: number;
  users: number;
  transfers: number;
}

/**
 * Read-only, so backing up can never change what it is backing up.
 *
 * That matters more than it sounds: opening read-write checkpoints the
 * write-ahead log on close, which rewrites the live database file while the
 * server is using it. Nothing is lost, but a backup tool that modifies the
 * original is not a backup tool. Read-only reads the log perfectly well --
 * with or without the shared-memory file beside it.
 */
export async function backupDatabase(sourcePath: string, destination: string): Promise<BackupResult> {
  if (!fs.existsSync(sourcePath)) throw new Error(`No database at ${sourcePath}.`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });

  const source = new Database(sourcePath, { readonly: true });
  let expectedUsers: number;
  let expectedTransfers: number;
  try {
    expectedUsers = count(source, 'users');
    expectedTransfers = count(source, 'transfers');
    await source.backup(destination);
  } finally {
    source.close();
  }

  const copy = new Database(destination);
  let users: number;
  let transfers: number;
  try {
    // The column is integrity_check, not integrity; reading the wrong key
    // gives undefined, which is not 'ok', which looks like a corrupt copy.
    const verdict = Object.values(copy.prepare('PRAGMA integrity_check').get() as object)[0];
    if (verdict !== 'ok') throw new Error(`the copy failed its integrity check: ${String(verdict)}`);

    users = count(copy, 'users');
    transfers = count(copy, 'transfers');

    // Cheap insurance. A backup is trusted precisely when nobody can check
    // it by hand, so it is worth proving the copy holds what the original
    // held before reporting success.
    if (users !== expectedUsers || transfers !== expectedTransfers) {
      throw new Error(
        `the copy does not match the original: ${expectedUsers} user(s) and ${expectedTransfers} transfer(s) ` +
          `became ${users} and ${transfers}`,
      );
    }

    // Fold the log into the file, so the backup is one file somebody can put
    // on a USB stick rather than three that have to travel together.
    copy.pragma('wal_checkpoint(TRUNCATE)');
    copy.pragma('journal_mode = DELETE');
  } finally {
    copy.close();
  }

  for (const sidecar of ['-wal', '-shm']) fs.rmSync(destination + sidecar, { force: true });

  return { destination, bytes: fs.statSync(destination).size, users, transfers };
}

function count(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/** `betsend-2026-10-17T18-30-21.db` — sortable, and legal on Windows. */
export function backupName(now = new Date()): string {
  return `betsend-${now.toISOString().replace(/[:.]/g, '-').slice(0, 19)}.db`;
}
