import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>;

/**
 * Password hashing with scrypt from Node's standard library — no native
 * dependency to compile on the office machine, and memory-hard enough that a
 * stolen database is not a list of passwords.
 *
 * Stored form: `scrypt$<N>$<r>$<p>$<salt-b64>$<hash-b64>`. The parameters live
 * in the string so they can be raised later without invalidating old hashes.
 */

const N = 16384; // CPU/memory cost — ~100 ms on a typical office PC
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

export const MIN_PASSWORD_LENGTH = 10;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  // maxmem must be raised above the 32 MB default for these parameters.
  const derived = await new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password, salt, KEY_LENGTH, { N, r: R, p: P, maxmem: 256 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;

  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, rawN, rawR, rawP, saltB64, hashB64] = parts;
  const n = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltB64, 'base64');
    expected = Buffer.from(hashB64, 'base64');
  } catch {
    return false;
  }

  let derived: Buffer;
  try {
    derived = await new Promise<Buffer>((resolve, reject) => {
      scryptCallback(password, salt, expected.length, { N: n, r, p, maxmem: 256 * 1024 * 1024 }, (err, key) =>
        err ? reject(err) : resolve(key),
      );
    });
  } catch {
    return false;
  }

  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

export interface PasswordCheck {
  ok: boolean;
  error?: string;
}

/**
 * Deliberately simple rules. Length does far more for real-world safety than
 * character-class requirements, which mostly produce `Password1!`.
 */
export function checkPasswordStrength(password: string, userName: string): PasswordCheck {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `Please use at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  if (password.length > 200) {
    return { ok: false, error: 'That password is too long.' };
  }
  const lower = password.toLowerCase();
  if (lower.includes(userName.toLowerCase())) {
    return { ok: false, error: 'Please do not put your own name in your password.' };
  }
  const tooCommon = ['password', 'betsend', '12345678', 'qwertyui', 'letmein', 'welcome'];
  if (tooCommon.some((bad) => lower.includes(bad))) {
    return { ok: false, error: 'That password is too easy to guess. Please pick another.' };
  }
  return { ok: true };
}

/** Marker for "this account exists but has no password yet". */
export const NO_PASSWORD = null;

/**
 * A dummy verification used when the account does not exist, so that a wrong
 * name and a wrong password take the same amount of time to reject.
 */
const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64');

export async function burnTime(password: string): Promise<void> {
  await verifyPassword(password, DUMMY_HASH);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
