import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../src/db/index.js';
import { paths } from '../src/config.js';
import { createUser, setPassword, type UserRow } from '../src/repos/users.js';
import { hashPassword } from '../src/services/passwords.js';
import { invalidateSettings } from '../src/services/settings.js';
import { insertBlob } from '../src/repos/blobs.js';
import { createTransfer, type TransferRow } from '../src/repos/transfers.js';
import { newId } from '../src/util/ids.js';

/**
 * Shared fixtures. Tests run in one process against one throwaway database
 * (see setup.mjs), so state is reset between them rather than re-imported —
 * the application's config and database handles are module singletons.
 */

export const TEST_PASSWORD = 'correct-horse-battery';

/** Wipe every table and every uploaded byte, leaving the schema in place. */
export function resetState(): void {
  const db = getDb();
  db.exec(`
    DELETE FROM recipients;
    DELETE FROM transfer_files;
    DELETE FROM transfers;
    DELETE FROM blobs;
    DELETE FROM uploads;
    DELETE FROM setup_tokens;
    DELETE FROM sessions;
    DELETE FROM events;
    DELETE FROM settings;
    DELETE FROM users;
  `);
  invalidateSettings();

  try {
    for (const entry of fs.readdirSync(paths.uploads)) {
      fs.rmSync(path.join(paths.uploads, entry), { force: true });
    }
  } catch {
    /* directory may not exist yet */
  }
}

export async function makeUser(name: string, options: { password?: boolean; admin?: boolean } = {}): Promise<UserRow> {
  const user = createUser(name, 'admin');
  if (options.password !== false) {
    setPassword(user.id, await hashPassword(TEST_PASSWORD));
  }
  if (options.admin) {
    getDb().prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(user.id);
  }
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(user.id) as UserRow;
}

/**
 * A blob with real bytes behind it, as if an upload had just finished. Returns
 * the id so a test can hand it to `createTransfer`.
 */
export function makeBlob(ownerId: number, options: { name?: string; bytes?: number } = {}): string {
  const id = newId(20);
  const size = options.bytes ?? 1024;
  fs.mkdirSync(paths.uploads, { recursive: true });
  fs.writeFileSync(path.join(paths.uploads, id), Buffer.alloc(size, 1));

  insertBlob({
    id,
    originalName: options.name ?? `${id}.bin`,
    size,
    mime: 'application/octet-stream',
    storageKey: id,
    ownerId,
  });
  return id;
}

export function makeTransfer(
  senderId: number,
  recipientIds: number[],
  options: { blobIds?: string[]; retentionHours?: number; note?: string } = {},
): TransferRow {
  const blobIds = options.blobIds ?? [makeBlob(senderId)];
  return createTransfer({
    senderId,
    blobIds,
    recipientIds,
    note: options.note ?? null,
    retentionHours: options.retentionHours ?? 72,
  });
}

/** Push a transfer's expiry into the past so the sweeper will act on it. */
export function expireTransfer(transferId: string): void {
  getDb().prepare('UPDATE transfers SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, transferId);
}

export function blobFileExists(blobId: string): boolean {
  return fs.existsSync(path.join(paths.uploads, blobId));
}

export function countRows(table: string): number {
  const row = getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}
