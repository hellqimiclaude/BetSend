import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkResumable,
  clearPending,
  fingerprintFor,
  readPending,
  writePending,
  type PendingSend,
} from '../src/pending.js';

let dir: string;
let store: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'betsend-pending-'));
  store = path.join(dir, 'pending.json');
});

function realFile(name: string, size = 100): string {
  const full = path.join(dir, name);
  fs.writeFileSync(full, Buffer.alloc(size));
  return full;
}

function sendFor(files: string[]): PendingSend {
  return {
    files: files.map((file, i) => {
      const stats = fs.statSync(file);
      return {
        id: `p${i}`,
        path: file,
        name: path.basename(file),
        size: stats.size,
        fingerprint: fingerprintFor(file, stats.size, stats.mtimeMs),
      };
    }),
    recipients: ['M.Beridze'],
    note: 'here you go',
    startedAt: Date.now(),
  };
}

describe('remembering a transfer across a restart', () => {
  test('a round trip', () => {
    const send = sendFor([realFile('a.bin'), realFile('b.bin')]);
    writePending(store, send);
    assert.deepEqual(readPending(store), send);
  });

  test('clearing it', () => {
    writePending(store, sendFor([realFile('a.bin')]));
    clearPending(store);
    assert.equal(readPending(store), null);
    assert.doesNotThrow(() => clearPending(store), 'clearing twice is not an error');
  });

  describe('a damaged record is dropped, never half-used', () => {
    test('missing', () => assert.equal(readPending(path.join(dir, 'nope.json')), null));

    test('not JSON', () => {
      fs.writeFileSync(store, '{ broken');
      assert.equal(readPending(store), null);
    });

    /** Resuming a transfer addressed to nobody would upload for nothing. */
    test('no recipients', () => {
      fs.writeFileSync(store, JSON.stringify({ files: [{ path: '/a', name: 'a', size: 1 }], recipients: [] }));
      assert.equal(readPending(store), null);
    });

    test('no files', () => {
      fs.writeFileSync(store, JSON.stringify({ files: [], recipients: ['M.Beridze'] }));
      assert.equal(readPending(store), null);
    });

    test('a bad entry is dropped but the good ones survive', () => {
      fs.writeFileSync(
        store,
        JSON.stringify({
          files: [{ path: '/a', name: 'a.bin', size: 10, fingerprint: 'x' }, { name: 'no path' }, 'nonsense'],
          recipients: ['M.Beridze'],
        }),
      );
      const send = readPending(store);
      assert.equal(send?.files.length, 1);
      assert.equal(send?.files[0].name, 'a.bin');
    });
  });
});

describe('deciding what can still be resumed', () => {
  test('an untouched file can', () => {
    const send = sendFor([realFile('a.bin')]);
    const { resumable, gone } = checkResumable(send);
    assert.equal(resumable.length, 1);
    assert.equal(gone.length, 0);
  });

  test('a deleted file cannot, and says so', () => {
    const file = realFile('a.bin');
    const send = sendFor([file]);
    fs.rmSync(file);

    const { resumable, gone } = checkResumable(send);
    assert.equal(resumable.length, 0);
    assert.match(gone[0].reason, /no longer where it was/);
  });

  /**
   * The one that matters. The server already holds the first half of the old
   * file; finishing it with the new one would hand the recipient a file that
   * never existed on anybody's disk.
   */
  test('a file edited while the app was off cannot be resumed', () => {
    const file = realFile('a.bin', 100);
    const send = sendFor([file]);

    fs.writeFileSync(file, Buffer.alloc(250));
    const { resumable, gone } = checkResumable(send);

    assert.equal(resumable.length, 0);
    assert.match(gone[0].reason, /changed since/);
  });

  test('a file touched but not changed is caught too, since mtime moved', () => {
    const file = realFile('a.bin', 100);
    const send = sendFor([file]);

    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(file, later, later);

    assert.equal(checkResumable(send).resumable.length, 0);
  });

  test('the good files come back when one of several is gone', () => {
    const keep = realFile('keep.bin');
    const lose = realFile('lose.bin');
    const send = sendFor([keep, lose]);
    fs.rmSync(lose);

    const { resumable, gone } = checkResumable(send);
    assert.deepEqual(resumable.map((f) => f.name), ['keep.bin']);
    assert.equal(gone.length, 1);
  });
});

describe('fingerprints', () => {
  test('the same file gives the same answer twice', () => {
    assert.equal(fingerprintFor('/a/b.bin', 100, 1000), fingerprintFor('/a/b.bin', 100, 1000));
  });

  test('size, time and path each change it', () => {
    const base = fingerprintFor('/a/b.bin', 100, 1000);
    assert.notEqual(base, fingerprintFor('/a/b.bin', 101, 1000));
    assert.notEqual(base, fingerprintFor('/a/b.bin', 100, 2000));
    assert.notEqual(base, fingerprintFor('/a/c.bin', 100, 1000));
  });

  /** Windows hands the same file over in whatever case it feels like. */
  test('case in the path does not change it', () => {
    assert.equal(fingerprintFor('C:\\Docs\\A.BIN', 100, 1000), fingerprintFor('c:\\docs\\a.bin', 100, 1000));
  });

  test('sub-millisecond jitter in mtime does not change it', () => {
    assert.equal(fingerprintFor('/a/b.bin', 100, 1000.4), fingerprintFor('/a/b.bin', 100, 1000.9));
  });
});
