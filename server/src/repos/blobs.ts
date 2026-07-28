import { getDb, now } from '../db/index.js';

export interface BlobRow {
  id: string;
  original_name: string;
  size: number;
  mime: string | null;
  storage_key: string;
  owner_id: number | null;
  ref_count: number;
  state: 'ready' | 'deleted';
  created_at: number;
  committed_at: number | null;
}

export function insertBlob(row: {
  id: string;
  originalName: string;
  size: number;
  mime: string | null;
  storageKey: string;
  ownerId: number | null;
}): void {
  getDb()
    .prepare(
      `INSERT INTO blobs (id, original_name, size, mime, storage_key, owner_id, ref_count, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 'ready', ?)
       ON CONFLICT(id) DO UPDATE SET
         original_name = excluded.original_name,
         size          = excluded.size,
         mime          = excluded.mime,
         storage_key   = excluded.storage_key,
         owner_id      = excluded.owner_id`,
    )
    .run(row.id, row.originalName, row.size, row.mime, row.storageKey, row.ownerId, now());
}

export function findBlob(id: string): BlobRow | undefined {
  return getDb().prepare('SELECT * FROM blobs WHERE id = ?').get(id) as BlobRow | undefined;
}

export function totalStoredBytes(): number {
  const row = getDb()
    .prepare("SELECT COALESCE(SUM(size), 0) AS n FROM blobs WHERE state = 'ready'")
    .get() as { n: number };
  return row.n;
}

/** Blobs whose last reference is gone — safe to unlink from disk. */
export function unreferencedBlobs(): BlobRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM blobs
        WHERE state = 'ready'
          AND ref_count <= 0
          AND committed_at IS NOT NULL`,
    )
    .all() as BlobRow[];
}

/** Uploads that were finished but never attached to a transfer (abandoned tabs). */
export function orphanBlobs(olderThan: number): BlobRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM blobs
        WHERE state = 'ready'
          AND committed_at IS NULL
          AND created_at < ?`,
    )
    .all(olderThan) as BlobRow[];
}

export function markBlobDeleted(id: string): void {
  getDb().prepare("UPDATE blobs SET state = 'deleted', ref_count = 0 WHERE id = ?").run(id);
}
