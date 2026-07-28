import type { FastifyInstance } from 'fastify';
import { currentUser } from './auth.js';
import { badRequest, forbidden, notFound, tooLarge } from '../util/errors.js';
import { getSettings } from '../services/settings.js';
import { resolveUpload } from '../services/tus.js';
import { findBlob, insertBlob } from '../repos/blobs.js';
import { findByName, findById } from '../repos/users.js';
import {
  createTransfer,
  inboxFor,
  logEvent,
  markSeen,
  recipientUserIds,
  requireTransfer,
  sentBy,
  setState,
  unreadCount,
  type TransferRow,
} from '../repos/transfers.js';
import { buildTransferViews } from '../views.js';
import { notifyNewTransfer, notifySender, notifyTransferGone } from '../services/notify.js';
import { sanitizeFilename } from '../util/format.js';
import { blobExists } from '../services/storage.js';

const MAX_NOTE_LENGTH = 500;
const MAX_FILES_PER_TRANSFER = 200;

export default async function transferRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Commit finished uploads into a transfer.
   *
   * The bytes are already on disk (streamed there by the tus endpoint). For a
   * bulk send we create ONE blob per file and ONE recipient row per person, so
   * a 10 GB file going to 40 people still occupies 10 GB.
   */
  app.post('/api/transfers', async (request) => {
    const user = currentUser(request);
    const settings = getSettings();
    const body = (request.body ?? {}) as {
      uploads?: unknown;
      recipients?: unknown;
      note?: unknown;
    };

    const uploadIds = Array.isArray(body.uploads) ? body.uploads.map(String).filter(Boolean) : [];
    const recipientNames = Array.isArray(body.recipients) ? body.recipients.map(String).filter(Boolean) : [];
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, MAX_NOTE_LENGTH) : '';

    if (uploadIds.length === 0) throw badRequest('Add at least one file before sending.', 'no_files');
    if (uploadIds.length > MAX_FILES_PER_TRANSFER) {
      throw badRequest(`That is more than ${MAX_FILES_PER_TRANSFER} files in one go. Please split it up.`, 'too_many_files');
    }
    if (recipientNames.length === 0) throw badRequest('Choose at least one person to send to.', 'no_recipients');

    // Resolve recipients (deduplicated, order preserved).
    const seen = new Set<number>();
    const recipientIds: number[] = [];
    for (const name of recipientNames) {
      const target = findByName(name);
      if (!target || !target.active) {
        throw badRequest(`${name} is not in the directory any more.`, 'unknown_recipient');
      }
      if (seen.has(target.id)) continue;
      seen.add(target.id);
      recipientIds.push(target.id);
    }

    // Register each finished upload as a blob (idempotent — a retried commit
    // reuses the existing row rather than duplicating bytes).
    for (const uploadId of uploadIds) {
      const existing = findBlob(uploadId);
      if (existing && existing.state === 'ready') continue;

      const upload = await resolveUpload(uploadId);
      if (!upload) {
        throw badRequest('One of the uploads did not finish. Please add that file again.', 'upload_incomplete');
      }
      if (settings.maxUploadSize > 0 && upload.size > settings.maxUploadSize) {
        throw tooLarge('That file is larger than this server allows.', 'file_too_large');
      }
      if (!blobExists(uploadId)) {
        throw badRequest('One of the uploads is no longer on the server. Please add that file again.', 'upload_missing');
      }

      insertBlob({
        id: upload.id,
        originalName: sanitizeFilename(upload.filename),
        size: upload.size,
        mime: upload.filetype,
        storageKey: upload.id,
        ownerId: user.id,
      });
    }

    const transfer = createTransfer({
      senderId: user.id,
      blobIds: uploadIds,
      recipientIds,
      note: note || null,
      retentionHours: settings.retentionHours,
    });

    logEvent('transfer.created', transfer.id, user.id, `${recipientIds.length} recipient(s)`);
    notifyNewTransfer(transfer, user.name);

    const [view] = buildTransferViews([transfer], {
      includeRecipients: true,
      senderName: () => user.name,
    });
    return { transfer: view };
  });

  /** Everything addressed to me that is still live. */
  app.get('/api/inbox', async (request) => {
    const user = currentUser(request);
    const rows = inboxFor(user.id);
    const senderNames = new Map(rows.map((r) => [r.id, r.sender_name]));
    const mine = new Map(
      rows.map((r) => [r.id, { seenAt: r.seen_at, downloadedAt: r.downloaded_at, downloadCount: r.download_count }]),
    );

    const transfers = buildTransferViews(rows as unknown as TransferRow[], {
      senderName: (row) => senderNames.get(row.id) ?? '',
      mine: (row) => mine.get(row.id),
    });

    return { transfers, unread: unreadCount(user.id) };
  });

  /** Everything I sent, with per-recipient download status. */
  app.get('/api/sent', async (request) => {
    const user = currentUser(request);
    const rows = sentBy(user.id);
    const transfers = buildTransferViews(rows, {
      includeRecipients: true,
      senderName: () => user.name,
    });
    return { transfers };
  });

  app.get('/api/transfers/:id', async (request) => {
    const user = currentUser(request);
    const { id } = request.params as { id: string };
    const transfer = requireTransfer(id);

    const isSender = transfer.sender_id === user.id;
    const isTarget = recipientUserIds(id).includes(user.id);
    if (!isSender && !isTarget) throw forbidden('That transfer is not yours.', 'not_yours');

    const senderName = findById(transfer.sender_id)?.name ?? '';
    const [view] = buildTransferViews([transfer], {
      includeRecipients: isSender,
      senderName: () => senderName,
    });
    return { transfer: view };
  });

  /** Mark an inbox item as read (clears the badge). */
  app.post('/api/transfers/:id/seen', async (request) => {
    const user = currentUser(request);
    const { id } = request.params as { id: string };
    const transfer = requireTransfer(id);
    if (!recipientUserIds(id).includes(user.id)) throw forbidden('That transfer is not yours.', 'not_yours');

    markSeen(id, user.id);
    notifySender(transfer, 'seen', user.id);
    return { ok: true, unread: unreadCount(user.id) };
  });

  /** Sender pulls a transfer back. Recipients lose access immediately. */
  app.post('/api/transfers/:id/revoke', async (request) => {
    const user = currentUser(request);
    const { id } = request.params as { id: string };
    const transfer = requireTransfer(id);

    if (transfer.sender_id !== user.id) throw forbidden('Only the sender can cancel a transfer.', 'not_sender');
    if (transfer.state !== 'active') throw badRequest('That transfer is already finished.', 'not_active');

    const targets = recipientUserIds(id);
    setState(id, 'revoked');
    logEvent('transfer.revoked', id, user.id);
    notifyTransferGone(id, 'revoked', user.name, targets);

    return { ok: true };
  });

  app.get('/api/unread', async (request) => {
    const user = currentUser(request);
    return { unread: unreadCount(user.id) };
  });

  app.get('/api/transfers/:id/exists', async (request) => {
    const { id } = request.params as { id: string };
    const transfer = requireTransfer(id);
    if (transfer.state !== 'active') throw notFound('That transfer is no longer available.', 'transfer_gone');
    return { ok: true };
  });
}
