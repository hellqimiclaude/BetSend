import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { makeUser, makeBlob, makeTransfer, resetState, TEST_PASSWORD } from './helpers.js';
import { invalidateSettings, updateSettings } from '../src/services/settings.js';
import { DAY_MS } from '../src/repos/links.js';

/**
 * Shareable download links.
 *
 * The point of a link is access that is not tied to the recipient list:
 * somebody covering for a colleague on holiday was never a recipient and
 * cannot be made into one retrospectively without rewriting what happened.
 *
 * Two properties carry the whole feature. A link must still require a
 * signed-in BetSend account, so one that leaks outside the company is worth
 * nothing. And the files behind it must survive as long as the link does --
 * a link to files retention swept away last Tuesday is worse than no link.
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
  invalidateSettings();
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
  return `bs_session=${response.cookies.find((c) => c.name === 'bs_session')!.value}`;
}

/**
 * A sent transfer, plus a link for it.
 *
 * Johnson sends to Beridze. Williams is the colleague who will cover for
 * Beridze later; she is deliberately not a recipient of anything.
 */
async function sendWithLink(days?: number) {
  const johnson = await makeUser('J.Johnson');
  const beridze = await makeUser('M.Beridze');
  await makeUser('A.Williams');

  const blobId = makeBlob(johnson.id, { name: 'brand-kit.zip', bytes: 2048 });
  const transfer = makeTransfer(johnson.id, [beridze.id], { blobIds: [blobId] });

  const cookie = await signIn('J.Johnson');
  const created = await app.inject({
    method: 'POST',
    url: `/api/transfers/${transfer.id}/link`,
    headers: { cookie },
    payload: days === undefined ? {} : { days },
  });
  assert.equal(created.statusCode, 200, created.body);

  const { token } = created.json().link as { token: string };
  return { transfer, token, blobId, cookie };
}

