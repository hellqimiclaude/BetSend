import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { makeUser, makeTransfer, resetState, TEST_PASSWORD } from './helpers.js';
import { createSetupToken } from '../src/services/sessions.js';
import { getDb } from '../src/db/index.js';

let app: FastifyInstance;

before(async () => {
  app = await buildApp();
  await app.ready();
});

after(async () => {
  await app.close();
});

/** The address makeUser() derives for a given display name. */
function addressFor(name: string): string {
  return `${name.toLowerCase().replace(/[^a-z0-9]+/g, '.')}@example.test`;
}

/** Sign in and return the raw cookie header to replay. */
async function signIn(name: string, password = TEST_PASSWORD): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/session',
    payload: { email: addressFor(name), password },
  });
  assert.equal(response.statusCode, 200, `sign-in for ${name} failed: ${response.body}`);
  const cookie = response.cookies.find((c) => c.name === 'bs_session');
  assert.ok(cookie, 'sign-in must set a session cookie');
  return `bs_session=${cookie.value}`;
}

beforeEach(() => resetState());

describe('endpoints refuse anonymous callers', () => {
  const protectedRoutes: [string, string][] = [
    ['GET', '/api/users'],
    ['GET', '/api/inbox'],
    ['GET', '/api/sent'],
    ['GET', '/api/me'],
    ['GET', '/api/unread'],
    ['GET', '/api/session'],
    ['POST', '/api/transfers'],
  ];

  for (const [method, url] of protectedRoutes) {
    test(`${method} ${url} -> 401`, async () => {
      const response = await app.inject({ method: method as 'GET', url });
      assert.equal(response.statusCode, 401);
      assert.equal(response.json().error.code, 'not_signed_in');
    });
  }

  test('POST /api/uploads -> 401 (regression: this once wrote to disk anonymously)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/uploads',
      headers: { 'tus-resumable': '1.0.0', 'upload-length': '1048576' },
    });
    assert.equal(response.statusCode, 401);
  });

  test('PATCH /api/uploads/:id -> 401', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/uploads/anything',
      headers: { 'tus-resumable': '1.0.0', 'upload-offset': '0' },
    });
    assert.equal(response.statusCode, 401);
  });

  test('the retired identity header grants nothing', async () => {
    await makeUser('J.Johnson');
    const response = await app.inject({ method: 'GET', url: '/api/inbox', headers: { 'x-user': 'J.Johnson' } });
    assert.equal(response.statusCode, 401);
  });

  test('the retired identity query parameter grants nothing', async () => {
    await makeUser('J.Johnson');
    const response = await app.inject({ method: 'GET', url: '/api/inbox?user=J.Johnson' });
    assert.equal(response.statusCode, 401);
  });

  test('bootstrap stays public but reveals no names', async () => {
    // Deliberately not J.Johnson: that is the format example the sign-in
    // screen shows everyone, so it appears in the payload by design.
    await makeUser('Z.Zelenko');
    const response = await app.inject({ method: 'GET', url: '/api/bootstrap' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().user, null);
    assert.doesNotMatch(response.body, /Zelenko/, 'the sign-in screen must not leak the staff list');
  });
});

describe('signing in', () => {
  test('a correct password sets an httpOnly cookie', async () => {
    await makeUser('J.Johnson');
    const response = await app.inject({
      method: 'POST',
      url: '/api/session',
      payload: { email: addressFor('J.Johnson'), password: TEST_PASSWORD },
    });

    assert.equal(response.statusCode, 200);
    const cookie = response.cookies.find((c) => c.name === 'bs_session');
    assert.ok(cookie);
    assert.equal(cookie.httpOnly, true, 'the cookie must be unreadable from JavaScript');
    assert.equal(cookie.sameSite?.toLowerCase(), 'lax');
  });

  test('a wrong password and an unknown name are indistinguishable', async () => {
    await makeUser('J.Johnson');

    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/api/session',
      payload: { email: addressFor('J.Johnson'), password: 'not-the-password' },
    });
    const unknownName = await app.inject({
      method: 'POST',
      url: '/api/session',
      payload: { email: 'z.nobody@example.test', password: 'not-the-password' },
    });

    assert.equal(wrongPassword.statusCode, unknownName.statusCode);
    assert.deepEqual(wrongPassword.json(), unknownName.json(), 'the form must not enumerate staff');
  });

  test('an account with no password set cannot sign in', async () => {
    await makeUser('N.Newcomer', { password: false });
    const response = await app.inject({
      method: 'POST',
      url: '/api/session',
      payload: { email: addressFor('N.Newcomer'), password: TEST_PASSWORD },
    });
    assert.equal(response.statusCode, 401);
  });

  test('the address is matched case-insensitively', async () => {
    await makeUser('J.Johnson');
    const response = await app.inject({
      method: 'POST',
      url: '/api/session',
      payload: { email: 'J.JOHNSON@EXAMPLE.TEST', password: TEST_PASSWORD },
    });
    assert.equal(response.statusCode, 200);
  });

  test('signing out stops the cookie working', async () => {
    await makeUser('J.Johnson');
    const cookie = await signIn('J.Johnson');

    assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode, 200);
    await app.inject({ method: 'DELETE', url: '/api/session', headers: { cookie } });
    assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode, 401);
  });

  test('a deactivated user is locked out immediately', async () => {
    const user = await makeUser('J.Johnson');
    const cookie = await signIn('J.Johnson');

    getDb().prepare('UPDATE users SET active = 0 WHERE id = ?').run(user.id);

    assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode, 401);
  });

  test('an expired session is refused', async () => {
    await makeUser('J.Johnson');
    const cookie = await signIn('J.Johnson');

    getDb().prepare('UPDATE sessions SET expires_at = ?').run(Date.now() - 1000);

    assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode, 401);
  });
});

