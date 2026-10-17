import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { getSettings } from '../services/settings.js';
import { NAME_EXAMPLE, NAME_PATTERN_SOURCE } from '../util/names.js';
import { countUsers, listUsers, touchLastSeen } from '../repos/users.js';
import { unreadCount } from '../repos/transfers.js';
import { toUserView } from '../views.js';
import { currentUser, optionalUser } from './auth.js';
import { MIN_PASSWORD_LENGTH } from '../services/passwords.js';
import { mailConfigured } from '../services/mail.js';

export default async function coreRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Everything the browser needs on first paint. Safe to call signed out — it
   * then returns only what the sign-in screen needs, and no staff names.
   */
  app.get('/api/bootstrap', async (request) => {
    const settings = getSettings();
    const user = optionalUser(request);
    if (user) touchLastSeen(user.id);

    return {
      app: { name: 'BetSend', version: '1.1.4' },
      registrationMode: settings.registrationMode,
      // The sign-in screen needs these to decide whether to offer "create an
      // account" and "forgot password" at all.
      emailDomains: config.emailDomains,
      mailConfigured: mailConfigured(),
      // An empty directory means nobody can get in: registering needs a mail
      // relay to verify the address, and the Admin page needs a session. The
      // sign-in screen offers first-run setup instead.
      needsFirstRun: countUsers() === 0,
      namePattern: NAME_PATTERN_SOURCE,
      nameExample: NAME_EXAMPLE,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      publicMode: config.publicMode,
      chunkSize: Math.max(1, config.chunkSizeMb) * 1024 * 1024,
      maxUploadSize: settings.maxUploadSize,
      retentionHours: settings.retentionHours,
      deleteAfterAllDownloaded: settings.deleteAfterAllDownloaded,
      uploadEndpoint: '/api/uploads',
      user: user ? toUserView(user) : null,
      unread: user ? unreadCount(user.id) : 0,
    };
  });

  /**
   * The staff directory, for the recipient picker.
   *
   * Signed-in only. Before authentication existed this was public; on a
   * public URL that would hand any passer-by a list of everyone who works here.
   */
  app.get('/api/users', async (request) => {
    currentUser(request);
    const q = ((request.query as Record<string, string>).q ?? '').trim().toLocaleLowerCase();
    const all = listUsers();
    const filtered = q ? all.filter((u) => u.name.toLocaleLowerCase().includes(q)) : all;
    return { users: filtered.map(toUserView) };
  });

  app.get('/api/me', async (request) => {
    const user = currentUser(request);
    return { user: toUserView(user), unread: unreadCount(user.id) };
  });
}
