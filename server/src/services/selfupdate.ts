import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from '../config.js';
import { getDb } from '../db/index.js';

/**
 * Noticing a new BetSend, and installing it when an administrator says so.
 *
 * Deliberately not automatic. One machine serves the whole office, there is
 * nobody watching it, and a server that fails to come back is an outage
 * nobody can explain. A person pressing a button has chosen the moment;
 * three in the afternoon on a Tuesday is not a moment anything should
 * choose for itself.
 *
 * What it does do is remove the part nobody enjoys: finding the release,
 * downloading the right one of two installers, and running it with the
 * flags that leave the configuration alone.
 */

/** The server's own manifest, published beside the installers. */
export interface UpdateManifest {
  version: string;
  file: string;
  sha256: string;
  size: number;
}

export interface UpdateStatus {
  current: string;
  /** The newer version on offer, or null when this is the newest. */
  available: string | null;
  checkedAt: number | null;
  /** Why the last check failed, if it did. */
  error: string | null;
  /** Set while an install is under way, so the page can say so. */
  installing: boolean;
}

let status: UpdateStatus = {
  current: '',
  available: null,
  checkedAt: null,
  error: null,
  installing: false,
};

let manifest: UpdateManifest | null = null;

export function updateStatus(current: string): UpdateStatus {
  return { ...status, current };
}

/** Test seam, and a way to drop a stale answer after an upgrade. */
export function resetUpdateStatus(): void {
  status = { current: '', available: null, checkedAt: null, error: null, installing: false };
  manifest = null;
}

/**
 * Compare two dotted versions numerically.
 *
 * Not a semver library: these are three numbers produced by this
 * repository's own release process, and a dependency to compare them would
 * be more surface than the problem deserves. Anything unparseable sorts as
 * zero, so a malformed feed can never look newer than what is installed.
 */
export function isNewer(candidate: string, current: string): boolean {
  const parts = (value: string): number[] =>
    value
      .trim()
      .replace(/^v/, '')
      .split('.')
      // Digits only. parseInt is lenient -- it reads "99999999999999999999x"
      // as a perfectly good enormous number -- and a version that has been
      // tampered with must sort as nothing, not as the largest thing here.
      .map((piece) => (/^\d+$/.test(piece) ? Number(piece) : 0));

  const a = parts(candidate);
  const b = parts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left > right;
  }
  return false;
}

/** Everything a manifest has to say before it is worth acting on. */
export function readManifest(raw: unknown): UpdateManifest | null {
  const value = (raw ?? {}) as Record<string, unknown>;
  const version = typeof value.version === 'string' ? value.version.trim() : '';
  const file = typeof value.file === 'string' ? value.file.trim() : '';
  const sha256 = typeof value.sha256 === 'string' ? value.sha256.trim().toLowerCase() : '';
  const size = Number(value.size);

  if (!/^\d+(\.\d+)*$/.test(version)) return null;
  // The name becomes part of a URL and a path on disk, so nothing that
  // could climb out of the folder it is downloaded into.
  if (!/^[A-Za-z0-9._-]+\.exe$/.test(file)) return null;
  if (!/^[a-f0-9]{64}$/.test(sha256)) return null;
  if (!Number.isInteger(size) || size <= 0) return null;

  return { version, file, sha256, size };
}

function feedBase(): string {
  return `https://github.com/${config.updateRepo}/releases/latest/download`;
}

/** Ask the feed what the newest release is. Never throws. */
export async function checkForUpdate(current: string): Promise<UpdateStatus> {
  try {
    const response = await fetch(`${feedBase()}/server-latest.json`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`the update feed answered with ${response.status}`);

    const parsed = readManifest(await response.json());
    if (!parsed) throw new Error('the update feed returned something unreadable');

    manifest = parsed;
    status = {
      ...status,
      checkedAt: Date.now(),
      error: null,
      available: isNewer(parsed.version, current) ? parsed.version : null,
    };
  } catch (err) {
    manifest = null;
    status = {
      ...status,
      checkedAt: Date.now(),
      available: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  return updateStatus(current);
}

/** Uploads still arriving. Restarting now would interrupt them. */
export function uploadsInFlight(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM uploads').get() as { n: number };
  return row.n;
}

export type InstallRefusal =
  | { ok: false; reason: string; code: string }
  | { ok: true; version: string };

/**
 * Download the installer, check it is what the feed said, and hand over.
 *
 * The installer stops this server, replaces its files and starts it again,
 * so nothing after the handover runs. That is why the checksum is verified
 * first: this is the one place where the office's file server runs an
 * executable it fetched off the internet, and the only thing standing
 * between a corrupted or substituted download and all of it is this
 * comparison.
 */
export async function applyUpdate(current: string): Promise<InstallRefusal> {
  if (status.installing) return { ok: false, reason: 'An update is already being installed.', code: 'busy' };
  if (!manifest || !status.available) {
    return { ok: false, reason: 'There is no update to install. Check again first.', code: 'nothing_to_do' };
  }
  if (!isNewer(manifest.version, current)) {
    return { ok: false, reason: `BetSend ${current} is already the newest version.`, code: 'up_to_date' };
  }

  const waiting = uploadsInFlight();
  if (waiting > 0) {
    return {
      ok: false,
      reason: `${waiting} upload(s) are still arriving. Updating now would interrupt them — try again shortly.`,
      code: 'uploads_in_flight',
    };
  }
  if (process.platform !== 'win32') {
    return { ok: false, reason: 'Updating from here is only supported on Windows.', code: 'unsupported' };
  }

  status = { ...status, installing: true };
  const wanted = manifest;

  try {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'betsend-update-'));
    const target = path.join(folder, wanted.file);

    const response = await fetch(`${feedBase()}/${encodeURIComponent(wanted.file)}`, {
      signal: AbortSignal.timeout(20 * 60_000),
    });
    if (!response.ok || !response.body) throw new Error(`the download answered with ${response.status}`);

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== wanted.size) {
      throw new Error(`the download is ${bytes.length} bytes, expected ${wanted.size}`);
    }

    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    if (digest !== wanted.sha256) {
      throw new Error('the download does not match the checksum the feed published');
    }

    fs.writeFileSync(target, bytes);

    /*
     * Detached, because the installer's first act is to stop this process.
     * A child would be killed with it, halfway through replacing the files
     * it had been asked to replace.
     *
     * No /DIR and no settings: the installer keeps the existing
     * config.json when it is run silently, which is the whole reason this
     * can be safe at all.
     */
    const child = spawn(target, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();

    return { ok: true, version: wanted.version };
  } catch (err) {
    status = { ...status, installing: false, error: err instanceof Error ? err.message : String(err) };
    return { ok: false, reason: status.error ?? 'The update could not be installed.', code: 'failed' };
  }
}