describe('making a link', () => {
  test('the sender gets a token and an expiry', async () => {
    const { token } = await sendWithLink(7);
    assert.ok(token.length >= 40, 'the token must not be guessable');
  });

  test('it lasts the number of days asked for', async () => {
    const { transfer, cookie } = await sendWithLink(14);

    const again = await app.inject({
      method: 'GET',
      url: '/api/sent',
      headers: { cookie },
    });
    const row = again.json().transfers.find((t: { id: string }) => t.id === transfer.id);
    const days = Math.round((row.link.expiresAt - Date.now()) / DAY_MS);
    assert.equal(days, 14);
  });

  test('without a number it uses the configured default', async () => {
    updateSettings({ linkDefaultDays: 3 });
    const { transfer, cookie } = await sendWithLink();

    const sent = await app.inject({ method: 'GET', url: '/api/sent', headers: { cookie } });
    const row = sent.json().transfers.find((t: { id: string }) => t.id === transfer.id);
    assert.equal(Math.round((row.link.expiresAt - Date.now()) / DAY_MS), 3);
  });

  test('longer than the maximum is refused, and says what the maximum is', async () => {
    updateSettings({ linkMaxDays: 30 });
    const johnson = await makeUser('J.Johnson');
    const beridze = await makeUser('M.Beridze');
    const transfer = makeTransfer(johnson.id, [beridze.id]);

    const response = await app.inject({
      method: 'POST',
      url: `/api/transfers/${transfer.id}/link`,
      headers: { cookie: await signIn('J.Johnson') },
      payload: { days: 400 },
    });

    assert.equal(response.statusCode, 400);
    assert.match(response.json().error.message, /at most 30 days/);
  });

  test('nonsense day counts are refused', async () => {
    const johnson = await makeUser('J.Johnson');
    const beridze = await makeUser('M.Beridze');
    const transfer = makeTransfer(johnson.id, [beridze.id]);
    const cookie = await signIn('J.Johnson');

    for (const days of [0, -5, 'soon', 1.5e9, {}]) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/transfers/${transfer.id}/link`,
        headers: { cookie },
        payload: { days },
      });
      assert.equal(response.statusCode, 400, `days=${JSON.stringify(days)} should be refused`);
    }
  });

  /**
   * Not nonsense, just unsaid. Plenty of clients serialise an omitted
   * optional field as null, and a sender who did not express an opinion
   * should get the default rather than an error.
   */
  test('an explicit null means "you choose"', async () => {
    updateSettings({ linkDefaultDays: 5 });
    const johnson = await makeUser('J.Johnson');
    const beridze = await makeUser('M.Beridze');
    const transfer = makeTransfer(johnson.id, [beridze.id]);

    const response = await app.inject({
      method: 'POST',
      url: `/api/transfers/${transfer.id}/link`,
      headers: { cookie: await signIn('J.Johnson') },
      payload: { days: null },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(Math.round((response.json().link.expiresAt - Date.now()) / DAY_MS), 5);
  });

  test('only the sender can make one', async () => {
    const johnson = await makeUser('J.Johnson');
    const beridze = await makeUser('M.Beridze');
    const transfer = makeTransfer(johnson.id, [beridze.id]);

    // Even the recipient cannot: handing their own copy on is the sender's
    // decision, not theirs.
    const response = await app.inject({
      method: 'POST',
      url: `/api/transfers/${transfer.id}/link`,
      headers: { cookie: await signIn('M.Beridze') },
      payload: { days: 7 },
    });
    assert.equal(response.statusCode, 403);
  });

  test('making a second one kills the first', async () => {
    const { transfer, token, cookie } = await sendWithLink(7);

    const replaced = await app.inject({
      method: 'POST',
      url: `/api/transfers/${transfer.id}/link`,
      headers: { cookie },
      payload: { days: 7 },
    });
    const fresh = replaced.json().link.token as string;
    assert.notEqual(fresh, token);

    const old = await app.inject({ method: 'GET', url: `/api/link/${token}`, headers: { cookie } });
    assert.equal(old.statusCode, 404);
    assert.equal(
      (await app.inject({ method: 'GET', url: `/api/link/${fresh}`, headers: { cookie } })).statusCode,
      200,
    );
  });
});

describe('who a link lets in', () => {
  test('a colleague who was never a recipient can download with it', async () => {
    const { transfer, token, blobId } = await sendWithLink(7);
    const williams = await signIn('A.Williams');

    // Without the link she cannot touch it.
    const refused = await app.inject({
      method: 'GET',
      url: `/api/transfers/${transfer.id}/files/${blobId}`,
      headers: { cookie: williams },
    });
    assert.equal(refused.statusCode, 403);

    const allowed = await app.inject({
      method: 'GET',
      url: `/api/transfers/${transfer.id}/files/${blobId}?link=${token}`,
      headers: { cookie: williams },
    });
    assert.equal(allowed.statusCode, 200);
    assert.equal(allowed.rawPayload.length, 2048);
  });

  /** The property the whole design rests on. */
  test('without signing in the link is worth nothing', async () => {
    const { transfer, token, blobId } = await sendWithLink(7);

    assert.equal((await app.inject({ method: 'GET', url: `/api/link/${token}` })).statusCode, 401);
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: `/api/transfers/${transfer.id}/files/${blobId}?link=${token}`,
        })
      ).statusCode,
      401,
    );
  });

  test('a link for one transfer is no use against another', async () => {
    const { token } = await sendWithLink(7);

    const johnson = await makeUser('J.Johnson');
    const beridze = await makeUser('M.Beridze');
    const otherBlob = makeBlob(johnson.id, { name: 'private.pdf', bytes: 10 });
    const other = makeTransfer(johnson.id, [beridze.id], { blobIds: [otherBlob] });

    const response = await app.inject({
      method: 'GET',
      url: `/api/transfers/${other.id}/files/${otherBlob}?link=${token}`,
      headers: { cookie: await signIn('A.Williams') },
    });
    assert.equal(response.statusCode, 403);
  });

  test('a made-up token opens nothing', async () => {
    const { transfer, blobId } = await sendWithLink(7);
    const williams = await signIn('A.Williams');

    for (const token of ['', 'x'.repeat(43), '../../etc/passwd']) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/transfers/${transfer.id}/files/${blobId}?link=${encodeURIComponent(token)}`,
        headers: { cookie: williams },
      });
      assert.equal(response.statusCode, 403, `token ${token} should not work`);
    }
  });

  test('the zip is reachable the same way', async () => {
    const { transfer, token } = await sendWithLink(7);
    const response = await app.inject({
      method: 'GET',
      url: `/api/transfers/${transfer.id}/zip?link=${token}`,
      headers: { cookie: await signIn('A.Williams') },
    });
    assert.equal(response.statusCode, 200);
  });

  test('the page behind the link says who sent what', async () => {
    const { token } = await sendWithLink(7);
    const response = await app.inject({
      method: 'GET',
      url: `/api/link/${token}`,
      headers: { cookie: await signIn('A.Williams') },
    });

    assert.equal(response.statusCode, 200);
    const { transfer } = response.json();
    assert.equal(transfer.sender.name, 'J.Johnson');
    assert.equal(transfer.files[0].name, 'brand-kit.zip');
    // Not the recipient list: who else was sent this is not the business of
    // whoever happens to hold the link.
    assert.equal(transfer.recipients, undefined);
  });
});

