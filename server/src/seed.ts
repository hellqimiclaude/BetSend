/**
 * Development fixture: ten colleagues you can actually sign in as.
 *   npm run seed
 * Safe to re-run — existing people keep their passwords.
 *
 * Every seeded account gets the same password, printed at the end. This is for
 * development only; never run it against a server people really use.
 */
import { ensureDirs, config, configFilePath } from './config.js';
import { getDb, closeDb } from './db/index.js';
import { findByName, importUsers, listUsers, setAdmin, setPassword } from './repos/users.js';
import { validateName } from './util/names.js';
import { hashPassword } from './services/passwords.js';

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

const DEV_PASSWORD = 'betsend-dev-2024';

async function main(): Promise<void> {
  if (config.publicMode) {
    console.error(
      'Refusing to seed: PUBLIC_MODE is on, and these are well-known accounts with a published password.',
    );
    process.exit(1);
  }

  ensureDirs();
  getDb();

  // Say which database is being written, so seeding the wrong one is obvious
  // rather than mysterious.
  console.log(`Config:   ${configFilePath ?? '(defaults and environment only)'}`);
  console.log(`Database: ${config.dbPath}\n`);

  const parsed = NAMES.map((n) => validateName(n)).filter((r) => r.ok);
  const { added, existing } = importUsers(parsed.map((p) => ({ value: p.value, key: p.key })));

  const hash = await hashPassword(DEV_PASSWORD);
  let given = 0;
  for (const name of NAMES) {
    const user = findByName(name);
    if (!user || user.password_hash) continue; // never overwrite a real password
    setPassword(user.id, hash);
    given++;
  }

  // The first name doubles as the admin so the Admin page is reachable without
  // digging the token out of config.json.
  const first = findByName(NAMES[0]);
  if (first && !first.is_admin) setAdmin(first.id, true);

  console.log(`Seeded ${added.length} user(s): ${added.join(', ') || '(none)'}`);
  if (existing.length) console.log(`Already present: ${existing.join(', ')}`);
  if (given > 0) console.log(`Set the development password on ${given} account(s).`);
  console.log(`\n  Sign in as any of them with the password:  ${DEV_PASSWORD}`);
  console.log(`  ${NAMES[0]} is an admin.\n`);
  console.log(`Directory now has ${listUsers().length} active user(s).`);

  closeDb();
}

main().catch((err) => {
  console.error('Seeding failed:', err);
  process.exit(1);
});
