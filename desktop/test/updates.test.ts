import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHECK_EVERY_MS,
  canInstallNow,
  describeFailure,
  lastCheckLabel,
  resolveAutoUpdater,
  NO_UPDATE,
  OFFER_AGAIN_AFTER_MS,
  shouldCheck,
  shouldOffer,
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

/**
 * The updater had never run on any build, and nothing said so.
 *
 * electron-updater is CommonJS and this app is ESM, so `import {
 * autoUpdater }` gives undefined: it is a lazy getter, which Node's
 * static scan of a CommonJS module cannot see. Assigning to a property
 * of it threw inside an async import nobody was awaiting, which is as
 * quiet as a failure gets.
 */
describe('getting hold of the updater at all', () => {
  test('it is found on the module', () => {
    const fake = { ok: true };
    assert.equal(resolveAutoUpdater({ autoUpdater: fake }), fake);
  });

  test('and on default, which is where ESM actually puts it', () => {
    const fake = { ok: true };
    assert.equal(resolveAutoUpdater({ default: { autoUpdater: fake } }), fake);
  });

  test('null rather than undefined when it is on neither, so the caller must look', () => {
    assert.equal(resolveAutoUpdater({}), null);
    assert.equal(resolveAutoUpdater({ default: {} }), null);
    assert.equal(resolveAutoUpdater(null), null);
  });

  /**
   * Against the real package, so a future version moving it is caught
   * here rather than by somebody wondering why their app never updates.
   * The property is inspected and never read: evaluating the getter
   * constructs an updater, which needs an Electron app to exist.
   */
  test('electron-updater still keeps it where we look', async () => {
    const module = (await import('electron-updater')) as Record<string, unknown>;
    const onModule = Object.getOwnPropertyDescriptor(module, 'autoUpdater');
    const onDefault = Object.getOwnPropertyDescriptor(
      (module.default as object | undefined) ?? {},
      'autoUpdater',
    );

    assert.ok(
      onModule !== undefined || onDefault !== undefined,
      'electron-updater exposes autoUpdater on neither the module nor its default',
    );
  });
});

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

describe('asking somebody to check', () => {
  /**
   * The whole point of a Check for updates button is that it checks now.
   * Falling through to "not for another four hours" would make it look
   * broken in exactly the situation somebody reaches for it.
   */
  test('a manual check ignores the schedule', () => {
    const justChecked = state({ lastCheckedAt: live.now - 1000 });
    assert.equal(shouldCheck(justChecked, live), false);
    assert.equal(shouldCheck(justChecked, { ...live, manual: true }), true);
  });

  test('but not while one is already downloading or waiting', () => {
    assert.equal(shouldCheck(state({ downloading: 10 }), { ...live, manual: true }), false);
    assert.equal(shouldCheck(state({ ready: '1.4.3' }), { ...live, manual: true }), false);
  });

  test('and never in a dev run, however it was asked for', () => {
    assert.equal(shouldCheck(state(), { ...live, packaged: false, manual: true }), false);
  });
});

describe('deciding whether to ask about installing', () => {
  const idle = { now: live.now, sending: false, receiving: false };

  test('nothing to ask about until one has downloaded', () => {
    assert.equal(shouldOffer(state(), idle), false);
    assert.equal(shouldOffer(state({ ready: '1.4.3' }), idle), true);
  });

  /** The install restarts the app; mid-transfer is the wrong moment. */
  test('not while a transfer is moving', () => {
    const ready = state({ ready: '1.4.3' });
    assert.equal(shouldOffer(ready, { ...idle, sending: true }), false);
    assert.equal(shouldOffer(ready, { ...idle, receiving: true }), false);
  });

  test('"Later" is honoured, and then expires', () => {
    const later = state({ ready: '1.4.3', deferredUntil: live.now + OFFER_AGAIN_AFTER_MS });
    assert.equal(shouldOffer(later, idle), false);
    assert.equal(shouldOffer(later, { ...idle, now: live.now + OFFER_AGAIN_AFTER_MS + 1 }), true);
  });

  /**
   * An update that downloaded mid-transfer must come back on its own.
   * Otherwise the only way to take it is to quit, which is the manual
   * step the whole feature exists to remove.
   */
  test('an update deferred by a transfer is offered once it finishes', () => {
    const ready = state({ ready: '1.4.3' });
    assert.equal(shouldOffer(ready, { ...idle, sending: true }), false);
    assert.equal(shouldOffer(ready, idle), true);
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

/**
 * The absence of this cost an afternoon: an update did not arrive and
 * there was no way for anybody, including whoever wrote the updater, to
 * tell whether it had failed, been refused, or never run.
 */
describe('saying when it last looked, and what it found', () => {
  const now = 1_000_000_000;

  test('before the first check it says so, rather than implying all is well', () => {
    assert.equal(lastCheckLabel(state(), now), 'Not checked for updates yet');
  });

  test('up to date is stated, not left to be inferred from silence', () => {
    assert.match(lastCheckLabel(state({ lastCheckedAt: now - 30_000 }), now), /just now: up to date/);
  });

  test('a failure says what went wrong, where somebody will see it', () => {
    const failed = state({ lastCheckedAt: now - 5 * 60_000, failed: 'Could not reach the update server.' });
    assert.equal(lastCheckLabel(failed, now), 'Update check 5 min ago: Could not reach the update server.');
  });

  test('a waiting update is named', () => {
    const ready = state({ lastCheckedAt: now - 60_000, ready: '1.4.5' });
    assert.match(lastCheckLabel(ready, now), /1\.4\.5 ready/);
  });

  test('hours rather than a long count of minutes', () => {
    assert.match(lastCheckLabel(state({ lastCheckedAt: now - 3 * 3600_000 }), now), /3h ago/);
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
