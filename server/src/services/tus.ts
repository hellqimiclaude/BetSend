import { Server } from '@tus/server';
import { FileStore } from '@tus/file-store';
import { config, paths, ensureDirs } from '../config.js';
import { getSettings } from './settings.js';
import { newId } from '../util/ids.js';
import { recordUpload } from '../repos/uploads.js';
import { resolveSessionFromHeaders } from '../routes/auth.js';

/**
 * Resumable uploads over the tus protocol.
 *
 * The browser (tus-js-client) slices each file into chunks and PATCHes them in
 * order; @tus/file-store appends each chunk straight to `<storage>/uploads/<id>`
 * and keeps the byte offset in a `<id>.json` sidecar. Nothing is ever held in
 * memory, and a dropped connection resumes from the last acknowledged offset.
 */

export const UPLOAD_PATH = '/api/uploads';

let server: Server | null = null;
let store: FileStore | null = null;

export function getUploadStore(): FileStore {
  if (!store) {
    ensureDirs();
    store = new FileStore({ directory: paths.uploads });
  }
  return store;
}

export function getTusServer(): Server {
  if (server) return server;

  server = new Server({
    path: UPLOAD_PATH,
    datastore: getUploadStore(),
    // Location headers stay relative so the app works on any LAN hostname/IP.
    relativeLocation: true,
    respectForwardedHeaders: false,
    // Runs before anything is written to disk. The route's preHandler has
    // already rejected anyone without a session, so this only has to remember
    // whose upload it is — recorded here so that even the very first PATCH can
    // be ownership-checked.
    namingFunction: (req) => {
      const id = newId(20);
      const user = resolveSessionFromHeaders(req.headers.cookie);
      if (user) {
        const declared = Number(req.headers['upload-length'] ?? 0);
        recordUpload(id, user.id, Number.isFinite(declared) ? declared : 0);
      }
      return id;
    },
    // Same-origin requests do not need CORS at all; naming the public origin
    // stops the server echoing an arbitrary one back when it is exposed.
    ...(config.publicMode && config.publicUrl ? { allowedOrigins: [new URL(config.publicUrl).origin] } : {}),
    // Read the limit per request so the admin page can change it without a restart.
    maxSize: async () => {
      const max = getSettings().maxUploadSize;
      return max > 0 ? max : Number.MAX_SAFE_INTEGER;
    },
  });

  return server;
}

export interface ResolvedUpload {
  id: string;
  size: number;
  offset: number;
  filename: string;
  filetype: string | null;
}

/**
 * Look a finished upload up in the tus store. Returns null when the id is
 * unknown or the upload never completed.
 */
export async function resolveUpload(id: string): Promise<ResolvedUpload | null> {
  try {
    const upload = await getUploadStore().getUpload(id);
    const size = Number(upload.size ?? 0);
    const offset = Number(upload.offset ?? 0);
    if (!size || offset !== size) return null;

    const metadata = (upload.metadata ?? {}) as Record<string, string | null>;
    return {
      id,
      size,
      offset,
      filename: metadata.filename || metadata.name || id,
      filetype: metadata.filetype || metadata.type || null,
    };
  } catch {
    return null;
  }
}
