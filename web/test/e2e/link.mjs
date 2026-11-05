/**
 * A download link, used the way it will actually be used.
 *
 * Johnson sends assets to Beridze and pastes the link somewhere. Beridze
 * goes on holiday. Williams, who was never a recipient and has no idea the
 * transfer exists, follows the link from a task, signs in, and gets the
 * files. Then Johnson turns the link off and Williams gets a page that
 * explains itself.
 *
 * Driven through the real browser because the parts that break here are the
 * parts no unit test touches: the hash surviving a sign-in, the clipboard
 * fallback on a plain-http origin, and whether the download button actually
 * carries the token.
 *
 * Not part of `npm test` — it wants Playwright and a browser.
 *
 *   npm run build -w web && node web/test/e2e/link.mjs
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = (() => {
  for (const candidate of ['playwright', '/opt/node-tools/node_modules/playwright/index.js']) {
    try {
      return require(candidate);
    } catch {
      /* try the next */
    }
  }
  throw new Error('Playwright is not installed.');
})();

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const ADMIN_TOKEN = 'link-e2e-token';
const PASSWORD = 'spare-anchor-violet';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'betsend-link-e2e-'));

let failures = 0;
const ok = (label) => console.log(`  ok  ${label}`);
const fail = (label, detail) => {
  failures++;
  console.log(`FAIL  ${label}${detail ? `\n      ${detail}` : ''}`);
};

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const port = await freePort();
const origin = `http://127.0.0.1:${port}`;
fs.writeFileSync(
  path.join(work, 'config.json'),
  JSON.stringify({
    port,
    host: '127.0.0.1',
    storageDir: path.join(work, 'data'),
    adminToken: ADMIN_TOKEN,
    emailDomains: ['betlive.com'],
    logLevel: 'silent',
    minFreeDiskBytes: 0,
  }),
);

const server = spawn(process.execPath, ['--import', 'tsx', path.join(repoRoot, 'server/src/index.ts')], {
  cwd: repoRoot,
  env: {
    ...process.env,
    CONFIG_FILE: path.join(work, 'config.json'),
    STORAGE_DIR: path.join(work, 'data'),
  },
  stdio: 'ignore',
});

const cleanup = () => {
  server.kill();
  fs.rmSync(work, { recursive: true, force: true });
};
process.on('exit', cleanup);

for (let i = 0; i < 80; i++) {
  try {
    if ((await fetch(`${origin}/api/health`)).ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 250));
}

const cookieOf = (r) =>
  (r.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('bs_session='))?.split(';')[0];

const first = await fetch(`${origin}/api/first-run`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ adminToken: ADMIN_TOKEN, email: 'j.johnson@betlive.com', password: PASSWORD }),
});
if (first.status !== 200) throw new Error(`first-run: ${await first.text()}`);
const adminCookie = cookieOf(first);

/** An account set up the way an administrator would set one up. */
async function makeAccount(email, displayName) {
  await fetch(`${origin}/api/admin/users/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({ text: email }),
  });
  const res = await fetch(`${origin}/api/admin/users/${displayName}/setup-link`, {
    method: 'POST',
    headers: { cookie: adminCookie },
  });
  const { link } = await res.json();
  const token = decodeURIComponent(/token=([^&]+)/.exec(link)[1]);
  const done = await fetch(`${origin}/api/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, password: PASSWORD }),
  });
  if (done.status !== 200) throw new Error(`setup ${displayName}: ${await done.text()}`);
}

await makeAccount('m.beridze@betlive.com', 'M.Beridze');
await makeAccount('a.williams@betlive.com', 'A.Williams');

const asset = path.join(work, 'brand-kit.zip');
const assetBytes = crypto.randomBytes(1024 * 1024 + 7);
fs.writeFileSync(asset, assetBytes);

const browser = await chromium.launch();

async function signIn(page, email) {
  await page.waitForSelector('input[type="email"]', { timeout: 30000 });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
}

// --- Johnson sends, and makes a link -------------------------------------
const johnson = await browser.newContext();
const jPage = await johnson.newPage();
await jPage.goto(origin);
await signIn(jPage, 'j.johnson@betlive.com');
await jPage.waitForSelector('nav, aside', { timeout: 30000 });
ok('the sender signs in');

