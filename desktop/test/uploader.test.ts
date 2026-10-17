import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageFiles } from '../src/staging.js';
import { describeUploadError, HostUploadBatch, summarise, uploadIdFromUrl } from '../src/uploader.js';

/**
 * The desktop uploader against a real BetSend server.
 *
 * Worth the trouble of starting one: this is a second implementation of the
 * upload protocol, living beside the browser's, and the only thing that can
 * show the two still agree is the server itself. A mock would agree with
 * whatever it was told.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let server: ChildProcess | null = null;
let origin = '';
let cookie = '';
let workDir = '';

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

before(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'betsend-uploader-'));
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;

  const configFile = path.join(workDir, 'config.json');
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      port,
      host: '127.0.0.1',
      storageDir: path.join(workDir, 'data'),
      adminToken: 'uploader-test-token',
      emailDomains: ['betlive.com'],
      logLevel: 'silent',
      minFreeDiskBytes: 0,
    }),
  );

  // Run from source: `npm test` happens before `npm run build` in CI, so
  // there is no server/dist to point at.
  server = spawn(
    process.execPath,
    ['--import', 'tsx', path.join(repoRoot, 'server', 'src', 'index.ts')],
    {
      cwd: repoRoot,
      env: { ...process.env, CONFIG_FILE: configFile, STORAGE_DIR: path.join(workDir, 'data') },
      stdio: 'ignore',
    },
  );

  await waitForHealth(origin);

  // First-run setup gives us an account and, more to the point, a cookie.
  const response = await fetch(`${origin}/api/first-run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      adminToken: 'uploader-test-token',
      email: 'j.johnson@betlive.com',
      password: 'spare-anchor-violet',
    }),
  });
  assert.equal(response.status, 200, await response.text());

  const setCookie = response.headers.getSetCookie?.() ?? [];
  const session = setCookie.find((c) => c.startsWith('bs_session='));
  assert.ok(session, 'the server did not set a session cookie');
  cookie = session.split(';')[0];
});

after(async () => {
  server?.kill();
  try {
    fs.rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

function makeFile(name: string, bytes: number): string {
  const full = path.join(workDir, name);
  // Random, so a server that silently truncated or reordered chunks would
  // not be covered for by a file of repeating bytes.
  fs.writeFileSync(full, crypto.randomBytes(bytes));
  return full;
}

describe('uploading from disk, the way a right-click does', () => {
  test('a file goes up and the server gives back an id', async () => {
    const { files } = stageFiles([makeFile('report.pdf', 3 * 1024 * 1024)]);
    const seen: number[] = [];

    const batch = new HostUploadBatch(files, {
      origin,
      cookie,
      chunkSize: 1024 * 1024,
      onProgress: (p) => seen.push(p.bytesUploaded),
    });

    const ids = await batch.start();

    assert.equal(ids.length, 1);
    assert.match(ids[0], /^[\w-]+$/);
    assert.equal(batch.progress.filesDone, 1);
    assert.equal(batch.progress.fraction, 1);
    assert.ok(seen.length > 1, 'progress should be reported as it goes, not only at the end');
    assert.ok(Math.max(...seen) === 3 * 1024 * 1024);
  });

  test('several files become one transfer the recipient can see', async () => {
    const { files } = stageFiles([makeFile('a.bin', 512 * 1024), makeFile('b.bin', 256 * 1024)]);
    const batch = new HostUploadBatch(files, { origin, cookie, chunkSize: 1024 * 1024 });
    const uploads = await batch.start();
    assert.equal(uploads.length, 2);

    // The same commit call the web app makes.
    const commit = await fetch(`${origin}/api/transfers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ uploads, recipients: ['J.Johnson'], note: 'from the right-click menu' }),
    });
    assert.equal(commit.status, 200, await commit.text());

    const sent = await (await fetch(`${origin}/api/sent`, { headers: { cookie } })).json();
    const transfer = sent.transfers[0];
    assert.equal(transfer.files.length, 2);
    assert.equal(transfer.note, 'from the right-click menu');
    assert.deepEqual(
      transfer.files.map((f: { name: string }) => f.name).sort(),
      ['a.bin', 'b.bin'],
    );
  });

  test('the bytes that arrive are the bytes that left', async () => {
    const source = makeFile('exact.bin', 1024 * 1024 + 7); // deliberately not a chunk multiple
    const original = fs.readFileSync(source);

    const { files } = stageFiles([source]);
    const uploads = await new HostUploadBatch(files, { origin, cookie, chunkSize: 256 * 1024 }).start();

    const commit = await fetch(`${origin}/api/transfers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ uploads, recipients: ['J.Johnson'] }),
    });
    const { transfer } = (await commit.json()) as { transfer: { id: string; files: { id: string }[] } };

    const download = await fetch(`${origin}/api/transfers/${transfer.id}/files/${transfer.files[0].id}`, {
      headers: { cookie },
    });
    assert.equal(download.status, 200);
    const received = Buffer.from(await download.arrayBuffer());

    assert.equal(received.length, original.length);
    assert.equal(
      crypto.createHash('sha256').update(received).digest('hex'),
      crypto.createHash('sha256').update(original).digest('hex'),
    );
  });

  test('an empty file still uploads', async () => {
    const { files } = stageFiles([makeFile('nothing.txt', 0)]);
    const ids = await new HostUploadBatch(files, { origin, cookie, chunkSize: 1024 * 1024 }).start();
    assert.equal(ids.length, 1);
  });

  test('without a session the server refuses, and the message says so', async () => {
    const { files } = stageFiles([makeFile('denied.bin', 64 * 1024)]);
    const batch = new HostUploadBatch(files, { origin, cookie: 'bs_session=not-a-real-session', chunkSize: 65536 });

    await assert.rejects(() => batch.start());
    assert.equal(batch.progress.files[0].status, 'error');
    assert.match(batch.progress.files[0].error ?? '', /signed out|refused/i);
  });
});

describe('helpers', () => {
  test('the upload id is the last segment of the tus URL', () => {
    assert.equal(uploadIdFromUrl('http://pc:8080/api/uploads/abc123'), 'abc123');
    assert.equal(uploadIdFromUrl('http://pc:8080/api/uploads/abc123/'), 'abc123');
    assert.equal(uploadIdFromUrl('http://pc:8080/api/uploads/abc123?x=1'), 'abc123');
    assert.equal(uploadIdFromUrl(null), null);
    assert.equal(uploadIdFromUrl(''), null);
  });

  test('progress of nothing is not a division by zero', () => {
    const progress = summarise([], false);
    assert.equal(progress.fraction, 0);
    assert.equal(progress.bytesTotal, 0);
  });

  test('the server’s own wording wins over a guess from the status code', () => {
    const error = Object.assign(new Error('failed'), {
      originalResponse: {
        getStatus: () => 413,
        getBody: () => JSON.stringify({ error: { message: 'That file is bigger than the 2 GB limit.' } }),
      },
    });
    assert.equal(describeUploadError(error as never), 'That file is bigger than the 2 GB limit.');
  });

  test('a body that is not JSON falls back to something readable', () => {
    const error = Object.assign(new Error('failed'), {
      originalResponse: { getStatus: () => 413, getBody: () => '<html>no</html>' },
    });
    assert.match(describeUploadError(error as never), /larger than the server allows/);
  });
});
