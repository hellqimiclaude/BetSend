import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeUser, resetState, countRows } from './helpers.js';
import {
  consumeSetupToken,
  createSession,
  createSetupToken,
  destroyAllSessionsFor,
  destroySession,
  purgeExpiredSessions,
  resolveSession,
  resolveSetupToken,
  sessionCountFor,
} from '../src/services/sessions.js';
import { getDb } from '../src/db/index.js';

beforeEach(() => resetState());

describe('sessions', () => {
  test('a fresh token resolves to its user', async () => {
    const user = await makeUser('J.Johnson');
    const token = createSession(user.id, 'test-agent');

    const resolved = resolveSession(token);
    assert.equal(resolved?.user.id, user.id);
  });

  test('the raw token is never stored', async () => {
    const user = await makeUser('J.Johnson');
    const token = createSession(user.id, null);

    const stored = getDb().prepare('SELECT id FROM sessions').get() as { id: string };
    assert.notEqual(stored.id, token, 'the database must hold a hash, not the cookie');
    assert.match(stored.id, /^[0-9a-f]{64}$/, 'expected a sha256 hex digest');
  });

  test('a made-up token resolves to nothing', () => {
    assert.equal(resolveSession('not-a-real-token'), null);
    assert.equal(resolveSession(undefined), null);
  });

  test('an expired session stops working and is purged', async () => {
    const user = await makeUser('J.Johnson');
    const token = createSession(user.id, null);

    getDb().prepare('UPDATE sessions SET expires_at = ?').run(Date.now() - 1000);
    assert.equal(resolveSession(token), null);

    assert.equal(purgeExpiredSessions(), 1);
    assert.equal(countRows('sessions'), 0);
  });

  test('signing out one device leaves the others alone', async () => {
    const user = await makeUser('J.Johnson');
    const laptop = createSession(user.id, 'laptop');
    const phone = createSession(user.id, 'phone');

    destroySession(laptop);

    assert.equal(resolveSession(laptop), null);
    assert.ok(resolveSession(phone), 'the other device should still be signed in');
    assert.equal(sessionCountFor(user.id), 1);
  });

  test('signing out everywhere clears the lot', async () => {
    const user = await makeUser('J.Johnson');
    const tokens = [createSession(user.id, 'a'), createSession(user.id, 'b'), createSession(user.id, 'c')];

    destroyAllSessionsFor(user.id);

    for (const token of tokens) assert.equal(resolveSession(token), null);
    assert.equal(sessionCountFor(user.id), 0);
  });

  test('one person signing out does not touch anyone else', async () => {
    const alice = await makeUser('A.Williams');
    const bob = await makeUser('B.Brown');
    const bobsToken = createSession(bob.id, null);
    createSession(alice.id, null);

    destroyAllSessionsFor(alice.id);

    assert.ok(resolveSession(bobsToken), 'the wrong person must not be signed out');
  });

  test('a deactivated user cannot use an existing session', async () => {
    const user = await makeUser('J.Johnson');
    const token = createSession(user.id, null);

    getDb().prepare('UPDATE users SET active = 0 WHERE id = ?').run(user.id);

    assert.equal(resolveSession(token), null);
  });
});

describe('setup tokens', () => {
  test('a token resolves to its user and can be consumed once', async () => {
    const user = await makeUser('N.Newcomer', { password: false });
    const token = createSetupToken(user.id);

    assert.equal(resolveSetupToken(token)?.id, user.id);
    consumeSetupToken(token);
    assert.equal(resolveSetupToken(token), null, 'a consumed link must not work again');
  });

  test('only the newest link for a person works', async () => {
    const user = await makeUser('N.Newcomer', { password: false });
    const first = createSetupToken(user.id);
    const second = createSetupToken(user.id);

    assert.equal(resolveSetupToken(first), null, 'issuing a new link should void the old one');
    assert.ok(resolveSetupToken(second));
  });

  test('the raw token is not stored', async () => {
    const user = await makeUser('N.Newcomer', { password: false });
    const token = createSetupToken(user.id);

    const stored = getDb().prepare('SELECT id FROM setup_tokens').get() as { id: string };
    assert.notEqual(stored.id, token);
    assert.match(stored.id, /^[0-9a-f]{64}$/);
  });

  test('an expired link resolves to nothing', async () => {
    const user = await makeUser('N.Newcomer', { password: false });
    const token = createSetupToken(user.id);

    getDb().prepare('UPDATE setup_tokens SET expires_at = ?').run(Date.now() - 1000);
    assert.equal(resolveSetupToken(token), null);
  });
});
