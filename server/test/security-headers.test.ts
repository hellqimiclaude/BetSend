import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp, inlineScriptHashes, PUBLIC_DIR } from '../src/app.js';

/**
 * index.html sets the dark class before first paint so the page never flashes
 * white on its way to dark. A `script-src 'self'` policy blocks that, which is
 * what shipped: the policy allowed 'unsafe-inline' for styles but not scripts,
 * so the flash happened on every load and said so only in the browser console,
 * where nothing was looking. The policy now carries the script's hash.
 */

let app: FastifyInstance;

before(async () => {
  app = await buildApp();
  await app.ready();
});

after(async () => {
  await app.close();
});

function sha256(body: string): string {
  return `'sha256-${crypto.createHash('sha256').update(body, 'utf8').digest('base64')}'`;
}

describe('inline script hashing', () => {
  test('hashes an inline script', () => {
    const body = '\n  document.documentElement.classList.add("dark");\n';
    assert.deepEqual(inlineScriptHashes(`<head><script>${body}</script></head>`), [sha256(body)]);
  });

  test('ignores a script loaded from a file', () => {
    assert.deepEqual(inlineScriptHashes('<script type="module" src="/assets/index.js"></script>'), []);
  });

  test('handles both in one document, and attributes on the inline tag', () => {
    const html = '<script src="/a.js"></script><script defer>var a = 1;</script>';
    assert.deepEqual(inlineScriptHashes(html), [sha256('var a = 1;')]);
  });

  test('a page with no scripts adds nothing', () => {
    assert.deepEqual(inlineScriptHashes('<html><body>nothing here</body></html>'), []);
  });
});

describe('the policy served with the page', () => {
  test('allows exactly the inline scripts the built page contains', async () => {
    const response = await app.inject({ method: 'GET', url: '/' });
    const policy = String(response.headers['content-security-policy'] ?? '');
    const scriptSrc = policy.split(';').map((p) => p.trim()).find((p) => p.startsWith('script-src'));

    assert.ok(scriptSrc, `no script-src in: ${policy}`);
    assert.match(scriptSrc, /^script-src 'self'/);

    const indexFile = path.join(PUBLIC_DIR, 'index.html');
    if (!fs.existsSync(indexFile)) {
      // Tests can run before `npm run build`. Nothing to allow, so nothing extra.
      assert.equal(scriptSrc, "script-src 'self'");
      return;
    }

    const expected = inlineScriptHashes(fs.readFileSync(indexFile, 'utf8'));
    for (const hash of expected) {
      assert.ok(scriptSrc.includes(hash), `the built page has an inline script the policy blocks: ${hash}`);
    }
  });

  test('the usual hardening is still there', async () => {
    const response = await app.inject({ method: 'GET', url: '/' });
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['x-frame-options'], 'DENY');
  });
});
