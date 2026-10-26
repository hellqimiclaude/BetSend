import type { FastifyInstance } from 'fastify';
import { badRequest, forbidden, notFound } from '../util/errors.js';
import { findByName } from '../repos/users.js';
import { currentUser, clientIp } from './auth.js';
import {
  announceEndpoint,
  claimOffer,
  createOffer,
  endpointFor,
  finishOffer,
  forgetEndpoint,
} from '../services/peers.js';
import { logEvent, recordDirectTransfer } from '../repos/transfers.js';
import { getSettings } from '../services/settings.js';
import { notifyDirectArrival } from '../services/notify.js';

/**
 * Brokering transfers that go straight from one machine to another.
 *
 * The server never sees the bytes on this path. What it does is vouch for
 * the two ends to each other: it knows who is signed in, it knows where
 * their apps are listening, and it issues the one-time token that lets a
 * recipient's app be sure the stranger connecting to it is a colleague
 * sending something they said they would send.
 *
 * Nothing here trusts what a client says about itself. The endpoint host is
 * read off the connection, and the recipient of an offer is decided by the
 * server rather than claimed by the sender.
 */
export default async function peerRoutes(app: FastifyInstance): Promise<void> {
  /**
   * "My app is listening on this port."
   *
   * The host is taken from the connection, not the body: a client that could
   * name its own address could point colleagues' transfers anywhere.
   */
  app.post('/api/peer/announce', async (request) => {
    const user = currentUser(request);
    const body = (request.body ?? {}) as { port?: unknown };
    const port = Number(body.port);

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw badRequest('That is not a port number.', 'bad_port');
    }

    announceEndpoint(user.id, user.name, clientIp(request), port);
    return { ok: true };
  });

  app.delete('/api/peer/announce', async (request) => {
    const user = currentUser(request);
    forgetEndpoint(user.id);
    return { ok: true };
  });

  /** Can this person take a direct transfer right now? */
  app.get('/api/peer/:name', async (request) => {
    currentUser(request);
    const { name } = request.params as { name: string };

    const target = findByName(decodeURIComponent(name));
    if (!target || !target.active) throw notFound('No such person.', 'unknown_recipient');

    const endpoint = endpointFor(target.id);
    // The address is not returned here. Only an offer hands that over, and
    // only to somebody who has just been given a token for it.
    return { name: target.name, direct: endpoint !== null };
  });

  /**
   * "I want to send these files straight to these people."
   *
   * Returns one token and one address per recipient who can take a direct
   * transfer. Recipients who cannot are listed separately, so the sender's
   * app can put those through the server instead.
   */
  app.post('/api/peer/offer', async (request) => {
    const user = currentUser(request);
    const body = (request.body ?? {}) as { recipients?: unknown; files?: unknown; note?: unknown };

    const names = Array.isArray(body.recipients)
      ? body.recipients.filter((n): n is string => typeof n === 'string')
      : [];
    if (names.length === 0) throw badRequest('Choose at least one person to send to.', 'no_recipients');

    const files = Array.isArray(body.files)
      ? body.files
          .map((f) => f as { name?: unknown; size?: unknown })
          .filter((f) => typeof f.name === 'string' && Number.isFinite(Number(f.size)))
          .map((f) => ({ name: String(f.name), size: Number(f.size) }))
      : [];
    if (files.length === 0) throw badRequest('Add at least one file before sending.', 'no_files');

    const note = typeof body.note === 'string' ? body.note : '';

    const ready: { name: string; token: string; host: string; port: number }[] = [];
    const unreachable: string[] = [];

    for (const name of names) {
      const target = findByName(name);
      if (!target || !target.active) {
        throw badRequest(`${name} is not in the directory any more.`, 'unknown_recipient');
      }
      // Sending to yourself directly would mean connecting to your own app
      // to receive what you already have.
      if (target.id === user.id) {
        unreachable.push(target.name);
        continue;
      }

      const endpoint = endpointFor(target.id);
      if (!endpoint) {
        unreachable.push(target.name);
        continue;
      }

      const offer = createOffer({
        senderId: user.id,
        senderName: user.name,
        recipientId: target.id,
        recipientName: target.name,
        files,
        note,
      });

      ready.push({ name: target.name, token: offer.token, host: endpoint.host, port: endpoint.port });
    }

    return { ready, unreachable };
  });

  /**
   * The recipient's app asking "who is this, and what did they say they
   * would send?" before accepting a byte.
   */
  app.post('/api/peer/claim', async (request) => {
    const user = currentUser(request);
    const body = (request.body ?? {}) as { token?: unknown };
    const token = typeof body.token === 'string' ? body.token : '';

    const offer = claimOffer(token, user.id);
    if (!offer) throw forbidden('That transfer is not for you, or it has expired.', 'bad_offer');

    return {
      from: offer.senderName,
      files: offer.files,
      note: offer.note,
      totalBytes: offer.files.reduce((sum, file) => sum + file.size, 0),
    };
  });

  /** "It arrived." Recorded so the Sent page can say so. */
  app.post('/api/peer/complete', async (request) => {
    const user = currentUser(request);
    const body = (request.body ?? {}) as { token?: unknown; ok?: unknown };
    const token = typeof body.token === 'string' ? body.token : '';

    const offer = finishOffer(token);
    if (!offer || offer.recipientId !== user.id) {
      throw forbidden('That transfer is not for you.', 'bad_offer');
    }

    const delivered = body.ok !== false;

    if (!delivered) {
      logEvent('transfer.direct_failed', null, offer.senderId, `to ${offer.recipientName}`);
      return { ok: true };
    }

    /*
     * Written here and nowhere earlier. An offer that was made and then not
     * used -- the sender changed their mind, or the connection died and it
     * fell back to the server -- must leave no record of a delivery that did
     * not happen. By this point the recipient's own app has the bytes on
     * disk and is saying so.
     *
     * Without this the feature has a hole somebody would find within a day:
     * send a file directly and it appears in neither Sent nor Inbox, because
     * nothing on this server ever learned it existed.
     */
    const transfer = recordDirectTransfer({
      senderId: offer.senderId,
      recipientId: offer.recipientId,
      files: offer.files,
      note: offer.note || null,
      retentionHours: getSettings().retentionHours,
    });

    logEvent(
      'transfer.direct_delivered',
      transfer.id,
      offer.senderId,
      `${offer.files.length} file(s) to ${offer.recipientName}`,
    );
    notifyDirectArrival(transfer, offer.senderName);

    return { ok: true };
  });
}
