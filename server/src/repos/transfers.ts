import { getDb, now } from '../db/index.js';
import { newId } from '../util/ids.js';
import { badRequest, notFound } from '../util/errors.js';

export interface TransferRow {
  id: string;
  sender_id: number;
  note: string | null;
  created_at: number;
  expires_at: number;
  state: 'active' | 'revoked' | 'expired' | 'completed' | 'deleted';
  total_size: number;
  file_count: number;
  purged_at: number | null;
}

export interface TransferFileRow {
  transfer_id: string;
  blob_id: string;
  ordinal: number;
  original_name: string;
  size: number;
  mime: string | null;
  storage_key: string;
  blob_state: string;
}

export interface RecipientRow {
  id: number;
  transfer_id: string;
  user_id: number;
  name: string;
  seen_at: number | null;
  downloaded_at: number | null;
  download_count: number;
  notified_at: number | null;
}

function placeholders(n: number): string {
  return new Array(n).fill('?').join(',');
}

export interface CreateTransferInput {
  senderId: number;
  blobIds: string[];
  recipientIds: number[];
  note: string | null;
  retentionHours: number;
}

/**
 * Commits an upload into a transfer. The bytes were already streamed to disk by
 * the tus endpoint; this only writes metadata. For a bulk send there is exactly
 * one `blobs` row and one `transfer_files` row per file, plus one `recipients`
 * row per person — the file is never copied.
 */
export function createTransfer(input: CreateTransferInput): TransferRow {
  const db = getDb();
  const id = newId(12);
  const ts = now();
  const expiresAt = ts + Math.max(1, input.retentionHours) * 3600_000;

  const run = db.transaction(() => {
    let totalSize = 0;
    const blobs = db
      .prepare(`SELECT * FROM blobs WHERE id IN (${placeholders(input.blobIds.length)})`)
      .all(...input.blobIds) as { id: string; size: number; state: string; committed_at: number | null }[];

    const byId = new Map(blobs.map((b) => [b.id, b]));
    for (const blobId of input.blobIds) {
      const blob = byId.get(blobId);
      if (!blob || blob.state !== 'ready') {
        throw badRequest('One of the uploads is no longer available. Please add the file again.', 'upload_missing');
      }
      totalSize += blob.size;
    }

    db.prepare(
      `INSERT INTO transfers (id, sender_id, note, created_at, expires_at, state, total_size, file_count)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
    ).run(id, input.senderId, input.note, ts, expiresAt, totalSize, input.blobIds.length);

    const linkFile = db.prepare('INSERT INTO transfer_files (transfer_id, blob_id, ordinal) VALUES (?, ?, ?)');
    const bumpRef = db.prepare(
      'UPDATE blobs SET ref_count = ref_count + 1, committed_at = COALESCE(committed_at, ?) WHERE id = ?',
    );
    input.blobIds.forEach((blobId, index) => {
      linkFile.run(id, blobId, index);
      bumpRef.run(ts, blobId);
    });

    const addRecipient = db.prepare(
      'INSERT OR IGNORE INTO recipients (transfer_id, user_id) VALUES (?, ?)',
    );
    for (const userId of input.recipientIds) addRecipient.run(id, userId);
  });

  run();
  return getTransfer(id)!;
}

export function getTransfer(id: string): TransferRow | undefined {
  return getDb().prepare('SELECT * FROM transfers WHERE id = ?').get(id) as TransferRow | undefined;
}

export function requireTransfer(id: string): TransferRow {
  const row = getTransfer(id);
  if (!row) throw notFound('That transfer no longer exists.', 'transfer_gone');
  return row;
}

export function filesFor(transferIds: string[]): TransferFileRow[] {
  if (transferIds.length === 0) return [];
  return getDb()
    .prepare(
      `SELECT tf.transfer_id, tf.blob_id, tf.ordinal,
              b.original_name, b.size, b.mime, b.storage_key, b.state AS blob_state
         FROM transfer_files tf
         JOIN blobs b ON b.id = tf.blob_id
        WHERE tf.transfer_id IN (${placeholders(transferIds.length)})
        ORDER BY tf.transfer_id, tf.ordinal`,
    )
    .all(...transferIds) as TransferFileRow[];
}

export function recipientsFor(transferIds: string[]): RecipientRow[] {
  if (transferIds.length === 0) return [];
  return getDb()
    .prepare(
      `SELECT r.id, r.transfer_id, r.user_id, u.name, r.seen_at, r.downloaded_at,
              r.download_count, r.notified_at
         FROM recipients r
         JOIN users u ON u.id = r.user_id
        WHERE r.transfer_id IN (${placeholders(transferIds.length)})
        ORDER BY u.name COLLATE NOCASE`,
    )
    .all(...transferIds) as RecipientRow[];
}

export function recipientUserIds(transferId: string): number[] {
  const rows = getDb()
    .prepare('SELECT user_id FROM recipients WHERE transfer_id = ?')
    .all(transferId) as { user_id: number }[];
  return rows.map((r) => r.user_id);
}

/** Transfers addressed to a user that are still live. */
export function inboxFor(userId: number): (TransferRow & {
  sender_name: string;
  seen_at: number | null;
  downloaded_at: number | null;
  download_count: number;
})[] {
  return getDb()
    .prepare(
      `SELECT t.*, u.name AS sender_name, r.seen_at, r.downloaded_at, r.download_count
         FROM recipients r
         JOIN transfers t ON t.id = r.transfer_id
         JOIN users u     ON u.id = t.sender_id
        WHERE r.user_id = ?
          AND t.state = 'active'
          AND t.purged_at IS NULL
        ORDER BY t.created_at DESC`,
    )
    .all(userId) as never;
}

export function sentBy(userId: number): TransferRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM transfers
        WHERE sender_id = ? AND state != 'deleted'
        ORDER BY created_at DESC
        LIMIT 200`,
    )
    .all(userId) as TransferRow[];
}

export function unreadCount(userId: number): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n
         FROM recipients r
         JOIN transfers t ON t.id = r.transfer_id
        WHERE r.user_id = ? AND r.seen_at IS NULL AND t.state = 'active' AND t.purged_at IS NULL`,
    )
    .get(userId) as { n: number };
  return row.n;
}

export function markSeen(transferId: string, userId: number): void {
  getDb()
    .prepare('UPDATE recipients SET seen_at = COALESCE(seen_at, ?) WHERE transfer_id = ? AND user_id = ?')
    .run(now(), transferId, userId);
}

export function markDownloaded(transferId: string, userId: number): void {
  const ts = now();
  getDb()
    .prepare(
      `UPDATE recipients
          SET downloaded_at  = COALESCE(downloaded_at, ?),
              seen_at        = COALESCE(seen_at, ?),
              download_count = download_count + 1
        WHERE transfer_id = ? AND user_id = ?`,
    )
    .run(ts, ts, transferId, userId);
}

export function isRecipient(transferId: string, userId: number): boolean {
  const row = getDb()
    .prepare('SELECT 1 AS ok FROM recipients WHERE transfer_id = ? AND user_id = ?')
    .get(transferId, userId) as { ok: number } | undefined;
  return Boolean(row);
}

export function allRecipientsDownloaded(transferId: string): boolean {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS pending FROM recipients WHERE transfer_id = ? AND downloaded_at IS NULL`,
    )
    .get(transferId) as { pending: number };
  return row.pending === 0;
}

