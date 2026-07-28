/**
 * In-memory sliding-window rate limiting.
 *
 * Enough for a single-process app with 150 users: it protects the login and
 * admin-token endpoints from being brute-forced, and it costs nothing. It
 * resets on restart, which is an acceptable trade for not adding Redis to an
 * office tool.
 */

interface Bucket {
  hits: number[];
  blockedUntil: number;
}

const buckets = new Map<string, Bucket>();

let sweeper: NodeJS.Timeout | null = null;

function ensureSweeper(): void {
  if (sweeper) return;
  // Keep the map from growing forever on a long-running server.
  sweeper = setInterval(() => {
    const cutoff = Date.now() - 3600_000;
    for (const [key, bucket] of buckets) {
      if (bucket.blockedUntil < Date.now() && (bucket.hits.at(-1) ?? 0) < cutoff) {
        buckets.delete(key);
      }
    }
  }, 600_000);
  sweeper.unref?.();
}

export interface LimitOptions {
  /** Attempts allowed inside the window. */
  max: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** How long to lock the key out once the limit is passed. */
  blockMs: number;
}

export interface LimitResult {
  allowed: boolean;
  /** Seconds until the caller may try again. Only meaningful when blocked. */
  retryAfter: number;
}

/** Record an attempt and report whether it is allowed. */
export function hit(key: string, options: LimitOptions): LimitResult {
  ensureSweeper();

  const nowMs = Date.now();
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { hits: [], blockedUntil: 0 };
    buckets.set(key, bucket);
  }

  if (bucket.blockedUntil > nowMs) {
    return { allowed: false, retryAfter: Math.ceil((bucket.blockedUntil - nowMs) / 1000) };
  }

  const windowStart = nowMs - options.windowMs;
  bucket.hits = bucket.hits.filter((at) => at > windowStart);
  bucket.hits.push(nowMs);

  if (bucket.hits.length > options.max) {
    bucket.blockedUntil = nowMs + options.blockMs;
    bucket.hits = [];
    return { allowed: false, retryAfter: Math.ceil(options.blockMs / 1000) };
  }

  return { allowed: true, retryAfter: 0 };
}

/** Called after a successful login so one bad typo does not count against you. */
export function clear(key: string): void {
  buckets.delete(key);
}

export const LOGIN_LIMIT: LimitOptions = { max: 8, windowMs: 15 * 60_000, blockMs: 15 * 60_000 };
export const ADMIN_LIMIT: LimitOptions = { max: 5, windowMs: 15 * 60_000, blockMs: 30 * 60_000 };
export const SETUP_LIMIT: LimitOptions = { max: 10, windowMs: 60 * 60_000, blockMs: 60 * 60_000 };
