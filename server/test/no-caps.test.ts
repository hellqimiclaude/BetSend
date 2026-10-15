import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeBlob, makeUser, resetState } from './helpers.js';
import { createTransfer, filesFor, getTransfer, recipientsFor } from '../src/repos/transfers.js';
import { buildTransferViews } from '../src/views.js';

/**
 * Neither the file count nor the note length is capped.
 *
 * The file count is the one with teeth: SQLite allows at most 32,766 host
 * parameters in a statement, so an `IN (...)` built from a transfer's files
 * has to be batched. Without that, removing the cap would turn a large
 * transfer into a 500 rather than into a large transfer.
 */

let sender: Awaited<ReturnType<typeof makeUser>>;
let recipient: Awaited<ReturnType<typeof makeUser>>;

beforeEach(async () => {
  resetState();
  sender = await makeUser('J.Johnson');
  recipient = await makeUser('A.Williams');
});

describe('no cap on files per transfer', () => {
  test('a transfer of 1,000 files round-trips', () => {
    const blobIds = Array.from({ length: 1000 }, (_, i) => makeBlob(sender.id, { name: `file-${i}.bin`, bytes: 8 }));

    const transfer = createTransfer({
      senderId: sender.id,
      blobIds,
      recipientIds: [recipient.id],
      note: null,
      retentionHours: 72,
    });

    assert.equal(transfer.file_count, 1000);
    assert.equal(filesFor([transfer.id]).length, 1000);

    const [view] = buildTransferViews([transfer], { includeRecipients: true, senderName: () => sender.name });
    assert.equal(view.files.length, 1000);
  });

  test('more transfer ids than SQLite allows parameters still reads back', () => {
    // The batching is on the id list, so this is the boundary that matters.
    // Only one transfer really exists; the rest are filler ids to force the
    // query past the 32,766 limit it would otherwise hit.
    const blobId = makeBlob(sender.id);
    const real = createTransfer({
      senderId: sender.id,
      blobIds: [blobId],
      recipientIds: [recipient.id],
      note: null,
      retentionHours: 72,
    });

    const ids = [real.id, ...Array.from({ length: 40_000 }, (_, i) => `absent-${i}`)];

    // Before batching this threw "too many SQL variables".
    assert.equal(filesFor(ids).length, 1);
    assert.equal(recipientsFor(ids).length, 1);
  });
});

describe('no cap on the note', () => {
  test('a note far longer than the old 500-character limit survives intact', () => {
    const note = 'Please review the attached. '.repeat(500); // ~14,000 characters
    const transfer = createTransfer({
      senderId: sender.id,
      blobIds: [makeBlob(sender.id)],
      recipientIds: [recipient.id],
      note,
      retentionHours: 72,
    });

    const stored = getTransfer(transfer.id)?.note ?? '';
    assert.equal(stored.length, note.length, 'the note must not be truncated');
    assert.equal(stored, note);
  });

  test('newlines and unicode in a note are preserved', () => {
    const note = 'Line one\nLine two\n\n— em dash, émoji 🎉, quote "x"';
    const transfer = createTransfer({
      senderId: sender.id,
      blobIds: [makeBlob(sender.id)],
      recipientIds: [recipient.id],
      note,
      retentionHours: 72,
    });
    assert.equal(getTransfer(transfer.id)?.note, note);
  });
});
