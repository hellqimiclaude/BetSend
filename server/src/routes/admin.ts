import type { FastifyInstance } from 'fastify';
import { config, paths } from '../config.js';
import { requireAdmin } from './auth.js';
import { badRequest, notFound } from '../util/errors.js';
import { parseEmailList, validateEmail } from '../util/email.js';
import {
  countUsers,
  countWithoutEmail,
  countWithoutPassword,
  setEmail,
  deactivateUser,
  findByName,
  importUsers,
  listUsers,
  setAdmin,
} from '../repos/users.js';
import {
  createSetupToken,
  destroyAllSessionsFor,
  sessionCountFor,
  setupLinkFor,
} from '../services/sessions.js';
import {
  activeTransferCount,
  listAllTransfers,
  logEvent,
  recipientUserIds,
  requireTransfer,
  setState,
} from '../repos/transfers.js';
import { totalStoredBytes } from '../repos/blobs.js';
import { diskUsage } from '../services/storage.js';
import { getSettings, updateSettings, type RuntimeSettings } from '../services/settings.js';
import { sweep } from '../services/cleanup.js';
import { notifyTransferGone } from '../services/notify.js';
import { onlineUserNames } from '../ws/hub.js';
import { findByEmail } from '../repos/users.js';
import { mailConfigured, sendOrThrow, testMessage, verifyConnection } from '../services/mail.js';
import { findById } from '../repos/users.js';
import { toUserView } from '../views.js';

