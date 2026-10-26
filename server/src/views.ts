import {
  directFilesFor,
  filesFor,
  recipientsFor,
  type DirectFileRow,
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
  /**
   * 'direct' means the files went machine to machine. There is nothing on
   * this server to download, so the page must not offer to.
   */
  delivery: TransferRow['delivery'];
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
  /** The work address: what makes two people with the same name distinct. */
  email: string | null;
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
    email: row.email,
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

/**
 * The id is deliberately not a blob id, because there is no blob. It exists
 * only so the list has stable keys; nothing can be fetched with it.
 */
function toDirectFileView(row: DirectFileRow): FileView {
  return { id: `direct:${row.transfer_id}:${row.ordinal}`, name: row.name, size: row.size, mime: null };
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

  // Only queried when there is something to query for, so the ordinary
  // server-only case costs nothing.
  const directIds = rows.filter((r) => r.delivery === 'direct').map((r) => r.id);
  const directFiles = directIds.length > 0 ? groupBy(directFilesFor(directIds)) : null;

  return rows.map((row) => {
    const senderName = options.senderName ? options.senderName(row) : '';
    const view: TransferView = {
      id: row.id,
      note: row.note,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      state: row.state,
      delivery: row.delivery,
      totalSize: row.total_size,
      fileCount: row.file_count,
      sender: { name: senderName, online: senderName ? isOnline(senderName) : false },
      files:
        row.delivery === 'direct'
          ? (directFiles?.get(row.id) ?? []).map(toDirectFileView)
          : (files.get(row.id) ?? []).map(toFileView),
    };
    if (recipients) view.recipients = (recipients.get(row.id) ?? []).map(toRecipientView);
    if (options.mine) view.me = options.mine(row);
    return view;
  });
}
