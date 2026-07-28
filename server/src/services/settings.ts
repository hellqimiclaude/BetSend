import { getDb } from '../db/index.js';
import { config } from '../config.js';

/**
 * Admin-editable settings. Values live in the `settings` table and fall back to
 * the boot config when unset. `storageDir` is shown in the admin UI but only
 * takes effect after a restart — everything else is live.
 */
export interface RuntimeSettings {
  retentionHours: number;
  maxUploadSize: number; // bytes; 0 = unlimited
  deleteAfterAllDownloaded: boolean;
  registrationMode: 'open' | 'list';
  storageDir: string;
  /**
   * How someone gets their first password.
   *   invite — only via a one-time link an admin generated (default when public)
   *   claim  — anyone whose name is on the staff list can set one themselves
   */
  signupMode: 'invite' | 'claim';
}

const KEYS: (keyof RuntimeSettings)[] = [
  'retentionHours',
  'maxUploadSize',
  'deleteAfterAllDownloaded',
  'registrationMode',
  'storageDir',
  'signupMode',
];

function defaults(): RuntimeSettings {
  return {
    retentionHours: config.retentionHours,
    maxUploadSize: config.maxUploadSize,
    deleteAfterAllDownloaded: config.deleteAfterAllDownloaded,
    registrationMode: config.registrationMode,
    storageDir: config.storageDir,
    // Exposed to the internet, an open claim flow is a land-grab; require an
    // invite unless an admin deliberately relaxes it.
    signupMode: config.publicMode ? 'invite' : 'claim',
  };
}

let cache: RuntimeSettings | null = null;

export function getSettings(): RuntimeSettings {
  if (cache) return cache;

  const rows = getDb().prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const stored = new Map(rows.map((r) => [r.key, r.value]));
  const base = defaults();
  const out = { ...base };

  for (const key of KEYS) {
    const raw = stored.get(key);
    if (raw === undefined) continue;
    switch (key) {
      case 'retentionHours':
      case 'maxUploadSize': {
        const n = Number(raw);
        if (Number.isFinite(n) && n >= 0) out[key] = n;
        break;
      }
      case 'deleteAfterAllDownloaded':
        out[key] = raw === 'true';
        break;
      case 'registrationMode':
        out[key] = raw === 'list' ? 'list' : 'open';
        break;
      case 'signupMode':
        out[key] = raw === 'claim' ? 'claim' : 'invite';
        break;
      case 'storageDir':
        if (raw) out[key] = raw;
        break;
    }
  }

  cache = out;
  return out;
}

export function updateSettings(patch: Partial<RuntimeSettings>): RuntimeSettings {
  const db = getDb();
  const stmt = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );

  const write = db.transaction(() => {
    for (const key of KEYS) {
      const value = patch[key];
      if (value === undefined) continue;
      stmt.run(key, String(value));
    }
  });
  write();

  cache = null;
  return getSettings();
}

/** Drop the memo — used by tests and after a bulk settings import. */
export function invalidateSettings(): void {
  cache = null;
}
