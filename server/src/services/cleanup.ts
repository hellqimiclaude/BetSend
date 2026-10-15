import { config } from '../config.js';
import { getDb } from '../db/index.js';
import {
  expiredTransferIds,
  fullyDownloadedTransferIds,
  getTransfer,
  logEvent,
  recipientUserIds,
  releaseTransfer,
  setState,
  unpurgedFinishedTransferIds,
} from '../repos/transfers.js';
import { markBlobDeleted, orphanBlobs, unreferencedBlobs } from '../repos/blobs.js';
import { listStrayFiles, removeBlobFiles, removeStrayFile } from './storage.js';
import { getSettings } from './settings.js';
import { notifyTransferGone } from './notify.js';
import { findById } from '../repos/users.js';
import { purgeExpiredSessions } from './sessions.js';
import { purgeStaleUploads } from '../repos/uploads.js';

export interface SweepResult {
  expired: number;
  completed: number;
  releasedTransfers: number;
  deletedBlobs: number;
  freedBytes: number;
  strayFiles: number;
  expiredSessions: number;
  staleUploads: number;
}

/**
 * The retention sweep. Runs on a timer and on demand from the admin page.
 *
 *  1. active transfers past `expires_at`            -> state 'expired'
 *  2. active transfers every recipient downloaded   -> state 'completed'  (if enabled)
 *  3. any finished transfer not yet purged          -> release its blob references
 *  4. blobs whose ref_count hit 0                   -> unlink from disk
 *  5. finished uploads never attached to a transfer -> unlink after orphanUploadHours
 *  6. files on disk with no blob row at all         -> unlink after orphanUploadHours
 *  7. sessions past their expiry                    -> deleted
 *  8. ownership rows for abandoned uploads          -> deleted, freeing quota
 */
export async function sweep(): Promise<SweepResult> {
  const settings = getSettings();
  const result: SweepResult = {
    expired: 0,
    completed: 0,
    releasedTransfers: 0,
    deletedBlobs: 0,
    freedBytes: 0,
    strayFiles: 0,
    expiredSessions: 0,
    staleUploads: 0,
  };

  // 1 — expiry
  for (const id of expiredTransferIds()) {
    const transfer = getTransfer(id);
    if (!transfer) continue;
    const recipients = recipientUserIds(id);
    setState(id, 'expired');
    logEvent('transfer.expired', id, null);
    notifyTransferGone(id, 'expired', findById(transfer.sender_id)?.name ?? '', recipients);
    result.expired++;
  }

  // 2 — everyone has it
  if (settings.deleteAfterAllDownloaded) {
    for (const id of fullyDownloadedTransferIds()) {
      setState(id, 'completed');
      logEvent('transfer.completed', id, null);
      result.completed++;
    }
  }

  // 3 — drop references
  for (const id of unpurgedFinishedTransferIds()) {
    releaseTransfer(id);
    result.releasedTransfers++;
  }

  // 4 — unlink orphaned bytes
  for (const blob of unreferencedBlobs()) {
    await removeBlobFiles(blob.storage_key);
    markBlobDeleted(blob.id);
    result.deletedBlobs++;
    result.freedBytes += blob.size;
  }

  // 5 — uploads that were never sent
  const orphanCutoff = Date.now() - config.orphanUploadHours * 3600_000;
  for (const blob of orphanBlobs(orphanCutoff)) {
    await removeBlobFiles(blob.storage_key);
    markBlobDeleted(blob.id);
    result.deletedBlobs++;
    result.freedBytes += blob.size;
  }

  // 6 — bytes on disk we have no record of (server killed mid-upload)
  const known = new Set(
    (getDb().prepare("SELECT storage_key FROM blobs WHERE state = 'ready'").all() as {
      storage_key: string;
    }[]).map((r) => r.storage_key),
  );
  for (const entry of await listStrayFiles(known, orphanCutoff)) {
    await removeStrayFile(entry);
    result.strayFiles++;
  }

  // 7 — logins that have run out
  result.expiredSessions = purgeExpiredSessions();

  // 8 — ownership rows for uploads that were abandoned, so the quota they
  // reserved is handed back
  result.staleUploads = purgeStaleUploads(orphanCutoff);

  return result;
}

export function startCleanupLoop(log: { info: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void }): () => void {
  const intervalMs = Math.max(1, config.cleanupIntervalMinutes) * 60_000;

  const tick = () => {
    sweep()
      .then((result) => {
        const touched =
          result.expired + result.completed + result.deletedBlobs + result.strayFiles + result.releasedTransfers;
        if (touched > 0) log.info(result, 'retention sweep');
      })
      .catch((err) => log.error({ err }, 'retention sweep failed'));
  };

  const timer = setInterval(tick, intervalMs);
  // Give the server a moment to finish booting before the first pass.
  const kickoff = setTimeout(tick, 5_000);

  return () => {
    clearInterval(timer);
    clearTimeout(kickoff);
  };
}
