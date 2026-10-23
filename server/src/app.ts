import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import { config } from './config.js';
import { AppError } from './util/errors.js';
import sessionRoutes from './routes/session.js';
import coreRoutes from './routes/core.js';
import uploadRoutes from './routes/uploads.js';
import transferRoutes from './routes/transfers.js';
import downloadRoutes from './routes/download.js';
import adminRoutes from './routes/admin.js';
import peerRoutes from './routes/peers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
/** Built frontend. `npm run build` puts Vite's output here. */
export const PUBLIC_DIR = path.resolve(here, '..', 'public');

/**
 * Hashes of the inline scripts in the built index.html.
 *
 * index.html carries one inline script: it reads the saved theme and sets the
 * dark class before first paint, so the page never flashes white on its way to
 * dark. A `script-src 'self'` policy blocks it, which is what was happening --
 * the policy was written allowing 'unsafe-inline' for styles but not scripts,
 * so the flash it exists to prevent happened on every load, visible only in the
 * browser console.
 *
 * Hashing the script rather than allowing 'unsafe-inline' keeps the policy
 * strict, and computing it from the file rather than pasting a constant means
 * it cannot drift when the script changes.
 */
export function inlineScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  // Inline only: a tag with a src attribute loads from an origin instead.
  const pattern = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi;

  for (const match of html.matchAll(pattern)) {
    const body = match[1];
    if (!body) continue;
    hashes.push(`'sha256-${crypto.createHash('sha256').update(body, 'utf8').digest('base64')}'`);
  }
  return hashes;
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.logLevel },
    // Uploads arrive as raw streams on the tus routes, so this only covers
    // JSON. It is generous because a transfer commit carries one id per file
    // and there is no cap on how many files a transfer may hold, nor on the
    // length of the note.
    bodyLimit: 16 * 1024 * 1024,
    // Behind Caddy/nginx the socket address is the proxy, so rate limiting and
    // logs need the forwarded client address instead. Only trust this when a
    // proxy really is in front — otherwise clients can spoof their own IP.
    trustProxy: config.behindProxy,
  });

  await app.register(fastifyCookie);

  /**
   * Security headers. The app is a self-contained SPA that talks only to its
   * own origin, so the policy can be strict.
   */
  // Read once at boot: the built file does not change under a running server.
  const indexFile = path.join(PUBLIC_DIR, 'index.html');
  const scriptHashes = (fs.existsSync(indexFile) ? inlineScriptHashes(fs.readFileSync(indexFile, 'utf8')) : [])
    .map((hash) => ' ' + hash)
    .join('');

  app.addHook('onSend', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');

    if (config.publicMode) {
      reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }

    // Only on the HTML shell — no need to repeat it on every asset or download.
    if (!request.url.startsWith('/api/')) {
      reply.header(
        'Content-Security-Policy',
        [
          "default-src 'self'",
          `script-src 'self'${scriptHashes}`,
          // Vite injects style tags at runtime.
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data:",
          "connect-src 'self' ws: wss:",
          "frame-ancestors 'none'",
          "base-uri 'self'",
          "form-action 'self'",
          "object-src 'none'",
        ].join('; '),
      );
    }
  });

  /**
   * Users never see a stack trace. Known problems become a friendly sentence,
   * anything unexpected becomes a generic apology and is logged in full.
   */
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      return;
    }
    const failure = error as { statusCode?: number; code?: string; message?: string };
    if (failure.statusCode === 400 && String(failure.message ?? '').includes('JSON')) {
      reply.code(400).send({ error: { code: 'bad_json', message: 'That request was malformed.' } });
      return;
    }

    /**
     * Fastify's own errors already carry the right status: a content type
     * nothing can parse is 415, a body over the limit is 413. Sweeping those
     * into the 500 below told the caller "something went wrong on the server"
     * when the request was at fault, and logged it next to real server faults
     * — which is how a plain 415 came to look like a crash.
     *
     * Only 4xx passes through. A 5xx from a library is still ours to own, and
     * its message is not for the caller.
     */
    if (typeof failure.statusCode === 'number' && failure.statusCode >= 400 && failure.statusCode < 500) {
      const code = failure.code ? failure.code.toLowerCase().replace(/^fst_err_/, '') : 'bad_request';
      request.log.info({ err: error }, 'rejected request');
      reply.code(failure.statusCode).send({
        error: { code, message: failure.message ?? 'That request could not be handled.' },
      });
      return;
    }

    request.log.error({ err: error }, 'unhandled error');
    reply.code(500).send({
      error: { code: 'server_error', message: 'Something went wrong on the server. Please try again.' },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      reply.code(404).send({ error: { code: 'not_found', message: 'Unknown endpoint.' } });
      return;
    }
    // Single-page app: hand every other path to index.html.
    const indexFile = path.join(PUBLIC_DIR, 'index.html');
    if (fs.existsSync(indexFile)) {
      reply.type('text/html').send(fs.createReadStream(indexFile));
      return;
    }
    reply
      .code(404)
      .type('text/plain')
      .send('BetSend: the web interface has not been built yet. Run `npm run build`, then restart.');
  });

  await app.register(sessionRoutes);
  await app.register(coreRoutes);
  await app.register(uploadRoutes);
  await app.register(transferRoutes);
  await app.register(downloadRoutes);
  await app.register(adminRoutes);
  await app.register(peerRoutes);

  app.get('/api/health', async () => ({ ok: true, time: Date.now() }));

  if (fs.existsSync(PUBLIC_DIR)) {
    await app.register(fastifyStatic, { root: PUBLIC_DIR, index: ['index.html'], wildcard: false });
  } else {
    app.log.warn({ dir: PUBLIC_DIR }, 'no built frontend found — API only');
  }

  return app;
}
