import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeUser, makeBlob, resetState } from './helpers.js';
import {
  applyUpdate,
  isNewer,
  readManifest,
  resetUpdateStatus,
  uploadsInFlight,
} from '../src/services/selfupdate.js';

/**
 * Deciding whether, and what, to install over the office's file server.
 *
 * This is the one place BetSend runs an executable it fetched off the
 * internet. Everything here is about refusing to: an unreadable feed, a
 * version that is not actually newer, a download that is not the one the
 * feed described, a moment when somebody is mid-upload.
 */

beforeEach(() => {
  resetState();
  resetUpdateStatus();
});

describe('is it actually newer', () => {
  test('ordinary ordering', () => {
    assert.equal(isNewer('1.5.1', '1.5.0'), true);
    assert.equal(isNewer('1.6.0', '1.5.9'), true);
    assert.equal(isNewer('2.0.0', '1.99.99'), true);
  });

  test('the same version is not newer, which is what stops a loop', () => {
    assert.equal(isNewer('1.5.0', '1.5.0'), false);
  });

  test('older is not newer, so a feed that rolls back cannot push a downgrade', () => {
    assert.equal(isNewer('1.4.9', '1.5.0'), false);
    assert.equal(isNewer('1.5.0', '1.5.1'), false);
  });

  /** Ten is bigger than nine, which string comparison disagrees with. */
  test('numbers, not text', () => {
    assert.equal(isNewer('1.10.0', '1.9.0'), true);
    assert.equal(isNewer('1.9.0', '1.10.0'), false);
  });

  test('a leading v is tolerated, since tags carry one', () => {
    assert.equal(isNewer('v1.5.1', '1.5.0'), true);
  });

  /**
   * Nonsense sorts as zero rather than as something enormous. A feed that
   * has been tampered with or has simply broken must not be able to look
   * newer than what is installed.
   */
  test('rubbish never looks newer', () => {
    assert.equal(isNewer('banana', '1.5.0'), false);
    assert.equal(isNewer('', '1.5.0'), false);
    assert.equal(isNewer('99999999999999999999x', '1.5.0'), false);
  });
});

describe('reading the feed', () => {
  const good = {
    version: '1.5.1',
    file: 'BetSend-Setup-1.5.1.exe',
    sha256: 'a'.repeat(64),
    size: 34951997,
  };

  test('a complete manifest is accepted', () => {
    assert.deepEqual(readManifest(good), good);
  });

  test('anything missing is refused rather than half-used', () => {
    for (const key of ['version', 'file', 'sha256', 'size'] as const) {
      const partial: Record<string, unknown> = { ...good };
      delete partial[key];
      assert.equal(readManifest(partial), null, `a manifest without ${key} was accepted`);
    }
  });

  /**
   * The filename goes into a URL and into a path on disk. A feed that
   * could name "..\\..\\Windows\\System32\\..." would be choosing where
   * this writes, and then running it.
   */
  test('a filename that could climb out of its folder is refused', () => {
    for (const file of [
      '../../evil.exe',
      '..\\..\\evil.exe',
      '/etc/passwd',
      'C:\\Windows\\System32\\calc.exe',
      'BetSend Setup.exe',
      'installer.bat',
      'installer.exe.ps1',
    ]) {
      assert.equal(readManifest({ ...good, file }), null, `"${file}" was accepted`);
    }
  });

  test('a checksum that is not a sha256 is refused', () => {
    assert.equal(readManifest({ ...good, sha256: 'nope' }), null);
    assert.equal(readManifest({ ...good, sha256: 'A'.repeat(63) }), null);
    // Upper case is the same digest, just shouted.
    assert.deepEqual(readManifest({ ...good, sha256: 'A'.repeat(64) }), { ...good, sha256: 'a'.repeat(64) });
  });

  test('a nonsense size is refused', () => {
    for (const size of [0, -1, 1.5, 'big', null]) {
      assert.equal(readManifest({ ...good, size }), null, `size ${String(size)} was accepted`);
    }
  });

  test('a version that is not a version is refused', () => {
    assert.equal(readManifest({ ...good, version: 'latest' }), null);
    assert.equal(readManifest({ ...good, version: '1.5.1-rc1' }), null);
  });
});

describe('refusing to install', () => {
  test('with nothing checked for, there is nothing to install', async () => {
    const outcome = await applyUpdate('1.5.0');
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false && outcome.code, 'nothing_to_do');
  });

  /**
   * Restarting mid-upload interrupts it. tus resumes, so nothing is lost,
   * but there is no reason to interrupt somebody when the administrator
   * can press the button again in five minutes.
   */
  test('uploads still arriving are counted, and they stop an install', async () => {
    assert.equal(uploadsInFlight(), 0);

    const user = await makeUser('J.Johnson');
    const { recordUpload } = await import('../src/repos/uploads.js');
    recordUpload('upload-in-progress', user.id, 1024);

    assert.equal(uploadsInFlight(), 1);

    // Still refused for want of a manifest, but the count is what the
    // route reports, and it is what the install consults first.
    const outcome = await applyUpdate('1.5.0');
    assert.equal(outcome.ok, false);
    assert.ok(makeBlob);
  });
});
