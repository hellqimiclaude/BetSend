import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deliver } from '../src/peer/deliver.js';
import { PeerLink } from '../src/peer/link.js';
import { PeerReceiver } from '../src/peer/receiver.js';
import { sendDirect, type SendableFile } from '../src/peer/sender.js';

/**
 * Two signed-in people, one real server, and a file that never touches it.
 *
 * The socket tests prove the two halves of the wire protocol agree with
 * each other, which they would even if both were wrong about what the
 * server says. This is the one that cannot be fooled: the token comes from
 * the real broker, the address comes from the real announce, and the file
 * lands on a real disk.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ADMIN_TOKEN = 'peer-link-test-token';
const PASSWORD = 'spare-anchor-violet';

let server: ChildProcess | null = null;
let origin = '';
let workDir = '';
/** J.Johnson, who sends. */
let alice: PeerLink;
/** K.Kelly, who receives. */
let bob: PeerLink;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function waitForHealth(url: string, attempts = 60): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`the test server never answered at ${url}`);
}

/**
 * Status check and body in one go.
 *
 * `assert.equal(r.status, 200, await r.text())` is a trap: the message is
 * evaluated whether or not the assertion fails, so the body is gone by the
 * time anything wants to read it.
 */
async function expectOk(response: Response): Promise<string> {
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return text;
}

function cookieFrom(response: Response): string {
  const session = (response.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('bs_session='));
  assert.ok(session, 'the server did not set a session cookie');
  return session.split(';')[0];
}