describe('turning a link off', () => {
  test('revoking stops it immediately', async () => {
    const { transfer, token, blobId, cookie } = await sendWithLink(7);
    const williams = await signIn('A.Williams');

    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: `/api/transfers/${transfer.id}/files/${blobId}?link=${token}`,
          headers: { cookie: williams },
        })
      ).statusCode,
      200,
    );

    const revoked = await app.inject({
      method: 'DELETE',
      url: `/api/transfers/${transfer.id}/link`,
      headers: { cookie },
    });
    assert.equal(revoked.statusCode, 200);

    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: `/api/transfers/${transfer.id}/files/${blobId}?link=${token}`,
          headers: { cookie: williams },
        })
      ).statusCode,
      403,
    );
  });

  test('a revoked link explains itself rather than pretending it never existed', async () => {
    const { transfer, token, cookie } = await sendWithLink(7);
    await app.inject({ method: 'DELETE', url: `/api/transfers/${transfer.id}/link`, headers: { cookie } });

    const response = await app.inject({
      method: 'GET',
      url: `/api/link/${token}`,
      headers: { cookie: await signIn('A.Williams') },
    });
    assert.equal(response.json().error.code, 'link_revoked');
    assert.match(response.json().error.message, /turned this link off/);
  });

  test('revoking does not take the files from the people it was sent to', async () => {
    const { transfer, blobId, cookie } = await sendWithLink(7);
    await app.inject({ method: 'DELETE', url: `/api/transfers/${transfer.id}/link`, headers: { cookie } });

    const response = await app.inject({
      method: 'GET',
      url: `/api/transfers/${transfer.id}/files/${blobId}`,
      headers: { cookie: await signIn('M.Beridze') },
    });
    assert.equal(response.statusCode, 200);
  });

  test('only the sender can revoke', async () => {
    const { transfer } = await sendWithLink(7);
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/transfers/${transfer.id}/link`,
      headers: { cookie: await signIn('A.Williams') },
    });
    assert.equal(response.statusCode, 403);
  });
});

describe('a link that went directly cannot exist', () => {
  test('asking for one explains why, and what to do instead', async () => {
    const johnson = await makeUser('J.Johnson');
    const beridze = await makeUser('M.Beridze');
    const { recordDirectTransfer } = await import('../src/repos/transfers.js');

    const direct = recordDirectTransfer({
      senderId: johnson.id,
      recipientId: beridze.id,
      files: [{ name: 'brand-kit.zip', size: 2048 }],
      note: null,
      retentionHours: 72,
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/transfers/${direct.id}/link`,
      headers: { cookie: await signIn('J.Johnson') },
      payload: { days: 7 },
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'direct_transfer');
    assert.match(response.json().error.message, /through the server/);
  });
});

/**
 * The link's lifetime is the files' lifetime.
 *
 * This is where a link quietly stops working. Retention has two ways to
 * delete files early -- the expiry sweep, and the delete-once-everyone-has-it
 * setting -- and both of them are about the recipient list, which is exactly
 * what a link exists to sidestep. A link to files that were swept last
 * Tuesday is worse than no link at all, because somebody is relying on it.
 */
