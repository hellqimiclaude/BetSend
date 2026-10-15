import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  blobFileExists,
  countRows,
  expireTransfer,
  makeBlob,
  makeTransfer,
  makeUser,
  resetState,
} from './helpers.js';
import { sweep } from '../src/services/cleanup.js';
import { getDb } from '../src/db/index.js';
import { findBlob } from '../src/repos/blobs.js';
import { getTransfer, markDownloaded, setState } from '../src/repos/transfers.js';
import { updateSettings } from '../src/services/settings.js';
import { paths } from '../src/config.js';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The sweeper deletes people's files on a timer. A bug here either loses a
 * transfer early or leaks disk forever, and neither is visible until somebody
 * complains — which is exactly why it is the most heavily tested part.
 */

let sender: Awaited<ReturnType<typeof makeUser>>;
let alice: Awaited<ReturnType<typeof makeUser>>;
let bob: Awaited<ReturnType<typeof makeUser>>;

beforeEach(async () => {
  resetState();
  updateSettings({ deleteAfterAllDownloaded: true });
  sender = await makeUser('J.Johnson');
  alice = await makeUser('A.Williams');
  bob = await makeUser('B.Brown');
});

describe('a live transfer is left alone', () => {
  test('nothing is deleted before expiry while a recipient has not downloaded', async () => {
    const blobId = makeBlob(sender.id);
    const transfer = makeTransfer(sender.id, [alice.id, bob.id], { blobIds: [blobId] });

    const result = await sweep();

    assert.equal(result.expired, 0);
    assert.equal(result.deletedBlobs, 0);
    assert.equal(getTransfer(transfer.id)?.state, 'active');
    assert.ok(blobFileExists(blobId), 'the file must still be on disk');
  });

  test('a partial download does not trigger deletion', async () => {
    const blobId = makeBlob(sender.id);
    const transfer = makeTransfer(sender.id, [alice.id, bob.id], { blobIds: [blobId] });

    markDownloaded(transfer.id, alice.id); // bob has not

    await sweep();

    assert.equal(getTransfer(transfer.id)?.state, 'active');
    assert.ok(blobFileExists(blobId), 'one of two downloads must not delete the file');
  });
});

describe('expiry', () => {
  test('a transfer past its deadline is expired and its bytes removed', async () => {
    const blobId = makeBlob(sender.id);
    const transfer = makeTransfer(sender.id, [alice.id], { blobIds: [blobId] });
    expireTransfer(transfer.id);

    const result = await sweep();

    assert.equal(result.expired, 1);
    assert.equal(getTransfer(transfer.id)?.state, 'expired');
    assert.equal(blobFileExists(blobId), false, 'an expired transfer must not leave bytes behind');
    assert.equal(findBlob(blobId)?.state, 'deleted');
  });

  test('retentionHours decides the deadline at creation time', () => {
    const before = Date.now();
    const transfer = makeTransfer(sender.id, [alice.id], { retentionHours: 5 });
    const expected = before + 5 * 3600_000;
    // Allow a second of slack for the clock between the two reads.
    assert.ok(Math.abs(transfer.expires_at - expected) < 1000, 'expiry should be creation + retention');
  });
});

describe('delete once everyone has downloaded', () => {
  test('completes and removes the bytes when the last recipient downloads', async () => {
    const blobId = makeBlob(sender.id);
    const transfer = makeTransfer(sender.id, [alice.id, bob.id], { blobIds: [blobId] });

    markDownloaded(transfer.id, alice.id);
    markDownloaded(transfer.id, bob.id);

    const result = await sweep();

    assert.equal(result.completed, 1);
    assert.equal(getTransfer(transfer.id)?.state, 'completed');
    assert.equal(blobFileExists(blobId), false);
  });

  test('the setting is honoured when switched off', async () => {
    updateSettings({ deleteAfterAllDownloaded: false });
    const blobId = makeBlob(sender.id);
    const transfer = makeTransfer(sender.id, [alice.id], { blobIds: [blobId] });

    markDownloaded(transfer.id, alice.id);
    await sweep();

    assert.equal(getTransfer(transfer.id)?.state, 'active', 'should wait for expiry instead');
    assert.ok(blobFileExists(blobId));
  });
});

