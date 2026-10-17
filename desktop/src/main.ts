import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  shell,
  Tray,
  session as electronSession,
  type IpcMainInvokeEvent,
} from 'electron';
import { healthUrl, isSameServer, parseAddress } from './address.js';
import { explainNetworkFailure, unreachableMessage } from './failure.js';
import { COOKIE_NAME, sessionCookieFor } from './host.js';
import { Outbox } from './outbox.js';
import { checkResumable, clearPending, readPending, writePending, type PendingFile } from './pending.js';
import { readSettings, writeSettings, type Settings } from './settings.js';
import { LaunchCollector, pathsFromArgv } from './staging.js';
import { HostUploadBatch, type BatchProgress } from './uploader.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
/** The transfer that was in flight, so it can be carried on after a restart. */
const PENDING_FILE = path.join(app.getPath('userData'), 'pending.json');
/** Where tus records how far each file got. */
const TUS_URLS_FILE = path.join(app.getPath('userData'), 'tus-urls.json');
const HEALTH_TIMEOUT_MS = 4000;

let settings: Settings = readSettings(SETTINGS_FILE);
let mainWindow: BrowserWindow | null = null;
let setupWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
/** Set on quit so closing the window hides to the tray instead of exiting. */
let quitting = false;

/** Files the user right-clicked in Explorer, waiting for recipients. */
const outbox = new Outbox();
let sending: HostUploadBatch | null = null;
/** The latest progress, for the tray and for a window that opens mid-send. */
let lastProgress: BatchProgress | null = null;

/**
 * Windows runs the shell verb once per selected file, so a multi-file
 * right-click arrives as a burst of launches. Gather them before showing
 * anybody, or a thirty-file selection becomes thirty transfers.
 */
const launches = new LaunchCollector((paths) => acceptPaths(paths));

/**
 * One instance only.
 *
 * Two windows onto the same server would be merely untidy today, but stage two
 * sends file paths from Explorer's right-click menu into the running app, and
 * that needs a single known instance to send them to.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    launches.add(pathsFromArgv(argv));
    showMainWindow();
  });
  void start();
}

async function start(): Promise<void> {
  await app.whenReady();
  applyStartWithWindows();
  registerIpc();
  registerHostIpc();
  createTray();

  // Files from the launch that started the app, as opposed to a later
  // right-click arriving through 'second-instance'.
  launches.add(pathsFromArgv(process.argv));

  if (settings.serverUrl) {
    openMainWindow(settings.serverUrl);
  } else {
    openSetupWindow();
  }

  app.on('activate', () => showMainWindow());

  watchForSignIn();

  // After the window exists, so its notifications and progress have somewhere
  // to go.
  void resumePending();
}

// Closing the last window is not quitting: the app sits in the tray so a
// transfer can finish and a notification can still arrive.
app.on('window-all-closed', () => {
  /* held open by the tray */
});

app.on('before-quit', () => {
  quitting = true;
});

// --- settings ---------------------------------------------------------------

function save(changes: Partial<Settings>): void {
  settings = { ...settings, ...changes };
  try {
    writeSettings(SETTINGS_FILE, settings);
  } catch (err) {
    // Not worth interrupting anybody over: it means the window size or the
    // address will not be remembered, and the app still works.
    console.error('could not save settings:', err);
  }
}

function applyStartWithWindows(): void {
  // Not supported in a dev run from the source tree, and setting it there
  // would register the path of a checkout that may not exist tomorrow.
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: settings.startWithWindows, args: ['--hidden'] });
}

// --- windows ----------------------------------------------------------------

