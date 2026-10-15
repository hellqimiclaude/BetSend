import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';
import { resetTransport } from '../src/services/mail.js';
import { startFakeSmtp, type FakeSmtp } from './fake-smtp.js';
import { makeUser, resetState, TEST_PASSWORD } from './helpers.js';
import { findByEmail } from '../src/repos/users.js';
import { updateSettings } from '../src/services/settings.js';

/**
 * Registering, verifying and resetting, all driven through a fake relay so
 * the real nodemailer path is exercised rather than mocked out. Their actual
 * Exchange server is the one thing these cannot cover.
 */

let app: FastifyInstance;
let smtp: FakeSmtp;

const OFFICE = 'betlive.com';

before(async () => {
  smtp = await startFakeSmtp();
  config.smtpHost = '127.0.0.1';
  config.smtpPort = smtp.port;
  config.smtpFrom = `BetSend <betsend@${OFFICE}>`;
  config.emailDomains = [OFFICE];
  config.requireAdminApproval = false;
  resetTransport();

  app = await buildApp();
  await app.ready();
});

after(async () => {
  await app.close();
  await smtp.close();
  resetTransport();
});

beforeEach(() => {
  resetState();
  smtp.received.length = 0;
  updateSettings({ registrationMode: 'open' });
});

/** Pull the one-time link out of whatever landed in the mailbox. */
function linkFrom(body: string): string {
  const match = body.match(/https?:\/\/\S*#\/setup\?token=[A-Za-z0-9_-]+/);
  assert.ok(match, `no setup link in:\n${body}`);
  return match[0];
}

function tokenFrom(body: string): string {
  return new URL(linkFrom(body)).hash.split('token=')[1];
}

describe('registering with a work address', () => {
  test('a betlive.com address is emailed a link', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/register',
      payload: { email: `j.johnson@${OFFICE}` },
    });
    assert.equal(response.statusCode, 200);

    const mail = await smtp.next();
    assert.deepEqual(mail.to, [`j.johnson@${OFFICE}`]);
    assert.match(mail.text, /Finish setting up BetSend/);
    assert.ok(linkFrom(mail.text).startsWith('http'), 'the link must be absolute to work from a mailbox');
  });

  test('an outside address is refused and nothing is sent', async () => {
    for (const outsider of ['someone@gmail.com', `someone@${OFFICE}.evil.net`, 'someone@notbetlive.com']) {
      const response = await app.inject({ method: 'POST', url: '/api/register', payload: { email: outsider } });
      assert.equal(response.statusCode, 403, `${outsider} should be refused`);
      assert.match(response.json().error.message, /betlive\.com/);
    }
    assert.equal(smtp.received.length, 0, 'no mail may be sent to an outside address');
  });

  test('the link sets a password and signs the person in', async () => {
    await app.inject({ method: 'POST', url: '/api/register', payload: { email: `n.newcomer@${OFFICE}` } });
    const token = tokenFrom((await smtp.next()).text);

    const check = await app.inject({ method: 'GET', url: `/api/setup/check?token=${token}` });
    assert.equal(check.statusCode, 200);
    assert.equal(check.json().email, `n.newcomer@${OFFICE}`);

    const done = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { token, password: 'marmalade-tuesday' },
    });
    assert.equal(done.statusCode, 200);
    assert.equal(done.json().user.email, `n.newcomer@${OFFICE}`);
    assert.ok(done.cookies.find((c) => c.name === 'bs_session'), 'should be signed in straight away');

    const user = findByEmail(`n.newcomer@${OFFICE}`);
    assert.ok(user?.email_verified_at, 'following the link proves they can read that mailbox');
  });

  test('the display name comes from the address', async () => {
    await app.inject({ method: 'POST', url: '/api/register', payload: { email: `a.williams@${OFFICE}` } });
    await smtp.next();
    assert.equal(findByEmail(`a.williams@${OFFICE}`)?.name, 'A.Williams');
  });

  test('registering an address that already has an account reveals nothing', async () => {
    await makeUser('J.Johnson', { email: `j.johnson@${OFFICE}` });

    const response = await app.inject({
      method: 'POST',
      url: '/api/register',
      payload: { email: `j.johnson@${OFFICE}` },
    });

    // Same 200 as a brand-new address; the detail goes to the mailbox.
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { ok: true });
  });

  test('in list-only mode an unknown address is silently ignored', async () => {
    updateSettings({ registrationMode: 'list' });

    const response = await app.inject({
      method: 'POST',
      url: '/api/register',
      payload: { email: `stranger@${OFFICE}` },
    });

    assert.equal(response.statusCode, 200, 'the response must not reveal who is on the list');
    assert.equal(smtp.received.length, 0, 'but no link is sent');
    assert.equal(findByEmail(`stranger@${OFFICE}`), undefined, 'and no account is created');
  });
});

