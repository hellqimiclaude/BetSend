import fs from 'node:fs';
import path from 'node:path';

/**
 * Turning an Explorer right-click into a list of files to send.
 *
 * Windows runs the shell verb once per selected file. Right-click thirty
 * files and the app is launched thirty times, each with one path -- so the
 * paths arrive as a scatter of separate launches, a few milliseconds apart,
 * and have to be gathered back into one transfer before anybody sees them.
 * That gathering is what `LaunchCollector` does.
 *
 * Nothing here touches Electron, so it can be tested on its own.
 */

export interface StagedFile {
  /** Stable within a run; the renderer refers to files by this, never by path. */
  id: string;
  path: string;
  name: string;
  size: number;
}

export interface StagingResult {
  files: StagedFile[];
  /** Paths that could not be staged, with the reason, for telling the user. */
  skipped: { path: string; reason: string }[];
}

/** The switch the shell verb passes. Also accepts `--send=<path>`. */
export const SEND_FLAG = '--send';

/**
 * Pull the file paths out of a command line.
 *
 * Electron and Chromium add their own switches, and a dev run has a bare `.`
 * for the app directory, so this takes only what follows an explicit --send
 * rather than treating every non-switch argument as a file.
 */
export function pathsFromArgv(argv: readonly string[]): string[] {
  const paths: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === SEND_FLAG) {
      const next = argv[i + 1];
      // A bare --send at the end, or one followed by another switch, carries
      // no path -- which happens if the registry entry loses its "%1".
      if (next !== undefined && !next.startsWith('-')) {
        paths.push(next);
        i++;
      }
      continue;
    }
    if (arg.startsWith(`${SEND_FLAG}=`)) {
      const value = arg.slice(SEND_FLAG.length + 1);
      if (value) paths.push(value);
    }
  }

  return paths;
}

let counter = 0;

/**
 * Check the paths exist and are files, and measure them.
 *
 * Directories are refused rather than walked. A right-click on a folder could
 * mean four files or forty thousand, and silently starting the second is not
 * something anybody asked for.
 */
export function stageFiles(paths: readonly string[], alreadyStaged: readonly StagedFile[] = []): StagingResult {
  const files: StagedFile[] = [];
  const skipped: StagingResult['skipped'] = [];
  const seen = new Set(alreadyStaged.map((file) => path.resolve(file.path).toLowerCase()));

  for (const raw of paths) {
    const full = path.resolve(raw);
    // Windows paths are case-insensitive, and the shell is not consistent
    // about the case it hands over.
    const key = full.toLowerCase();
    if (seen.has(key)) continue;

    let stats: fs.Stats;
    try {
      stats = fs.statSync(full);
    } catch {
      skipped.push({ path: full, reason: 'it could not be found' });
      continue;
    }

    if (stats.isDirectory()) {
      skipped.push({ path: full, reason: 'it is a folder — send the files inside it instead' });
      continue;
    }
    if (!stats.isFile()) {
      skipped.push({ path: full, reason: 'it is not an ordinary file' });
      continue;
    }

    seen.add(key);
    files.push({ id: `s${++counter}`, path: full, name: path.basename(full), size: stats.size });
  }

  return { files, skipped };
}

/**
 * Gathers paths arriving from separate launches into one batch.
 *
 * The quiet period is what makes a thirty-file selection one transfer instead
 * of thirty. It is deliberately generous: a slow machine launching the app
 * thirty times can space them out, and waiting a moment longer costs nothing
 * next to splitting somebody's transfer in half.
 */
export class LaunchCollector {
  private pending: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly deliver: (paths: string[]) => void,
    private readonly quietMs = 600,
    private readonly schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> = setTimeout,
    private readonly unschedule: (handle: ReturnType<typeof setTimeout>) => void = clearTimeout,
  ) {}

  add(paths: readonly string[]): void {
    if (paths.length === 0) return;
    this.pending.push(...paths);
    if (this.timer !== null) this.unschedule(this.timer);
    this.timer = this.schedule(() => this.flush(), this.quietMs);
  }

  /** Deliver now, without waiting out the quiet period. */
  flush(): void {
    if (this.timer !== null) {
      this.unschedule(this.timer);
      this.timer = null;
    }
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    this.deliver(batch);
  }

  get waiting(): number {
    return this.pending.length;
  }
}
