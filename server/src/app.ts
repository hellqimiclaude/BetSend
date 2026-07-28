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

const here = path.dirname(fileURLToPath(import.meta.url));
/** Built frontend. `npm run build` puts Vite's output here. */
export const PUBLIC_DIR = path.resolve(here, '..', 'public');

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.logLevel },
    // Uploads arrive as raw streams on the tus routes; nothing else is large.
    bodyLimit: 1024 * 1024,
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
          "script-src 'self'",
          // Vite inlines the theme bootstrap and injects style tags.
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
    const failure = error as { statusCode?: number; message?: string };
    if (failure.statusCode === 400 && String(failure.message ?? '').includes('JSON')) {
      reply.code(400).send({ error: { code: 'bad_json', message: 'That request was malformed.' } });
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

  app.get('/api/health', async () => ({ ok: true, time: Date.now() }));

  if (fs.existsSync(PUBLIC_DIR)) {
    await app.register(fastifyStatic, { root: PUBLIC_DIR, index: ['index.html'], wildcard: false });
  } else {
    app.log.warn({ dir: PUBLIC_DIR }, 'no built frontend found — API only');
  }

  return app;
}
