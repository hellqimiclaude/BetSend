/** Mirrors the shapes returned by the server (see server/src/views.ts). */

export interface UserView {
  name: string;
  online: boolean;
  lastSeenAt: number | null;
  source: 'self' | 'admin';
  isAdmin: boolean;
  hasPassword: boolean;
}

export interface AdminUserView extends UserView {
  active: boolean;
  createdAt: number;
  passwordSetAt: number | null;
  activeSessions: number;
}

export interface SetupLink {
  name: string;
  link: string;
  needsPublicUrl: boolean;
  expiresInHours: number;
  isReset: boolean;
}

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

export type TransferState = 'active' | 'revoked' | 'expired' | 'completed' | 'deleted';

export interface TransferView {
  id: string;
  note: string | null;
  createdAt: number;
  expiresAt: number;
  state: TransferState;
  totalSize: number;
  fileCount: number;
  sender: { name: string; online: boolean };
  files: FileView[];
  recipients?: RecipientView[];
  me?: { seenAt: number | null; downloadedAt: number | null; downloadCount: number };
}

export interface Bootstrap {
  app: { name: string; version: string };
  registrationMode: 'open' | 'list';
  signupMode: 'invite' | 'claim';
  publicMode: boolean;
  minPasswordLength: number;
  namePattern: string;
  nameExample: string;
  chunkSize: number;
  maxUploadSize: number;
  retentionHours: number;
  deleteAfterAllDownloaded: boolean;
  uploadEndpoint: string;
  user: UserView | null;
  unread: number;
}

export interface RuntimeSettings {
  retentionHours: number;
  maxUploadSize: number;
  deleteAfterAllDownloaded: boolean;
  registrationMode: 'open' | 'list';
  storageDir: string;
  signupMode: 'invite' | 'claim';
}

export interface AdminOverview {
  storage: {
    directory: string;
    uploadsDirectory: string;
    usedByTransfers: number;
    diskFree: number;
    diskTotal: number;
  };
  counts: { users: number; online: number; activeTransfers: number; withoutPassword: number };
  security: { publicMode: boolean; behindProxy: boolean; publicUrl: string };
  settings: RuntimeSettings;
  server: {
    port: number;
    chunkSizeMb: number;
    cleanupIntervalMinutes: number;
    orphanUploadHours: number;
  };
}

export interface AdminTransfer {
  id: string;
  sender: string;
  note: string | null;
  createdAt: number;
  expiresAt: number;
  state: TransferState;
  totalSize: number;
  fileCount: number;
  recipientCount: number;
}

export type ServerEvent =
  | { type: 'hello'; user: string; unread: number }
  | { type: 'presence'; online: string[] }
  | {
      type: 'transfer:new';
      transferId: string;
      from: string;
      fileCount: number;
      totalSize: number;
      note: string | null;
      unread: number;
    }
  | { type: 'transfer:revoked'; transferId: string; from: string; unread: number }
  | { type: 'transfer:expired'; transferId: string; unread: number }
  | { type: 'transfer:downloaded'; transferId: string; by: string }
  | { type: 'transfer:seen'; transferId: string; by: string }
  | { type: 'inbox:changed'; unread: number };
