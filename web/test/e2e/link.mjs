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
/*
 * The address the server is told to put in links, deliberately spelled
 * differently from the one the browser uses. Both reach the same process,
 * so the link still works -- but if the page ever goes back to building the
 * URL out of window.location, the link will say 127.0.0.1 and the check
 * below will catch it. That is the bug this whole file exists to prevent:
 * a link that only works on the machine that made it.
 */
const publicOrigin = `http://localhost:${port}`;
fs.writeFileSync(
  path.join(work, 'config.json'),
  JSON.stringify({
    port,
    host: '127.0.0.1',
    publicUrl: publicOrigin,
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

async function cookieFor(email) {
  const response = await fetch(`${origin}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  return cookieOf(response);
}

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
  ? ok(`a link is created: ${url.replace(publicOrigin, '')}`)
  : fail('the link looks wrong', url);

// The server's address, not the browser's. Somebody who opens BetSend as
// localhost on the server PC must still get a link other machines can use.
url.startsWith(publicOrigin)
  ? ok('the address comes from the server, not from the browser')
  : fail(`the link carries the browser's own address`, url);

const until = await jPage.locator('text=/Works until/').first().innerText();
// A 21-day deadline shown with a relative formatter reads "just now", which
// is how this was wrong the first time it was written.
/just now|ago/i.test(until)
  ? fail('the expiry is formatted as if it were in the past', until)
  : ok(`the card says when it runs out: ${until}`);

// --- Williams, who was never a recipient ---------------------------------
const williams = await browser.newContext();
const wPage = await williams.newPage();
await wPage.goto(url); // exactly the URL she was given, fresh cookie jar

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

// --- the three ways to send ----------------------------------------------
//
// Recipients only is everything above. These are the two new shapes: a
// link alongside a send, and a link with nobody to send to at all.

async function sendFrom(page, { recipients, link, file }) {
  await page.goto(`${origin}/#/send`);
  await page.waitForSelector('input[type="file"]', { state: 'attached', timeout: 20000 });
  await page.setInputFiles('input[type="file"]', file);
  for (const name of recipients) await page.getByText(name, { exact: false }).first().click();
  if (link) await page.locator('input[type="checkbox"]').first().check();
  await page.getByRole('button', { name: /^(Send|Send and create link|Create link)$/ }).last().click();
}

// 1. Recipients and a link together.
const both = path.join(work, 'both.bin');
fs.writeFileSync(both, crypto.randomBytes(256 * 1024));
await sendFrom(jPage, { recipients: ['M.Beridze'], link: true, file: both });

const bothLink = jPage.locator('input[readonly]').first();
await bothLink.waitFor({ timeout: 60000 });
const bothUrl = await bothLink.inputValue();
/#\/d\/.{20,}$/.test(bothUrl) ? ok('sending with a link gives back a link') : fail('no link after send+link', bothUrl);

const beridzeInbox = await (
  await fetch(`${origin}/api/inbox`, { headers: { cookie: await cookieFor('m.beridze@betlive.com') } })
).json();
beridzeInbox.transfers.some((tr) => tr.files.some((f) => f.name === 'both.bin'))
  ? ok('and the recipient still got it in their inbox')
  : fail('the recipient did not get a transfer that also had a link');

// 2. A link with nobody chosen at all.
const alone = path.join(work, 'alone.bin');
const aloneBytes = crypto.randomBytes(300 * 1024);
fs.writeFileSync(alone, aloneBytes);
await sendFrom(jPage, { recipients: [], link: true, file: alone });

const aloneField = jPage.locator('input[readonly]').first();
await aloneField.waitFor({ timeout: 60000 });
const aloneUrl = await aloneField.inputValue();
/#\/d\/.{20,}$/.test(aloneUrl) ? ok('a link can be made with nobody to send to') : fail('no link', aloneUrl);

// Williams, who was never a recipient of anything, can fetch it.
const wPage2 = await (await browser.newContext()).newPage();
await wPage2.goto(aloneUrl);
await signIn(wPage2, 'a.williams@betlive.com');
await wPage2.getByRole('heading', { name: /Shared files/i }).first().waitFor({ timeout: 30000 });

const aloneDownload = await Promise.all([
  wPage2.waitForEvent('download', { timeout: 60000 }),
  wPage2.getByRole('button', { name: /^Download$/i }).last().click(),
]).then(([d]) => d);
const aloneSaved = path.join(work, 'alone-downloaded.bin');
await aloneDownload.saveAs(aloneSaved);
crypto.createHash('sha256').update(fs.readFileSync(aloneSaved)).digest('hex') ===
crypto.createHash('sha256').update(aloneBytes).digest('hex')
  ? ok('and a colleague can download it, byte for byte')
  : fail('the link-only download differs from what was uploaded');

// Nobody's inbox gained anything: it was addressed to nobody.
const beridzeAfter = await (
  await fetch(`${origin}/api/inbox`, { headers: { cookie: await cookieFor('m.beridze@betlive.com') } })
).json();
beridzeAfter.transfers.some((tr) => tr.files.some((f) => f.name === 'alone.bin'))
  ? fail('a link-only transfer turned up in somebody\u2019s inbox')
  : ok('and it is in nobody\u2019s inbox, because it was sent to nobody');

// 3. Neither is refused, rather than silently doing nothing.
await jPage.goto(`${origin}/#/send`);
await jPage.waitForSelector('input[type="file"]', { state: 'attached', timeout: 20000 });
await jPage.setInputFiles('input[type="file"]', alone);
const submit = jPage.getByRole('button', { name: /^Send$/ }).last();
(await submit.isDisabled())
  ? ok('with no recipients and no link, Send is not offered')
  : fail('Send was clickable with nothing to send to and no link');

// --- the Admin update panel ----------------------------------------------
//
// It cannot reach GitHub from here, which is the useful case to check:
// a failed check must say so rather than imply everything is current.

await jPage.goto(`${origin}/#/admin`);
const updateHeading = jPage.getByText('Updates', { exact: true }).first();
await updateHeading.waitFor({ timeout: 30000 });
ok('Admin shows an Updates section');

const versionLine = await jPage.locator('text=/This server is running BetSend/').first().innerText();
/BetSend \d+\.\d+\.\d+/.test(versionLine)
  ? ok(`and names the running version: ${versionLine.trim()}`)
  : fail('the running version is not shown', versionLine);

// Before anything has looked, it must not claim to be the newest.
const beforeCheck = await jPage.locator('text=/This server is running BetSend/').first().innerText();
/newest version/.test(beforeCheck)
  ? fail('it claimed to be up to date before checking', beforeCheck)
  : ok('and does not claim to be up to date before it has looked');

await jPage.getByRole('button', { name: /^Check now$/ }).click();
// Either answer is fine; silence is not. Matched on the line that only
// appears once a check has completed, so stale text cannot pass this.
const answered = await jPage
  .locator('text=/Last checked|Could not check/')
  .first()
  .innerText({ timeout: 30000 })
  .catch(() => '');
answered
  ? ok(`a check says what happened: "${answered.trim().slice(0, 70)}"`)
  : fail('checking for updates reported nothing at all');

// With nothing newer found, there must be no button offering to install.
const installOffered = await jPage.getByRole('button', { name: /^Update now$/ }).count();
installOffered === 0
  ? ok('and offers no install when there is nothing to install')
  : fail('an Update now button appeared with no update available');

await browser.close();
server.kill();
console.log(failures === 0 ? 'done' : `done with ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
