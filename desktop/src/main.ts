import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  shell,
  Tray,
  type IpcMainInvokeEvent,
} from 'electron';
import { healthUrl, isSameServer, parseAddress } from './address.js';
import { explainNetworkFailure, unreachableMessage } from './failure.js';
import { readSettings, writeSettings, type Settings } from './settings.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
const HEALTH_TIMEOUT_MS = 4000;

let settings: Settings = readSettings(SETTINGS_FILE);
let mainWindow: BrowserWindow | null = null;
let setupWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
/** Set on quit so closing the window hides to the tray instead of exiting. */
let quitting = false;

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
  app.on('second-instance', () => showMainWindow());
  void start();
}

async function start(): Promise<void> {
  await app.whenReady();
  applyStartWithWindows();
  registerIpc();
  createTray();

  if (settings.serverUrl) {
    openMainWindow(settings.serverUrl);
  } else {
    openSetupWindow();
  }

  app.on('activate', () => showMainWindow());
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
      // The window shows a remote page, so it gets no privileges at all.
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
  tray?.setContextMenu(
    Menu.buildFromTemplate([
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
        click: () => {
          quitting = true;
          app.quit();
        },
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

process.on('uncaughtException', (err) => {
  console.error(err);
  if (app.isReady()) {
    dialog.showErrorBox('BetSend', `Something went wrong:\n\n${err.message}`);
  }
});
