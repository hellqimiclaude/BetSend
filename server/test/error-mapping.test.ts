import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

/**
 * Fastify rejects some requests before any route runs: a content type it has
 * no parser for is 415, a body over the limit is 413. Those were all being
 * rewritten as 500 "Something went wrong on the server", which blames the
 * server for the caller's request and buries genuine faults in a log full of
 * "unhandled error".
 *
 * It was not theoretical. A plain form-encoded POST from PowerShell — which
 * is what `Invoke-WebRequest -Method POST` sends by default — produced a 500
 * and looked, for a while, like the installed server was broken.
 */

let app: FastifyInstance;

before(async () => {
  app = await buildApp();
  await app.ready();
});

after(async () => {
  await app.close();
});

describe('errors Fastify raises before the route', () => {
  test('a content type with no parser is 415, not 500', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/session',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'email=j.johnson@betlive.com&password=whatever',
    });

    assert.equal(response.statusCode, 415, response.body);
    assert.match(response.json().error.code, /media_type/);
  });

  test('malformed JSON still gets its own friendly message', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/session',
      headers: { 'content-type': 'application/json' },
      payload: '{ "email": ',
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'bad_json');
  });

  test('an unknown endpoint is still a clean 404', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/nothing-here' });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, 'not_found');
  });

  test('the response never leaks a stack trace', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/session',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'x=1',
    });

    assert.doesNotMatch(response.body, /at .*\(/, 'a stack trace reached the client');
  });
});
