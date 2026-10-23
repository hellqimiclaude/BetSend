import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  bytesPerSecond,
  describeSeconds,
  EMPTY,
  estimateSeconds,
  readHistory,
  record,
  writeHistory,
  type History,
} from '../src/throughput.js';

const MB = 1024 * 1024;

/** A transfer of `mb` megabytes that took `seconds`. */
function ran(mb: number, seconds: number): { bytes: number; milliseconds: number } {
  return { bytes: mb * MB, milliseconds: seconds * 1000 };
}

function history(route: 'direct' | 'server', samples: { bytes: number; milliseconds: number }[]): History {
  return samples.reduce((h, s) => record(h, route, s), { ...EMPTY });
}

describe('learning how fast each route is', () => {
  test('with nothing measured it says so rather than guessing', () => {
    assert.equal(bytesPerSecond({ ...EMPTY }, 'direct'), null);
    assert.equal(estimateSeconds({ ...EMPTY }, 'direct', 100 * MB), null);
  });

  test('one measured transfer is enough to estimate the next', () => {
    const h = history('direct', [ran(100, 10)]); // 10 MB/s
    assert.equal(Math.round(estimateSeconds(h, 'direct', 50 * MB)!), 5);
  });

  test('what was measured on one route says nothing about the other', () => {
    const h = history('direct', [ran(100, 10)]);
    assert.equal(estimateSeconds(h, 'server', 50 * MB), null);
  });

  /**
   * A laptop that went to sleep mid-transfer produces one absurd sample.
   * The mean would carry it into every future estimate; the median does not.
   */
  test('one stalled transfer does not poison the estimate', () => {
    const h = history('direct', [ran(100, 10), ran(100, 10), ran(100, 600), ran(100, 10), ran(100, 10)]);
    assert.equal(Math.round(estimateSeconds(h, 'direct', 100 * MB)!), 10);
  });

  test('the estimate follows a link that really did get slower', () => {
    let h = history('direct', Array(10).fill(ran(100, 5)));
    assert.equal(Math.round(estimateSeconds(h, 'direct', 100 * MB)!), 5);

    for (let i = 0; i < 10; i++) h = record(h, 'direct', ran(100, 20));
    assert.equal(Math.round(estimateSeconds(h, 'direct', 100 * MB)!), 20);
  });

  test('only the last ten transfers are remembered', () => {
    let h: History = { ...EMPTY };
    for (let i = 0; i < 40; i++) h = record(h, 'direct', ran(100, 10));
    assert.equal(h.direct.length, 10);
  });

  /**
   * A 20 KB file that finishes in four milliseconds implies gigabytes a
   * second. Believing it would promise that a 4 GB folder takes one second.
   */
  test('a transfer too small to measure is timed and thrown away', () => {
    const h = record({ ...EMPTY }, 'direct', { bytes: 20 * 1024, milliseconds: 4 });
    assert.deepEqual(h.direct, []);
    assert.equal(estimateSeconds(h, 'direct', 4096 * MB), null);
  });

  test('a big file that finished implausibly fast is also ignored', () => {
    const h = record({ ...EMPTY }, 'direct', { bytes: 900 * MB, milliseconds: 3 });
    assert.deepEqual(h.direct, []);
  });

  test('nothing is ever estimated as instant', () => {
    const h = history('direct', [ran(1000, 1)]);
    assert.ok(estimateSeconds(h, 'direct', 1)! >= 1);
  });

  test('a negative or nonsense size has no estimate', () => {
    const h = history('direct', [ran(100, 10)]);
    assert.equal(estimateSeconds(h, 'direct', -1), null);
    assert.equal(estimateSeconds(h, 'direct', Number.NaN), null);
  });
});

describe('saying the estimate out loud', () => {
  test('an unknown estimate is admitted, not invented', () => {
    assert.equal(describeSeconds(null), 'time unknown');
  });

  test('short waits are not counted down to the second', () => {
    assert.equal(describeSeconds(3), 'a few seconds');
    assert.equal(describeSeconds(32), 'about 30 seconds');
    assert.equal(describeSeconds(70), 'about a minute');
  });

  test('longer waits get rounder as they get longer', () => {
    assert.equal(describeSeconds(8 * 60), 'about 8 minutes');
    assert.equal(describeSeconds(45 * 60), 'about 45 minutes');
    assert.equal(describeSeconds(62 * 60), 'about an hour');
    assert.equal(describeSeconds(3 * 3600), 'about 3 hours');
  });
});

describe('remembering it between runs', () => {
  test('what was measured survives a restart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'betsend-rate-'));
    const file = path.join(dir, 'nested', 'throughput.json');

    writeHistory(file, history('server', [ran(100, 20)]));
    assert.equal(Math.round(estimateSeconds(readHistory(file), 'server', 100 * MB)!), 20);
  });

  test('a file that has never been written reads as nothing measured', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'betsend-rate-'));
    assert.deepEqual(readHistory(path.join(dir, 'missing.json')), EMPTY);
  });

  /** Same reasoning as settings.json: a cache file must never stop the app. */
  test('a corrupt file is discarded rather than thrown', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'betsend-rate-'));
    const file = path.join(dir, 'throughput.json');
    fs.writeFileSync(file, '{ this is not json');
    assert.deepEqual(readHistory(file), EMPTY);
  });

  test('junk inside an otherwise valid file is dropped sample by sample', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'betsend-rate-'));
    const file = path.join(dir, 'throughput.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        direct: [{ bytes: 'lots', milliseconds: 1000 }, ran(100, 10), null],
        server: 'not an array',
      }),
    );

    const loaded = readHistory(file);
    assert.equal(loaded.direct.length, 1);
    assert.deepEqual(loaded.server, []);
  });
});
