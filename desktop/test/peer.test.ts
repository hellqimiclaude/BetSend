import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PeerReceiver, type ClaimResult } from '../src/peer/receiver.js';
import { sendDirect, type SendableFile } from '../src/peer/sender.js';
import { encodeLine, safeFilename, uniqueFilename } from '../src/peer/protocol.js';

/**
 * Two BetSend apps talking to each other over a real socket.
 *
 * This is a listening port on somebody's PC on an office network, so a good
 * half of what follows is about what happens when whoever connects is not a
 * colleague being helpful.
 */

let dir: string;
let inbox: string;
let receiver: PeerReceiver | null = null;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'betsend-peer-'));
  inbox = path.join(dir, 'inbox');
});

afterEach(async () => {
  await receiver?.close();
  receiver = null;
});

function makeFile(name: string, bytes: number): SendableFile {
  const full = path.join(dir, name);
  fs.writeFileSync(full, crypto.randomBytes(bytes));
  return { path: full, name, size: bytes };
}

/** A receiver whose "ask the server" step is stubbed. */
async function startReceiver(
  claim: (token: string) => Promise<ClaimResult | null>,
  hooks: {
    onFailed?: (reason: string) => void;
    onFinished?: (r: { files: string[] }) => void;
    onProgress?: (p: { from: string; name: string; received: number; total: number }) => void;
  } = {},
): Promise<number> {
  const completed: { token: string; ok: boolean }[] = [];
  receiver = new PeerReceiver({
    destination: inbox,
    claim,
    complete: async (token, ok) => void completed.push({ token, ok }),
    ...hooks,
  });
  return receiver.listen(0);
}

const GOOD_TOKEN = 'a-token-the-server-issued';

function claimFor(files: SendableFile[]): (token: string) => Promise<ClaimResult | null> {
  return async (token) =>
    token === GOOD_TOKEN
      ? { from: 'J.Johnson', files: files.map((f) => ({ name: f.name, size: f.size })), note: 'here you go' }
      : null;
}

describe('sending a file straight to another machine', () => {
  test('it arrives, byte for byte', async () => {
    const file = makeFile('report.pdf', 3 * 1024 * 1024 + 17);
    const port = await startReceiver(claimFor([file]));

    const result = await sendDirect({ host: '127.0.0.1', port, token: GOOD_TOKEN, files: [file] });

    assert.equal(result.bytesSent, file.size);
    const landed = path.join(inbox, 'report.pdf');
    assert.ok(fs.existsSync(landed));
    assert.equal(
      crypto.createHash('sha256').update(fs.readFileSync(landed)).digest('hex'),
      crypto.createHash('sha256').update(fs.readFileSync(file.path)).digest('hex'),
    );
  });

  test('several files in one connection', async () => {
    const files = [makeFile('a.bin', 200_000), makeFile('b.bin', 50_000), makeFile('c.bin', 1)];
    const port = await startReceiver(claimFor(files));

    await sendDirect({ host: '127.0.0.1', port, token: GOOD_TOKEN, files });

    assert.deepEqual(fs.readdirSync(inbox).sort(), ['a.bin', 'b.bin', 'c.bin']);
    for (const file of files) {
      assert.equal(fs.statSync(path.join(inbox, file.name)).size, file.size);
    }
  });

  test('an empty file still arrives', async () => {
    const file = makeFile('nothing.txt', 0);
    const port = await startReceiver(claimFor([file]));

    await sendDirect({ host: '127.0.0.1', port, token: GOOD_TOKEN, files: [file] });
    assert.equal(fs.statSync(path.join(inbox, 'nothing.txt')).size, 0);
  });

  test('progress is reported as it goes, not only at the end', async () => {
    const file = makeFile('big.bin', 4 * 1024 * 1024);
    const port = await startReceiver(claimFor([file]));

    const seen: number[] = [];
    await sendDirect({
      host: '127.0.0.1',
      port,
      token: GOOD_TOKEN,
      files: [file],
      onProgress: (p) => seen.push(p.totalSent),
    });

    assert.ok(seen.length > 1, 'expected several progress reports');
    assert.equal(seen[seen.length - 1], file.size);
  });

  /**
   * The receiving end has no page to report to: nobody asked for this file
   * and there may be no window open. Without progress out here, a four
   * gigabyte transfer is several silent minutes and then a notification.
   */
  test('the recipient is told how far along an arriving file is', async () => {
    const file = makeFile('big.bin', 4 * 1024 * 1024);
    const seen: { name: string; received: number; total: number; from: string }[] = [];
    const port = await startReceiver(claimFor([file]), { onProgress: (p) => seen.push(p) });

    await sendDirect({ host: '127.0.0.1', port, token: GOOD_TOKEN, files: [file] });

    assert.ok(seen.length > 1, 'expected progress as it arrived, not once at the end');
    assert.equal(seen[seen.length - 1].received, file.size);
    assert.equal(seen[0].total, file.size);
    assert.equal(seen[0].name, 'big.bin');
    // Who it is from, so the tray can say so without a second lookup.
    assert.equal(seen[0].from, 'J.Johnson');
    // Never more than was promised, or a percentage would read over 100.
    assert.ok(seen.every((p) => p.received <= p.total));
  });

  test('an existing file is not overwritten', async () => {
    const file = makeFile('report.pdf', 1000);
    fs.mkdirSync(inbox, { recursive: true });
    fs.writeFileSync(path.join(inbox, 'report.pdf'), 'something that was already here');

    const port = await startReceiver(claimFor([file]));
    await sendDirect({ host: '127.0.0.1', port, token: GOOD_TOKEN, files: [file] });

    assert.equal(fs.readFileSync(path.join(inbox, 'report.pdf'), 'utf8'), 'something that was already here');
    assert.equal(fs.statSync(path.join(inbox, 'report (2).pdf')).size, 1000);
  });
});

