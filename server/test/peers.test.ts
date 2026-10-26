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

/**
 * The bytes bypass this server, but the fact that they moved must not.
 *
 * Without a record, a file sent directly appears in neither the sender's
 * Sent page nor the recipient's Inbox -- it simply happens and is forgotten,
 * which is indistinguishable from the feature being broken.
 */
describe('remembering a transfer that went straight to the other machine', () => {
  async function deliver(
    recipient = 'M.Beridze',
    files = [{ name: 'report.pdf', size: 1024 }],
    note = 'read this',
  ) {
    await makeUser('J.Johnson');
    await makeUser(recipient);
    const johnson = await signIn('J.Johnson');
    const theirs = await signIn(recipient);
    await announce(theirs, 51234);

    const offer = await app.inject({
      method: 'POST',
      url: '/api/peer/offer',
      headers: { cookie: johnson },
      payload: { recipients: [recipient], files, note },
    });
    const { token } = offer.json().ready[0] as { token: string };

    await app.inject({ method: 'POST', url: '/api/peer/claim', headers: { cookie: theirs }, payload: { token } });
    const done = await app.inject({
      method: 'POST',
      url: '/api/peer/complete',
      headers: { cookie: theirs },
      payload: { token, ok: true },
    });
    assert.equal(done.statusCode, 200, done.body);
    return { johnson, theirs };
  }

  test('the sender sees it on their Sent page', async () => {
    const { johnson } = await deliver();

    const sent = await app.inject({ method: 'GET', url: '/api/sent', headers: { cookie: johnson } });
    const [transfer] = sent.json().transfers;

    assert.equal(transfer.delivery, 'direct');
    assert.equal(transfer.fileCount, 1);
    assert.equal(transfer.totalSize, 1024);
    assert.deepEqual(
      transfer.files.map((f: { name: string; size: number }) => f),
      [{ id: transfer.files[0].id, name: 'report.pdf', size: 1024, mime: null }],
    );
    assert.equal(transfer.recipients[0].name, 'M.Beridze');
  });

  test('the recipient sees it in their Inbox, unread', async () => {
    const { theirs } = await deliver();

    const inbox = await app.inject({ method: 'GET', url: '/api/inbox', headers: { cookie: theirs } });
    const [transfer] = inbox.json().transfers;

    assert.equal(transfer.delivery, 'direct');
    assert.equal(transfer.sender.name, 'J.Johnson');
    assert.equal(transfer.note, 'read this');
    // They have the bytes already; what they have not done is look at the app.
    assert.equal(transfer.me.downloadedAt !== null, true);
    assert.equal(transfer.me.seenAt, null);

    const unread = await app.inject({ method: 'GET', url: '/api/unread', headers: { cookie: theirs } });
    assert.equal(unread.json().unread, 1);
  });

  test('a transfer still going is not recorded as delivered', async () => {
    await makeUser('J.Johnson');
    await makeUser('M.Beridze');
    const johnson = await signIn('J.Johnson');
    await announce(await signIn('M.Beridze'), 51234);

    await app.inject({
      method: 'POST',
      url: '/api/peer/offer',
      headers: { cookie: johnson },
      payload: { recipients: ['M.Beridze'], files: [{ name: 'report.pdf', size: 1024 }], note: '' },
    });

    const sent = await app.inject({ method: 'GET', url: '/api/sent', headers: { cookie: johnson } });
    assert.deepEqual(sent.json().transfers, [], 'an offer that was never used is not a delivery');
  });

  /** It fell back to the server, which will record its own transfer. */
  test('a direct attempt that failed is not recorded as delivered', async () => {
    await makeUser('J.Johnson');
    await makeUser('M.Beridze');
    const johnson = await signIn('J.Johnson');
    const theirs = await signIn('M.Beridze');
    await announce(theirs, 51234);

    const offer = await app.inject({
      method: 'POST',
      url: '/api/peer/offer',
      headers: { cookie: johnson },
      payload: { recipients: ['M.Beridze'], files: [{ name: 'report.pdf', size: 1024 }], note: '' },
    });
    const { token } = offer.json().ready[0] as { token: string };
    await app.inject({ method: 'POST', url: '/api/peer/claim', headers: { cookie: theirs }, payload: { token } });
    await app.inject({
      method: 'POST',
      url: '/api/peer/complete',
      headers: { cookie: theirs },
      payload: { token, ok: false },
    });

    const sent = await app.inject({ method: 'GET', url: '/api/sent', headers: { cookie: johnson } });
    assert.deepEqual(sent.json().transfers, []);
  });

  test('every file is listed, in the order it was sent', async () => {
    const { johnson } = await deliver('M.Beridze', [
      { name: 'a.bin', size: 10 },
      { name: 'b.bin', size: 20 },
      { name: 'c.bin', size: 30 },
    ]);

    const sent = await app.inject({ method: 'GET', url: '/api/sent', headers: { cookie: johnson } });
    const [transfer] = sent.json().transfers;

    assert.deepEqual(
      transfer.files.map((f: { name: string }) => f.name),
      ['a.bin', 'b.bin', 'c.bin'],
    );
    assert.equal(transfer.totalSize, 60);
  });

  /**
   * There is nothing on this server to pull back. Revoking must say so
   * rather than appearing to work.
   */
  test('it cannot be revoked, because there is nothing here to revoke', async () => {
    const { johnson } = await deliver();
    const sent = await app.inject({ method: 'GET', url: '/api/sent', headers: { cookie: johnson } });
    const { id } = sent.json().transfers[0] as { id: string };

    const response = await app.inject({
      method: 'POST',
      url: `/api/transfers/${id}/revoke`,
      headers: { cookie: johnson },
    });
    assert.equal(response.statusCode, 400);
  });

  /**
   * The sweeper frees blobs. These rows hold none, and a bug that let one
   * through would have it releasing references that were never taken.
   */
  test('the retention sweeper has nothing to do with it', async () => {
    await deliver();
    const { expiredTransferIds, fullyDownloadedTransferIds, unpurgedFinishedTransferIds } = await import(
      '../src/repos/transfers.js'
    );

    assert.deepEqual(expiredTransferIds(), []);
    assert.deepEqual(fullyDownloadedTransferIds(), []);
    assert.deepEqual(unpurgedFinishedTransferIds(), []);
  });
});

