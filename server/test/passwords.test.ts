import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { checkPasswordStrength, hashPassword, verifyPassword } from '../src/services/passwords.js';

describe('password hashing', () => {
  test('a hash verifies against its own password and nothing else', async () => {
    const hash = await hashPassword('correct-horse-battery');
    assert.equal(await verifyPassword('correct-horse-battery', hash), true);
    assert.equal(await verifyPassword('Correct-horse-battery', hash), false);
    assert.equal(await verifyPassword('', hash), false);
  });

  test('the same password hashes differently every time', async () => {
    const [a, b] = await Promise.all([hashPassword('same-input-twice'), hashPassword('same-input-twice')]);
    assert.notEqual(a, b, 'a random salt must make the stored values differ');
    assert.equal(await verifyPassword('same-input-twice', a), true);
    assert.equal(await verifyPassword('same-input-twice', b), true);
  });

  test('the stored form carries its parameters, so they can be raised later', async () => {
    const hash = await hashPassword('a-phrase-to-store');
    const [scheme, n, r, p] = hash.split('$');
    assert.equal(scheme, 'scrypt');
    assert.ok(Number(n) >= 16384, 'cost should not be weakened by accident');
    assert.ok(Number(r) > 0 && Number(p) > 0);
  });

  test('the plaintext never appears in the stored value', async () => {
    const hash = await hashPassword('hunter-two-and-friends');
    assert.doesNotMatch(hash, /hunter/i);
  });

  test('a missing or malformed hash never verifies', async () => {
    for (const stored of [null, '', 'not-a-hash', 'scrypt$1$2$3', 'bcrypt$x$y$z$w$v']) {
      assert.equal(await verifyPassword('anything', stored as string | null), false, `${stored} must not verify`);
    }
  });
});

describe('password strength', () => {
  test('accepts an ordinary passphrase', () => {
    assert.equal(checkPasswordStrength('marmalade tuesday', 'J.Johnson').ok, true);
  });

  test('rejects anything shorter than ten characters', () => {
    const result = checkPasswordStrength('short', 'J.Johnson');
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /10 characters/);
  });

  test('rejects the user’s own name, however they case it', () => {
    for (const attempt of ['J.Johnson-is-me', 'j.johnson-is-me', 'xxJ.JOHNSONxx']) {
      assert.equal(checkPasswordStrength(attempt, 'J.Johnson').ok, false, `${attempt} should be refused`);
    }
  });

  test('rejects the obvious guesses', () => {
    for (const attempt of ['password1234', 'MyPassword!!', 'betsend-rules', 'letmein-please', '12345678901']) {
      assert.equal(checkPasswordStrength(attempt, 'J.Johnson').ok, false, `${attempt} should be refused`);
    }
  });

  test('rejects an absurdly long password rather than hashing it', () => {
    assert.equal(checkPasswordStrength('x'.repeat(500), 'J.Johnson').ok, false);
  });

  test('every refusal explains itself', () => {
    for (const attempt of ['short', 'J.Johnson-is-me', 'password1234']) {
      const result = checkPasswordStrength(attempt, 'J.Johnson');
      assert.ok(result.error && result.error.length > 10, 'a refusal must say why');
    }
  });
});