describe('forgotten passwords', () => {
  test('a known address is emailed a reset link that works', async () => {
    await makeUser('J.Johnson', { email: `j.johnson@${OFFICE}` });

    const response = await app.inject({
      method: 'POST',
      url: '/api/password/forgot',
      payload: { email: `j.johnson@${OFFICE}` },
    });
    assert.equal(response.statusCode, 200);

    const mail = await smtp.next();
    assert.match(mail.text, /Reset your BetSend password/);

    const token = tokenFrom(mail.text);
    const reset = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { token, password: 'rusty-lantern-tide' },
    });
    assert.equal(reset.statusCode, 200, `setup refused: ${reset.body}`);

    // The new password works and the old one does not.
    const withNew = await app.inject({
      method: 'POST',
      url: '/api/session',
      payload: { email: `j.johnson@${OFFICE}`, password: 'rusty-lantern-tide' },
    });
    assert.equal(withNew.statusCode, 200);

    const withOld = await app.inject({
      method: 'POST',
      url: '/api/session',
      payload: { email: `j.johnson@${OFFICE}`, password: TEST_PASSWORD },
    });
    assert.equal(withOld.statusCode, 401);
  });

  test('an unknown address gets the same answer and no mail', async () => {
    const known = await app.inject({
      method: 'POST',
      url: '/api/password/forgot',
      payload: { email: `nobody@${OFFICE}` },
    });
    assert.equal(known.statusCode, 200);
    assert.deepEqual(known.json(), { ok: true });
    assert.equal(smtp.received.length, 0);
  });

  test('a reset link cannot be used twice', async () => {
    await makeUser('M.Smith', { email: `m.smith@${OFFICE}` });
    await app.inject({ method: 'POST', url: '/api/password/forgot', payload: { email: `m.smith@${OFFICE}` } });
    const token = tokenFrom((await smtp.next()).text);

    const first = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { token, password: 'quiet-harbour-ninety' },
    });
    assert.equal(first.statusCode, 200);

    const second = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { token, password: 'another-good-phrase' },
    });
    assert.equal(second.statusCode, 400);
  });

  test('a password cannot contain the person’s own address', async () => {
    await makeUser('K.Jones', { email: `k.jones@${OFFICE}` });
    await app.inject({ method: 'POST', url: '/api/password/forgot', payload: { email: `k.jones@${OFFICE}` } });
    const token = tokenFrom((await smtp.next()).text);

    for (const attempt of ['k.jones-is-great', 'my-betlive-password', 'jones-jones-jones']) {
      const response = await app.inject({ method: 'POST', url: '/api/setup', payload: { token, password: attempt } });
      assert.equal(response.statusCode, 400, `${attempt} should be refused`);
    }
  });
});

describe('transfer notifications', () => {
  test('a recipient is emailed that files are waiting, with the expiry', async () => {
    const sender = await makeUser('J.Johnson', { email: `j.johnson@${OFFICE}` });
    const recipient = await makeUser('A.Williams', { email: `a.williams@${OFFICE}` });

    const { makeTransfer } = await import('./helpers.js');
    const { notifyNewTransfer } = await import('../src/services/notify.js');
    const transfer = makeTransfer(sender.id, [recipient.id], { note: 'Board pack' });
    notifyNewTransfer(transfer, sender.name);

    const mail = await smtp.next();
    assert.deepEqual(mail.to, [`a.williams@${OFFICE}`]);
    assert.match(mail.text, /J\.Johnson sent you/);
    assert.match(mail.text, /Board pack/);
    assert.match(mail.text, /deleted/i, 'the expiry is the point of telling them');
  });

  test('sending still works when the relay is down', async () => {
    const sender = await makeUser('J.Johnson', { email: `j.johnson@${OFFICE}` });
    const recipient = await makeUser('A.Williams', { email: `a.williams@${OFFICE}` });

    const goodPort = config.smtpPort;
    config.smtpPort = 1; // nothing is listening here
    resetTransport();
    try {
      const { makeTransfer } = await import('./helpers.js');
      const { notifyNewTransfer } = await import('../src/services/notify.js');
      const transfer = makeTransfer(sender.id, [recipient.id]);
      // Must not throw, and must not block, with nothing listening.
      notifyNewTransfer(transfer, sender.name);
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.ok(transfer.id, 'the transfer must stand even though the email could not go out');
    } finally {
      config.smtpPort = goodPort;
      resetTransport();
    }
  });
});
