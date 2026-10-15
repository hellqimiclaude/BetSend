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
import { findByEmail, importUsers, listUsers, markEmailVerified, setAdmin, setPassword } from './repos/users.js';
import { parseEmailList } from './util/email.js';
import { hashPassword } from './services/passwords.js';

// Addresses, since that is the identity now; the display names come from them.
//
// Deliberately NOT betlive.com. These are fake people with a password printed
// in this file, and if the relay is configured, sending one a transfer would
// put mail in a real colleague's inbox. `.test` is reserved by RFC 6761 and
// can never route anywhere.
const PEOPLE = [
  'j.johnson@example.test',
  'm.smith@example.test',
  'a.williams@example.test',
  'r.brown@example.test',
  'k.jones@example.test',
  't.garcia@example.test',
  'l.miller@example.test',
  's.davis@example.test',
  'p.rodriguez@example.test',
  'n.wilson@example.test',
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

  const { valid } = parseEmailList(PEOPLE.join('\n'));
  const { added, existing } = importUsers(valid);

  const hash = await hashPassword(DEV_PASSWORD);
  let given = 0;
  for (const address of PEOPLE) {
    const user = findByEmail(address);
    if (!user || user.password_hash) continue; // never overwrite a real password
    setPassword(user.id, hash);
    markEmailVerified(user.id);
    given++;
  }

  // The first one doubles as the admin so the Admin page is reachable without
  // digging the token out of config.json.
  const first = findByEmail(PEOPLE[0]);
  if (first && !first.is_admin) setAdmin(first.id, true);

  console.log(`Seeded ${added.length} user(s): ${added.join(', ') || '(none)'}`);
  if (existing.length) console.log(`Already present: ${existing.join(', ')}`);
  if (given > 0) console.log(`Set the development password on ${given} account(s).`);
  console.log(`\n  Sign in with any of those addresses and the password:  ${DEV_PASSWORD}`);
  console.log(`  ${PEOPLE[0]} is an admin.\n`);
  console.log(`Directory now has ${listUsers().length} active user(s).`);

  closeDb();
}

main().catch((err) => {
  console.error('Seeding failed:', err);
  process.exit(1);
});
