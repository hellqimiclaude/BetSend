import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeName, validateName, parseNameList, nameKey } from '../src/util/names.js';

describe('name normalisation', () => {
  test('capitalises the initial and the surname', () => {
    assert.equal(normalizeName('j.johnson'), 'J.Johnson');
    assert.equal(normalizeName('J.JOHNSON'), 'J.Johnson');
    assert.equal(normalizeName('  j.JOHNSON  '), 'J.Johnson');
  });

  test('treats differently-cased spellings as the same person', () => {
    assert.equal(nameKey('J.JOHNSON'), nameKey('j.johnson'));
  });

  test('keeps the shape of hyphenated and apostrophed surnames', () => {
    assert.equal(normalizeName("s.o'brien"), "S.O'Brien");
    assert.equal(normalizeName('a.smith-jones'), 'A.Smith-Jones');
    assert.equal(normalizeName('j.van dyke'), 'J.Van Dyke');
  });

  test('handles non-ASCII surnames', () => {
    assert.equal(normalizeName('a.müller'), 'A.Müller');
  });

  test('collapses runs of whitespace', () => {
    assert.equal(normalizeName('j.van    dyke'), 'J.Van Dyke');
  });
});

describe('name validation', () => {
  // One-letter surnames are deliberately allowed: they are rare but real
  // (the Chinese surname O, the Korean U), and wrongly locking a colleague out
  // is worse than letting a typo through a list an admin curates anyway.
  for (const good of ['J.Johnson', 'a.williams', "S.O'Brien", 'A.Müller', 'J.Van Dyke', 'J.J']) {
    test(`accepts ${good}`, () => {
      assert.equal(validateName(good).ok, true, `${good} should be valid`);
    });
  }

  for (const bad of ['', '   ', 'bob', 'Johnson', 'J.', '.Johnson', 'J Johnson', 'J.Johnson<script>']) {
    test(`rejects ${JSON.stringify(bad)}`, () => {
      const result = validateName(bad);
      assert.equal(result.ok, false, `${bad} should be invalid`);
      assert.ok(result.error && result.error.length > 0, 'an invalid name must come with a message');
    });
  }

  test('the rejection message is plain language, not a regex', () => {
    const result = validateName('bob');
    assert.match(result.error ?? '', /initial/i);
    assert.doesNotMatch(result.error ?? '', /\\p\{L\}/);
  });
});

describe('staff list import', () => {
  test('one name per line', () => {
    const { valid, invalid } = parseNameList('J.Johnson\nM.Smith\nA.Williams');
    assert.deepEqual(valid.map((v) => v.value), ['J.Johnson', 'M.Smith', 'A.Williams']);
    assert.equal(invalid.length, 0);
  });

  test('CSV takes the first column and skips a header row', () => {
    const { valid } = parseNameList('name,department\nJ.Johnson,Finance\nM.Smith,Legal');
    assert.deepEqual(valid.map((v) => v.value), ['J.Johnson', 'M.Smith']);
  });

  test('ignores blank lines and comments', () => {
    const { valid, invalid } = parseNameList('\n\n# people\nJ.Johnson\n\n');
    assert.deepEqual(valid.map((v) => v.value), ['J.Johnson']);
    assert.equal(invalid.length, 0);
  });

  test('deduplicates case-insensitively within one paste', () => {
    const { valid } = parseNameList('J.Johnson\nj.johnson\nJ.JOHNSON');
    assert.equal(valid.length, 1);
  });

  test('reports bad lines instead of dropping them silently', () => {
    const { valid, invalid } = parseNameList('J.Johnson\nnot a name\nM.Smith');
    assert.equal(valid.length, 2);
    assert.equal(invalid.length, 1);
    assert.equal(invalid[0].line, 'not a name');
  });

  test('handles CRLF, as pasted from Windows', () => {
    const { valid } = parseNameList('J.Johnson\r\nM.Smith\r\n');
    assert.equal(valid.length, 2);
  });

  test('strips quotes around a CSV cell', () => {
    const { valid } = parseNameList('"J.Johnson",Finance');
    assert.deepEqual(valid.map((v) => v.value), ['J.Johnson']);
  });
});
