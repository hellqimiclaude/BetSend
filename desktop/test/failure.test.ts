import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { explainNetworkFailure, unreachableMessage } from '../src/failure.js';

/**
 * Node's fetch reports everything as "fetch failed" and buries the reason in
 * `cause`. That string was reaching the setup window, where it told somebody
 * who had just mistyped their office PC's name precisely nothing.
 */

/** What Node's fetch actually throws: a TypeError wrapping the syscall error. */
function fetchFailure(code: string): Error {
  const cause = Object.assign(new Error(`connect ${code} 127.0.0.1:8080`), { code });
  return Object.assign(new TypeError('fetch failed'), { cause });
}

describe('explaining why a server could not be reached', () => {
  test('a refused connection points at the port', () => {
    assert.match(explainNetworkFailure(fetchFailure('ECONNREFUSED')), /nothing is listening on that port/i);
  });

  test('an unknown host points at the name', () => {
    assert.match(explainNetworkFailure(fetchFailure('ENOTFOUND')), /No computer with that name/i);
  });

  test('a timeout suggests it is off or firewalled', () => {
    assert.match(explainNetworkFailure(fetchFailure('ETIMEDOUT')), /switched off, or blocked by a firewall/i);
  });

  test('an unreachable network asks about the VPN', () => {
    assert.match(explainNetworkFailure(fetchFailure('EHOSTUNREACH')), /office network or VPN/i);
  });

  test('a bad certificate says so', () => {
    assert.match(explainNetworkFailure(fetchFailure('CERT_HAS_EXPIRED')), /certificate has expired/i);
  });

  test('an abort counts as a timeout', () => {
    const aborted = Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });
    assert.match(explainNetworkFailure(aborted), /did not answer in time/i);
  });

  /**
   * fetch has a blocked-port list going back to the 1990s -- 21, 25, 110 and
   * others. It refuses those with "bad port" and no error code, so they used
   * to fall through to the generic answer. Somebody typing their mail
   * server's address by mistake lands exactly here.
   */
  test('a port fetch refuses outright explains itself', () => {
    const cause = new Error('bad port');
    const message = explainNetworkFailure(new TypeError('fetch failed', { cause }));
    assert.match(message, /cannot be used for web traffic/i);
    assert.match(message, /8080 or 80/);
  });

  test('anything unrecognised still reads as English', () => {
    const message = explainNetworkFailure(new Error('something nobody predicted'));
    assert.equal(message, 'It could not be reached.');
    assert.doesNotMatch(message, /fetch failed|undefined|\[object/);
  });

  test('a failure with no cause at all does not throw', () => {
    assert.doesNotThrow(() => explainNetworkFailure(undefined));
    assert.doesNotThrow(() => explainNetworkFailure(null));
    assert.doesNotThrow(() => explainNetworkFailure('a string'));
  });

  test('a cause chain is followed, not just the top error', () => {
    const inner = Object.assign(new Error('inner'), { code: 'ENOTFOUND' });
    const middle = Object.assign(new Error('middle'), { cause: inner });
    const outer = new TypeError('fetch failed', { cause: middle });
    assert.match(explainNetworkFailure(outer), /No computer with that name/i);
  });

  test('a circular cause chain terminates', () => {
    const a: { cause?: unknown } = {};
    a.cause = a;
    assert.doesNotThrow(() => explainNetworkFailure(a));
  });
});

describe('the message shown in the setup window', () => {
  test('one candidate carries the specific reason', () => {
    const message = unreachableMessage(['http://betsend-pc:8080'], 'It did not answer in time.');
    assert.match(message, /http:\/\/betsend-pc:8080/);
    assert.match(message, /did not answer in time/);
  });

  test('two candidates name both, since neither reason is the whole story', () => {
    const message = unreachableMessage(['http://pc:8080', 'http://pc'], 'nope');
    assert.match(message, /http:\/\/pc:8080 or http:\/\/pc/);
    assert.match(message, /switched on/);
  });
});
