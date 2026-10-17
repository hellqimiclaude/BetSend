import fs from 'node:fs';
import path from 'node:path';
import { fingerprintFor, type StagedFile } from './staging.js';

export { fingerprintFor };

/**
 * The transfer that was in flight when the app stopped.
 *
 * Uploads run in this process, so closing the window no longer loses them --
 * but quitting, a crash or a reboot still did. This is what survives that:
 * which files, to whom, and the note. tus keeps its own record of how far
 * each file got, so between the two there is enough to carry on rather than
 * start a 10 GB file again.
 *
 * One at a time. A queue would be a different feature, and a half-built one
 * is worse than none.
 */

/** The same thing a staged file is; it has simply outlived one run. */
export type PendingFile = StagedFile;

export interface PendingSend {
  files: PendingFile[];
  recipients: string[];
  note: string;
  startedAt: number;
}

export function readPending(file: string): PendingSend | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const raw = parsed as Record<string, unknown>;
  const recipients = Array.isArray(raw.recipients)
    ? raw.recipients.filter((r): r is string => typeof r === 'string' && r.length > 0)
    : [];
  const files = Array.isArray(raw.files) ? raw.files.map(readFile).filter((f): f is PendingFile => f !== null) : [];

  // Either half missing makes the record useless; better to drop it than to
  // resume a transfer addressed to nobody.
  if (files.length === 0 || recipients.length === 0) return null;

  return {
    files,
    recipients,
    note: typeof raw.note === 'string' ? raw.note : '',
    startedAt: typeof raw.startedAt === 'number' ? raw.startedAt : Date.now(),
  };
}

function readFile(raw: unknown): PendingFile | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const f = raw as Record<string, unknown>;
  if (typeof f.path !== 'string' || typeof f.name !== 'string') return null;
  const size = Number(f.size);
  if (!Number.isFinite(size) || size < 0) return null;
  return {
    id: typeof f.id === 'string' ? f.id : `p${Math.random().toString(36).slice(2, 8)}`,
    path: f.path,
    name: f.name,
    size,
    fingerprint: typeof f.fingerprint === 'string' ? f.fingerprint : '',
  };
}

export function writePending(file: string, send: PendingSend): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(send, null, 2), 'utf8');
}

export function clearPending(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* nothing to clear */
  }
}

export interface ResumeCheck {
  resumable: PendingFile[];
  /** Files that changed or vanished while the app was not running. */
  gone: { name: string; reason: string }[];
}

/**
 * Which of a pending send's files can still be continued.
 *
 * A file that has been moved, deleted or edited since cannot be: the bytes
 * on the server came from the old one, and finishing it with the new one
 * would produce something that was never on anybody's disk.
 */
export function checkResumable(send: PendingSend): ResumeCheck {
  const resumable: PendingFile[] = [];
  const gone: ResumeCheck['gone'] = [];

  for (const file of send.files) {
    let stats: fs.Stats;
    try {
      stats = fs.statSync(file.path);
    } catch {
      gone.push({ name: file.name, reason: 'it is no longer where it was' });
      continue;
    }
    if (!stats.isFile()) {
      gone.push({ name: file.name, reason: 'it is no longer a file' });
      continue;
    }
    if (fingerprintFor(file.path, stats.size, stats.mtimeMs) !== file.fingerprint) {
      gone.push({ name: file.name, reason: 'it has changed since the transfer started' });
      continue;
    }
    resumable.push(file);
  }

  return { resumable, gone };
}
