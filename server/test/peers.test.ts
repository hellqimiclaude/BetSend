import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { makeUser, resetState, TEST_PASSWORD } from './helpers.js';
import { resetPeers } from '../src/services/peers.js';

/**
 * Brokering a transfer that goes machine to machine.
 *
 * The server never touches the bytes here, so the only thing protecting a
 * colleague's PC from whoever else is on the office network is the token
 * this issues. Most of what follows is about that.
 */

let app: FastifyInstance;

before(async () => {
  app = await buildApp();
  await app.ready();
});

after(async () => {
  await app.close();
});

beforeEach(() => {
  resetState();
  resetPeers();
});

function addressFor(name: string): string {
  return `${name.toLowerCase().replace(/[^a-z0-9]+/g, '.')}@example.test`;
}

async function signIn(name: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/session',
    payload: { email: addressFor(name), password: TEST_PASSWORD },
  });
  assert.equal(response.statusCode, 200, response.body);
  const cookie = response.cookies.find((c) => c.name === 'bs_session');
  return `bs_session=${cookie!.value}`;
}

async function announce(cookie: string, port: number) {
  return app.inject({ method: 'POST', url: '/api/peer/announce', headers: { cookie }, payload: { port } });
}

describe('saying where my app is listening', () => {
  test('a sensible port is accepted', async () => {
    await makeUser('J.Johnson');
    const cookie = await signIn('J.Johnson');
    assert.equal((await announce(cookie, 51234)).statusCode, 200);
  });

  test('nonsense is refused', async () => {
    await makeUser('J.Johnson');
    const cookie = await signIn('J.Johnson');
    for (const port of [0, -1, 70000, 1.5, 'eighty', null]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/peer/announce',
        headers: { cookie },
        payload: { port },
      });
      assert.equal(response.statusCode, 400, `port ${String(port)} should be refused`);
    }
  });

  test('not without signing in', async () => {
    assert.equal((await app.inject({ method: 'POST', url: '/api/peer/announce', payload: { port: 1234 } })).statusCode, 401);
  });
});

describe('finding out who can take a direct transfer', () => {
  test('somebody who has announced can, somebody who has not cannot', async () => {
    await makeUser('J.Johnson');
    const beridze = await makeUser('M.Beridze');
    const johnson = await signIn('J.Johnson');

    let look = await app.inject({ method: 'GET', url: '/api/peer/M.Beridze', headers: { cookie: johnson } });
    assert.equal(look.json().direct, false);

    await announce(await signIn('M.Beridze'), 51234);

    look = await app.inject({ method: 'GET', url: '/api/peer/M.Beridze', headers: { cookie: johnson } });
    assert.equal(look.json().direct, true);
    assert.equal(beridze.name, 'M.Beridze');
  });

  /**
   * Knowing somebody is reachable is one thing; being handed the address of
   * their machine is another. Only an offer does that.
   */
  test('the lookup does not reveal the address', async () => {
    await makeUser('J.Johnson');
    await makeUser('M.Beridze');
    await announce(await signIn('M.Beridze'), 51234);

    const look = await app.inject({
      method: 'GET',
      url: '/api/peer/M.Beridze',
      headers: { cookie: await signIn('J.Johnson') },
    });
    const body = look.json();
    assert.equal(body.direct, true);
    assert.equal(body.host, undefined);
    assert.equal(body.port, undefined);
  });
});