describe('what a connection without a valid token gets', () => {
  test('a refused token means nothing is written', async () => {
    const file = makeFile('report.pdf', 1000);
    const port = await startReceiver(claimFor([file]));

    await assert.rejects(
      () => sendDirect({ host: '127.0.0.1', port, token: 'not-the-token', files: [file] }),
      /not for me/i,
    );
    assert.equal(fs.existsSync(inbox) && fs.readdirSync(inbox).length > 0, false);
  });

  /** Somebody scanning the network finds an open port and pokes it. */
  test('a connection that is not BetSend at all is hung up on', async () => {
    const port = await startReceiver(claimFor([]));

    const reply = await rawExchange(port, 'GET / HTTP/1.1\r\n\r\n');
    assert.match(reply, /not a BetSend sender|^$/);
    assert.equal(fs.existsSync(inbox) && fs.readdirSync(inbox).length > 0, false);
  });

  test('a wrong protocol version is refused', async () => {
    const port = await startReceiver(claimFor([]));
    const reply = await rawExchange(port, JSON.stringify({ v: 99, token: GOOD_TOKEN }) + '\n');
    assert.match(reply, /not a BetSend sender/);
  });

  /**
   * The server said one file was coming. A sender that then tries to push a
   * second does not get to -- otherwise the token would be a licence to
   * write anything at all onto a colleague's disk.
   */
  test('a file the server did not promise is refused', async () => {
    const promised = makeFile('expected.bin', 100);
    const sneaky = makeFile('surprise.exe', 100);
    const port = await startReceiver(claimFor([promised]));

    await assert.rejects(
      () => sendDirect({ host: '127.0.0.1', port, token: GOOD_TOKEN, files: [sneaky] }),
      /was not part of this transfer/,
    );
    assert.equal(fs.existsSync(path.join(inbox, 'surprise.exe')), false);
  });

  test('a file bigger than promised is refused', async () => {
    const file = makeFile('report.pdf', 1000);
    const port = await startReceiver(async () => ({
      from: 'J.Johnson',
      files: [{ name: 'report.pdf', size: 10 }],
      note: '',
    }));

    await assert.rejects(
      () => sendDirect({ host: '127.0.0.1', port, token: GOOD_TOKEN, files: [file] }),
      /not the size promised/,
    );
  });
});

