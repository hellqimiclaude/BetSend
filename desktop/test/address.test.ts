import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { healthUrl, isSameServer, parseAddress } from '../src/address.js';

/**
 * The first screen a colleague sees asks for the server address, and they will
 * type whatever they were told in the corridor. Everything here is a form
 * somebody will plausibly enter.
 */

function candidates(input: string): string[] {
  const result = parseAddress(input);
  assert.ok(result.ok, `expected ${input} to parse, got: ${result.ok ? '' : result.error}`);
  return result.candidates;
}

function errorFor(input: string): string {
  const result = parseAddress(input);
  assert.ok(!result.ok, `expected ${JSON.stringify(input)} to be refused`);
  return result.error;
}

describe('reading the address somebody typed', () => {
  test('a full URL is taken as given', () => {
    assert.deepEqual(candidates('http://192.168.1.5:8080'), ['http://192.168.1.5:8080']);
    assert.deepEqual(candidates('https://files.betlive.com'), ['https://files.betlive.com']);
  });

  test('a bare machine name gets http, and both likely ports', () => {
    assert.deepEqual(candidates('betsend-pc'), ['http://betsend-pc:8080', 'http://betsend-pc']);
  });

  test('a bare address with a port is taken at its word', () => {
    assert.deepEqual(candidates('192.168.1.5:8080'), ['http://192.168.1.5:8080']);
    // http://host IS port 80 -- URL drops the default, and so does this.
    assert.deepEqual(candidates('192.168.1.5:80'), ['http://192.168.1.5']);
  });

  test('trailing slashes and paths are dropped', () => {
    assert.deepEqual(candidates('http://betsend-pc:8080/'), ['http://betsend-pc:8080']);
    assert.deepEqual(candidates('http://betsend-pc:8080/#/inbox'), ['http://betsend-pc:8080']);
  });

  test('surrounding whitespace does not matter', () => {
    assert.deepEqual(candidates('  192.168.1.5:8080  '), ['http://192.168.1.5:8080']);
  });

  test('case in the host does not matter', () => {
    assert.deepEqual(candidates('BETSEND-PC:8080'), ['http://betsend-pc:8080']);
  });

  test('https with no port means 443, not the installer default', () => {
    assert.deepEqual(candidates('https://files.betlive.com'), ['https://files.betlive.com']);
  });

  describe('what it refuses', () => {
    test('nothing at all', () => {
      assert.match(errorFor(''), /Enter the address/);
      assert.match(errorFor('   '), /Enter the address/);
    });

    test('a scheme that is not the web', () => {
      assert.match(errorFor('ftp://betsend-pc'), /http:\/\/ or https:\/\//);
      assert.match(errorFor('file:///C:/betsend'), /http:\/\/ or https:\/\//);
    });

    test('credentials in the address', () => {
      assert.match(errorFor('http://admin:secret@betsend-pc:8080'), /username and password/);
    });

    test('something that is not an address at all', () => {
      assert.match(errorFor('http://'), /not an address|missing a computer name/);
    });
  });
});

describe('health endpoint', () => {
  test('is built from the origin', () => {
    assert.equal(healthUrl('http://betsend-pc:8080'), 'http://betsend-pc:8080/api/health');
  });

  test('a stray trailing slash does not double up', () => {
    assert.equal(healthUrl('http://betsend-pc:8080/'), 'http://betsend-pc:8080/api/health');
  });
});

/**
 * The window shows one server. A link in somebody's transfer note must not be
 * able to repoint it at a look-alike sign-in page with no address bar to give
 * the game away.
 */
describe('deciding what the window may show', () => {
  const server = 'http://betsend-pc:8080';

  test('pages on the server are fine', () => {
    assert.equal(isSameServer(server, 'http://betsend-pc:8080/'), true);
    assert.equal(isSameServer(server, 'http://betsend-pc:8080/api/download/abc'), true);
  });

  test('anywhere else is not', () => {
    assert.equal(isSameServer(server, 'http://evil.example/'), false);
    assert.equal(isSameServer(server, 'https://betsend-pc:8080/'), false, 'a different scheme is a different origin');
    assert.equal(isSameServer(server, 'http://betsend-pc:9999/'), false, 'a different port is a different origin');
    assert.equal(isSameServer(server, 'http://betsend-pc.evil.example:8080/'), false);
  });

  test('nonsense is not', () => {
    assert.equal(isSameServer(server, 'javascript:alert(1)'), false);
    assert.equal(isSameServer(server, ''), false);
  });
});