export function setState(transferId: string, state: TransferRow['state']): void {
  getDb().prepare('UPDATE transfers SET state = ? WHERE id = ?').run(state, transferId);
}

/**
 * Release a transfer's hold on its blobs. Called once per transfer by the
 * sweeper; `purged_at` makes it idempotent so ref counts can never go negative.
 */
export function releaseTransfer(transferId: string): void {
  const db = getDb();
  const run = db.transaction(() => {
    const row = db.prepare('SELECT purged_at FROM transfers WHERE id = ?').get(transferId) as
      | { purged_at: number | null }
      | undefined;
    if (!row || row.purged_at !== null) return;

    db.prepare(
      `UPDATE blobs SET ref_count = MAX(0, ref_count - 1)
        WHERE id IN (SELECT blob_id FROM transfer_files WHERE transfer_id = ?)`,
    ).run(transferId);
    db.prepare('UPDATE transfers SET purged_at = ? WHERE id = ?').run(now(), transferId);
  });
  run();
}

export function expiredTransferIds(): string[] {
  const rows = getDb()
    .prepare("SELECT id FROM transfers WHERE state = 'active' AND expires_at <= ?")
    .all(now()) as { id: string }[];
  return rows.map((r) => r.id);
}

/** Live transfers where every recipient has already downloaded. */
export function fullyDownloadedTransferIds(): string[] {
  const rows = getDb()
    .prepare(
      `SELECT t.id
         FROM transfers t
        WHERE t.state = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM recipients r
             WHERE r.transfer_id = t.id AND r.downloaded_at IS NULL
          )`,
    )
    .all() as { id: string }[];
  return rows.map((r) => r.id);
}

export function unpurgedFinishedTransferIds(): string[] {
  const rows = getDb()
    .prepare(
      `SELECT id FROM transfers
        WHERE state IN ('revoked','expired','completed','deleted')
          AND purged_at IS NULL`,
    )
    .all() as { id: string }[];
  return rows.map((r) => r.id);
}

export function activeTransferCount(): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM transfers WHERE state = 'active'")
    .get() as { n: number };
  return row.n;
}

export function listAllTransfers(limit = 200): (TransferRow & { sender_name: string; recipient_count: number })[] {
  return getDb()
    .prepare(
      `SELECT t.*, u.name AS sender_name,
              (SELECT COUNT(*) FROM recipients r WHERE r.transfer_id = t.id) AS recipient_count
         FROM transfers t
         JOIN users u ON u.id = t.sender_id
        WHERE t.state != 'deleted'
        ORDER BY t.created_at DESC
        LIMIT ?`,
    )
    .all(limit) as never;
}

export function logEvent(type: string, transferId: string | null, userId: number | null, detail?: string): void {
  getDb()
    .prepare('INSERT INTO events (ts, type, transfer_id, user_id, detail) VALUES (?, ?, ?, ?, ?)')
    .run(now(), type, transferId, userId, detail ?? null);
}
