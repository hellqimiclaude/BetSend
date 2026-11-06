/**
 * When the app should look for a new version, and what it should say.
 *
 * The parts that can be wrong without anybody noticing live here, away from
 * Electron, so they can be tested: whether a check is due, whether it is
 * safe to restart, and the wording somebody reads in the tray.
 *
 * Nothing here downloads anything. main.ts owns electron-updater; this owns
 * the decisions it makes.
 */

/**
 * Often enough that a release put out in the morning is on people's
 * machines by the afternoon, without anybody restarting anything -- and
 * rare enough that a hundred and fifty machines behind one office
 * connection are not hammering the update feed.
 */
export const CHECK_EVERY_MS = 4 * 3600_000;
/** A short wait after launch, so a check never competes with opening. */
export const FIRST_CHECK_DELAY_MS = 60_000;
/**
 * How long "Later" lasts.
 *
 * An update nobody installs is an update that did not happen, so the
 * question comes back -- but a dialog that reappears every ten minutes is
 * one people learn to dismiss without reading, which is worse than not
 * asking.
 */
export const OFFER_AGAIN_AFTER_MS = 4 * 3600_000;

export interface UpdateState {
  /** The version waiting to be installed, once one has downloaded. */
  ready: string | null;
  /** Set while a download is in progress, as a whole percentage. */
  downloading: number | null;
  /** The last thing that went wrong, for the tray. */
  failed: string | null;
  lastCheckedAt: number | null;
  /** Set when somebody said "later", so they are not asked again at once. */
  deferredUntil: number | null;
}

export const NO_UPDATE: UpdateState = {
  ready: null,
  downloading: null,
  failed: null,
  lastCheckedAt: null,
  deferredUntil: null,
};

/**
 * Pull autoUpdater out of electron-updater, whichever shape it arrives in.
 *
 * electron-updater is CommonJS, this app is ESM, and it exposes
 * autoUpdater as a lazy getter rather than a plain property. Node finds a
 * CommonJS module's named exports by reading its source statically, and a
 * getter is not something that can see -- so `import { autoUpdater }`
 * gives undefined and the real object is only reachable through
 * `default`.
 *
 * This had never worked on any build. The first line of setup assigns to
 * autoUpdater.autoDownload, which threw a TypeError inside an async
 * import with nothing listening, so every "check" failed before it
 * started and said nothing at all.
 */
export function resolveAutoUpdater<T>(module: unknown): T | null {
  const shape = module as { autoUpdater?: T; default?: { autoUpdater?: T } } | null;
  return shape?.autoUpdater ?? shape?.default?.autoUpdater ?? null;
}

/**
 * Should the app check now?
 *
 * Never in a dev run: the version there is whatever package.json says, and
 * an updater pointed at the packaged releases would cheerfully try to
 * "upgrade" a checkout. Never while one is already downloading, and never
 * while one is sitting there waiting to be installed -- there is nothing a
 * second answer could usefully change.
 */
export function shouldCheck(
  state: UpdateState,
  options: { packaged: boolean; online: boolean; now: number; manual?: boolean },
): boolean {
  if (!options.packaged || !options.online) return false;
  if (state.ready !== null || state.downloading !== null) return false;
  // Somebody who picked "Check for updates" is owed an answer now, not
  // whenever the schedule next comes round.
  if (options.manual) return true;
  if (state.lastCheckedAt === null) return true;
  return options.now - state.lastCheckedAt >= CHECK_EVERY_MS;
}

/**
 * Is now a good moment to ask about installing?
 *
 * Nothing is asked while a transfer is moving -- the install restarts the
 * app -- and nothing is asked again inside the window "Later" buys.
 */
export function shouldOffer(
  state: UpdateState,
  options: { now: number; sending: boolean; receiving: boolean },
): boolean {
  if (state.ready === null) return false;
  if (!canInstallNow(options)) return false;
  if (state.deferredUntil !== null && options.now < state.deferredUntil) return false;
  return true;
}

/**
 * May the app restart itself to install?
 *
 * Only when nothing is moving. Replacing the executable underneath a
 * transfer would lose it -- an upload could be resumed afterwards, but a
 * direct transfer could not, and the colleague on the other end would be
 * left with a half-written file and no explanation.
 */
export function canInstallNow(options: { sending: boolean; receiving: boolean }): boolean {
  return !options.sending && !options.receiving;
}

/** What the tray says about updates, or null when there is nothing to say. */
export function trayLabel(state: UpdateState): string | null {
  if (state.ready) return `Restart to update to ${state.ready}`;
  if (state.downloading !== null) return `Downloading update — ${state.downloading}%`;
  return null;
}

/**
 * A line in the tray saying when it last looked and what it found.
 *
 * Added because its absence cost an afternoon. The checks are silent by
 * design, which means a failing one and a successful one look identical
 * from outside: when an update did not arrive there was no way for
 * anybody, including whoever wrote this, to find out whether it had been
 * refused, had failed, or had never run at all.
 */
export function lastCheckLabel(state: UpdateState, now: number): string {
  if (state.lastCheckedAt === null) return 'Not checked for updates yet';

  const minutes = Math.floor((now - state.lastCheckedAt) / 60_000);
  const when =
    minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : `${Math.floor(minutes / 60)}h ago`;

  if (state.failed) return `Update check ${when}: ${state.failed}`;
  if (state.ready) return `Checked ${when}: ${state.ready} ready`;
  if (state.downloading !== null) return `Checked ${when}: downloading`;
  return `Checked ${when}: up to date`;
}

/**
 * Whether a failure is worth telling somebody about.
 *
 * Almost never. A failed update check means the app carries on exactly as
 * it did yesterday, and a popup about github.com being unreachable would be
 * noise on a network that may have no way out by design. It is recorded for
 * the tray and the log, and that is all.
 */
export function describeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/ENOTFOUND|EAI_AGAIN|ENETUNREACH|ETIMEDOUT/i.test(message)) {
    return 'Could not reach the update server.';
  }
  if (/404/.test(message)) return 'No published release to update to.';
  return message.slice(0, 200);
}