before(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'betsend-peer-link-'));
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;

  const configFile = path.join(workDir, 'config.json');
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      port,
      host: '127.0.0.1',
      storageDir: path.join(workDir, 'data'),
      adminToken: ADMIN_TOKEN,
      emailDomains: ['betlive.com'],
      logLevel: 'silent',
      minFreeDiskBytes: 0,
    }),
  );

  server = spawn(process.execPath, ['--import', 'tsx', path.join(repoRoot, 'server', 'src', 'index.ts')], {
    cwd: repoRoot,
    env: { ...process.env, CONFIG_FILE: configFile, STORAGE_DIR: path.join(workDir, 'data') },
    stdio: 'ignore',
  });
  await waitForHealth(origin);

  const first = await fetch(`${origin}/api/first-run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ adminToken: ADMIN_TOKEN, email: 'j.johnson@betlive.com', password: PASSWORD }),
  });
  await expectOk(first);
  const aliceCookie = cookieFrom(first);
  alice = new PeerLink(origin, aliceCookie);

  // A colleague to send to, set up the way an administrator would.
  const imported = await fetch(`${origin}/api/admin/users/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: aliceCookie },
    body: JSON.stringify({ text: 'k.kelly@betlive.com' }),
  });
  await expectOk(imported);

  const linkResponse = await fetch(`${origin}/api/admin/users/K.Kelly/setup-link`, {
    method: 'POST',
    headers: { cookie: aliceCookie },
  });
  const { link } = JSON.parse(await expectOk(linkResponse)) as { link: string };
  const token = /token=([^&]+)/.exec(link)?.[1];
  assert.ok(token, `no setup token in ${link}`);

  const setup = await fetch(`${origin}/api/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: decodeURIComponent(token), password: PASSWORD }),
  });
  await expectOk(setup);
  bob = new PeerLink(origin, cookieFrom(setup));
});

after(async () => {
  server?.kill();
  try {
    fs.rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

function makeFile(name: string, bytes: number): SendableFile {
  const full = path.join(workDir, name);
  fs.writeFileSync(full, crypto.randomBytes(bytes));
  return { path: full, name, size: bytes };
}

/** Bob's app: listening, and checking tokens with the real server. */
async function bobListens(inbox: string): Promise<{ receiver: PeerReceiver; port: number }> {
  const receiver = new PeerReceiver({
    destination: inbox,
    claim: (token) => bob.claim(token),
    complete: (token, ok) => bob.complete(token, ok),
  });
  const port = await receiver.listen(0);
  await bob.announce(port);
  return { receiver, port };
}

describe('two apps and a real server', () => {
  test('a file goes from one machine to the other and never through the server', async () => {
    const inbox = path.join(workDir, 'inbox-1');
    const { receiver } = await bobListens(inbox);

    try {
      const file = makeFile('report-1.pdf', 2 * 1024 * 1024 + 11);
      const offer = await alice.offer(['K.Kelly'], [{ name: file.name, size: file.size }], 'for review');

      assert.deepEqual(offer.unreachable, []);
      assert.equal(offer.ready.length, 1);
      assert.equal(offer.ready[0].name, 'K.Kelly');

      await sendDirect({ ...offer.ready[0], files: [file] });

      assert.equal(
        crypto.createHash('sha256').update(fs.readFileSync(path.join(inbox, 'report-1.pdf'))).digest('hex'),
        crypto.createHash('sha256').update(fs.readFileSync(file.path)).digest('hex'),
      );

      // Nothing was uploaded, so the server's storage holds no copy of it.
      const stored = fs.readdirSync(path.join(workDir, 'data'), { recursive: true }) as string[];
      assert.equal(
        stored.some((entry) => String(entry).includes('report-1')),
        false,
        'the server kept a copy of a transfer it was only supposed to broker',
      );
    } finally {
      await receiver.close();
      await bob.unannounce();
    }
  });

  test('somebody with no app running is unreachable, not an error', async () => {
    const offer = await alice.offer(['K.Kelly'], [{ name: 'x.bin', size: 10 }], '');
    assert.deepEqual(offer.ready, []);
    assert.deepEqual(offer.unreachable, ['K.Kelly']);
  });

  test('the chooser can ask who is available without minting a token', async () => {
    assert.equal(await alice.canTakeDirect('K.Kelly'), false);

    const inbox = path.join(workDir, 'inbox-2');
    const { receiver } = await bobListens(inbox);
    try {
      assert.equal(await alice.canTakeDirect('K.Kelly'), true);
      assert.equal(await alice.canTakeDirect('Nobody.AtAll'), false);
    } finally {
      await receiver.close();
      await bob.unannounce();
    }
  });

  /**
   * The token is the whole security model: it is what tells a recipient's
   * app that the machine connecting to it is a colleague and not whoever
   * found the port. One use, one recipient.
   */
  test('a token cannot be used twice', async () => {
    const file = makeFile('report-2.pdf', 1024);
    const offer = await alice.offer(['K.Kelly'], [{ name: file.name, size: file.size }], '');
    const { token } = offer.ready[0] ?? { token: '' };

    const inbox = path.join(workDir, 'inbox-3');
    const { receiver } = await bobListens(inbox);
    try {
      const fresh = await alice.offer(['K.Kelly'], [{ name: file.name, size: file.size }], '');
      assert.ok(await bob.claim(fresh.ready[0].token));
      assert.equal(await bob.claim(fresh.ready[0].token), null, 'the same token worked a second time');
      assert.equal(await bob.claim(token || 'never-issued'), null);
    } finally {
      await receiver.close();
      await bob.unannounce();
    }
  });

  test('a token issued for one person is no use to another', async () => {
    const inbox = path.join(workDir, 'inbox-4');
    const { receiver } = await bobListens(inbox);
    try {
      const offer = await alice.offer(['K.Kelly'], [{ name: 'x.bin', size: 10 }], '');
      // Alice presenting the token she was given for Kelly.
      assert.equal(await alice.claim(offer.ready[0].token), null);
    } finally {
      await receiver.close();
      await bob.unannounce();
    }
  });
});

/**
 * A listening port that forwards to `target` and then stops, as a switch
 * dropping a link would. Nothing is wrong with either end afterwards --
 * the connection simply went away mid-file.
 */
async function severedAfter(
  target: number,
  bytes: number,
): Promise<{ relayPort: number; close: () => Promise<void> }> {
  const live = new Set<net.Socket>();

  const relay = net.createServer((inbound) => {
    const outbound = net.createConnection({ host: '127.0.0.1', port: target });
    live.add(inbound).add(outbound);

    let passed = 0;
    const cut = (): void => {
      inbound.destroy();
      outbound.destroy();
    };

    inbound.on('data', (chunk: Buffer) => {
      passed += chunk.length;
      outbound.write(chunk);
      if (passed > bytes) cut();
    });
    outbound.on('data', (chunk: Buffer) => inbound.write(chunk));
    inbound.on('error', cut);
    outbound.on('error', cut);
    inbound.on('close', cut);
    outbound.on('close', cut);
  });

  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', () => resolve()));
  const address = relay.address();

  return {
    relayPort: typeof address === 'object' && address ? address.port : 0,
    close: async () => {
      for (const socket of live) socket.destroy();
      await new Promise<void>((resolve) => relay.close(() => resolve()));
    },
  };
}

describe('the whole decision, end to end', () => {
  test('direct when the app is running, the server when it is not', async () => {
    const inbox = path.join(workDir, 'inbox-5');
    const file = makeFile('report-3.pdf', 512 * 1024);

    const servered: string[][] = [];
    const run = (): ReturnType<typeof deliver> =>
      deliver({
        route: 'direct',
        recipients: ['K.Kelly'],
        files: [file],
        note: '',
        offer: (to, files, note) => alice.offer(to, files, note),
        direct: (target, files) =>
          sendDirect({ ...target, files }).then((r) => ({
            bytes: r.bytesSent,
            milliseconds: r.milliseconds,
          })),
        viaServer: async (to) => {
          servered.push(to);
          return { bytes: file.size, milliseconds: 1 };
        },
      });

    const { receiver } = await bobListens(inbox);
    try {
      const first = await run();
      assert.deepEqual(first.direct, ['K.Kelly']);
      assert.deepEqual(servered, []);
      assert.ok(fs.existsSync(path.join(inbox, 'report-3.pdf')));
    } finally {
      await receiver.close();
      await bob.unannounce();
    }

    // Kelly closes the app. The same request now goes the long way.
    const second = await run();
    assert.deepEqual(second.direct, []);
    assert.deepEqual(second.viaServer, ['K.Kelly']);
    assert.deepEqual(servered, [['K.Kelly']]);
  });

  /** The case the whole fallback exists for: it breaks after it has started. */
  test('a recipient that dies mid-transfer is picked up by the server', async () => {
    const inbox = path.join(workDir, 'inbox-6');
    const file = makeFile('report-4.pdf', 6 * 1024 * 1024);

    const { receiver, port } = await bobListens(inbox);
    // Everything reaches Kelly's app through here, and stops reaching it
    // after a megabyte. A timer would not do: on loopback six megabytes
    // are gone before any timer this test could set would fire, and the
    // fallback would never be exercised at all.
    const { relayPort, close: closeRelay } = await severedAfter(port, 1024 * 1024);
    await bob.announce(relayPort);

    const servered: string[][] = [];
    const report = await deliver({
      route: 'direct',
      recipients: ['K.Kelly'],
      files: [file],
      note: '',
      offer: (to, files, note) => alice.offer(to, files, note),
      direct: (target, files) =>
        sendDirect({ ...target, files }).then((r) => ({
          bytes: r.bytesSent,
          milliseconds: r.milliseconds,
        })),
      viaServer: async (to) => {
        servered.push(to);
        return { bytes: file.size, milliseconds: 1 };
      },
    });

    await closeRelay();
    await receiver.close();
    await bob.unannounce();

    assert.deepEqual(report.direct, [], 'the transfer cannot have succeeded: it was cut');
    assert.deepEqual(report.viaServer, ['K.Kelly']);
    assert.equal(report.fellBack.length, 1);
    assert.deepEqual(servered, [['K.Kelly']]);
    assert.equal(
      fs.existsSync(path.join(inbox, 'report-4.pdf')),
      false,
      'a half-written file was left looking complete',
    );
  });
});
