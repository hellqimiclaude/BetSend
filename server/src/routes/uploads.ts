import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getTusServer, UPLOAD_PATH } from '../services/tus.js';

/**
 * Mounts the tus endpoint inside its own encapsulated scope so we can strip
 * Fastify's body parsers: tus needs the raw request stream, and Fastify must
 * not read a single byte of it. `reply.hijack()` hands the socket to tus.
 */
export default async function uploadRoutes(app: FastifyInstance): Promise<void> {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', (_request, _payload, done) => done(null));

  const tus = getTusServer();

  const handler = async (request: FastifyRequest, reply: FastifyReply) => {
    reply.hijack();
    await tus.handle(request.raw, reply.raw);
  };

  const methods = ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS'] as const;

  app.route({ method: [...methods], url: UPLOAD_PATH, exposeHeadRoute: false, handler });
  app.route({ method: [...methods], url: `${UPLOAD_PATH}/*`, exposeHeadRoute: false, handler });
}
