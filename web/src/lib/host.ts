/**
 * The desktop app, seen from the page.
 *
 * BetSend is served to an ordinary browser and to an Electron window, and the
 * same bundle runs in both. Where the window is hosted by the desktop app it
 * injects `betsendHost`; everywhere else this returns null and the app behaves
 * exactly as it always has.
 *
 * It exists because a page cannot upload a file it was only told the name of.
 * When the user right-clicks files in Explorer, the app holds them and does
 * the uploading; the page collects recipients and watches progress.
 */

export interface HostStagedFile {
  id: string;
  name: string;
  size: number;
}

export interface HostProgress {
  files: { id: string; name: string; size: number; bytesUploaded: number; status: string; error?: string }[];
  bytesUploaded: number;
  bytesTotal: number;
  fraction: number;
  filesDone: number;
  running: boolean;
}

export interface HostBridge {
  version: number;
  staged(): Promise<HostStagedFile[]>;
  stagePicked(files: File[]): Promise<{ files: HostStagedFile[]; skipped: { name: string; reason: string }[] }>;
  unstage(id: string): Promise<HostStagedFile[]>;
  clear(): Promise<void>;
  send(recipients: string[], note: string): Promise<{ ok: boolean; error?: string }>;
  cancel(): Promise<void>;
  onStagedChanged(callback: (files: HostStagedFile[]) => void): () => void;
  onProgress(callback: (progress: HostProgress) => void): () => void;
}

/** The versions of the bridge this build knows how to talk to. */
const SUPPORTED = 1;

/**
 * Returns the bridge, or null in a browser.
 *
 * The version check matters because the two halves ship separately: somebody
 * can upgrade the server without upgrading the desktop app, leaving a new
 * page talking to an old host. Refusing an unknown version falls back to
 * ordinary browser uploads, which always work, instead of calling something
 * that is not there.
 */
export function hostBridge(): HostBridge | null {
  const candidate = (globalThis as { betsendHost?: Partial<HostBridge> }).betsendHost;
  if (!candidate || candidate.version !== SUPPORTED) return null;
  if (typeof candidate.send !== 'function' || typeof candidate.staged !== 'function') return null;
  return candidate as HostBridge;
}

/** Is this page running inside the desktop app? */
export function inDesktopApp(): boolean {
  return hostBridge() !== null;
}