describe('keeping the files as long as the link', () => {
  test('a link pushes the transfer expiry out to match', async () => {
    const johnson = await makeUser('J.Johnson');
    const beridze = await makeUser('M.Beridze');
    // Three hours, as a short retention policy would give.
    const transfer = makeTransfer(johnson.id, [beridze.id], { retentionHours: 3 });

    await app.inject({
      method: 'POST',
      url: `/api/transfers/${transfer.id}/link`,
      headers: { cookie: await signIn('J.Johnson') },
      payload: { days: 21 },
    });

    const { getTransfer } = await import('../src/repos/transfers.js');
    const days = (getTransfer(transfer.id)!.expires_at - Date.now()) / DAY_MS;
    assert.ok(days > 20.9 && days < 21.1, `expected ~21 days, got ${days}`);
  });

  /** A generous retention must not be cut short by a brief link. */
  test('a short link never pulls the expiry in', async () => {
    const johnson = await makeUser('J.Johnson');
    const beridze = await makeUser('M.Beridze');
    const transfer = makeTransfer(johnson.id, [beridze.id], { retentionHours: 24 * 60 });
    const before = transfer.expires_at;

    await app.inject({
      method: 'POST',
      url: `/api/transfers/${transfer.id}/link`,
      headers: { cookie: await signIn('J.Johnson') },
      payload: { days: 1 },
    });

    const { getTransfer } = await import('../src/repos/transfers.js');
    assert.equal(getTransfer(transfer.id)!.expires_at, before);
  });

  /**
   * The one that would really bite. Beridze downloads his copy, the
   * delete-once-everyone-has-it sweep fires, and the files vanish before
   * the colleague covering for him ever clicks the link.
   */
  test('the files survive every recipient downloading', async () => {
    const { transfer, token, blobId, cookie } = await sendWithLink(21);
    const { markDownloaded } = await import('../src/repos/transfers.js');
    const beridze = await makeUser('M.Beridze');
    markDownloaded(transfer.id, beridze.id);

    updateSettings({ deleteAfterAllDownloaded: true });
    const { sweep } = await import('../src/services/cleanup.js');
    await sweep();

    const response = await app.inject({
      method: 'GET',
      url: `/api/transfers/${transfer.id}/files/${blobId}?link=${token}`,
      headers: { cookie: await signIn('A.Williams') },
    });
    assert.equal(response.statusCode, 200, 'the link stopped working once the recipients had collected');
    assert.equal(response.rawPayload.length, 2048);

    // And it is still listed as live for the sender, not quietly finished.
    const sent = await app.inject({ method: 'GET', url: '/api/sent', headers: { cookie } });
    const row = sent.json().transfers.find((t: { id: string }) => t.id === transfer.id);
    assert.equal(row.state, 'active');
  });

  /** Once the link is revoked, normal retention takes over again. */
  test('revoking lets the usual sweep finish the transfer', async () => {
    const { transfer, cookie } = await sendWithLink(21);
    const { markDownloaded } = await import('../src/repos/transfers.js');
    const beridze = await makeUser('M.Beridze');
    markDownloaded(transfer.id, beridze.id);

    await app.inject({ method: 'DELETE', url: `/api/transfers/${transfer.id}/link`, headers: { cookie } });

    updateSettings({ deleteAfterAllDownloaded: true });
    const { sweep } = await import('../src/services/cleanup.js');
    await sweep();

    const { getTransfer } = await import('../src/repos/transfers.js');
    assert.equal(getTransfer(transfer.id)!.state, 'completed');
  });

  test('an expired link says when it expired', async () => {
    const { transfer, token } = await sendWithLink(7);
    // Wind the link back as if a fortnight had passed.
    const { getDb } = await import('../src/db/index.js');
    getDb()
      .prepare('UPDATE download_links SET expires_at = ? WHERE transfer_id = ?')
      .run(Date.now() - 2 * DAY_MS, transfer.id);

    const response = await app.inject({
      method: 'GET',
      url: `/api/link/${token}`,
      headers: { cookie: await signIn('A.Williams') },
    });

    assert.equal(response.json().error.code, 'link_expired');
    assert.match(response.json().error.message, /expired on \d+ \w+/);
  });

  test('an expired link cannot download either', async () => {
    const { transfer, token, blobId } = await sendWithLink(7);
    const { getDb } = await import('../src/db/index.js');
    getDb()
      .prepare('UPDATE download_links SET expires_at = ? WHERE transfer_id = ?')
      .run(Date.now() - 1000, transfer.id);

    const response = await app.inject({
      method: 'GET',
      url: `/api/transfers/${transfer.id}/files/${blobId}?link=${token}`,
      headers: { cookie: await signIn('A.Williams') },
    });
    assert.equal(response.statusCode, 403);
  });

  /**
   * Somebody using a link is not the recipient collecting their files. If it
   * counted, the sender's "still waiting for" list would go quiet because a
   * colleague fetched a copy on their behalf.
   */
  test('a download through a link does not mark the recipient as having it', async () => {
    const { transfer, token, blobId, cookie } = await sendWithLink(7);

    await app.inject({
      method: 'GET',
      url: `/api/transfers/${transfer.id}/files/${blobId}?link=${token}`,
      headers: { cookie: await signIn('A.Williams') },
    });

    const sent = await app.inject({ method: 'GET', url: '/api/sent', headers: { cookie } });
    const row = sent.json().transfers.find((t: { id: string }) => t.id === transfer.id);
    assert.equal(row.recipients[0].name, 'M.Beridze');
    assert.equal(row.recipients[0].downloadedAt, null);
  });

  test('but it is recorded against the account that made it', async () => {
    const { transfer, token, blobId } = await sendWithLink(7);
    const williams = await makeUser('A.Williams');

    await app.inject({
      method: 'GET',
      url: `/api/transfers/${transfer.id}/files/${blobId}?link=${token}`,
      headers: { cookie: await signIn('A.Williams') },
    });

    const { getDb } = await import('../src/db/index.js');
    const row = getDb()
      .prepare("SELECT * FROM events WHERE type = 'link.downloaded' AND transfer_id = ?")
      .get(transfer.id) as { user_id: number } | undefined;

    assert.ok(row, 'the download was not logged');
    assert.equal(row!.user_id, williams.id);
  });
});

