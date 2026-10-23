import fs from 'node:fs';
import path from 'node:path';

/**
 * How fast each route has actually been, so the app can say how long a
 * transfer will take instead of guessing.
 *
 * There is no way to know this in advance. An office LAN might be gigabit
 * to the desk and a hundred megabits over an old switch in the corner; the
 * server PC might be busy. So nothing is assumed: the app times every
 * transfer it finishes and answers from what it has measured. Until it has
 * measured something it says it does not know, which is honest and is also
 * what somebody would rather read than a number that turns out to be
 * wrong by a factor of ten.
 *
 * Kept in its own file rather than in settings.json. This one is written
 * after every transfer and is of no interest to a human; settings.json is
 * the one somebody opens in Notepad to fix a wrong server address, and
 * mixing a machine-written log into it would be unkind.
 */

export type Route = 'direct' | 'server';

export interface Sample {
  bytes: number;
  milliseconds: number;
}

export interface History {
  direct: Sample[];
  server: Sample[];
}

export const EMPTY: History = { direct: [], server: [] };

/** Enough to ride out one odd transfer, few enough to follow a real change. */
const KEEP = 10;

/**
 * Below these, a transfer measures the overhead rather than the link.
 *
 * A 20 KB file that finishes in four milliseconds implies five gigabytes a
 * second, which would then be used to promise that a 4 GB folder takes one
 * second. Small transfers are timed and thrown away.
 */
const MIN_BYTES = 512 * 1024;
const MIN_MS = 100;

export function isUseful(sample: Sample): boolean {
  return (
    Number.isFinite(sample.bytes) &&
    Number.isFinite(sample.milliseconds) &&
    sample.bytes >= MIN_BYTES &&
    sample.milliseconds >= MIN_MS
  );
}

/** Adds a sample if it is worth keeping, and forgets the oldest. */
export function record(history: History, route: Route, sample: Sample): History {
  if (!isUseful(sample)) return history;
  const kept = [...history[route], sample].slice(-KEEP);
  return { ...history, [route]: kept };
}

/**
 * The rate to plan with, or null if nothing has been measured.
 *
 * The median, not the mean: one transfer that stalled while somebody's
 * machine went to sleep should not drag every future estimate down with
 * it, and on a LAN that is the common kind of outlier.
 */
export function bytesPerSecond(history: History, route: Route): number | null {
  const rates = history[route]
    .filter(isUseful)
    .map((sample) => (sample.bytes / sample.milliseconds) * 1000)
    .sort((a, b) => a - b);

  if (rates.length === 0) return null;

  const middle = Math.floor(rates.length / 2);
  return rates.length % 2 === 1 ? rates[middle] : (rates[middle - 1] + rates[middle]) / 2;
}

/**
 * How long `bytes` should take on this route, in seconds, or null if the
 * app has nothing to base that on.
 */
export function estimateSeconds(history: History, route: Route, bytes: number): number | null {
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  const rate = bytesPerSecond(history, route);
  if (rate === null || rate <= 0) return null;
  // Never promise instant: a transfer has a handshake, and a round number
  // of zero seconds reads as a bug.
  return Math.max(1, bytes / rate);
}

/**
 * An estimate in words, in the shape somebody waiting would say it.
 *
 * Deliberately vague at the top end. "About 20 minutes" is a useful thing
 * to be told; "19 minutes 43 seconds" is a promise that will be broken.
 */
export function describeSeconds(seconds: number | null): string {
  if (seconds === null) return 'time unknown';
  if (seconds < 10) return 'a few seconds';
  if (seconds < 60) return `about ${Math.round(seconds / 5) * 5} seconds`;
  if (seconds < 90) return 'about a minute';

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} minutes`;

  const hours = seconds / 3600;
  if (hours < 1.75) return 'about an hour';
  return `about ${Math.round(hours)} hours`;
}

export function readHistory(file: string): History {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return { ...EMPTY };
  }
  if (typeof parsed !== 'object' || parsed === null) return { ...EMPTY };

  const raw = parsed as Record<string, unknown>;
  return { direct: readSamples(raw.direct), server: readSamples(raw.server) };
}

function readSamples(raw: unknown): Sample[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      const sample = (entry ?? {}) as Record<string, unknown>;
      return { bytes: Number(sample.bytes), milliseconds: Number(sample.milliseconds) };
    })
    .filter(isUseful)
    .slice(-KEEP);
}

export function writeHistory(file: string, history: History): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(history), { encoding: 'utf8' });
}
