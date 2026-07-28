import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { getSettings } from '../services/settings.js';
import { NAME_EXAMPLE, NAME_PATTERN_SOURCE, validateName } from '../util/names.js';
import { createUser, findByName, listUsers, touchLastSeen } from '../repos/users.js';
import { unreadCount } from '../repos/transfers.js';
import { toUserView } from '../views.js';
import { currentUser } from './auth.js';
import { badRequest, forbidden } from '../util/errors.js';

export default async function coreRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Everything the browser needs on first paint: server limits, the naming
   * rule, and — if the browser remembered an identity — that user's state.
   */
  app.get('/api/bootstrap', async (request) => {
    const settings = getSettings();
    const header = request.headers['x-user'];
    const name = (Array.isArray(header) ? header[0] : header)?.trim();
    const user = name ? findByName(name) : undefined;

    if (user?.active) touchLastSeen(user.id);

    return {
      app: { name: 'BetSend', version: '1.0.0' },
      registrationMode: settings.registrationMode,
      namePattern: NAME_PATTERN_SOURCE,
      nameExample: NAME_EXAMPLE,
      chunkSize: Math.max(1, config.chunkSizeMb) * 1024 * 1024,
      maxUploadSize: settings.maxUploadSize,
      retentionHours: settings.retentionHours,
      deleteAfterAllDownloaded: settings.deleteAfterAllDownloaded,
      uploadEndpoint: '/api/uploads',
      user: user?.active ? toUserView(user) : null,
      unread: user?.active ? unreadCount(user.id) : 0,
    };
  });

  /** Directory for the recipient picker. `q` filters server-side for big lists. */
  app.get('/api/users', async (request) => {
    const q = ((request.query as Record<string, string>).q ?? '').trim().toLocaleLowerCase();
    const all = listUsers();
    const filtered = q ? all.filter((u) => u.name.toLocaleLowerCase().includes(q)) : all;
    return { users: filtered.map(toUserView) };
  });

  /**
   * Claim an identity. In `open` mode an unknown name is created on the spot;
   * in `list` mode the name must already have been imported by an admin.
   */
  app.post('/api/users/claim', async (request) => {
    const body = (request.body ?? {}) as { name?: string };
    const check = validateName(body.name ?? '');
    if (!check.ok) throw badRequest(check.error!, 'invalid_name');

    const settings = getSettings();
    const existing = findByName(check.value);

    if (!existing || !existing.active) {
      if (settings.registrationMode === 'list') {
        throw forbidden(
          `${check.value} is not on the staff list. Ask whoever runs BetSend to add you.`,
          'not_on_list',
        );
      }
      const created = createUser(check.value, 'self');
      return { user: toUserView(created), unread: 0 };
    }

    touchLastSeen(existing.id);
    return { user: toUserView(existing), unread: unreadCount(existing.id) };
  });

  app.get('/api/me', async (request) => {
    const user = currentUser(request);
    return { user: toUserView(user), unread: unreadCount(user.id) };
  });
}
