import { getDb, now } from '../db/index.js';

/**
 * Ownership of in-flight tus uploads.
 *
 * tus upload ids travel in URLs, so without this table any signed-in person
 * who learned an id could resume, inspect or cancel somebody else's upload.
 * It also lets us account for space a user has reserved but not yet committed,
 * which is what the per-user quota is measured against.
 */

export interface UploadRow {
  id: string;
  user_id: number;
  size: number;
  created_at: number;
}

export function recordUpload(id: string, userId: number, size: number): void {
  getDb()
    .prepare(
      `INSERT INTO uploads (id, user_id, size, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET user_id = excluded.user_id, size = excluded.size`,
    )
    .run(id, userId, Math.max(0, size), now());
}

/** The user who created this upload, or null if we have never seen the id. */
export function uploadOwner(id: string): number | null {
  const row = getDb().prepare('SELECT user_id FROM uploads WHERE id = ?').get(id) as
    | { user_id: number }
    | undefined;
  return row ? row.user_id : null;
}

/** Bytes this user has reserved by starting uploads they have not yet sent. */
export function inFlightBytesFor(userId: number): number {
  const row = getDb()
    .prepare('SELECT COALESCE(SUM(size), 0) AS n FROM uploads WHERE user_id = ?')
    .get(userId) as { n: number };
  return row.n;
}

export function forgetUpload(id: string): void {
  getDb().prepare('DELETE FROM uploads WHERE id = ?').run(id);
}

export function forgetUploads(ids: string[]): void {
  if (ids.length === 0) return;
  const db = getDb();
  const stmt = db.prepare('DELETE FROM uploads WHERE id = ?');
  const run = db.transaction(() => {
    for (const id of ids) stmt.run(id);
  });
  run();
}

/** Rows left behind by abandoned uploads, cleared on the same schedule as the bytes. */
export function purgeStaleUploads(olderThan: number): number {
  const result = getDb().prepare('DELETE FROM uploads WHERE created_at < ?').run(olderThan);
  return result.changes;
}
