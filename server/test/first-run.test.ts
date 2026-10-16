import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { makeUser, resetState } from './helpers.js';
import { config } from '../src/config.js';
import { countUsers } from '../src/repos/users.js';
import { clearAll } from '../src/services/ratelimit.js';

/**
 * A brand new install has nobody in it, and both other ways in are shut:
 * registering needs a mail relay to verify the address, and the Admin page
 * needs a session. Without first-run setup the server is a locked door with
 * the key inside — which is exactly what shipped, and what these cover.
 */

let app: FastifyInstance;

const OFFICE = 'betlive.com';

before(async () => {
  config.emailDomains = [OFFICE];
  app = await buildApp();
  await app.ready();
});

after(async () => {
  await app.close();
});

beforeEach(() => {
  resetState();
  clearAll(); // the limiter is process-wide, and these tests share a process
});

const GOOD_PASSWORD = 'spare-anchor-violet';

function firstRun(payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/api/first-run', payload });
}

describe('first-run setup', () => {
  test('bootstrap says setup is needed while the directory is empty', async () => {
    const empty = await app.inject({ method: 'GET', url: '/api/bootstrap' });
    assert.equal(empty.json().needsFirstRun, true);

    makeUser('J.Johnson');

    const populated = await app.inject({ method: 'GET', url: '/api/bootstrap' });
    assert.equal(populated.json().needsFirstRun, false);
  });

  test('the admin token creates the first account, signed in and an admin', async () => {
    const response = await firstRun({
      adminToken: config.adminToken,
      email: 'j.johnson@betlive.com',
      password: GOOD_PASSWORD,
    });

    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.equal(body.user.name, 'J.Johnson');
    assert.equal(body.user.isAdmin, true);
    assert.ok(
      response.cookies.find((c) => c.name === 'bs_session'),
      'first-run must sign the new admin in',
    );
  });

  test('the new account can sign in afterwards', async () => {
    await firstRun({ adminToken: config.adminToken, email: 'j.johnson@betlive.com', password: GOOD_PASSWORD });

    const signIn = await app.inject({
      method: 'POST',
      url: '/api/session',
      payload: { email: 'j.johnson@betlive.com', password: GOOD_PASSWORD },
    });
    assert.equal(signIn.statusCode, 200, signIn.body);
  });

  test('a wrong admin token creates nothing', async () => {
    const response = await firstRun({
      adminToken: 'not-the-token',
      email: 'j.johnson@betlive.com',
      password: GOOD_PASSWORD,
    });

    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error.code, 'bad_admin_token');
    assert.equal(countUsers(), 0);
  });

  test('it closes once somebody exists, so it is not a back door', async () => {
    makeUser('M.Smith');

    const response = await firstRun({
      adminToken: config.adminToken,
      email: 'j.johnson@betlive.com',
      password: GOOD_PASSWORD,
    });

    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error.code, 'already_set_up');
  });

  /**
   * The one that matters most. Creating the account before checking the
   * password would leave a passwordless user behind, and the guard above
   * would then refuse every retry — bricking the install with no way back.
   */
  test('a rejected password leaves the door open for another try', async () => {
    const weak = await firstRun({
      adminToken: config.adminToken,
      email: 'j.johnson@betlive.com',
      password: 'short',
    });
    assert.equal(weak.statusCode, 400);
    assert.equal(weak.json().error.code, 'weak_password');
    assert.equal(countUsers(), 0, 'a rejected attempt must not create an account');

    const retry = await firstRun({
      adminToken: config.adminToken,
      email: 'j.johnson@betlive.com',
      password: GOOD_PASSWORD,
    });
    assert.equal(retry.statusCode, 200, retry.body);
  });

  test('a password containing the address is refused', async () => {
    const response = await firstRun({
      adminToken: config.adminToken,
      email: 'j.johnson@betlive.com',
      password: 'j.johnson-is-here',
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'weak_password');
    assert.equal(countUsers(), 0);
  });

  test('an address outside the allowed domains is refused', async () => {
    const response = await firstRun({
      adminToken: config.adminToken,
      email: 'j.johnson@gmail.com',
      password: GOOD_PASSWORD,
    });

    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error.code, 'domain_not_allowed');
    assert.equal(countUsers(), 0);
  });
});