describe('offering a direct transfer', () => {
  async function setUpPair() {
    await makeUser('J.Johnson');
    await makeUser('M.Beridze');
    const johnson = await signIn('J.Johnson');
    const beridze = await signIn('M.Beridze');
    await announce(beridze, 51234);
    return { johnson, beridze };
  }

  const files = [{ name: 'report.pdf', size: 1024 }];

  test('a reachable recipient comes back with a token and an address', async () => {
    const { johnson } = await setUpPair();

    const response = await app.inject({
      method: 'POST',
      url: '/api/peer/offer',
      headers: { cookie: johnson },
      payload: { recipients: ['M.Beridze'], files, note: 'here' },
    });

    assert.equal(response.statusCode, 200, response.body);
    const { ready, unreachable } = response.json();
    assert.equal(unreachable.length, 0);
    assert.equal(ready.length, 1);
    assert.equal(ready[0].port, 51234);
    assert.ok(ready[0].token.length >= 40, 'the token should not be guessable');
  });

  test('somebody with no app running is listed as unreachable, not an error', async () => {
    const { johnson } = await setUpPair();
    await makeUser('A.Williams');

    const response = await app.inject({
      method: 'POST',
      url: '/api/peer/offer',
      headers: { cookie: johnson },
      payload: { recipients: ['M.Beridze', 'A.Williams'], files },
    });

    const { ready, unreachable } = response.json();
    assert.deepEqual(ready.map((r: { name: string }) => r.name), ['M.Beridze']);
    assert.deepEqual(unreachable, ['A.Williams']);
  });

  test('every token is different', async () => {
    const { johnson } = await setUpPair();
    const tokens = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/peer/offer',
        headers: { cookie: johnson },
        payload: { recipients: ['M.Beridze'], files },
      });
      tokens.add(response.json().ready[0].token);
    }
    assert.equal(tokens.size, 5);
  });
});

describe('claiming an offer', () => {
  async function offerTo(recipient: string) {
    await makeUser('J.Johnson');
    await makeUser(recipient);
    await makeUser('A.Williams');
    const johnson = await signIn('J.Johnson');
    await announce(await signIn(recipient), 51234);

    const response = await app.inject({
      method: 'POST',
      url: '/api/peer/offer',
      headers: { cookie: johnson },
      payload: { recipients: [recipient], files: [{ name: 'report.pdf', size: 1024 }], note: 'read this' },
    });
    return response.json().ready[0].token as string;
  }

  test('the recipient is told who it is from and what is coming', async () => {
    const token = await offerTo('M.Beridze');

    const response = await app.inject({
      method: 'POST',
      url: '/api/peer/claim',
      headers: { cookie: await signIn('M.Beridze') },
      payload: { token },
    });

    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.equal(body.from, 'J.Johnson');
    assert.equal(body.note, 'read this');
    assert.equal(body.totalBytes, 1024);
    assert.deepEqual(body.files, [{ name: 'report.pdf', size: 1024 }]);
  });

  /**
   * The point of the whole mechanism. Somebody else on the LAN who gets hold
   * of a token still cannot use it, because the server checks it was issued
   * for them.
   */
  test('somebody else holding the token gets nothing', async () => {
    const token = await offerTo('M.Beridze');

    const response = await app.inject({
      method: 'POST',
      url: '/api/peer/claim',
      headers: { cookie: await signIn('A.Williams') },
      payload: { token },
    });

    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error.code, 'bad_offer');
  });

  test('a token works once', async () => {
    const token = await offerTo('M.Beridze');
    const cookie = await signIn('M.Beridze');

    assert.equal((await app.inject({ method: 'POST', url: '/api/peer/claim', headers: { cookie }, payload: { token } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/api/peer/claim', headers: { cookie }, payload: { token } })).statusCode, 403);
  });

  test('a made-up token is refused', async () => {
    await makeUser('M.Beridze');
    const response = await app.inject({
      method: 'POST',
      url: '/api/peer/claim',
      headers: { cookie: await signIn('M.Beridze') },
      payload: { token: 'a'.repeat(43) },
    });
    assert.equal(response.statusCode, 403);
  });

  test('no token at all is refused', async () => {
    await makeUser('M.Beridze');
    const response = await app.inject({
      method: 'POST',
      url: '/api/peer/claim',
      headers: { cookie: await signIn('M.Beridze') },
      payload: {},
    });
    assert.equal(response.statusCode, 403);
  });
});
