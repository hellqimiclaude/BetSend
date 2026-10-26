/**
 * The desktop app, driven as a person would drive it.
 *
 * Everything under test/ runs modules in isolation; main.ts is the one file
 * none of it touches, and main.ts is where the window, the tray, the IPC and
 * the peer plumbing are actually wired together. A typo in a channel name
 * typechecks perfectly and breaks the whole feature, so this starts the real
 * app against a real server and clicks through it.
 *
 * Not part of `npm test`: it wants Playwright and, on Linux, an X server,
 * neither of which is a dependency of this repository.
 *
 *   npm run build -w desktop
 *   xvfb-run -a node desktop/test/e2e/smoke.mjs      # Linux
 *   node desktop/test/e2e/smoke.mjs                  # Windows or macOS
 */
import { createRequire } from 'node:module';

// Playwright may be installed in the repo or globally; this script is not
// worth a dependency of its own.
const electron = await (async () => {
  const require = createRequire(import.meta.url);
  for (const candidate of ['playwright', '/opt/node-tools/node_modules/playwright/index.js']) {
    try {
      return require(candidate)._electron;
    } catch {
      /* try the next one */
    }
  }
  throw new Error('Playwright is not installed. `npm i -g playwright`, or add it to the repo.');
})();
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const repoRoot = '/home/user/BetSend';
const ADMIN_TOKEN = 'smoke-token';
const PASSWORD = 'spare-anchor-violet';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'betsend-smoke-'));

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const ok = (label) => console.log(`  ok  ${label}`);
const fail = (label, detail) => {
  console.log(`FAIL  ${label}${detail ? `\n      ${detail}` : ''}`);
  process.exitCode = 1;
};

