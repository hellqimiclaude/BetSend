import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getTusServer, UPLOAD_PATH } from '../services/tus.js';
import { config } from '../config.js';
import { getSettings } from '../services/settings.js';
import { currentUser } from './auth.js';
import { forbidden, tooLarge } from '../util/errors.js';
import { forgetUpload, inFlightBytesFor, uploadOwner } from '../repos/uploads.js';
import { diskUsage } from '../services/storage.js';
import { formatBytes } from '../util/format.js';

/**
 * Mounts the tus endpoint inside its own encapsulated scope so we can strip
 * Fastify's body parsers: tus needs the raw request stream, and Fastify must
 * not read a single byte of it. `reply.hijack()` hands the socket to tus.
 */

/** `/api/uploads/<id>` -> `<id>`; `/api/uploads` -> null. */
function uploadIdFrom(url: string): string | null {
  const path = url.split('?')[0];
  if (!path.startsWith(UPLOAD_PATH)) return null;
  const rest = path.slice(UPLOAD_PATH.length).replace(/^\/+/, '').replace(/\/+$/, '');
  return rest || null;
}

export default async function uploadRoutes(app: FastifyInstance): Promise<void> {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', (_request, _payload, done) => done(null));

  const tus = getTusServer();

  /**
   * Everything below here needs a signed-in user.
   *
   * This runs *before* `tus.handle()`, which matters: tus picks an id and
   * creates the file early in its POST handler, so a check inside one of its
   * own hooks would already have let an anonymous caller write to disk.
   */
  app.addHook('preHandler', async (request) => {
    // Protocol discovery only: no body, no side effects, nothing to leak. Left
    // open so a CORS preflight — which browsers send without cookies — cannot
    // deadlock a legitimate client.
    if (request.method === 'OPTIONS') return;

    const user = currentUser(request);
    const id = uploadIdFrom(request.url);

    if (id) {
      // Resuming, inspecting, cancelling or appending to an existing upload.
      // Ids are unguessable, but that is not a reason to let one colleague
      // touch another's transfer-in-progress.
      const owner = uploadOwner(id);
      if (owner !== null && owner !== user.id) {
        throw forbidden('That upload belongs to someone else.', 'not_your_upload');
      }
      return;
    }

    if (request.method !== 'POST') return;

    // Creating a new upload: refuse before any bytes are reserved if it would
    // exhaust the disk, or push this person past their quota.
    const declared = Number(request.headers['upload-length'] ?? 0);
    const wanted = Number.isFinite(declared) && declared > 0 ? declared : 0;

    const maxUploadSize = getSettings().maxUploadSize;
    if (maxUploadSize > 0 && wanted > maxUploadSize) {
      throw tooLarge(
        `That file is larger than this server allows (${formatBytes(maxUploadSize)}).`,
        'file_too_large',
      );
    }

    const free = diskUsage().freeBytes;
    if (free > 0 && free - wanted < config.minFreeDiskBytes) {
      request.log.warn({ free, wanted }, 'upload refused: not enough disk space');
      throw tooLarge(
        'The server is running out of space. Ask whoever runs BetSend to free some up.',
        'disk_full',
      );
    }

    const quota = config.perUserUploadBytes;
    if (quota > 0 && inFlightBytesFor(user.id) + wanted > quota) {
      throw tooLarge(
        `You already have ${formatBytes(inFlightBytesFor(user.id))} waiting to be sent, which is as much as this server allows at once. Send or cancel those first.`,
        'quota_exceeded',
      );
    }
  });

  const handler = async (request: FastifyRequest, reply: FastifyReply) => {
    const id = uploadIdFrom(request.url);
    reply.hijack();
    await tus.handle(request.raw, reply.raw);

    // A cancelled upload releases its quota straight away rather than waiting
    // for the sweeper.
    if (request.method === 'DELETE' && id && reply.raw.statusCode === 204) {
      try {
        forgetUpload(id);
      } catch {
        /* the sweeper will catch it */
      }
    }
  };

  const methods = ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS'] as const;

  app.route({ method: [...methods], url: UPLOAD_PATH, exposeHeadRoute: false, handler });
  app.route({ method: [...methods], url: `${UPLOAD_PATH}/*`, exposeHeadRoute: false, handler });
}
