import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  displayNameFromEmail,
  emailDomain,
  isAllowedDomain,
  parseEmailList,
  validateEmail,
} from '../src/util/email.js';

/** The office domain. Only addresses here prove somebody works at BetLive. */
const OFFICE = ['betlive.com'];

describe('email validation', () => {
  for (const good of [
    'j.johnson@betlive.com',
    'JJohnson@BetLive.com',
    "s.o'brien@betlive.com",
    'a.muller+reports@betlive.com',
    'x@betlive.co.uk',
  ]) {
    test(`accepts ${good}`, () => assert.equal(validateEmail(good).ok, true, `${good} should be valid`));
  }

  for (const bad of ['', '   ', 'jjohnson', 'j.johnson@', '@betlive.com', 'a b@betlive.com', 'a@b', 'a@@b.com']) {
    test(`rejects ${JSON.stringify(bad)}`, () => {
      const result = validateEmail(bad);
      assert.equal(result.ok, false, `${bad} should be invalid`);
      assert.ok(result.error && result.error.length > 0);
    });
  }

  test('the key is lowercased so case never splits an account', () => {
    assert.equal(validateEmail('J.Johnson@BetLive.com').key, 'j.johnson@betlive.com');
  });
});

describe('the office domain', () => {
  test('accepts an address at betlive.com', () => {
    assert.equal(isAllowedDomain('j.johnson@betlive.com', OFFICE), true);
    assert.equal(isAllowedDomain('J.Johnson@BETLIVE.COM', OFFICE), true);
  });

  test('accepts a subdomain of it', () => {
    assert.equal(isAllowedDomain('j.johnson@mail.betlive.com', OFFICE), true);
  });

  test('refuses anything else, including lookalikes', () => {
    for (const outsider of [
      'j.johnson@gmail.com',
      'j.johnson@betlive.com.evil.net',
      'j.johnson@notbetlive.com',
      'j.johnson@betlive.co',
    ]) {
      assert.equal(isAllowedDomain(outsider, OFFICE), false, `${outsider} must not be allowed`);
    }
  });

  test('an empty list turns the check off', () => {
    assert.equal(isAllowedDomain('anyone@anywhere.test', []), true);
  });

  test('the domain is read from the last @, not the first', () => {
    assert.equal(emailDomain('odd"@"name@betlive.com'), 'betlive.com');
  });
});

describe('display names derived from addresses', () => {
  const cases: [string, string][] = [
    ['j.johnson@betlive.com', 'J.Johnson'],
    ['john.johnson@betlive.com', 'J.Johnson'],
    ['J.JOHNSON@betlive.com', 'J.Johnson'],
    ['mary-anne.smith@betlive.com', 'M.Smith'],
    ['a_williams@betlive.com', 'A.Williams'],
    ['reception@betlive.com', 'Reception'],
  ];
  for (const [address, expected] of cases) {
    test(`${address} -> ${expected}`, () => assert.equal(displayNameFromEmail(address), expected));
  }
});

describe('importing a staff list', () => {
  test('one address per line', () => {
    const { valid, invalid } = parseEmailList('j.johnson@betlive.com\nm.smith@betlive.com');
    assert.deepEqual(valid.map((v) => v.email), ['j.johnson@betlive.com', 'm.smith@betlive.com']);
    assert.equal(invalid.length, 0);
  });

  test('CSV as Name,email keeps the given name', () => {
    const { valid } = parseEmailList('Jo Johnson,j.johnson@betlive.com');
    assert.equal(valid[0].email, 'j.johnson@betlive.com');
    assert.equal(valid[0].name, 'Jo Johnson');
  });

  test('CSV the other way round still finds the address', () => {
    const { valid } = parseEmailList('j.johnson@betlive.com,Finance');
    assert.equal(valid[0].email, 'j.johnson@betlive.com');
  });

  test('a name is derived when the line has only an address', () => {
    const { valid } = parseEmailList('j.johnson@betlive.com');
    assert.equal(valid[0].name, 'J.Johnson');
  });

  test('deduplicates case-insensitively', () => {
    const { valid } = parseEmailList('j.johnson@betlive.com\nJ.JOHNSON@BETLIVE.COM');
    assert.equal(valid.length, 1);
  });

  test('skips headers, blanks and comments', () => {
    const { valid, invalid } = parseEmailList('email\n\n# staff\nj.johnson@betlive.com\n');
    assert.equal(valid.length, 1);
    assert.equal(invalid.length, 0);
  });

  test('reports lines with no address rather than dropping them', () => {
    const { valid, invalid } = parseEmailList('j.johnson@betlive.com\nJust A Name\nm.smith@betlive.com');
    assert.equal(valid.length, 2);
    assert.equal(invalid.length, 1);
  });

  test('survives CRLF, as pasted from Outlook', () => {
    const { valid } = parseEmailList('j.johnson@betlive.com\r\nm.smith@betlive.com\r\n');
    assert.equal(valid.length, 2);
  });
});
