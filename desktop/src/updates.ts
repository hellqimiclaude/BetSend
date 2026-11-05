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

/** Once a day is plenty for an office app, and it is 150 machines. */
export const CHECK_EVERY_MS = 24 * 3600_000;
/** A short wait after launch, so a check never competes with opening. */
export const FIRST_CHECK_DELAY_MS = 60_000;

export interface UpdateState {
  /** The version waiting to be installed, once one has downloaded. */
  ready: string | null;
  /** Set while a download is in progress, as a whole percentage. */
  downloading: number | null;
  /** The last thing that went wrong, for the tray. */
  failed: string | null;
  lastCheckedAt: number | null;
}

export const NO_UPDATE: UpdateState = {
  ready: null,
  downloading: null,
  failed: null,
  lastCheckedAt: null,
};

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
  options: { packaged: boolean; online: boolean; now: number },
): boolean {
  if (!options.packaged || !options.online) return false;
  if (state.ready !== null || state.downloading !== null) return false;
  if (state.lastCheckedAt === null) return true;
  return options.now - state.lastCheckedAt >= CHECK_EVERY_MS;
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
