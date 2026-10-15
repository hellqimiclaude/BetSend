import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';
import { makeUser, resetState, TEST_PASSWORD } from './helpers.js';
import { countRows } from './helpers.js';

/**
 * tus and the download routes both call `reply.hijack()` and stream raw
 * sockets, which Fastify's `inject()` cannot model — so these run against a
 * real listening server.
 */

let app: FastifyInstance;
let base: string;

before(async () => {
  app = await buildApp();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await app.close();
});

beforeEach(() => resetState());

async function signIn(name: string): Promise<string> {
  const response = await fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, password: TEST_PASSWORD }),
  });
  assert.equal(response.status, 200, `sign-in for ${name} failed`);
  const setCookie = response.headers.getSetCookie().find((c) => c.startsWith('bs_session='));
  assert.ok(setCookie, 'expected a session cookie');
  return setCookie.split(';')[0];
}

const b64 = (value: string) => Buffer.from(value).toString('base64');

/** `Response.json()` is typed `unknown`; a test knows the shape it asked for. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asJson = (response: Response): Promise<any> => response.json() as Promise<any>;

async function createUpload(
  cookie: string | null,
  size: number,
  filename = 'test.bin',
): Promise<Response> {
  return fetch(`${base}/api/uploads`, {
    method: 'POST',
    headers: {
      'Tus-Resumable': '1.0.0',
      'Upload-Length': String(size),
      'Upload-Metadata': `filename ${b64(filename)}`,
      ...(cookie ? { Cookie: cookie } : {}),
    },
  });
}

async function patch(cookie: string | null, location: string, offset: number, body: Buffer): Promise<Response> {
  return fetch(`${base}${location}`, {
    method: 'PATCH',
    headers: {
      'Tus-Resumable': '1.0.0',
      'Upload-Offset': String(offset),
      'Content-Type': 'application/offset+octet-stream',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: new Uint8Array(body),
  });
}

describe('uploads require a session', () => {
  test('an anonymous create is refused and writes nothing', async () => {
    const response = await createUpload(null, 1024 * 1024);
    assert.equal(response.status, 401);
    assert.equal(countRows('uploads'), 0, 'no upload may be recorded for an anonymous caller');
  });

  test('an anonymous PATCH to a real upload is refused', async () => {
    await makeUser('J.Johnson');
    const cookie = await signIn('J.Johnson');
    const created = await createUpload(cookie, 16);
    const location = created.headers.get('location')!;

    const response = await patch(null, location, 0, Buffer.alloc(16, 1));
    assert.equal(response.status, 401);
  });

  test('a signed-in user can upload and commit', async () => {
    const sender = await makeUser('J.Johnson');
    await makeUser('A.Williams');
    const cookie = await signIn('J.Johnson');

    const bytes = Buffer.alloc(4096, 7);
    const created = await createUpload(cookie, bytes.length, 'report.pdf');
    assert.equal(created.status, 201);
    const location = created.headers.get('location')!;

    const written = await patch(cookie, location, 0, bytes);
    assert.equal(written.status, 204);

    const uploadId = location.split('/').pop()!;
    const commit = await fetch(`${base}/api/transfers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ uploads: [uploadId], recipients: ['A.Williams'], note: 'here you go' }),
    });

    assert.equal(commit.status, 200);
    const body = await asJson(commit);
    assert.equal(body.transfer.files[0].name, 'report.pdf');
    assert.equal(body.transfer.files[0].size, bytes.length);
    assert.equal(body.transfer.recipients.length, 1);
    assert.equal(countRows('uploads'), 0, 'committing releases the in-flight reservation');
    assert.ok(sender.id);
  });
});

describe('an upload belongs to the person who started it', () => {
  test('another signed-in user cannot inspect, append to, or cancel it', async () => {
    await makeUser('J.Johnson');
    await makeUser('K.Jones');
    const owner = await signIn('J.Johnson');
    const other = await signIn('K.Jones');

    const created = await createUpload(owner, 1024);
    const location = created.headers.get('location')!;

    for (const method of ['HEAD', 'DELETE'] as const) {
      const response = await fetch(`${base}${location}`, {
        method,
        headers: { 'Tus-Resumable': '1.0.0', Cookie: other },
      });
      assert.equal(response.status, 403, `${method} by a stranger should be refused`);
    }

    const appended = await patch(other, location, 0, Buffer.alloc(16, 2));
    assert.equal(appended.status, 403);

    // The owner is unaffected.
    const head = await fetch(`${base}${location}`, {
      method: 'HEAD',
      headers: { 'Tus-Resumable': '1.0.0', Cookie: owner },
    });
    assert.equal(head.status, 200);
  });
});

describe('resuming', () => {
  test('a half-finished upload continues from the acknowledged offset', async () => {
    await makeUser('J.Johnson');
    await makeUser('A.Williams');
    const cookie = await signIn('J.Johnson');

    const whole = Buffer.alloc(8192);
    for (let i = 0; i < whole.length; i++) whole[i] = i % 251;

    const created = await createUpload(cookie, whole.length);
    const location = created.headers.get('location')!;

    await patch(cookie, location, 0, whole.subarray(0, 3000));

    const head = await fetch(`${base}${location}`, {
      method: 'HEAD',
      headers: { 'Tus-Resumable': '1.0.0', Cookie: cookie },
    });
    assert.equal(head.headers.get('upload-offset'), '3000', 'the server must report where to resume');

    await patch(cookie, location, 3000, whole.subarray(3000));

    const uploadId = location.split('/').pop()!;
    const commit = await fetch(`${base}/api/transfers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ uploads: [uploadId], recipients: ['A.Williams'] }),
    });
    assert.equal(commit.status, 200);

    // Download it back and check the bytes survived the seam.
    const transfer = (await asJson(commit)).transfer;
    const recipient = await signIn('A.Williams');
    const download = await fetch(`${base}/api/transfers/${transfer.id}/files/${transfer.files[0].id}`, {
      headers: { Cookie: recipient },
    });
    const received = Buffer.from(await download.arrayBuffer());
    assert.deepEqual(received, whole, 'a resumed upload must reassemble byte for byte');
  });
});

describe('limits', () => {
  test('an upload that would exhaust the disk is refused', async () => {
    await makeUser('J.Johnson');
    const cookie = await signIn('J.Johnson');

    const original = config.minFreeDiskBytes;
    config.minFreeDiskBytes = Number.MAX_SAFE_INTEGER;
    try {
      const response = await createUpload(cookie, 1024);
      assert.equal(response.status, 413);
      assert.equal((await asJson(response)).error.code, 'disk_full');
    } finally {
      config.minFreeDiskBytes = original;
    }
  });

  test('the per-user quota counts only that user', async () => {
    await makeUser('J.Johnson');
    await makeUser('K.Jones');
    const mine = await signIn('J.Johnson');
    const theirs = await signIn('K.Jones');

    const original = config.perUserUploadBytes;
    config.perUserUploadBytes = 3000;
    try {
      assert.equal((await createUpload(mine, 2000)).status, 201);

      const overflow = await createUpload(mine, 2000);
      assert.equal(overflow.status, 413);
      assert.equal((await asJson(overflow)).error.code, 'quota_exceeded');

      assert.equal((await createUpload(theirs, 2000)).status, 201, 'one person must not block another');
    } finally {
      config.perUserUploadBytes = original;
    }
  });

  test('cancelling hands the quota back', async () => {
    await makeUser('J.Johnson');
    const cookie = await signIn('J.Johnson');

    const original = config.perUserUploadBytes;
    config.perUserUploadBytes = 3000;
    try {
      const created = await createUpload(cookie, 2000);
      const location = created.headers.get('location')!;

      assert.equal((await createUpload(cookie, 2000)).status, 413);

      const cancelled = await fetch(`${base}${location}`, {
        method: 'DELETE',
        headers: { 'Tus-Resumable': '1.0.0', Cookie: cookie },
      });
      assert.equal(cancelled.status, 204);

      assert.equal((await createUpload(cookie, 2000)).status, 201, 'the cancelled reservation should be released');
    } finally {
      config.perUserUploadBytes = original;
    }
  });
});

describe('downloads', () => {
  async function sendFile(bytes: Buffer): Promise<{ transfer: any; sender: string; recipient: string }> {
    await makeUser('J.Johnson');
    await makeUser('A.Williams');
    const sender = await signIn('J.Johnson');

    const created = await createUpload(sender, bytes.length, 'payload.bin');
    const location = created.headers.get('location')!;
    await patch(sender, location, 0, bytes);

    const commit = await fetch(`${base}/api/transfers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sender },
      body: JSON.stringify({ uploads: [location.split('/').pop()], recipients: ['A.Williams'] }),
    });
    const transfer = (await asJson(commit)).transfer;
    return { transfer, sender, recipient: await signIn('A.Williams') };
  }

  test('a file comes back whole, with the headers the browser needs', async () => {
    const bytes = Buffer.alloc(5000, 3);
    const { transfer, recipient } = await sendFile(bytes);

    const response = await fetch(`${base}/api/transfers/${transfer.id}/files/${transfer.files[0].id}`, {
      headers: { Cookie: recipient },
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-length'), String(bytes.length));
    assert.match(response.headers.get('content-disposition') ?? '', /payload\.bin/);
    assert.equal(response.headers.get('accept-ranges'), 'bytes');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  });

  test('a range request returns exactly that slice', async () => {
    const bytes = Buffer.alloc(5000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 253;
    const { transfer, recipient } = await sendFile(bytes);

    const response = await fetch(`${base}/api/transfers/${transfer.id}/files/${transfer.files[0].id}`, {
      headers: { Cookie: recipient, Range: 'bytes=1000-1999' },
    });

    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), `bytes 1000-1999/${bytes.length}`);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(1000, 2000));
  });

  test('an unsatisfiable range is rejected rather than served wrongly', async () => {
    const { transfer, recipient } = await sendFile(Buffer.alloc(100, 1));
    const response = await fetch(`${base}/api/transfers/${transfer.id}/files/${transfer.files[0].id}`, {
      headers: { Cookie: recipient, Range: 'bytes=9999-' },
    });
    assert.equal(response.status, 416);
  });

  test('a completed download is recorded for the sender to see', async () => {
    const { transfer, sender, recipient } = await sendFile(Buffer.alloc(256, 9));

    await fetch(`${base}/api/transfers/${transfer.id}/files/${transfer.files[0].id}`, {
      headers: { Cookie: recipient },
    }).then((r) => r.arrayBuffer());

    // The bookkeeping happens when the response finishes, just after the body.
    await new Promise((resolve) => setTimeout(resolve, 150));

    const sent = await fetch(`${base}/api/sent`, { headers: { Cookie: sender } }).then(asJson);
    assert.ok(sent.transfers[0].recipients[0].downloadedAt, 'the sender should see the download');
  });

  test('a partial download is not counted as received', async () => {
    const { transfer, sender, recipient } = await sendFile(Buffer.alloc(5000, 4));

    await fetch(`${base}/api/transfers/${transfer.id}/files/${transfer.files[0].id}`, {
      headers: { Cookie: recipient, Range: 'bytes=0-99' },
    }).then((r) => r.arrayBuffer());
    await new Promise((resolve) => setTimeout(resolve, 150));

    const sent = await fetch(`${base}/api/sent`, { headers: { Cookie: sender } }).then(asJson);
    assert.equal(sent.transfers[0].recipients[0].downloadedAt, null, 'a 100-byte range is not the whole file');
  });

  test('the zip contains every file', async () => {
    await makeUser('J.Johnson');
    await makeUser('A.Williams');
    const sender = await signIn('J.Johnson');

    const uploadIds: string[] = [];
    for (const name of ['one.txt', 'two.txt']) {
      const created = await createUpload(sender, 64, name);
      const location = created.headers.get('location')!;
      await patch(sender, location, 0, Buffer.alloc(64, name.charCodeAt(0)));
      uploadIds.push(location.split('/').pop()!);
    }

    const commit = await fetch(`${base}/api/transfers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sender },
      body: JSON.stringify({ uploads: uploadIds, recipients: ['A.Williams'] }),
    });
    const transfer = (await asJson(commit)).transfer;

    const recipient = await signIn('A.Williams');
    const zip = await fetch(`${base}/api/transfers/${transfer.id}/zip`, { headers: { Cookie: recipient } });
    assert.equal(zip.status, 200);

    const buffer = Buffer.from(await zip.arrayBuffer());
    assert.equal(buffer.subarray(0, 2).toString(), 'PK', 'should be a zip archive');
    assert.match(buffer.toString('latin1'), /one\.txt/);
    assert.match(buffer.toString('latin1'), /two\.txt/);
  });
});