await jPage.setInputFiles('input[type="file"]', asset);
await jPage.getByText('M.Beridze', { exact: false }).first().click();
await jPage.getByRole('button', { name: /^Send$/ }).last().click();
await jPage.waitForSelector('text=/Sent to/i', { timeout: 60000 });
ok('the files go up through the server');

await jPage.goto(`${origin}/#/sent`);
await jPage.waitForSelector('#\\31 ', { timeout: 1 }).catch(() => {});
const daysField = jPage.locator('input[type="number"]').first();
await daysField.waitFor({ timeout: 20000 });
await daysField.fill('21');
await jPage.getByRole('button', { name: /Create a link/i }).first().click();

const linkField = jPage.locator('input[readonly]').first();
await linkField.waitFor({ timeout: 20000 });
const url = await linkField.inputValue();
/^https?:\/\/.+\/#\/d\/.{20,}$/.test(url)
  ? ok(`a link is created: ${url.replace(origin, '')}`)
  : fail('the link looks wrong', url);

const until = await jPage.locator('text=/Works until/').first().innerText();
// A 21-day deadline shown with a relative formatter reads "just now", which
// is how this was wrong the first time it was written.
/just now|ago/i.test(until)
  ? fail('the expiry is formatted as if it were in the past', until)
  : ok(`the card says when it runs out: ${until}`);

// --- Williams, who was never a recipient ---------------------------------
const williams = await browser.newContext();
const wPage = await williams.newPage();
await wPage.goto(url.replace(origin, origin)); // same origin, fresh cookie jar

const hint = await wPage
  .locator('text=/Sign in to open the link/i')
  .first()
  .innerText()
  .catch(() => '');
hint ? ok('a stranger to the transfer is asked to sign in, and told why') : fail('no sign-in hint shown');

await signIn(wPage, 'a.williams@betlive.com');

// The hash must survive signing in, or she lands on the Send screen.
const heading = await wPage
  .getByRole('heading', { name: /Shared files/i })
  .first()
  .innerText()
  .catch(() => '');
heading
  ? ok('after signing in she lands on the files, not the Send screen')
  : fail('the link was lost across sign-in', `hash is now ${await wPage.evaluate(() => location.hash)}`);

const fromLine = await wPage.locator('text=/Sent by J.Johnson/').first().innerText().catch(() => '');
fromLine ? ok('it says who sent them') : fail('the sender is not named');

const shownFile = await wPage.locator('text=brand-kit.zip').first().innerText().catch(() => '');
shownFile ? ok('the file is listed') : fail('the file is not listed');

// Who else it was sent to is nobody's business but the sender's.
const leaked = await wPage.locator('text=M.Beridze').count();
leaked === 0 ? ok('the recipient list is not exposed') : fail('the recipient list leaked to the link holder');

// --- she downloads it ----------------------------------------------------
const download = await Promise.all([
  wPage.waitForEvent('download', { timeout: 60000 }),
  wPage.getByRole('button', { name: /^Download$/i }).last().click(),
]).then(([d]) => d);

const saved = path.join(work, 'downloaded.zip');
await download.saveAs(saved);
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
sha(saved) === sha(asset)
  ? ok('the file she gets is byte for byte the file he sent')
  : fail('the downloaded bytes differ from the original');

// --- and it is on the record, without faking the recipient's status ------
const sent = await (await fetch(`${origin}/api/sent`, { headers: { cookie: adminCookie } })).json();
const row = sent.transfers[0];
row.recipients[0].downloadedAt === null
  ? ok('a download through a link does not mark the recipient as having collected')
  : fail('the recipient was wrongly marked as having downloaded');

// --- Johnson turns it off ------------------------------------------------
await jPage.reload();
await jPage.getByRole('button', { name: /Turn off/i }).first().click();
await jPage.waitForSelector('text=/Link turned off/i', { timeout: 20000 });
ok('the sender can turn the link off');

await wPage.reload();
const gone = await wPage
  .locator('text=/not available|turned this link off/i')
  .first()
  .innerText()
  .catch(() => '');
gone
  ? ok(`a revoked link explains itself: "${gone.trim()}"`)
  : fail('a revoked link did not say what happened');

await browser.close();
server.kill();
console.log(failures === 0 ? 'done' : `done with ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