const port = await freePort();
const origin = `http://127.0.0.1:${port}`;
const configFile = path.join(work, 'config.json');
fs.writeFileSync(
  configFile,
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
  env: { ...process.env, CONFIG_FILE: configFile, STORAGE_DIR: path.join(work, 'data') },
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

// A second account, so the app has somebody to send to.
await fetch(`${origin}/api/admin/users/import`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie: adminCookie },
  body: JSON.stringify({ text: 'k.kelly@betlive.com' }),
});
const linkRes = await fetch(`${origin}/api/admin/users/K.Kelly/setup-link`, {
  method: 'POST',
  headers: { cookie: adminCookie },
});
const { link } = await linkRes.json();
const setupToken = decodeURIComponent(/token=([^&]+)/.exec(link)[1]);
const setup = await fetch(`${origin}/api/setup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ token: setupToken, password: PASSWORD }),
});
if (setup.status !== 200) throw new Error(`setup: ${await setup.text()}`);
const kellyCookie = cookieOf(setup);

// --- the app -----------------------------------------------------------
const userData = path.join(work, 'userdata');
fs.mkdirSync(userData, { recursive: true });
fs.writeFileSync(
  path.join(userData, 'settings.json'),
  JSON.stringify({ serverUrl: origin, startWithWindows: false, window: null }),
);

// Big enough to measure. The app throws away any transfer that finished
// in under 100ms, because a file that quick says more about the overhead
// than about the link -- and 2 MB over loopback lands on either side of
// that line depending on the day.
const sample = path.join(work, 'report.pdf');
fs.writeFileSync(sample, crypto.randomBytes(48 * 1024 * 1024));

const app = await electron.launch({
  executablePath: path.join(repoRoot, 'node_modules/electron/dist/electron'),
  args: [path.join(repoRoot, 'desktop/dist/main.js'), `--user-data-dir=${userData}`, `--send=${sample}`],
  cwd: repoRoot,
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
});

const page = await app.firstWindow();
await page.waitForLoadState('domcontentloaded');

const crashes = [];
page.on('pageerror', (e) => crashes.push(String(e)));

// Sign in as Kelly, so the app is a different person from the one probing.
await page.waitForSelector('input[type="email"]', { timeout: 30000 });
await page.fill('input[type="email"]', 'k.kelly@betlive.com');
await page.fill('input[type="password"]', PASSWORD);
await page.click('button[type="submit"]');
await page.waitForSelector('nav, aside', { timeout: 30000 });
ok('the app starts and signs in');

// 1. Did it announce itself? Ask the server as somebody else.
let announced = false;
for (let i = 0; i < 40; i++) {
  const r = await fetch(`${origin}/api/peer/K.Kelly`, { headers: { cookie: adminCookie } });
  if (r.ok && (await r.json()).direct === true) {
    announced = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 250));
}
announced
  ? ok('it opened a port and announced it to the server')
  : fail('it never announced a listening port');

// 2. Are the right-clicked files staged?
//    Polled, not sampled: the app deliberately waits out a quiet period
//    before publishing a batch, because Windows runs the shell verb once
//    per selected file and thirty of them must become one transfer.
let staged = [];
for (let i = 0; i < 40; i++) {
  staged = await page.evaluate(() => window.betsendHost?.staged?.() ?? []);
  if (staged.length > 0) break;
  await new Promise((r) => setTimeout(r, 250));
}
staged.length === 1 && staged[0].name === 'report.pdf'
  ? ok('the right-clicked file is staged')
  : fail('the right-clicked file is not staged', JSON.stringify(staged));

// 3. Does host:routes answer, and is the bridge version what the page expects?
const routes = await page.evaluate(() => window.betsendHost.routes(['J.Johnson']));
console.log('      routes ->', JSON.stringify(routes));
routes && typeof routes.bytes === 'number' && Array.isArray(routes.reachable)
  ? ok('host:routes answers in the shape the chooser expects')
  : fail('host:routes returned something unusable');
routes.server.text === 'time unknown' && routes.direct.text === 'time unknown'
  ? ok('with nothing measured, it says so rather than guessing')
  : fail('invented an estimate from no measurements', JSON.stringify(routes));
routes.unreachable.includes('J.Johnson') && routes.reachable.length === 0
  ? ok('somebody with no app running is reported unreachable')
  : fail('reachability is wrong', JSON.stringify(routes));

// 4. The chooser: pick a recipient who IS reachable and press Send.
//    Kelly's own app is the only listener, so make Johnson one too.
const johnsonPort = await freePort();
// Accepts, then hangs up. A colleague whose app is running but whose
// connection dies -- the exact case the fallback exists for, and fast
// enough to test, unlike waiting out a socket timeout.
const listener = net.createServer((socket) => socket.destroy());
await new Promise((r) => listener.listen(johnsonPort, '0.0.0.0', r));
await fetch(`${origin}/api/peer/announce`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie: adminCookie },
  body: JSON.stringify({ port: johnsonPort }),
});

const reachable = await page.evaluate(() => window.betsendHost.routes(['J.Johnson']));
reachable.reachable.includes('J.Johnson')
  ? ok('a colleague with the app open is reported reachable')
  : fail('a listening colleague was not seen', JSON.stringify(reachable));

await page.getByText('J.Johnson', { exact: false }).first().click();
await page.getByRole('button', { name: /^Send$/ }).last().click();

const dialog = page.getByRole('dialog');
try {
  await dialog.waitFor({ timeout: 10000 });
  ok('the chooser appears when there is a real choice');
  const text = await dialog.innerText();
  console.log('      dialog:', text.replace(/\n+/g, ' | '));
  /Straight to their PC/.test(text) && /Through the server/.test(text)
    ? ok('it offers both routes')
    : fail('the chooser is missing a route', text);
} catch (err) {
  fail('the chooser never appeared', String(err).slice(0, 300));
  await page.screenshot({ path: '/tmp/claude-0/-home-user-BetSend/7c27e1dd-f10b-5f4e-a8a7-aa64b5c9f3d7/scratchpad/chooser-missing.png' });
}

// 5. Choose direct, and watch it fall back to the server all by itself.
await dialog.getByText('Straight to their PC').click();
await dialog.getByRole('button', { name: /^Send$/ }).click();

let inbox = [];
for (let i = 0; i < 120; i++) {
  const r = await fetch(`${origin}/api/inbox`, { headers: { cookie: adminCookie } });
  if (r.ok) {
    const body = await r.json();
    inbox = body.transfers ?? body.items ?? (Array.isArray(body) ? body : []);
    if (inbox.length > 0) break;
  }
  await new Promise((r) => setTimeout(r, 500));
}
inbox.length === 1
  ? ok('direct failed, the server leg took over, and the file arrived')
  : fail('nothing arrived after the direct route failed', JSON.stringify(inbox).slice(0, 300));

// 6. Having actually measured one, the estimate stops being unknown.
const measured = await page.evaluate(() => window.betsendHost.routes(['J.Johnson']));
console.log('      routes after one transfer ->', JSON.stringify(measured));
measured.server.seconds !== null
  ? ok('the server estimate is now measured, not unknown')
  : fail('a finished transfer taught it nothing', JSON.stringify(measured));
measured.direct.seconds === null
  ? ok('the direct estimate is still unknown, because no direct transfer finished')
  : fail('it invented a direct estimate from a server transfer');

listener.close();

// 7. A direct transfer that actually works, end to end.
//    Johnson is now a real BetSend receiver -- the same code the desktop app
//    runs -- checking the token with the real server before accepting a byte.
const { PeerReceiver } = await import(path.join(repoRoot, 'desktop/dist/peer/receiver.js'));
const { PeerLink } = await import(path.join(repoRoot, 'desktop/dist/peer/link.js'));

const johnsonLink = new PeerLink(origin, adminCookie);
const johnsonInbox = path.join(work, 'johnson-inbox');
const johnsonApp = new PeerReceiver({
  destination: johnsonInbox,
  claim: (token) => johnsonLink.claim(token),
  complete: (token, okFlag) => johnsonLink.complete(token, okFlag),
});
const johnsonPeerPort = await johnsonApp.listen(0);
await johnsonLink.announce(johnsonPeerPort);

// Stage a second file the way Explorer does: another launch of the same app,
// which the running instance picks up and gathers.
const second = path.join(work, 'contract.pdf');
fs.writeFileSync(second, crypto.randomBytes(3 * 1024 * 1024));
const relaunchLog = fs.openSync(path.join(work, 'relaunch.log'), 'w');
spawn(path.join(repoRoot, 'node_modules/electron/dist/electron'), [
  path.join(repoRoot, 'desktop/dist/main.js'),
  // Only because this container runs as root; Windows needs nothing of the
  // sort, and Playwright passes it to the first app for the same reason.
  '--no-sandbox',
  `--user-data-dir=${userData}`,
  `--send=${second}`,
], { stdio: ['ignore', relaunchLog, relaunchLog], detached: false });

let restaged = [];
for (let i = 0; i < 60; i++) {
  restaged = await page.evaluate(() => window.betsendHost?.staged?.() ?? []);
  if (restaged.length > 0) break;
  await new Promise((r) => setTimeout(r, 500));
}
restaged.length === 1 && restaged[0].name === 'contract.pdf'
  ? ok('a second right-click reaches the running app')
  : fail('the second launch staged nothing', fs.readFileSync(path.join(work, 'relaunch.log'), 'utf8').slice(0, 800) || '(the second process printed nothing)');

if (restaged.length === 0) {
  await app.close();
  server.kill();
  process.exit(1);
}

await page.getByText('J.Johnson', { exact: false }).first().click();
await page.getByRole('button', { name: /^Send$/ }).last().click();
const dialog2 = page.getByRole('dialog');
await dialog2.waitFor({ timeout: 10000 });
await dialog2.getByText('Straight to their PC').click();
await dialog2.getByRole('button', { name: /^Send$/ }).click();

let landed = false;
for (let i = 0; i < 120; i++) {
  if (fs.existsSync(path.join(johnsonInbox, 'contract.pdf'))) { landed = true; break; }
  await new Promise((r) => setTimeout(r, 250));
}
landed
  ? ok('the file arrived on the other machine')
  : fail('the direct transfer never landed', JSON.stringify(fs.existsSync(johnsonInbox) ? fs.readdirSync(johnsonInbox) : 'no folder'));

if (landed) {
  const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  sha(path.join(johnsonInbox, 'contract.pdf')) === sha(second)
    ? ok('byte for byte')
    : fail('the file that arrived is not the file that was sent');
}

// 8. The server never saw the bytes, but it did record that it happened.
let sentRow = null;
for (let i = 0; i < 40; i++) {
  const r = await fetch(`${origin}/api/sent`, { headers: { cookie: kellyCookie } });
  if (r.ok) {
    sentRow = (await r.json()).transfers.find((tr) => tr.delivery === 'direct') ?? null;
    if (sentRow) break;
  }
  await new Promise((r) => setTimeout(r, 250));
}
sentRow
  ? ok('it shows on the sender\u2019s Sent page, marked as direct')
  : fail('a direct transfer left no trace on the Sent page');
if (sentRow) {
  sentRow.files.length === 1 && sentRow.files[0].name === 'contract.pdf' && sentRow.totalSize === 3 * 1024 * 1024
    ? ok('with the right file and size')
    : fail('the recorded file list is wrong', JSON.stringify(sentRow.files));
}

const johnsonInboxRows = await (await fetch(`${origin}/api/inbox`, { headers: { cookie: adminCookie } })).json();
const arrival = johnsonInboxRows.transfers.find((tr) => tr.delivery === 'direct');
arrival && arrival.sender.name === 'K.Kelly'
  ? ok('and in the recipient\u2019s Inbox, from the right person')
  : fail('the recipient has no record of it', JSON.stringify(johnsonInboxRows.transfers));

// 9. Nothing was stored. The whole point.
const stored = fs.readdirSync(path.join(work, 'data'), { recursive: true }).map(String);
stored.some((f) => f.includes('contract'))
  ? fail('the server kept a copy of a file it only brokered')
  : ok('the server kept no copy of it');

await johnsonApp.close();
await johnsonLink.unannounce();

if (crashes.length) fail('the page threw', crashes.join('\n      '));

await app.close();
server.kill();
console.log('done');
process.exit(process.exitCode ?? 0);
