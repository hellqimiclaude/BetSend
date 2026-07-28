import { createReadStream } from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ZipArchive } from 'archiver';
import mime from 'mime-types';
import { currentUser } from './auth.js';
import { forbidden, notFound } from '../util/errors.js';
import {
  filesFor,
  isRecipient,
  logEvent,
  markDownloaded,
  requireTransfer,
  type TransferRow,
} from '../repos/transfers.js';
import { findById } from '../repos/users.js';
import { notifySender } from '../services/notify.js';
import { blobPath, blobExists } from '../services/storage.js';
import { contentDisposition, sanitizeFilename } from '../util/format.js';

/** A transfer can still be fetched while it is live, or completed-but-not-yet-purged. */
function assertDownloadable(transfer: TransferRow): void {
  if (transfer.purged_at !== null) throw notFound('Those files have already been deleted.', 'transfer_gone');
  if (transfer.state === 'revoked') throw notFound('The sender cancelled that transfer.', 'transfer_revoked');
  if (transfer.state === 'expired') throw notFound('That transfer has expired.', 'transfer_expired');
  if (transfer.state !== 'active' && transfer.state !== 'completed') {
    throw notFound('That transfer is no longer available.', 'transfer_gone');
  }
}

interface Access {
  userId: number;
  isRecipient: boolean;
}

function authorize(request: FastifyRequest, transfer: TransferRow): Access {
  const user = currentUser(request);
  const recipient = isRecipient(transfer.id, user.id);
  if (!recipient && transfer.sender_id !== user.id) {
    throw forbidden('That transfer was not sent to you.', 'not_yours');
  }
  return { userId: user.id, isRecipient: recipient };
}

/** Record the download once the bytes actually reached the client. */
function recordWhenComplete(transfer: TransferRow, access: Access, res: NodeJS.WritableStream & { on: Function }): void {
  if (!access.isRecipient) return; // senders can re-check their own files without skewing status
  res.on('finish', () => {
    try {
      markDownloaded(transfer.id, access.userId);
      logEvent('transfer.downloaded', transfer.id, access.userId);
      notifySender(transfer, 'downloaded', access.userId);
    } catch {
      /* the response already succeeded — never fail a download over bookkeeping */
    }
  });
}

interface ParsedRange {
  start: number;
  end: number;
}

/** Single-range parsing only — enough for browser pause/resume, nothing exotic. */
function parseRange(header: string | undefined, size: number): ParsedRange | null | 'invalid' {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return 'invalid';

  const [, rawStart, rawEnd] = match;
  let start: number;
  let end: number;

  if (rawStart === '') {
    if (rawEnd === '') return 'invalid';
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return 'invalid';
  return { start, end: Math.min(end, size - 1) };
}

export default async function downloadRoutes(app: FastifyInstance): Promise<void> {
  /** One file, streamed, with Content-Length so the browser shows real progress. */
  app.get('/api/transfers/:id/files/:blobId', async (request, reply) => {
    const { id, blobId } = request.params as { id: string; blobId: string };
    const transfer = requireTransfer(id);
    assertDownloadable(transfer);
    const access = authorize(request, transfer);

    const file = filesFor([id]).find((f) => f.blob_id === blobId);
    if (!file) throw notFound('That file is not part of this transfer.', 'file_not_found');
    if (file.blob_state !== 'ready' || !blobExists(file.storage_key)) {
      throw notFound('That file has already been deleted from the server.', 'file_gone');
    }

    const size = file.size;
    const range = parseRange(request.headers.range, size);

    if (range === 'invalid') {
      reply.header('Content-Range', `bytes */${size}`);
      return reply.code(416).send({ error: { code: 'bad_range', message: 'Requested range is not valid.' } });
    }

    const start = range ? range.start : 0;
    const end = range ? range.end : size - 1;
    const type = file.mime || mime.lookup(file.original_name) || 'application/octet-stream';

    reply.hijack();
    const res = reply.raw;
    res.writeHead(range ? 206 : 200, {
      'Content-Type': String(type),
      'Content-Length': String(end - start + 1),
      'Content-Disposition': contentDisposition(file.original_name),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    });

    // Only count it as "downloaded" when the whole file went out.
    if (end === size - 1 && start === 0) recordWhenComplete(transfer, access, res);

    const stream = createReadStream(blobPath(file.storage_key), { start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  });

  /**
   * All files in one zip, built on the fly. Entries are streamed straight from
   * disk into the archive, so a 10 GB transfer never touches RAM. No
   * Content-Length is possible here — the browser shows an indeterminate
   * progress bar, which is why single files are offered separately.
   */
  app.get('/api/transfers/:id/zip', async (request, reply) => {
    const { id } = request.params as { id: string };
    const transfer = requireTransfer(id);
    assertDownloadable(transfer);
    const access = authorize(request, transfer);

    const files = filesFor([id]).filter((f) => f.blob_state === 'ready' && blobExists(f.storage_key));
    if (files.length === 0) throw notFound('Those files have already been deleted.', 'files_gone');

    const senderName = findById(transfer.sender_id)?.name ?? 'betsend';
    const zipName = sanitizeFilename(`${senderName}-${new Date(transfer.created_at).toISOString().slice(0, 10)}.zip`);

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': contentDisposition(zipName),
      'Cache-Control': 'no-store',
    });

    recordWhenComplete(transfer, access, res);

    // store-only: these are arbitrary office files, most are already compressed,
    // and deflating a 10 GB video would just burn CPU for nothing.
    const archive = new ZipArchive({ store: true });
    archive.on('error', () => res.destroy());
    archive.on('warning', (err) => request.log.warn({ err }, 'zip warning'));
    res.on('close', () => archive.destroy());

    archive.pipe(res);

    const usedNames = new Set<string>();
    for (const file of files) {
      // Two files with the same name in one transfer would collide in the zip.
      let entryName = file.original_name;
      let counter = 2;
      while (usedNames.has(entryName.toLowerCase())) {
        const dot = file.original_name.lastIndexOf('.');
        entryName =
          dot > 0
            ? `${file.original_name.slice(0, dot)} (${counter})${file.original_name.slice(dot)}`
            : `${file.original_name} (${counter})`;
        counter++;
      }
      usedNames.add(entryName.toLowerCase());
      archive.file(blobPath(file.storage_key), { name: entryName });
    }

    await archive.finalize();
  });
}