/**
 * An address is only worth handing out to somebody who can route to it.
 *
 * The endpoint host is whatever the server saw a connection come from, and
 * for an app running on the server PC itself that is 127.0.0.1 -- correct
 * for them, useless to anybody else.
 */
describe('not handing out an address the asker cannot reach', () => {
  async function announceFrom(name: string, remoteAddress: string, port = 51234) {
    return app.inject({
      method: 'POST',
      url: '/api/peer/announce',
      headers: { cookie: await signIn(name) },
      payload: { port },
      remoteAddress,
    });
  }

  async function lookFor(name: string, cookie: string, remoteAddress: string) {
    const response = await app.inject({
      method: 'GET',
      url: `/api/peer/${name}`,
      headers: { cookie },
      remoteAddress,
    });
    return response.json().direct as boolean;
  }

  test('a colleague on the network is told the app on the server PC is unreachable', async () => {
    await makeUser('J.Johnson');
    await makeUser('M.Beridze');
    const johnson = await signIn('J.Johnson');

    // Beridze is signed in on the machine the server runs on.
    await announceFrom('M.Beridze', '127.0.0.1');

    assert.equal(await lookFor('M.Beridze', johnson, '10.2.254.239'), false);
  });

  test('and is given no token for them, so nothing waits on a dead connection', async () => {
    await makeUser('J.Johnson');
    await makeUser('M.Beridze');
    const johnson = await signIn('J.Johnson');
    await announceFrom('M.Beridze', '127.0.0.1');

    const offer = await app.inject({
      method: 'POST',
      url: '/api/peer/offer',
      headers: { cookie: johnson },
      payload: { recipients: ['M.Beridze'], files: [{ name: 'a.bin', size: 1 }], note: '' },
      remoteAddress: '10.2.254.239',
    });

    assert.deepEqual(offer.json().ready, []);
    assert.deepEqual(offer.json().unreachable, ['M.Beridze']);
  });

  test('somebody else on that same machine still reaches them', async () => {
    await makeUser('J.Johnson');
    await makeUser('M.Beridze');
    const johnson = await signIn('J.Johnson');
    await announceFrom('M.Beridze', '127.0.0.1');

    assert.equal(await lookFor('M.Beridze', johnson, '127.0.0.1'), true);
  });

  test('an ordinary LAN address is reachable from anywhere on the LAN', async () => {
    await makeUser('J.Johnson');
    await makeUser('M.Beridze');
    const johnson = await signIn('J.Johnson');
    await announceFrom('M.Beridze', '10.2.254.240');

    assert.equal(await lookFor('M.Beridze', johnson, '10.2.254.239'), true);
  });

  test('an IPv4 address wearing an IPv6 prefix is the same address', async () => {
    const { isLoopback, normaliseHost, reachableFrom } = await import('../src/services/peers.js');

    assert.equal(normaliseHost('::ffff:10.2.254.239'), '10.2.254.239');
    assert.equal(normaliseHost('10.2.254.239'), '10.2.254.239');
    assert.equal(normaliseHost('::1'), '::1');

    assert.equal(isLoopback('::ffff:127.0.0.1'), true);
    assert.equal(isLoopback('::1'), true);
    assert.equal(isLoopback('127.1.2.3'), true);
    assert.equal(isLoopback('10.2.254.239'), false);
    // Not loopback, whatever it looks like at a glance.
    assert.equal(isLoopback('127.0.0.1.example.com'), false);
    assert.equal(isLoopback('12.7.0.1'), false);

    assert.equal(reachableFrom('::ffff:10.0.0.5', '10.0.0.6'), true);
    assert.equal(reachableFrom('::ffff:127.0.0.1', '10.0.0.6'), false);
    assert.equal(reachableFrom('::ffff:127.0.0.1', '::1'), true);
  });
});
