import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Outbox } from '../src/outbox.js';

let dir: string;
let outbox: Outbox;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'betsend-outbox-'));
  outbox = new Outbox();
});

function file(name: string, size = 4): string {
  const full = path.join(dir, name);
  fs.writeFileSync(full, Buffer.alloc(size));
  return full;
}

describe('files waiting to be sent', () => {
  test('adding, totalling and clearing', () => {
    outbox.add([file('a.bin', 100), file('b.bin', 200)]);
    assert.equal(outbox.files.length, 2);
    assert.equal(outbox.totalBytes, 300);

    outbox.clear();
    assert.equal(outbox.files.length, 0);
    assert.equal(outbox.totalBytes, 0);
  });

  /** Right-click the same file twice and it should be in the transfer once. */
  test('a file added twice appears once', () => {
    const a = file('a.bin');
    outbox.add([a]);
    outbox.add([a]);
    assert.equal(outbox.files.length, 1);
  });

  test('refusals come back so the user can be told', () => {
    const { skipped } = outbox.add([path.join(dir, 'ghost.bin')]);
    assert.equal(outbox.files.length, 0);
    assert.match(skipped[0].reason, /could not be found/);
  });

  test('removing by id, and removing something that is not there', () => {
    outbox.add([file('a.bin'), file('b.bin')]);
    const [first] = outbox.files;
    assert.equal(outbox.remove(first.id), true);
    assert.equal(outbox.files.length, 1);
    assert.equal(outbox.remove('nope'), false);
  });

  /**
   * The window shows a page served by the office server. Where a file sits on
   * somebody's hard disk is not something that page needs, so it never
   * crosses the bridge.
   */
  test('the renderer is given names and sizes, never paths', () => {
    outbox.add([file('payslip.pdf', 10)]);
    const view = outbox.forRenderer();

    assert.deepEqual(Object.keys(view[0]).sort(), ['id', 'name', 'size']);
    assert.equal(JSON.stringify(view).includes(dir), false, 'a local path reached the renderer');
  });
});
