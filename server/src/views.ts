import {
  filesFor,
  recipientsFor,
  type TransferRow,
  type TransferFileRow,
  type RecipientRow,
} from './repos/transfers.js';
import { isOnline } from './ws/hub.js';
import type { UserRow } from './repos/users.js';

/** Shapes returned to the browser. Kept in sync with web/src/types.ts. */

export interface FileView {
  id: string;
  name: string;
  size: number;
  mime: string | null;
}

export interface RecipientView {
  name: string;
  online: boolean;
  seenAt: number | null;
  downloadedAt: number | null;
  downloadCount: number;
}

export interface TransferView {
  id: string;
  note: string | null;
  createdAt: number;
  expiresAt: number;
  state: TransferRow['state'];
  totalSize: number;
  fileCount: number;
  sender: { name: string; online: boolean };
  files: FileView[];
  recipients?: RecipientView[];
  /** Present on inbox items: this user's own status for the transfer. */
  me?: { seenAt: number | null; downloadedAt: number | null; downloadCount: number };
}

export interface UserView {
  name: string;
  online: boolean;
  lastSeenAt: number | null;
  source: 'self' | 'admin';
  isAdmin: boolean;
  /** False means the account exists but nobody has set a password yet. */
  hasPassword: boolean;
}

export function toUserView(row: UserRow): UserView {
  return {
    name: row.name,
    online: isOnline(row.name),
    lastSeenAt: row.last_seen_at,
    source: row.source,
    isAdmin: Boolean(row.is_admin),
    hasPassword: Boolean(row.password_hash),
  };
}

function groupBy<T extends { transfer_id: string }>(rows: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const list = map.get(row.transfer_id);
    if (list) list.push(row);
    else map.set(row.transfer_id, [row]);
  }
  return map;
}

function toFileView(row: TransferFileRow): FileView {
  return { id: row.blob_id, name: row.original_name, size: row.size, mime: row.mime };
}

function toRecipientView(row: RecipientRow): RecipientView {
  return {
    name: row.name,
    online: isOnline(row.name),
    seenAt: row.seen_at,
    downloadedAt: row.downloaded_at,
    downloadCount: row.download_count,
  };
}

export interface BuildOptions {
  includeRecipients?: boolean;
  /** Sender name per transfer id; avoids a second join for the sent view. */
  senderName?: (row: TransferRow) => string;
  /** Per-user status for inbox rows. */
  mine?: (row: TransferRow) => TransferView['me'];
}

export function buildTransferViews(rows: TransferRow[], options: BuildOptions = {}): TransferView[] {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const files = groupBy(filesFor(ids));
  const recipients = options.includeRecipients ? groupBy(recipientsFor(ids)) : null;

  return rows.map((row) => {
    const senderName = options.senderName ? options.senderName(row) : '';
    const view: TransferView = {
      id: row.id,
      note: row.note,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      state: row.state,
      totalSize: row.total_size,
      fileCount: row.file_count,
      sender: { name: senderName, online: senderName ? isOnline(senderName) : false },
      files: (files.get(row.id) ?? []).map(toFileView),
    };
    if (recipients) view.recipients = (recipients.get(row.id) ?? []).map(toRecipientView);
    if (options.mine) view.me = options.mine(row);
    return view;
  });
}