describe('setup links', () => {
  test('a link lets someone set a first password, once', async () => {
    const user = await makeUser('N.Newcomer', { password: false });
    const token = createSetupToken(user.id);

    const check = await app.inject({ method: 'GET', url: `/api/setup/check?token=${token}` });
    assert.equal(check.statusCode, 200);
    assert.equal(check.json().name, 'N.Newcomer');

    const first = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { token, password: 'marmalade-tuesday' },
    });
    assert.equal(first.statusCode, 200);

    const replay = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { token, password: 'rusty-lantern-tide' },
    });
    assert.equal(replay.statusCode, 400, 'a setup link must not work twice');
  });

  test('an expired link is refused', async () => {
    const user = await makeUser('N.Newcomer', { password: false });
    const token = createSetupToken(user.id);
    getDb().prepare('UPDATE setup_tokens SET expires_at = ?').run(Date.now() - 1000);

    const response = await app.inject({ method: 'GET', url: `/api/setup/check?token=${token}` });
    assert.equal(response.statusCode, 400);
  });

  test('weak passwords are refused with a reason', async () => {
    const user = await makeUser('N.Newcomer', { password: false });

    for (const [password, reason] of [['short', /10 characters/i], ['n.newcomer-is-me', /your own name/i]] as const) {
      const token = createSetupToken(user.id);
      const response = await app.inject({ method: 'POST', url: '/api/setup', payload: { token, password } });
      assert.equal(response.statusCode, 400);
      assert.match(response.json().error.message, reason);
    }
  });

  test('changing a password signs other devices out', async () => {
    await makeUser('J.Johnson');
    const laptop = await signIn('J.Johnson');
    const desktop = await signIn('J.Johnson');

    const changed = await app.inject({
      method: 'POST',
      url: '/api/session/password',
      headers: { cookie: desktop },
      payload: { currentPassword: TEST_PASSWORD, newPassword: 'quiet-harbour-ninety' },
    });
    assert.equal(changed.statusCode, 200);

    const stillIn = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: laptop } });
    assert.equal(stillIn.statusCode, 401, 'the other device must be signed out');
  });
});

describe('admin', () => {
  test('the token is required', async () => {
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/overview' })).statusCode, 403);
  });

  test('a wrong token is refused', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/overview',
      headers: { 'x-admin-token': 'wrong' },
    });
    assert.equal(response.statusCode, 403);
  });

  test('the configured token is accepted', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/overview',
      headers: { 'x-admin-token': 'test-admin-token' },
    });
    assert.equal(response.statusCode, 200);
  });

  test('an admin account needs no token', async () => {
    await makeUser('J.Johnson', { admin: true });
    const cookie = await signIn('J.Johnson');
    const response = await app.inject({ method: 'GET', url: '/api/admin/overview', headers: { cookie } });
    assert.equal(response.statusCode, 200);
  });

  test('an ordinary signed-in user is not an admin', async () => {
    await makeUser('M.Smith');
    const cookie = await signIn('M.Smith');
    const response = await app.inject({ method: 'GET', url: '/api/admin/overview', headers: { cookie } });
    assert.equal(response.statusCode, 403);
  });
});

describe('one colleague cannot read another\'s transfer', () => {
  test('a non-recipient is refused the metadata and the file', async () => {
    const sender = await makeUser('J.Johnson');
    const recipient = await makeUser('A.Williams');
    await makeUser('K.Jones');

    const transfer = makeTransfer(sender.id, [recipient.id]);
    const blobId = (getDb().prepare('SELECT blob_id FROM transfer_files WHERE transfer_id = ?').get(transfer.id) as { blob_id: string }).blob_id;

    const outsider = await signIn('K.Jones');
    assert.equal(
      (await app.inject({ method: 'GET', url: `/api/transfers/${transfer.id}`, headers: { cookie: outsider } })).statusCode,
      403,
    );
    assert.equal(
      (await app.inject({ method: 'GET', url: `/api/transfers/${transfer.id}/files/${blobId}`, headers: { cookie: outsider } })).statusCode,
      403,
    );
    assert.equal(
      (await app.inject({ method: 'GET', url: `/api/transfers/${transfer.id}/zip`, headers: { cookie: outsider } })).statusCode,
      403,
    );
  });

  test('only the sender can revoke', async () => {
    const sender = await makeUser('J.Johnson');
    const recipient = await makeUser('A.Williams');
    const transfer = makeTransfer(sender.id, [recipient.id]);

    const theirs = await signIn('A.Williams');
    const response = await app.inject({
      method: 'POST',
      url: `/api/transfers/${transfer.id}/revoke`,
      headers: { cookie: theirs },
    });
    assert.equal(response.statusCode, 403, 'a recipient must not be able to revoke');
  });

  test('a recipient can read what was sent to them', async () => {
    const sender = await makeUser('J.Johnson');
    const recipient = await makeUser('A.Williams');
    const transfer = makeTransfer(sender.id, [recipient.id]);

    const cookie = await signIn('A.Williams');
    const response = await app.inject({ method: 'GET', url: `/api/transfers/${transfer.id}`, headers: { cookie } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().transfer.sender.name, 'J.Johnson');
  });
});
