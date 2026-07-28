import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { paths } from '../config.js';

/**
 * Uploaded bytes live in `<storageDir>/uploads/<blobId>`, written there by the
 * tus FileStore. tus also writes a `<blobId>.json` sidecar holding the resume
 * offset; both are removed together when a blob is released.
 */

export function blobPath(storageKey: string): string {
  return path.join(paths.uploads, path.basename(storageKey));
}

export function blobExists(storageKey: string): boolean {
  try {
    return fs.statSync(blobPath(storageKey)).isFile();
  } catch {
    return false;
  }
}

export function blobSizeOnDisk(storageKey: string): number {
  try {
    return fs.statSync(blobPath(storageKey)).size;
  } catch {
    return 0;
  }
}

export async function removeBlobFiles(storageKey: string): Promise<void> {
  const base = blobPath(storageKey);
  await Promise.all([
    fsp.rm(base, { force: true }),
    fsp.rm(`${base}.json`, { force: true }),
    // tus <= 1.x writes the sidecar next to the file; older layouts used a
    // separate directory. `force` makes both harmless if absent.
    fsp.rm(path.join(paths.uploads, `${path.basename(storageKey)}.info`), { force: true }),
  ]);
}

export interface DiskUsage {
  usedBytes: number;
  freeBytes: number;
  totalBytes: number;
}

export function diskUsage(): DiskUsage {
  try {
    const stats = fs.statfsSync(paths.root);
    const total = stats.blocks * stats.bsize;
    const free = stats.bavail * stats.bsize;
    return { usedBytes: total - free, freeBytes: free, totalBytes: total };
  } catch {
    return { usedBytes: 0, freeBytes: 0, totalBytes: 0 };
  }
}

/** Files sitting in the uploads dir with no matching blob row (crashed uploads). */
export async function listStrayFiles(knownKeys: Set<string>, olderThan: number): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fsp.readdir(paths.uploads);
  } catch {
    return [];
  }

  const stray: string[] = [];
  for (const entry of entries) {
    const key = entry.endsWith('.json') ? entry.slice(0, -5) : entry;
    if (knownKeys.has(key)) continue;
    try {
      const stat = await fsp.stat(path.join(paths.uploads, entry));
      if (stat.mtimeMs < olderThan) stray.push(entry);
    } catch {
      /* raced with another delete — ignore */
    }
  }
  return stray;
}

export async function removeStrayFile(entry: string): Promise<void> {
  await fsp.rm(path.join(paths.uploads, path.basename(entry)), { force: true });
}
