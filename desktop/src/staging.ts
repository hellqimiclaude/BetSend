import crypto from 'node:crypto';
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
  /**
   * Identifies the file to tus so a half-finished upload can be picked up on
   * the next run. See fingerprintFor.
   */
  fingerprint: string;
}

/**
 * Path, size and modification time.
 *
 * Size and mtime are in it deliberately: if somebody edits a file while it is
 * half uploaded, resuming would splice the old bytes onto the new and the
 * recipient would get a file that never existed. A changed fingerprint makes
 * tus start again, which is the only correct answer.
 */
export function fingerprintFor(file: string, size: number, mtimeMs: number): string {
  return crypto
    .createHash('sha256')
    .update(`${path.resolve(file).toLowerCase()}|${size}|${Math.floor(mtimeMs)}`)
    .digest('hex')
    .slice(0, 32);
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
 * Harder than it should be, because Chromium rewrites the command line before
 * the app ever sees it. Launch BetSend with `--send C:\report.pdf` and what
 * arrives is:
 *
 *     ["BetSend.exe", "--user-data-dir=...", "--send",
 *      "--allow-file-access-from-files", ".", "C:\report.pdf"]
 *
 * Every switch has been gathered to the front and every positional argument
 * pushed to the end, so `--send` and its path are no longer next to each
 * other. Reading "the argument after --send" finds another switch, refuses
 * it, and stages nothing -- which is precisely what happened: the right-click
 * menu worked, the window came forward, and the file vanished.
 *
 * So: `--send=<path>` first, which survives the reordering because Chromium
 * keeps a switch and its value together. Failing that, a bare `--send`
 * switch means the paths are among the positional arguments at the end.
 */
export function pathsFromArgv(argv: readonly string[]): string[] {
  const attached: string[] = [];
  let sawBareSendSwitch = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg.startsWith(`${SEND_FLAG}=`)) {
      const value = arg.slice(SEND_FLAG.length + 1);
      if (value) attached.push(value);
      continue;
    }

    if (arg === SEND_FLAG) {
      // Either the value follows directly (an unreordered command line) or
      // it has been moved to the positionals.
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        attached.push(next);
        i++;
      } else {
        sawBareSendSwitch = true;
      }
    }
  }

  if (attached.length > 0) return attached;
  if (!sawBareSendSwitch) return [];

  return positionalArguments(argv);
}

/**
 * The non-switch arguments, minus the things that are never files.
 *
 * argv[0] is the executable. "." is the app directory in a development run.
 * Everything else at the tail of a reordered command line is what the user
 * actually pointed at.
 */
function positionalArguments(argv: readonly string[]): string[] {
  return argv.slice(1).filter((arg) => !arg.startsWith('-') && arg !== '.' && arg.length > 0);
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
    files.push({
      id: `s${++counter}`,
      path: full,
      name: path.basename(full),
      size: stats.size,
      fingerprint: fingerprintFor(full, stats.size, stats.mtimeMs),
    });
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
