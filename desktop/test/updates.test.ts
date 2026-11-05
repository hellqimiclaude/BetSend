import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHECK_EVERY_MS,
  canInstallNow,
  describeFailure,
  NO_UPDATE,
  shouldCheck,
  trayLabel,
  type UpdateState,
} from '../src/updates.js';

/**
 * Updating 150 machines without anybody downloading anything.
 *
 * The risk is not that an update fails -- it is that one installs at the
 * wrong moment, or that a dev checkout tries to upgrade itself into a
 * packaged release.
 */

function state(partial: Partial<UpdateState> = {}): UpdateState {
  return { ...NO_UPDATE, ...partial };
}

const live = { packaged: true, online: true, now: 1_000_000 };

describe('deciding whether to look', () => {
  test('a fresh packaged app checks straight away', () => {
    assert.equal(shouldCheck(state(), live), true);
  });

  /** The version in a checkout is whatever package.json says. */
  test('a dev run never checks', () => {
    assert.equal(shouldCheck(state(), { ...live, packaged: false }), false);
  });

  test('an app with no server to talk to does not check', () => {
    assert.equal(shouldCheck(state(), { ...live, online: false }), false);
  });

  test('not again until a day has passed', () => {
    const checked = state({ lastCheckedAt: live.now - 1000 });
    assert.equal(shouldCheck(checked, live), false);
    assert.equal(shouldCheck(checked, { ...live, now: live.now + CHECK_EVERY_MS }), true);
  });

  test('not while one is already downloading', () => {
    assert.equal(shouldCheck(state({ downloading: 40 }), live), false);
  });

  /** There is nothing a second answer could change. */
  test('not while one is waiting to be installed', () => {
    assert.equal(shouldCheck(state({ ready: '1.4.0' }), live), false);
  });
});

describe('deciding whether to install', () => {
  /**
   * Replacing the executable underneath a transfer loses it. An upload
   * could be resumed afterwards; a direct transfer could not, and the
   * colleague at the other end would be left with half a file.
   */
  test('never while something is being sent', () => {
    assert.equal(canInstallNow({ sending: true, receiving: false }), false);
  });

  test('never while something is arriving', () => {
    assert.equal(canInstallNow({ sending: false, receiving: true }), false);
  });

  test('yes when the app is idle', () => {
    assert.equal(canInstallNow({ sending: false, receiving: false }), true);
  });
});

describe('what the tray says', () => {
  test('nothing at all when there is no news', () => {
    assert.equal(trayLabel(state()), null);
    // A failed check is not news either: the app works exactly as it did.
    assert.equal(trayLabel(state({ failed: 'Could not reach the update server.' })), null);
  });

  test('progress while it downloads', () => {
    assert.equal(trayLabel(state({ downloading: 42 })), 'Downloading update — 42%');
  });

  test('and what to do once it is ready', () => {
    assert.equal(trayLabel(state({ ready: '1.4.0' })), 'Restart to update to 1.4.0');
  });

  test('ready beats downloading, so the label cannot go backwards', () => {
    assert.match(trayLabel(state({ ready: '1.4.0', downloading: 99 }))!, /Restart/);
  });
});

describe('explaining a failure to the log', () => {
  test('an office with no way out is a sentence, not a stack trace', () => {
    assert.equal(
      describeFailure(new Error('getaddrinfo ENOTFOUND github.com')),
      'Could not reach the update server.',
    );
    assert.equal(describeFailure(new Error('connect ETIMEDOUT 140.82.121.3:443')), 'Could not reach the update server.');
  });

  test('nothing published yet says so', () => {
    assert.equal(describeFailure(new Error('HttpError: 404 Not Found')), 'No published release to update to.');
  });

  test('anything else is passed through, but not a whole novel', () => {
    assert.equal(describeFailure(new Error('something odd')), 'something odd');
    assert.ok(describeFailure(new Error('x'.repeat(5000))).length <= 200);
  });

  test('a thrown non-error does not itself throw', () => {
    assert.equal(describeFailure('plain string'), 'plain string');
    assert.equal(typeof describeFailure(null), 'string');
  });
});