describe('reference counting across a bulk send', () => {
  test('one blob shared by two transfers survives until both are finished', async () => {
    const blobId = makeBlob(sender.id);
    const first = makeTransfer(sender.id, [alice.id], { blobIds: [blobId] });
    const second = makeTransfer(sender.id, [bob.id], { blobIds: [blobId] });

    assert.equal(findBlob(blobId)?.ref_count, 2, 'both transfers hold a reference');

    expireTransfer(first.id);
    await sweep();

    assert.ok(blobFileExists(blobId), 'the second transfer still needs these bytes');
    assert.equal(findBlob(blobId)?.ref_count, 1);

    expireTransfer(second.id);
    await sweep();

    assert.equal(blobFileExists(blobId), false, 'the last reference is gone, so the bytes go');
  });

  test('a fan-out to many recipients stores the bytes once', () => {
    const blobId = makeBlob(sender.id, { bytes: 4096 });
    makeTransfer(sender.id, [alice.id, bob.id], { blobIds: [blobId] });

    assert.equal(countRows('blobs'), 1);
    assert.equal(countRows('recipients'), 2);
    assert.equal(findBlob(blobId)?.ref_count, 1, 'recipients do not each take a reference');
  });

  test('sweeping twice does not drive the count negative', async () => {
    const blobId = makeBlob(sender.id);
    const transfer = makeTransfer(sender.id, [alice.id], { blobIds: [blobId] });
    expireTransfer(transfer.id);

    await sweep();
    await sweep();
    await sweep();

    const blob = findBlob(blobId);
    assert.ok((blob?.ref_count ?? 0) >= 0, 'ref_count must never go negative');
    assert.equal(blob?.state, 'deleted');
  });

  test('releasing is idempotent, so purged_at is only set once', async () => {
    const transfer = makeTransfer(sender.id, [alice.id]);
    expireTransfer(transfer.id);

    await sweep();
    const firstPurge = getTransfer(transfer.id)?.purged_at;
    await sweep();
    const secondPurge = getTransfer(transfer.id)?.purged_at;

    assert.ok(firstPurge, 'purged_at should be stamped');
    assert.equal(firstPurge, secondPurge, 'a second sweep must not re-stamp it');
  });
});

describe('revoking', () => {
  test('a revoked transfer loses its bytes on the next sweep', async () => {
    const blobId = makeBlob(sender.id);
    const transfer = makeTransfer(sender.id, [alice.id], { blobIds: [blobId] });

    setState(transfer.id, 'revoked');
    await sweep();

    assert.equal(blobFileExists(blobId), false);
  });
});

describe('abandoned uploads', () => {
  test('a finished upload never attached to a transfer is swept after the window', async () => {
    const blobId = makeBlob(sender.id);
    assert.ok(blobFileExists(blobId));

    // Not committed, and older than orphanUploadHours.
    getDb()
      .prepare('UPDATE blobs SET created_at = ? WHERE id = ?')
      .run(Date.now() - 48 * 3600_000, blobId);

    await sweep();

    assert.equal(blobFileExists(blobId), false, 'abandoned uploads must not accumulate');
  });

  test('a recent uncommitted upload is left alone', async () => {
    const blobId = makeBlob(sender.id);
    await sweep();
    assert.ok(blobFileExists(blobId), 'an upload in progress must survive a sweep');
  });

  test('a file on disk with no database row is removed once it is old', async () => {
    fs.mkdirSync(paths.uploads, { recursive: true });
    const stray = path.join(paths.uploads, 'stray-file-from-a-crash');
    fs.writeFileSync(stray, 'orphan');
    const old = Date.now() - 48 * 3600_000;
    fs.utimesSync(stray, old / 1000, old / 1000);

    const result = await sweep();

    assert.equal(result.strayFiles, 1);
    assert.equal(fs.existsSync(stray), false);
  });

  test('in-flight upload rows are cleared once stale, freeing the quota', async () => {
    getDb()
      .prepare('INSERT INTO uploads (id, user_id, size, created_at) VALUES (?, ?, ?, ?)')
      .run('abandoned-upload', sender.id, 5000, Date.now() - 48 * 3600_000);

    const result = await sweep();

    assert.equal(result.staleUploads, 1);
    assert.equal(countRows('uploads'), 0);
  });
});