function openMainWindow(serverUrl: string): void {
  if (mainWindow) {
    mainWindow.loadURL(serverUrl);
    showMainWindow();
    return;
  }

  const saved = settings.window;
  mainWindow = new BrowserWindow({
    width: saved?.width ?? 1100,
    height: saved?.height ?? 780,
    ...(saved?.x !== undefined && saved.y !== undefined ? { x: saved.x, y: saved.y } : {}),
    minWidth: 420,
    minHeight: 480,
    show: false,
    title: 'BetSend',
    // BetLive's page background, so there is no white flash before the
    // app paints its own dark theme.
    backgroundColor: '#101118',
    autoHideMenuBar: true,
    webPreferences: {
      // The window shows a remote page, so it gets no privileges beyond the
      // host bridge -- which exposes three calls about files the user has
      // already chosen in Explorer, and no way to name a file itself.
      preload: path.join(here, 'host-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (saved?.maximized) mainWindow.maximize();
  Menu.setApplicationMenu(null);

  guardNavigation(mainWindow, serverUrl);
  rememberGeometry(mainWindow);

  mainWindow.once('ready-to-show', () => {
    if (!process.argv.includes('--hidden')) mainWindow?.show();
  });

  // A reload, a sign-in or a navigation loses whatever the page was told, so
  // hand the staged files over again once it is ready to receive them.
  mainWindow.webContents.on('did-finish-load', () => {
    publishStaged();
    // A window opened in the middle of a transfer should show it, not an
    // idle screen with a progress bar that only appears on the next tick.
    if (lastProgress) mainWindow?.webContents.send('host:progress', lastProgress);
  });

  mainWindow.on('close', (event) => {
    // The X button hides; quitting is done from the tray.
    if (quitting) return;
    event.preventDefault();
    mainWindow?.hide();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    // -3 is ERR_ABORTED, which a cancelled navigation raises routinely.
    if (!isMainFrame || code === -3) return;
    showUnreachable(serverUrl, `${description} (${code})`, url);
  });

  void mainWindow.loadURL(serverUrl);
}

function showMainWindow(): void {
  if (!mainWindow) {
    if (settings.serverUrl) openMainWindow(settings.serverUrl);
    else openSetupWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/**
 * Quitting with an upload running loses nothing permanently -- it resumes on
 * the next run -- but the recipient does not get the files until then, which
 * is not what somebody closing a tray icon usually has in mind.
 */
async function quitSafely(): Promise<void> {
  if (sending && lastProgress?.running) {
    const { response } = await dialog.showMessageBox({
      type: 'question',
      buttons: ['Keep sending', 'Quit anyway'],
      defaultId: 0,
      cancelId: 0,
      title: 'BetSend',
      message: 'A transfer is still going.',
      detail: 'Quitting stops it. It will carry on from where it stopped the next time BetSend opens.',
    });
    if (response === 0) return;
  }
  quitting = true;
  app.quit();
}

function openSetupWindow(): void {
  if (setupWindow) {
    setupWindow.focus();
    return;
  }

  setupWindow = new BrowserWindow({
    width: 520,
    height: 460,
    resizable: false,
    title: 'BetSend',
    backgroundColor: '#101118',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  Menu.setApplicationMenu(null);
  setupWindow.on('closed', () => {
    setupWindow = null;
    // Nothing to show and nothing configured: there is no app without a
    // server, so closing the setup window means giving up for now.
    if (!settings.serverUrl && !mainWindow) {
      quitting = true;
      app.quit();
    }
  });

  void setupWindow.loadFile(path.join(here, 'setup.html'));
}

/**
 * The window exists to show one server. A link in a transfer note, or a
 * redirect to something pretending to be a sign-in page, must not be able to
 * take it somewhere else -- there is no address bar here for anyone to check.
 */
function guardNavigation(window: BrowserWindow, serverUrl: string): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, url) => {
    if (isSameServer(serverUrl, url)) return;
    event.preventDefault();
    void shell.openExternal(url);
  });

  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
}

function rememberGeometry(window: BrowserWindow): void {
  const store = (): void => {
    if (!window || window.isDestroyed() || window.isMinimized()) return;
    const maximized = window.isMaximized();
    // getNormalBounds is the un-maximized size, which is what should come
    // back when somebody un-maximizes later.
    const bounds = window.getNormalBounds();
    save({ window: { ...bounds, maximized } });
  };

  window.on('resize', store);
  window.on('move', store);
  window.on('maximize', store);
  window.on('unmaximize', store);
}

function showUnreachable(serverUrl: string, reason: string, url: string): void {
  if (!mainWindow) return;
  const page = `data:text/html;charset=utf-8,${encodeURIComponent(unreachableHtml(serverUrl, reason, url))}`;
  void mainWindow.loadURL(page);
}

function unreachableHtml(serverUrl: string, reason: string, url: string): string {
  const safe = (text: string): string =>
    text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>BetSend</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.6 Inter, "Segoe UI", system-ui, sans-serif; margin: 0; display: grid;
         place-items: center; min-height: 100vh; background: #f7f7f9; color: #101118; padding: 24px; }
  @media (prefers-color-scheme: dark) { body { background: #101118; color: #eeeef2; } }
  .card { max-width: 30rem; }
  h1 { font: 700 1.25rem/1.3 Montserrat, "Segoe UI", system-ui, sans-serif; margin: 0 0 .5rem; }
  p { margin: .5rem 0; }
  code { font-size: .9em; opacity: .8; word-break: break-all; }
  ul { padding-left: 1.2rem; }
</style></head>
<body><div class="card">
  <h1>Cannot reach BetSend</h1>
  <p>Nothing answered at <code>${safe(serverUrl)}</code>.</p>
  <ul>
    <li>Is the office PC that runs BetSend switched on?</li>
    <li>Are you on the office network, or connected to the VPN?</li>
    <li>Has the address changed? Open the tray icon and choose <b>Change server address</b>.</li>
  </ul>
  <p><code>${safe(reason)}</code><br><code>${safe(url)}</code></p>
</div></body></html>`;
}

// --- tray -------------------------------------------------------------------

function createTray(): void {
  const icon = nativeImage.createFromPath(path.join(here, 'icon.png'));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('BetSend');
  refreshTrayMenu();
  tray.on('click', () => showMainWindow());
}

function refreshTrayMenu(): void {
  if (!tray) return;

  // The window is often hidden while this runs -- that is the point of
  // uploading out here -- so the tray is the only place progress shows.
  const busy = lastProgress?.running ?? false;
  const percent = busy ? Math.floor((lastProgress?.fraction ?? 0) * 100) : 0;
  const remaining = busy ? (lastProgress?.files.length ?? 0) - (lastProgress?.filesDone ?? 0) : 0;

  tray.setToolTip(busy ? `BetSend — sending, ${percent}%` : 'BetSend');

  tray.setContextMenu(
    Menu.buildFromTemplate([
      ...(busy
        ? ([
            { label: `Sending ${remaining} file(s) — ${percent}%`, enabled: false },
            { label: 'Cancel transfer', click: () => void sending?.cancel() },
            { type: 'separator' },
          ] as Electron.MenuItemConstructorOptions[])
        : []),
      { label: 'Open BetSend', click: () => showMainWindow() },
      { type: 'separator' },
      {
        label: 'Start with Windows',
        type: 'checkbox',
        checked: settings.startWithWindows,
        click: (item) => {
          save({ startWithWindows: item.checked });
          applyStartWithWindows();
        },
      },
      { label: 'Change server address...', click: () => openSetupWindow() },
      { type: 'separator' },
      {
        label: 'Quit BetSend',
        click: () => void quitSafely(),
      },
    ]),
  );
}

// --- setup window plumbing --------------------------------------------------

function registerIpc(): void {
  ipcMain.handle('betsend:current-address', () => settings.serverUrl ?? '');

  /**
   * Try what somebody typed and report which address answered.
   *
   * The probe is the point: a typo, the wrong port and a server that is simply
   * off all look identical in a text box, and telling them apart afterwards is
   * what the "cannot reach" page exists to apologise for.
   */
  ipcMain.handle('betsend:try-address', async (_event: IpcMainInvokeEvent, raw: unknown) => {
    const parsed = parseAddress(typeof raw === 'string' ? raw : '');
    if (!parsed.ok) return { ok: false as const, error: parsed.error };

    const failures: string[] = [];
    for (const candidate of parsed.candidates) {
      const outcome = await probe(candidate);
      if (outcome.ok) return { ok: true as const, url: candidate };
      failures.push(outcome.error);
    }

    return { ok: false as const, error: unreachableMessage(parsed.candidates, failures[0]) };
  });

  ipcMain.handle('betsend:use-address', (_event: IpcMainInvokeEvent, raw: unknown) => {
    const url = typeof raw === 'string' ? raw : '';
    const parsed = parseAddress(url);
    if (!parsed.ok) return { ok: false as const, error: parsed.error };

    save({ serverUrl: parsed.candidates[0] });
    refreshTrayMenu();

    setupWindow?.close();
    // A different server means a different set of people and a different
    // session, so the window is rebuilt rather than merely re-pointed.
    if (mainWindow) {
      mainWindow.destroy();
      mainWindow = null;
    }
    openMainWindow(parsed.candidates[0]);
    return { ok: true as const };
  });
}

async function probe(origin: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response = await fetch(healthUrl(origin), {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return { ok: false, error: `It answered with ${response.status}.` };

    // Something answered, but is it BetSend? A proxy or another service on
    // that port would otherwise be accepted and then show a blank window.
    const body = (await response.json()) as { ok?: unknown };
    if (body?.ok !== true) return { ok: false, error: 'Something answered, but it is not BetSend.' };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: explainNetworkFailure(err) };
  }
}

// --- files from the Explorer right-click menu -------------------------------

function acceptPaths(paths: string[]): void {
  const { skipped } = outbox.add(paths);

  if (skipped.length > 0 && outbox.files.length === 0) {
    // Nothing usable arrived, so say why rather than opening an empty window.
    dialog.showMessageBox({
      type: 'info',
      title: 'BetSend',
      message: skipped.length === 1 ? 'That file cannot be sent.' : 'Those files cannot be sent.',
      detail: skipped.map((s) => `${path.basename(s.path)} — ${s.reason}`).join('\n'),
    });
    return;
  }

  publishStaged();
  showMainWindow();
}

function publishStaged(): void {
  mainWindow?.webContents.send('host:staged-changed', outbox.forRenderer());
}

function registerHostIpc(): void {
  ipcMain.handle('host:staged', () => outbox.forRenderer());

  /**
   * Files dropped on the page, routed through the host so the desktop app
   * uploads everything the same way. The paths come from the preload's
   * getPathForFile, so they are files the user themselves chose.
   */
  ipcMain.handle('host:stage-paths', (_event, paths: unknown) => {
    const list = Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string') : [];
    const { skipped } = outbox.add(list);
    publishStaged();
    return { files: outbox.forRenderer(), skipped: skipped.map((s) => ({ name: path.basename(s.path), reason: s.reason })) };
  });

  ipcMain.handle('host:unstage', (_event, id: unknown) => {
    if (typeof id === 'string') outbox.remove(id);
    return outbox.forRenderer();
  });

  ipcMain.handle('host:clear', () => {
    outbox.clear();
    publishStaged();
  });

  ipcMain.handle('host:cancel', async () => {
    await sending?.cancel();
    sending = null;
  });

  /**
   * Upload everything staged, then commit it as one transfer.
   *
   * The commit is the same call the web page makes; only the upload differs,
   * because only this process can read a file off the disk.
   */
  ipcMain.handle('host:send', async (_event, input: unknown) => {
    const { recipients, note } = (input ?? {}) as { recipients?: unknown; note?: unknown };
    const to = Array.isArray(recipients) ? recipients.filter((r): r is string => typeof r === 'string') : [];

    if (outbox.files.length === 0) return { ok: false, error: 'There are no files to send.' };
    if (to.length === 0) return { ok: false, error: 'Choose at least one person to send to.' };
    if (sending) return { ok: false, error: 'A transfer is already going.' };

    const files = [...outbox.files];
    const result = await performSend(files, to, typeof note === 'string' ? note : '');
    if (result.ok) {
      outbox.clear();
      publishStaged();
    }
    return result;
  });
}

// --- sending ----------------------------------------------------------------

/**
 * Upload the files and commit the transfer, writing down what is in flight
 * first so a restart can pick it up.
 *
 * The record is deliberately written before the first byte: a crash two
 * seconds in should still be resumable, and an orphaned record costs nothing
 * -- it is checked against the disk before anything is retried.
 */
async function performSend(
  files: PendingFile[],
  recipients: string[],
  note: string,
): Promise<{ ok: boolean; error?: string }> {
  const origin = settings.serverUrl;
  if (!origin) return { ok: false, error: 'No server address is set.' };

  const cookie = await sessionCookieFor(origin);
  if (!cookie) return { ok: false, error: 'You are not signed in. Open BetSend, sign in, and try again.' };

  writePending(PENDING_FILE, { files, recipients, note, startedAt: Date.now() });

  const batch = new HostUploadBatch(files, {
    origin,
    cookie,
    chunkSize: 8 * 1024 * 1024,
    urlStoragePath: TUS_URLS_FILE,
    onProgress: (progress) => {
      lastProgress = progress;
      mainWindow?.webContents.send('host:progress', progress);
      mainWindow?.setProgressBar(progress.running ? progress.fraction : -1);
      refreshTrayMenu();
    },
  });
  sending = batch;

  try {
    const uploads = await batch.start();

    const response = await fetch(`${origin.replace(/\/+$/, '')}/api/transfers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ uploads, recipients, note }),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
      const error = body?.error?.message ?? `The server refused the transfer (${response.status}).`;
      announce('BetSend could not send your files', error);
      return { ok: false, error };
    }

    clearPending(PENDING_FILE);
    announce(
      files.length === 1 ? `${files[0].name} sent` : `${files.length} files sent`,
      `Delivered to ${recipients.join(', ')}.`,
    );
    return { ok: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // The record stays: this is exactly the case resuming exists for.
    announce('BetSend could not send your files', error);
    return { ok: false, error };
  } finally {
    sending = null;
    lastProgress = null;
    mainWindow?.setProgressBar(-1);
    refreshTrayMenu();
  }
}

/**
 * Carry on a transfer the app was in the middle of when it stopped.
 *
 * Silent when there is nothing to do. When there is, it says so rather than
 * uploading in the background unannounced -- somebody who quit mid-transfer
 * and reopened the app a day later deserves to know it started again.
 */
async function resumePending(): Promise<void> {
  if (sending) return;

  const pending = readPending(PENDING_FILE);
  if (!pending) return;

  /*
   * The session cookie normally outlives a restart, but not if it expired,
   * the user signed out, or the jar was cleared. Leave the record alone and
   * come back after the next sign-in rather than announcing a failure for
   * something that is about to be fixed by itself.
   */
  const origin = settings.serverUrl;
  if (!origin || !(await sessionCookieFor(origin))) return;

  const { resumable, gone } = checkResumable(pending);

  if (resumable.length === 0) {
    clearPending(PENDING_FILE);
    announce('BetSend could not finish an earlier transfer', gone[0]?.reason ?? 'The files are no longer available.');
    return;
  }

  if (gone.length > 0) {
    // Some of it can go on, but not all, and sending half of what somebody
    // asked for without telling them would be worse than stopping.
    clearPending(PENDING_FILE);
    announce(
      'An earlier transfer could not be finished',
      `${gone.map((g) => g.name).join(', ')} — ${gone[0].reason}. Send them again.`,
    );
    return;
  }

  announce('Carrying on with an earlier transfer', `${resumable.length} file(s) to ${pending.recipients.join(', ')}.`);
  await performSend(resumable, pending.recipients, pending.note);
}

/**
 * Notice when somebody signs in, so a transfer that was waiting for a session
 * can get going.
 *
 * The obvious hook -- the page finishing a load -- is the wrong one: signing
 * in happens inside the single-page app with no navigation at all, so that
 * event never comes. A cookie appearing in the jar is the actual moment.
 */
function watchForSignIn(): void {
  electronSession.defaultSession.cookies.on('changed', (_event, cookie, _cause, removed) => {
    if (removed || cookie.name !== COOKIE_NAME) return;
    void resumePending();
  });
}

function announce(title: string, body: string): void {
  if (!Notification.isSupported()) return;
  try {
    new Notification({ title, body, icon: path.join(here, 'icon.png') }).show();
  } catch {
    /* a notification failing is never worth interrupting a transfer over */
  }
}

process.on('uncaughtException', (err) => {
  console.error(err);
  if (app.isReady()) {
    dialog.showErrorBox('BetSend', `Something went wrong:\n\n${err.message}`);
  }
});