describe('when it goes wrong', () => {
  test('a half-finished transfer leaves nothing that looks finished', async () => {
    const file = makeFile('report.pdf', 8 * 1024 * 1024);
    const port = await startReceiver(claimFor([file]));

    // Hang up partway through, as a laptop lid closing would.
    const socket = net.createConnection({ host: '127.0.0.1', port });
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    socket.write(encodeLine({ v: 1, token: GOOD_TOKEN }));
    await new Promise<void>((resolve) => socket.once('data', () => resolve()));
    socket.write(encodeLine({ name: 'report.pdf', size: file.size }));
    socket.write(crypto.randomBytes(1024 * 1024));
    await new Promise((r) => setTimeout(r, 300));
    socket.destroy();
    await new Promise((r) => setTimeout(r, 500));

    const left = fs.existsSync(inbox) ? fs.readdirSync(inbox) : [];
    assert.deepEqual(left.filter((f) => !f.endsWith('.part')), [], 'a partial file was left looking complete');
  });

  test('corrupted bytes are caught and the file is discarded', async () => {
    const port = await startReceiver(async () => ({
      from: 'J.Johnson',
      files: [{ name: 'report.pdf', size: 16 }],
      note: '',
    }));

    const socket = net.createConnection({ host: '127.0.0.1', port });
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    socket.write(encodeLine({ v: 1, token: GOOD_TOKEN }));
    await new Promise<void>((resolve) => socket.once('data', () => resolve()));

    socket.write(encodeLine({ name: 'report.pdf', size: 16 }));
    socket.write(Buffer.alloc(16, 1));
    // A hash that does not match what was actually sent.
    socket.write(encodeLine({ sha256: 'f'.repeat(64) }));

    const reply = await readOnce(socket);
    socket.destroy();

    assert.match(reply, /corrupted/);
    assert.equal(fs.existsSync(path.join(inbox, 'report.pdf')), false);
  });

  test('connecting to nothing fails with something readable', async () => {
    const file = makeFile('report.pdf', 10);
    await assert.rejects(
      () => sendDirect({ host: '127.0.0.1', port: 9, token: GOOD_TOKEN, files: [file], connectTimeoutMs: 1500 }),
      (err: Error) => /ECONNREFUSED|did not answer/i.test(err.message),
    );
  });
});

describe('filenames arriving from another machine', () => {
  test('a path is reduced to its last component', () => {
    assert.equal(safeFilename('C:\\Windows\\System32\\evil.dll'), 'evil.dll');
    assert.equal(safeFilename('../../../etc/passwd'), 'passwd');
    assert.equal(safeFilename('/etc/shadow'), 'shadow');
  });

  test('names Windows reserves are defused', () => {
    assert.equal(safeFilename('CON'), '_CON');
    assert.equal(safeFilename('nul.txt'), '_nul.txt');
    assert.equal(safeFilename('COM1.pdf'), '_COM1.pdf');
  });

  test('a trailing dot or space, which Windows silently drops, is removed', () => {
    assert.equal(safeFilename('report.pdf.'), 'report.pdf');
    assert.equal(safeFilename('report.pdf '), 'report.pdf');
  });

  test('characters that are not legal in a filename are replaced', () => {
    assert.equal(safeFilename('a<b>c:d"e|f?g*h.txt'), 'a_b_c_d_e_f_g_h.txt');
  });

  test('an empty or dots-only name still produces something', () => {
    assert.equal(safeFilename(''), 'file');
    assert.equal(safeFilename('...'), 'file');
    assert.equal(safeFilename('   '), 'file');
  });

  test('an absurdly long name is cut short', () => {
    assert.ok(safeFilename('x'.repeat(5000)).length <= 200);
  });

  test('ordinary names are left alone', () => {
    assert.equal(safeFilename('Quarterly Report 2026.xlsx'), 'Quarterly Report 2026.xlsx');
    assert.equal(safeFilename('ანგარიში.pdf'), 'ანგარიში.pdf');
  });

  test('collisions are numbered the way Windows numbers them', () => {
    const taken = new Set(['/d/report.pdf', '/d/report (2).pdf']);
    assert.equal(uniqueFilename('/d', 'report.pdf', (f) => taken.has(f.replace(/\\/g, '/'))), 'report (3).pdf');
  });
});

/** Send a raw string, read whatever comes back, give up quickly. */
async function rawExchange(port: number, payload: string): Promise<string> {
  const socket = net.createConnection({ host: '127.0.0.1', port });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', reject);
  });
  socket.write(payload);
  const reply = await readOnce(socket);
  socket.destroy();
  return reply;
}

function readOnce(socket: net.Socket): Promise<string> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(''), 3000);
    socket.once('data', (chunk: Buffer) => {
      clearTimeout(timer);
      resolve(chunk.toString('utf8'));
    });
    socket.once('close', () => {
      clearTimeout(timer);
      resolve('');
    });
  });
}
