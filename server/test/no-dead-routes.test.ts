import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

/**
 * `/api/transfers/:id/exists` was left over from an early version and nothing
 * called it. It also never checked who was asking, so anyone who could reach
 * the server could test transfer ids until one came back 200 — a slow but
 * real way to learn that a given transfer exists. Gone, and staying gone.
 */

let app: FastifyInstance;

before(async () => {
  app = await buildApp();
  await app.ready();
});

after(async () => {
  await app.close();
});

describe('routes that should not exist', () => {
  test('the old transfer-probe endpoint is gone', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/transfers/anything/exists' });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, 'not_found');
  });

  /**
   * Everything under /api must either need a session or be deliberately
   * public. This lists the deliberate ones, so a new route that forgets to
   * check has to be added here on purpose rather than by accident.
   */
  test('the endpoints reachable without signing in are only the expected ones', async () => {
    const expected = [
      'GET /api/health',
      'GET /api/bootstrap',
      'GET /api/setup/check',
      'GET /api/session/limits',
      'POST /api/session',
      'POST /api/register',
      'POST /api/password/forgot',
      'POST /api/setup',
      'POST /api/first-run',
      // Guarded by the admin token rather than a session.
      'POST /api/admin/verify',
    ];

    const routes = listRoutes(app);
    // Without this the loop below could quietly iterate nothing and pass.
    assert.ok(routes.length >= 15, `only parsed ${routes.length} routes — the parser has drifted`);

    const anonymous: string[] = [];
    for (const route of routes) {
      if (!route.url.startsWith('/api/')) continue;
      if (route.method !== 'GET' && route.method !== 'POST') continue;
      // A path with a placeholder in it cannot be probed as written: ':id'
      // needs a real id, and injecting a literal '*' simply does not resolve.
      // Those routes are covered by their own tests.
      if (route.url.includes(':') || route.url.includes('*')) continue;

      const response = await app.inject({ method: route.method, url: route.url, payload: {} });
      if (response.statusCode !== 401 && response.statusCode !== 403) {
        anonymous.push(`${route.method} ${route.url}`);
      }
    }

    const unexpected = anonymous.filter((route) => !expected.includes(route));
    assert.deepEqual(unexpected, [], 'these answer without a session — add a check, or add them to the list above');
  });
});

/**
 * Fastify's route table, flattened to method + url pairs.
 *
 * printRoutes draws a tree whose children are *relative* segments -- the root
 * is "/" and beneath it sits "api/session", not "/api/session" -- so the full
 * path has to be rebuilt from the indentation. The first version of this
 * expected every line to start with a slash, matched almost nothing, and
 * happily reported that every route was fine.
 */
function listRoutes(instance: FastifyInstance): { method: string; url: string }[] {
  const found: { method: string; url: string }[] = [];
  /** Path pieces by tree depth, so a child can be joined onto its parent. */
  const atDepth = new Map<number, string>();

  for (const line of instance.printRoutes({ commonPrefix: false }).split('\n')) {
    // e.g. "    │   ├── /password (POST)" -> indent, segment, methods
    const match = /^([\s│├└─]*?)(?:[├└]── )?(\S+)(?:\s+\(([^)]+)\))?\s*$/.exec(line);
    if (!match) continue;

    const [, indent, segment, methods] = match;
    if (!segment) continue;

    const depth = indent.length;
    const parent = [...atDepth.entries()]
      .filter(([d]) => d < depth)
      .sort((a, b) => b[0] - a[0])[0]?.[1] ?? '';

    const full = (parent + segment).replace(/\/{2,}/g, '/');
    atDepth.set(depth, full);
    // Anything deeper belongs to a different branch now.
    for (const d of [...atDepth.keys()]) if (d > depth) atDepth.delete(d);

    if (!methods) continue;
    for (const method of methods.split(',')) found.push({ method: method.trim(), url: full });
  }

  return found;
}