/**
 * A transfer with nobody to send to.
 *
 * "Put these somewhere and give me a link" is a real thing to want --
 * pasting it into a task, handing it to somebody not yet chosen -- and it
 * is the same transfer as any other, minus the recipients.
 *
 * The sharp edge is retention. Delete-once-everyone-has-downloaded asks
 * whether any recipient has not collected; with no recipients at all the
 * answer is vacuously no, so without the link exemption these would be
 * swept the moment the first sweep ran.
 */
describe('a link with no recipients', () => {
  async function linkOnly(days = 7) {
    const johnson = await makeUser('J.Johnson');
    await makeUser('A.Williams');
    const blobId = makeBlob(johnson.id, { name: 'brand-kit.zip', bytes: 2048 });
    const cookie = await signIn('J.Johnson');

    const response = await app.inject({
      method: 'POST',
      url: '/api/transfers',
      headers: { cookie },
      payload: { uploads: [blobId], recipients: [], note: 'for whoever needs it', link: { days } },
    });
    assert.equal(response.statusCode, 200, response.body);
    return { response, cookie, blobId, transfer: response.json().transfer };
  }

  test('sending to nobody is allowed when a link is asked for', async () => {
    const { transfer } = await linkOnly();
    assert.deepEqual(transfer.recipients, []);
    assert.ok(transfer.link?.token, 'no link came back with the transfer');
  });

  test('sending to nobody without a link is still refused', async () => {
    const johnson = await makeUser('J.Johnson');
    const blobId = makeBlob(johnson.id);

    const response = await app.inject({
      method: 'POST',
      url: '/api/transfers',
      headers: { cookie: await signIn('J.Johnson') },
      payload: { uploads: [blobId], recipients: [] },
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'no_recipients');
    assert.match(response.json().error.message, /or create a download link/);
  });

  test('the link works for a colleague who was never a recipient', async () => {
    const { transfer, blobId } = await linkOnly();

    const response = await app.inject({
      method: 'GET',
      url: `/api/transfers/${transfer.id}/files/${blobId}?link=${transfer.link.token}`,
      headers: { cookie: await signIn('A.Williams') },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.rawPayload.length, 2048);
  });

  /** The one that would quietly delete the files before anybody used them. */
  test('the sweep does not finish it just because nobody is waiting', async () => {
    const { transfer, blobId } = await linkOnly(21);

    updateSettings({ deleteAfterAllDownloaded: true });
    const { sweep } = await import('../src/services/cleanup.js');
    await sweep();

    const { getTransfer } = await import('../src/repos/transfers.js');
    assert.equal(getTransfer(transfer.id)!.state, 'active');

    const response = await app.inject({
      method: 'GET',
      url: `/api/transfers/${transfer.id}/files/${blobId}?link=${transfer.link.token}`,
      headers: { cookie: await signIn('A.Williams') },
    });
    assert.equal(response.statusCode, 200, 'the files were swept before anybody fetched them');
  });

  /** Once the link is off, a transfer addressed to nobody has no purpose. */
  test('revoking the link hands it back to the sweep', async () => {
    const { transfer, cookie } = await linkOnly();
    await app.inject({ method: 'DELETE', url: `/api/transfers/${transfer.id}/link`, headers: { cookie } });

    updateSettings({ deleteAfterAllDownloaded: true });
    const { sweep } = await import('../src/services/cleanup.js');
    await sweep();

    const { getTransfer } = await import('../src/repos/transfers.js');
    assert.equal(getTransfer(transfer.id)!.state, 'completed');
  });

  test('it is on the sender’s Sent page, with the link', async () => {
    const { transfer, cookie } = await linkOnly();
    const sent = await app.inject({ method: 'GET', url: '/api/sent', headers: { cookie } });
    const row = sent.json().transfers.find((t: { id: string }) => t.id === transfer.id);

    assert.ok(row, 'a link-only transfer vanished from Sent');
    assert.deepEqual(row.recipients, []);
    assert.equal(row.link.token, transfer.link.token);
  });

  test('and in nobody’s inbox, because it was addressed to nobody', async () => {
    await linkOnly();
    const inbox = await app.inject({
      method: 'GET',
      url: '/api/inbox',
      headers: { cookie: await signIn('A.Williams') },
    });
    assert.deepEqual(inbox.json().transfers, []);
  });
});

describe('asking for a link while sending', () => {
  test('recipients and a link at once', async () => {
    const johnson = await makeUser('J.Johnson');
    await makeUser('M.Beridze');
    await makeUser('A.Williams');
    const blobId = makeBlob(johnson.id, { name: 'brand-kit.zip', bytes: 1024 });

    const response = await app.inject({
      method: 'POST',
      url: '/api/transfers',
      headers: { cookie: await signIn('J.Johnson') },
      payload: { uploads: [blobId], recipients: ['M.Beridze'], link: { days: 14 } },
    });

    assert.equal(response.statusCode, 200, response.body);
    const { transfer } = response.json();
    assert.deepEqual(
      transfer.recipients.map((r: { name: string }) => r.name),
      ['M.Beridze'],
    );
    assert.ok(transfer.link?.token);

    // Beridze through the inbox, Williams through the link.
    const inbox = await app.inject({
      method: 'GET',
      url: '/api/inbox',
      headers: { cookie: await signIn('M.Beridze') },
    });
    assert.equal(inbox.json().transfers.length, 1);

    const viaLink = await app.inject({
      method: 'GET',
      url: `/api/transfers/${transfer.id}/files/${blobId}?link=${transfer.link.token}`,
      headers: { cookie: await signIn('A.Williams') },
    });
    assert.equal(viaLink.statusCode, 200);
  });

  test('"link": true means one of whatever length is configured', async () => {
    updateSettings({ linkDefaultDays: 9 });
    const johnson = await makeUser('J.Johnson');
    const blobId = makeBlob(johnson.id);

    const response = await app.inject({
      method: 'POST',
      url: '/api/transfers',
      headers: { cookie: await signIn('J.Johnson') },
      payload: { uploads: [blobId], recipients: [], link: true },
    });

    assert.equal(response.statusCode, 200, response.body);
    const days = Math.round((response.json().transfer.link.expiresAt - Date.now()) / DAY_MS);
    assert.equal(days, 9);
  });

  test('longer than the maximum is refused before anything is committed', async () => {
    updateSettings({ linkMaxDays: 30 });
    const johnson = await makeUser('J.Johnson');
    const blobId = makeBlob(johnson.id);

    const response = await app.inject({
      method: 'POST',
      url: '/api/transfers',
      headers: { cookie: await signIn('J.Johnson') },
      payload: { uploads: [blobId], recipients: [], link: { days: 365 } },
    });

    assert.equal(response.statusCode, 400);
    assert.match(response.json().error.message, /at most 30 days/);

    const sent = await app.inject({
      method: 'GET',
      url: '/api/sent',
      headers: { cookie: await signIn('J.Johnson') },
    });
    assert.deepEqual(sent.json().transfers, [], 'a refused request still created a transfer');
  });
});
