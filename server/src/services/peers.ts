import crypto from 'node:crypto';
import { now } from '../db/index.js';

/**
 * Who can accept a file sent straight to their machine, and the one-time
 * tokens that make such a transfer safe.
 *
 * Deliberately in memory rather than the database. An endpoint is only
 * meaningful while that app is running and holding that port, so it should
 * vanish on a server restart along with every assumption behind it -- a
 * stale endpoint in a table would send people's files at whatever now owns
 * that address.
 */

export interface PeerEndpoint {
  userId: number;
  userName: string;
  /** Taken from the connection, never from what the client claimed. */
  host: string;
  port: number;
  announcedAt: number;
}

/** How long an endpoint is trusted without being announced again. */
const ENDPOINT_TTL_MS = 2 * 60 * 1000;

/**
 * A direct transfer waiting to happen.
 *
 * The token is the whole security model. The recipient's app does not decide
 * whether to trust whoever connected to it -- it hands the token back to the
 * server and is told who the sender is and what they are allowed to send.
 * A connection without a valid token gets nothing.
 */
export interface DirectOffer {
  token: string;
  senderId: number;
  senderName: string;
  recipientId: number;
  recipientName: string;
  files: { name: string; size: number }[];
  note: string;
  createdAt: number;
  claimedAt: number | null;
}

/** Long enough for somebody to be walking back to their desk, no longer. */
const OFFER_TTL_MS = 5 * 60 * 1000;

const endpoints = new Map<number, PeerEndpoint>();
const offers = new Map<string, DirectOffer>();

export function announceEndpoint(userId: number, userName: string, host: string, port: number): void {
  endpoints.set(userId, { userId, userName, host, port, announcedAt: now() });
}

export function forgetEndpoint(userId: number): void {
  endpoints.delete(userId);
}

export function endpointFor(userId: number): PeerEndpoint | null {
  const endpoint = endpoints.get(userId);
  if (!endpoint) return null;
  if (now() - endpoint.announcedAt > ENDPOINT_TTL_MS) {
    endpoints.delete(userId);
    return null;
  }
  return endpoint;
}

export function createOffer(input: Omit<DirectOffer, 'token' | 'createdAt' | 'claimedAt'>): DirectOffer {
  // 256 bits from the system generator. This is the only thing standing
  // between somebody on the LAN and a file-shaped hole in a colleague's PC.
  const token = crypto.randomBytes(32).toString('base64url');
  const offer: DirectOffer = { ...input, token, createdAt: now(), claimedAt: null };
  offers.set(token, offer);
  return offer;
}

/**
 * Look an offer up by its token, for the recipient.
 *
 * Single use: a token that has been claimed is gone, so a replayed one buys
 * nothing even if it is somehow overheard.
 */
export function claimOffer(token: string, recipientId: number): DirectOffer | null {
  const offer = offers.get(token);
  if (!offer) return null;

  if (now() - offer.createdAt > OFFER_TTL_MS) {
    offers.delete(token);
    return null;
  }
  // The token alone is not enough: it has to be this recipient's.
  if (offer.recipientId !== recipientId) return null;
  if (offer.claimedAt !== null) return null;

  offer.claimedAt = now();
  return offer;
}

export function finishOffer(token: string): DirectOffer | null {
  const offer = offers.get(token);
  if (!offer) return null;
  offers.delete(token);
  return offer;
}

/** Drop what has gone stale. Called by the same sweep as everything else. */
export function sweepPeers(): { endpoints: number; offers: number } {
  const current = now();
  let droppedEndpoints = 0;
  let droppedOffers = 0;

  for (const [id, endpoint] of endpoints) {
    if (current - endpoint.announcedAt > ENDPOINT_TTL_MS) {
      endpoints.delete(id);
      droppedEndpoints++;
    }
  }
  for (const [token, offer] of offers) {
    if (current - offer.createdAt > OFFER_TTL_MS) {
      offers.delete(token);
      droppedOffers++;
    }
  }
  return { endpoints: droppedEndpoints, offers: droppedOffers };
}

/** Tests only: the module keeps state for the life of the process. */
export function resetPeers(): void {
  endpoints.clear();
  offers.clear();
}
