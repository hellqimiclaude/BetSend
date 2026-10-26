import { sendToUserId } from '../ws/hub.js';
import { recipientUserIds, unreadCount, type TransferRow } from '../repos/transfers.js';
import { findById } from '../repos/users.js';
import { config } from '../config.js';
import { mailConfigured, newTransferMessage, send } from '../services/mail.js';
import { appBaseUrl } from '../util/baseurl.js';
import { formatBytes } from '../util/format.js';

const DAY = new Intl.DateTimeFormat('en-GB', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  hour: '2-digit',
  minute: '2-digit',
});

/**
 * Tell everyone the transfer was addressed to.
 *
 * The websocket only reaches people with the app open. Store-and-forward
 * means the recipient usually does not, so without the email a transfer can
 * sit unread until it expires - which is the app failing at its one job.
 * Mail is sent in the background: a relay that is down must never stop
 * somebody sending a file.
 */
export function notifyNewTransfer(transfer: TransferRow, senderName: string): void {
  const recipients = recipientUserIds(transfer.id);

  for (const userId of recipients) {
    sendToUserId(userId, {
      type: 'transfer:new',
      transferId: transfer.id,
      from: senderName,
      fileCount: transfer.file_count,
      totalSize: transfer.total_size,
      note: transfer.note,
      unread: unreadCount(userId),
    });
  }

  if (!config.notifyByEmail || !mailConfigured()) return;

  const link = `${appBaseUrl()}/#/inbox`;
  const expires = DAY.format(new Date(transfer.expires_at));

  void Promise.all(
    recipients.map((userId) => {
      const person = findById(userId);
      if (!person?.email) return Promise.resolve(false);
      return send(
        newTransferMessage({
          to: person.email,
          from: senderName,
          fileCount: transfer.file_count,
          totalSize: formatBytes(transfer.total_size),
          note: transfer.note,
          expires: expires,
          link,
        }),
      );
    }),
  );
}

/**
 * A transfer that arrived without passing through here.
 *
 * The websocket push only, never the email. The email exists to tell
 * somebody that files are waiting for them to come and fetch; these files
 * are already on their disk, and their own app has told them so. Sending
 * "you have files waiting" about something they already have would send
 * them looking for a download that does not exist.
 */
export function notifyDirectArrival(transfer: TransferRow, senderName: string): void {
  for (const userId of recipientUserIds(transfer.id)) {
    sendToUserId(userId, {
      type: 'transfer:new',
      transferId: transfer.id,
      from: senderName,
      fileCount: transfer.file_count,
      totalSize: transfer.total_size,
      note: transfer.note,
      unread: unreadCount(userId),
    });
  }
}

export function notifyTransferGone(
  transferId: string,
  kind: 'revoked' | 'expired',
  senderName: string,
  userIds: number[],
): void {
  for (const userId of userIds) {
    sendToUserId(
      userId,
      kind === 'revoked'
        ? { type: 'transfer:revoked', transferId, from: senderName, unread: unreadCount(userId) }
        : { type: 'transfer:expired', transferId, unread: unreadCount(userId) },
    );
  }
}

/** Tell the sender that one of their recipients downloaded (or opened) the transfer. */
export function notifySender(
  transfer: TransferRow,
  kind: 'downloaded' | 'seen',
  byUserId: number,
): void {
  const by = findById(byUserId);
  if (!by) return;
  sendToUserId(transfer.sender_id, {
    type: kind === 'downloaded' ? 'transfer:downloaded' : 'transfer:seen',
    transferId: transfer.id,
    by: by.name,
  });
}
