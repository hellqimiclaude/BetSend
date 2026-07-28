/**
 * Development fixture: ten colleagues to click around with.
 *   npm run seed
 * Safe to re-run — existing names are left alone.
 */
import { ensureDirs } from './config.js';
import { getDb, closeDb } from './db/index.js';
import { importUsers, listUsers } from './repos/users.js';
import { validateName } from './util/names.js';

const NAMES = [
  'J.Johnson',
  'M.Smith',
  'A.Williams',
  'R.Brown',
  'K.Jones',
  'T.Garcia',
  'L.Miller',
  'S.Davis',
  'P.Rodriguez',
  'N.Wilson',
];

ensureDirs();
getDb();

const parsed = NAMES.map((n) => validateName(n)).filter((r) => r.ok);
const { added, existing } = importUsers(parsed.map((p) => ({ value: p.value, key: p.key })));

console.log(`Seeded ${added.length} user(s): ${added.join(', ') || '(none)'}`);
if (existing.length) console.log(`Already present: ${existing.join(', ')}`);
console.log(`Directory now has ${listUsers().length} active user(s).`);

closeDb();
