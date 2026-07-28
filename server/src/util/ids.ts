import { randomBytes } from 'node:crypto';

const ALPHABET = 'abcdefghijkmnopqrstuvwxyz23456789'; // no l/1/0/o — these ids show up in URLs

export function newId(length = 16): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}