export default async function adminRoutes(app: FastifyInstance): Promise<void> {
  // Every route in this scope needs the shared admin token.
  app.addHook('preHandler', async (request) => requireAdmin(request));

  /** Cheap endpoint the admin page calls to check the token before showing anything. */
  app.post('/api/admin/verify', async () => ({ ok: true }));

  app.get('/api/admin/overview', async () => {
    const disk = diskUsage();
    return {
      storage: {
        directory: paths.root,
        uploadsDirectory: paths.uploads,
        usedByTransfers: totalStoredBytes(),
        diskFree: disk.freeBytes,
        diskTotal: disk.totalBytes,
      },
      counts: {
        users: countUsers(),
        online: onlineUserNames().length,
        activeTransfers: activeTransferCount(),
        withoutPassword: countWithoutPassword(),
        withoutEmail: countWithoutEmail(),
      },
      mail: {
        configured: mailConfigured(),
        host: config.smtpHost,
        from: config.smtpFrom,
        domains: config.emailDomains,
        notifyByEmail: config.notifyByEmail,
        requireAdminApproval: config.requireAdminApproval,
      },
      security: {
        publicMode: config.publicMode,
        behindProxy: config.behindProxy,
        publicUrl: config.publicUrl,
      },
      settings: getSettings(),
      server: {
        port: config.port,
        chunkSizeMb: config.chunkSizeMb,
        cleanupIntervalMinutes: config.cleanupIntervalMinutes,
        orphanUploadHours: config.orphanUploadHours,
      },
    };
  });

  app.get('/api/admin/settings', async () => ({ settings: getSettings() }));

  app.put('/api/admin/settings', async (request) => {
    const body = (request.body ?? {}) as Partial<Record<keyof RuntimeSettings, unknown>>;
    const patch: Partial<RuntimeSettings> = {};

    if (body.retentionHours !== undefined) {
      const n = Number(body.retentionHours);
      if (!Number.isFinite(n) || n < 1 || n > 24 * 365) {
        throw badRequest('Retention must be between 1 hour and one year.', 'bad_retention');
      }
      patch.retentionHours = Math.round(n);
    }

    if (body.maxUploadSize !== undefined) {
      const n = Number(body.maxUploadSize);
      if (!Number.isFinite(n) || n < 0) throw badRequest('Maximum file size must be 0 (no limit) or more.', 'bad_max_size');
      patch.maxUploadSize = Math.round(n);
    }

    if (body.deleteAfterAllDownloaded !== undefined) {
      patch.deleteAfterAllDownloaded = Boolean(body.deleteAfterAllDownloaded);
    }

    if (body.registrationMode !== undefined) {
      const mode = String(body.registrationMode);
      if (mode !== 'open' && mode !== 'list') throw badRequest('Unknown registration mode.', 'bad_mode');
      patch.registrationMode = mode;
    }

    if (body.storageDir !== undefined) {
      const dir = String(body.storageDir).trim();
      if (!dir) throw badRequest('Storage directory cannot be empty.', 'bad_storage_dir');
      patch.storageDir = dir;
    }

    const settings = updateSettings(patch);
    logEvent('admin.settings', null, null, JSON.stringify(patch));
    return {
      settings,
      // storageDir is only read at boot; tell the admin so they aren't surprised.
      restartRequired: patch.storageDir !== undefined && patch.storageDir !== paths.root,
    };
  });

  app.get('/api/admin/users', async () => {
    const users = listUsers(true);
    return {
      users: users.map((u) => ({
        ...toUserView(u),
        active: Boolean(u.active),
        createdAt: u.created_at,
        email: u.email,
        emailVerifiedAt: u.email_verified_at,
        passwordSetAt: u.password_set_at,
        activeSessions: sessionCountFor(u.id),
      })),
    };
  });

  /**
   * Generate a one-time link that lets someone set their first password (or
   * reset a forgotten one). The link is shown once — the server only keeps its
   * hash — so the admin copies it and sends it on however they like.
   */
  app.post('/api/admin/users/:name/setup-link', async (request) => {
    const { name } = request.params as { name: string };
    const user = findByName(decodeURIComponent(name));
    if (!user || !user.active) throw notFound('No such user.', 'user_not_found');

    const token = createSetupToken(user.id);
    logEvent('admin.setup_link', null, user.id);

    return {
      name: user.name,
      link: setupLinkFor(token),
      // Without a configured public URL the admin has to prefix their own host.
      needsPublicUrl: !config.publicUrl,
      expiresInHours: 72,
      isReset: Boolean(user.password_hash),
    };
  });

  /** Force someone out of every browser they are signed in on. */
  app.post('/api/admin/users/:name/sign-out', async (request) => {
    const { name } = request.params as { name: string };
    const user = findByName(decodeURIComponent(name));
    if (!user) throw notFound('No such user.', 'user_not_found');

    destroyAllSessionsFor(user.id);
    logEvent('admin.sign_out', null, user.id);
    return { ok: true };
  });

  app.post('/api/admin/users/:name/admin', async (request) => {
    const { name } = request.params as { name: string };
    const body = (request.body ?? {}) as { isAdmin?: unknown };
    const user = findByName(decodeURIComponent(name));
    if (!user || !user.active) throw notFound('No such user.', 'user_not_found');

    setAdmin(user.id, Boolean(body.isAdmin));
    logEvent('admin.role', null, user.id, Boolean(body.isAdmin) ? 'granted' : 'revoked');
    return { ok: true };
  });

  /** Paste a list (one name per line, or CSV with the name first). */
  app.post('/api/admin/users/import', async (request) => {
    const body = (request.body ?? {}) as { text?: unknown };
    const text = typeof body.text === 'string' ? body.text : '';
    if (!text.trim()) throw badRequest('Paste at least one email address.', 'empty_import');

    const { valid, invalid } = parseEmailList(text);
    if (valid.length === 0) {
      return { added: [], existing: [], invalid };
    }
    const { added, existing } = importUsers(valid);
    logEvent('admin.users.import', null, null, `${added.length} added`);
    return { added, existing, invalid };
  });

  /** Fill in or correct somebody's address. */
  app.put('/api/admin/users/:name/email', async (request) => {
    const { name } = request.params as { name: string };
    const body = (request.body ?? {}) as { email?: unknown };
    const user = findByName(decodeURIComponent(name));
    if (!user) throw notFound('No such user.', 'user_not_found');

    const check = validateEmail(typeof body.email === 'string' ? body.email : '');
    if (!check.ok) throw badRequest(check.error!, 'invalid_email');

    const clash = findByEmail(check.value);
    if (clash && clash.id !== user.id) {
      throw badRequest(`${check.value} already belongs to ${clash.name}.`, 'email_taken');
    }

    setEmail(user.id, check.value);
    logEvent('admin.users.email', null, user.id);
    return { ok: true };
  });

  /** Send a message to one address, to prove the relay works. */
  app.post('/api/admin/mail/test', async (request) => {
    const body = (request.body ?? {}) as { to?: unknown };
    const check = validateEmail(typeof body.to === 'string' ? body.to : '');
    if (!check.ok) throw badRequest(check.error!, 'invalid_email');

    try {
      await verifyConnection();
      await sendOrThrow(testMessage(check.value));
    } catch (err) {
      // The relay's own words are far more useful than anything generic.
      throw badRequest(`The mail server refused it: ${(err as Error).message}`, 'mail_failed');
    }
    logEvent('admin.mail.test', null, null, check.value);
    return { ok: true };
  });

  app.delete('/api/admin/users/:name', async (request) => {
    const { name } = request.params as { name: string };
    const user = findByName(decodeURIComponent(name));
    if (!user) throw notFound('No such user.', 'user_not_found');
    deactivateUser(user.id);
    // Removing someone must sign them out too, or their cookie keeps working.
    destroyAllSessionsFor(user.id);
    logEvent('admin.users.remove', null, user.id);
    return { ok: true };
  });

  app.get('/api/admin/transfers', async () => {
    const rows = listAllTransfers();
    return {
      transfers: rows.map((row) => ({
        id: row.id,
        sender: row.sender_name,
        note: row.note,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        state: row.state,
        totalSize: row.total_size,
        fileCount: row.file_count,
        recipientCount: row.recipient_count,
      })),
    };
  });

  /** Force-delete a transfer. Bytes go away on the next sweep (or right now). */
  app.delete('/api/admin/transfers/:id', async (request) => {
    const { id } = request.params as { id: string };
    const transfer = requireTransfer(id);
    const targets = recipientUserIds(id);

    setState(id, 'deleted');
    logEvent('admin.transfer.delete', id, null);
    notifyTransferGone(id, 'revoked', findById(transfer.sender_id)?.name ?? '', targets);

    const result = await sweep();
    return { ok: true, sweep: result };
  });

  app.post('/api/admin/cleanup', async () => {
    const result = await sweep();
    logEvent('admin.cleanup', null, null, JSON.stringify(result));
    return { sweep: result };
  });
}
