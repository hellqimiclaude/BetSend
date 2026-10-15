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
  /**
   * Refuse to start an upload that would leave less than this much free space.
   * Keeps one careless (or malicious) sender from filling the disk and taking
   * everybody else's transfers down with it.
   */
  minFreeDiskBytes: number;
  /** Cap on bytes one person may have uploaded but not yet sent. 0 = no cap. */
  perUserUploadBytes: number;
  logLevel: string;

  // --- public deployment -------------------------------------------------
  /**
   * Set when BetSend is reachable from outside the office. Turns on secure
   * cookies, HSTS, and proxy-aware client IPs. Leave false for a LAN install.
   */
  publicMode: boolean;
  /** Trust X-Forwarded-* headers. Required when behind Caddy/nginx. */
  behindProxy: boolean;
  /** e.g. https://files.example.com — used in generated setup links. */
  publicUrl: string;
  /** How long a login lasts before the user must sign in again. */
  sessionDays: number;

  // --- mail --------------------------------------------------------------
  /**
   * The office mail relay. Exchange on the LAN normally accepts unauthenticated
   * mail from an internal address on port 25, which is why user and password
   * are optional and `secure` defaults off.
   */
  smtpHost: string;
  smtpPort: number;
  /** Implicit TLS from the first byte (port 465). Exchange rarely uses this. */
  smtpSecure: boolean;
  /** Upgrade to TLS with STARTTLS where the relay offers it. */
  smtpRequireTls: boolean;
  /** Internal relays often present a self-signed certificate. */
  smtpRejectUnauthorized: boolean;
  smtpUser: string;
  smtpPassword: string;
  /** Envelope sender, e.g. "BetSend <betsend@company.com>". */
  smtpFrom: string;
  /**
   * Addresses must end in one of these to register. This is what replaces a
   * hand-curated staff list: only the office mail system can deliver to them.
   */
  emailDomains: string[];
  /** Make an admin approve each new account even after the address is verified. */
  requireAdminApproval: boolean;
  /** Email recipients when files arrive. The point of store-and-forward. */
  notifyByEmail: boolean;
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
  minFreeDiskBytes: 2 * 1024 * 1024 * 1024, // 2 GiB
  perUserUploadBytes: 0,
  logLevel: 'info',
  publicMode: false,
  behindProxy: false,
  publicUrl: '',
  sessionDays: 30,
  smtpHost: '',
  smtpPort: 25,
  smtpSecure: false,
  smtpRequireTls: false,
  smtpRejectUnauthorized: false,
  smtpUser: '',
  smtpPassword: '',
  smtpFrom: '',
  // The office domain. Only addresses here can register, which is what
  // proves somebody works at BetLive. Override for a different company.
  emailDomains: ['betlive.com'] as string[],
  requireAdminApproval: false,
  notifyByEmail: true,
};

/** Absolute path of the config file that was loaded, for logging. */
export let configFilePath: string | null = null;

/**
 * Find config.json by walking up from the working directory.
 *
 * Walking up matters: `npm run seed` executes inside the `server` workspace, so
 * its cwd is `server/` while config.json lives at the repository root. Looking
 * only at cwd meant the seed script quietly wrote to a different database than
 * the server was reading.
 */
function readConfigFile(): Record<string, unknown> {
  const candidates: string[] = [];

  if (process.env.CONFIG_FILE) {
    candidates.push(path.resolve(process.env.CONFIG_FILE));
  } else {
    let dir = process.cwd();
    for (;;) {
      candidates.push(path.join(dir, 'config.json'));
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as Record<string, unknown>;
      configFilePath = candidate;
      return parsed;
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

/**
 * A comma-separated env var, or a JSON array in the config file.
 *
 * An explicitly empty list is honoured as "no restriction" rather than
 * falling back to the default, so an admin can genuinely turn the check off.
 */
function pickList(env: string | undefined, file: unknown, fallback: string[]): string[] {
  const source = env !== undefined ? env : file;
  if (source === undefined || source === null) return fallback;
  if (Array.isArray(source)) return source.map((v) => String(v).trim()).filter(Boolean);
  if (typeof source === 'string') {
    return source.split(',').map((v) => v.trim()).filter(Boolean);
  }
  return fallback;
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
    minFreeDiskBytes: pickNumber(process.env.MIN_FREE_DISK_BYTES, file.minFreeDiskBytes, DEFAULTS.minFreeDiskBytes),
    perUserUploadBytes: pickNumber(
      process.env.PER_USER_UPLOAD_BYTES,
      file.perUserUploadBytes,
      DEFAULTS.perUserUploadBytes,
    ),
    logLevel: pickString(process.env.LOG_LEVEL, file.logLevel, DEFAULTS.logLevel),

    publicMode: pickBool(process.env.PUBLIC_MODE, file.publicMode, DEFAULTS.publicMode),
    // Behind a reverse proxy is implied by public mode, but can be set alone
    // (e.g. an internal nginx on the LAN).
    behindProxy: pickBool(
      process.env.BEHIND_PROXY,
      file.behindProxy,
      pickBool(process.env.PUBLIC_MODE, file.publicMode, DEFAULTS.publicMode),
    ),
    publicUrl: pickString(process.env.PUBLIC_URL, file.publicUrl, DEFAULTS.publicUrl).replace(/\/+$/, ''),
    sessionDays: pickNumber(process.env.SESSION_DAYS, file.sessionDays, DEFAULTS.sessionDays),

    smtpHost: pickString(process.env.SMTP_HOST, file.smtpHost, DEFAULTS.smtpHost),
    smtpPort: pickNumber(process.env.SMTP_PORT, file.smtpPort, DEFAULTS.smtpPort),
    smtpSecure: pickBool(process.env.SMTP_SECURE, file.smtpSecure, DEFAULTS.smtpSecure),
    smtpRequireTls: pickBool(process.env.SMTP_REQUIRE_TLS, file.smtpRequireTls, DEFAULTS.smtpRequireTls),
    smtpRejectUnauthorized: pickBool(
      process.env.SMTP_REJECT_UNAUTHORIZED,
      file.smtpRejectUnauthorized,
      DEFAULTS.smtpRejectUnauthorized,
    ),
    smtpUser: pickString(process.env.SMTP_USER, file.smtpUser, DEFAULTS.smtpUser),
    smtpPassword: pickString(process.env.SMTP_PASSWORD, file.smtpPassword, DEFAULTS.smtpPassword),
    smtpFrom: pickString(process.env.SMTP_FROM, file.smtpFrom, DEFAULTS.smtpFrom),
    emailDomains: pickList(process.env.EMAIL_DOMAINS, file.emailDomains, DEFAULTS.emailDomains),
    requireAdminApproval: pickBool(
      process.env.REQUIRE_ADMIN_APPROVAL,
      file.requireAdminApproval,
      DEFAULTS.requireAdminApproval,
    ),
    notifyByEmail: pickBool(process.env.NOTIFY_BY_EMAIL, file.notifyByEmail, DEFAULTS.notifyByEmail),
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
