import crypto from 'node:crypto';
import { getDb, now } from '../db/index.js';

/**
 * Shareable download links.
 *
 * A transfer is normally reachable only by the people it was addressed to.
 * That breaks the moment somebody goes on holiday and a colleague picks up
 * their work: the stand-in was never a recipient, and adding them to a
 * transfer that already happened is not always what the sender wants either.
 * A link is access that travels with the URL instead of with the recipient
 * list, and it still requires a signed-in BetSend account to use.
 *
 * The link's lifetime is also the files' lifetime. One number rather than
 * two, because two could disagree -- and a link to files that retention
 * swept away last Tuesday is worse than no link at all.
 */

export interface DownloadLinkRow {
  token: string;
  transfer_id: string;
  created_by: number;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
}

export const DAY_MS = 24 * 3600_000;

/**
 * Mint a link for a transfer, replacing any it already has.
 *
 * Replacing rather than refusing: the sender asking again means they want a
 * link, and the one certain way to end up with two live links to the same
 * files is to allow it. The old token stops working immediately, which is
 * also how somebody deliberately rotates a link they pasted in the wrong
 * place.
 */
export function createLink(transferId: string, createdBy: number, days: number): DownloadLinkRow {
  const db = getDb();
  const ts = now();
  // 32 bytes, so the token cannot be guessed and cannot be walked through by
  // a signed-in colleague looking for transfers that are not theirs.
  const token = crypto.randomBytes(32).toString('base64url');

  const run = db.transaction(() => {
    db.prepare('UPDATE download_links SET revoked_at = ? WHERE transfer_id = ? AND revoked_at IS NULL').run(
      ts,
      transferId,
    );
    db.prepare(
      `INSERT INTO download_links (token, transfer_id, created_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(token, transferId, createdBy, ts, ts + days * DAY_MS);

    keepTransferUntil(transferId, ts + days * DAY_MS);
  });

  run();
  return findLinkByToken(token)!;
}

/**
 * Push a transfer's expiry out so its files outlive the link.
 *
 * Never pulls it in. A transfer that was already being kept longer than the
 * link asks for -- a generous retention setting, say -- should not be cut
 * short by somebody making a short-lived link.
 */
export function keepTransferUntil(transferId: string, until: number): void {
  getDb()
    .prepare('UPDATE transfers SET expires_at = MAX(expires_at, ?) WHERE id = ?')
    .run(until, transferId);
}

export function findLinkByToken(token: string): DownloadLinkRow | undefined {
  if (!token) return undefined;
  return getDb().prepare('SELECT * FROM download_links WHERE token = ?').get(token) as
    | DownloadLinkRow
    | undefined;
}

/** The live link for a transfer, if it has one. */
export function liveLinkFor(transferId: string): DownloadLinkRow | null {
  const row = getDb()
    .prepare('SELECT * FROM download_links WHERE transfer_id = ? AND revoked_at IS NULL')
    .get(transferId) as DownloadLinkRow | undefined;
  return row && row.expires_at > now() ? row : null;
}

export function liveLinksFor(transferIds: string[]): Map<string, DownloadLinkRow> {
  if (transferIds.length === 0) return new Map();
  const placeholders = new Array(transferIds.length).fill('?').join(',');
  const rows = getDb()
    .prepare(
      `SELECT * FROM download_links
        WHERE revoked_at IS NULL AND expires_at > ? AND transfer_id IN (${placeholders})`,
    )
    .all(now(), ...transferIds) as DownloadLinkRow[];
  return new Map(rows.map((row) => [row.transfer_id, row]));
}

/**
 * Why a token cannot be used, or null when it can.
 *
 * Separate reasons on purpose. "This link expired on 5 December" tells
 * somebody clicking a stale task what happened and what to do; a flat 404
 * sends them to ask whether BetSend is broken.
 */
export type LinkRefusal = 'unknown' | 'revoked' | 'expired';

export function checkLink(token: string): { link: DownloadLinkRow } | { refused: LinkRefusal } {
  const link = findLinkByToken(token);
  if (!link) return { refused: 'unknown' };
  if (link.revoked_at !== null) return { refused: 'revoked' };
  if (link.expires_at <= now()) return { refused: 'expired' };
  return { link };
}

export function revokeLink(transferId: string): boolean {
  const result = getDb()
    .prepare('UPDATE download_links SET revoked_at = ? WHERE transfer_id = ? AND revoked_at IS NULL')
    .run(now(), transferId);
  return result.changes > 0;
}

/** Transfer ids holding files purely because a link is still live. */
export function transferIdsWithLiveLinks(): string[] {
  const rows = getDb()
    .prepare('SELECT DISTINCT transfer_id FROM download_links WHERE revoked_at IS NULL AND expires_at > ?')
    .all(now()) as { transfer_id: string }[];
  return rows.map((r) => r.transfer_id);
}

/** What the live links are holding on disk, for the admin page. */
export function linkedStorageBytes(): { transfers: number; bytes: number } {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS transfers, COALESCE(SUM(total_size), 0) AS bytes
         FROM transfers
        WHERE id IN (
          SELECT transfer_id FROM download_links WHERE revoked_at IS NULL AND expires_at > ?
        )`,
    )
    .get(now()) as { transfers: number; bytes: number };
  return row;
}
