import { sendToUserId } from '../ws/hub.js';
import { recipientUserIds, unreadCount, type TransferRow } from '../repos/transfers.js';
import { findById } from '../repos/users.js';

/** Push a "you have a new transfer" event to everyone it was addressed to. */
export function notifyNewTransfer(transfer: TransferRow, senderName: string): void {
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
