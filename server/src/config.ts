import fs from 'node:fs';
import path from 'node:path';

/**
 * Static configuration: read once at boot from (in order of precedence)
 * environment variables > config.json > defaults.
 *
 * A subset of these values (retention, max size, delete-after-download,
 * registration mode) can be overridden at runtime from the Admin page; those
 * live in the `settings` table and are read through `runtimeSettings.ts`.
 */

export interface AppConfig {
  host: string;
  port: number;
  /** Root directory for everything we persist: sqlite db + uploaded bytes. */
  storageDir: string;
  dbPath: string;
  adminToken: string;
  /** Defaults for the runtime-overridable settings. */
  retentionHours: number;
  maxUploadSize: number; // bytes; 0 = unlimited
  deleteAfterAllDownloaded: boolean;
  registrationMode: 'open' | 'list';
  /** Upload chunk size advertised to the browser, in MB. */
  chunkSizeMb: number;
  /** How often the retention sweeper runs. */
  cleanupIntervalMinutes: number;
  /** Uncommitted uploads older than this are swept away. */
  orphanUploadHours: number;
  logLevel: string;
}

const DEFAULTS = {
  host: '0.0.0.0',
  port: 8080,
  storageDir: 'data',
  adminToken: 'change-me',
  retentionHours: 72,
  maxUploadSize: 0,
  deleteAfterAllDownloaded: true,
  registrationMode: 'open' as const,
  chunkSizeMb: 8,
  cleanupIntervalMinutes: 10,
  orphanUploadHours: 24,
  logLevel: 'info',
};

function readConfigFile(): Record<string, unknown> {
  const explicit = process.env.CONFIG_FILE;
  const candidates = explicit ? [explicit] : [path.resolve(process.cwd(), 'config.json')];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return JSON.parse(fs.readFileSync(candidate, 'utf8')) as Record<string, unknown>;
      }
    } catch (err) {
      throw new Error(`Could not read config file ${candidate}: ${(err as Error).message}`);
    }
  }
  return {};
}

function pickString(env: string | undefined, file: unknown, fallback: string): string {
  if (env !== undefined && env !== '') return env;
  if (typeof file === 'string' && file !== '') return file;
  return fallback;
}

function pickNumber(env: string | undefined, file: unknown, fallback: number): number {
  const raw = env !== undefined && env !== '' ? env : file;
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function pickBool(env: string | undefined, file: unknown, fallback: boolean): boolean {
  const raw = env !== undefined && env !== '' ? env : file;
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw === 'boolean') return raw;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

export function loadConfig(): AppConfig {
  const file = readConfigFile();
  const storageDir = path.resolve(
    pickString(process.env.STORAGE_DIR, file.storageDir, DEFAULTS.storageDir),
  );
  const registrationMode = pickString(
    process.env.REGISTRATION_MODE,
    file.registrationMode,
    DEFAULTS.registrationMode,
  );

  return {
    host: pickString(process.env.HOST, file.host, DEFAULTS.host),
    port: pickNumber(process.env.PORT, file.port, DEFAULTS.port),
    storageDir,
    dbPath: path.resolve(
      pickString(process.env.DB_PATH, file.dbPath, path.join(storageDir, 'betsend.db')),
    ),
    adminToken: pickString(process.env.ADMIN_TOKEN, file.adminToken, DEFAULTS.adminToken),
    retentionHours: pickNumber(process.env.RETENTION_HOURS, file.retentionHours, DEFAULTS.retentionHours),
    maxUploadSize: pickNumber(process.env.MAX_UPLOAD_SIZE, file.maxUploadSize, DEFAULTS.maxUploadSize),
    deleteAfterAllDownloaded: pickBool(
      process.env.DELETE_AFTER_ALL_DOWNLOADED,
      file.deleteAfterAllDownloaded,
      DEFAULTS.deleteAfterAllDownloaded,
    ),
    registrationMode: registrationMode === 'list' ? 'list' : 'open',
    chunkSizeMb: pickNumber(process.env.CHUNK_SIZE_MB, file.chunkSizeMb, DEFAULTS.chunkSizeMb),
    cleanupIntervalMinutes: pickNumber(
      process.env.CLEANUP_INTERVAL_MINUTES,
      file.cleanupIntervalMinutes,
      DEFAULTS.cleanupIntervalMinutes,
    ),
    orphanUploadHours: pickNumber(
      process.env.ORPHAN_UPLOAD_HOURS,
      file.orphanUploadHours,
      DEFAULTS.orphanUploadHours,
    ),
    logLevel: pickString(process.env.LOG_LEVEL, file.logLevel, DEFAULTS.logLevel),
  };
}

export const config = loadConfig();

export const paths = {
  root: config.storageDir,
  uploads: path.join(config.storageDir, 'uploads'),
};

export function ensureDirs(): void {
  fs.mkdirSync(paths.root, { recursive: true });
  fs.mkdirSync(paths.uploads, { recursive: true });
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
}
