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

/**
 * Strip the IPv4-mapped IPv6 prefix a dual-stack listener adds.
 *
 * ::ffff:10.2.254.239 and 10.2.254.239 are the same machine, but only one of
 * them is something a person could read back to you over the phone when the
 * office network is not behaving.
 */
export function normaliseHost(host: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(host);
  return mapped ? mapped[1] : host;
}

export function isLoopback(host: string): boolean {
  const plain = normaliseHost(host);
  // Anchored at both ends: a prefix match would also claim
  // "127.0.0.1.example.com", which is a hostname somebody else controls.
  return plain === '::1' || plain === 'localhost' || /^127(\.\d{1,3}){3}$/.test(plain);
}

/**
 * Could the person asking actually reach this address?
 *
 * The endpoint host is whatever address the server saw that app connect
 * from. For somebody running BetSend on the server PC itself, that is
 * 127.0.0.1 -- a perfectly correct address, for them. Handing it to a
 * colleague would point their transfer at their own machine, where either
 * nothing answers or their own app does and then fails the token check.
 * Either way they wait for a connection that was never going to work.
 *
 * So a loopback endpoint is offered only to somebody who is themselves on
 * loopback, which is to say on that same machine. Everyone else is told
 * that person cannot take a direct transfer, and goes through the server
 * immediately instead of discovering it the slow way.
 */
export function reachableFrom(endpointHost: string, requesterHost: string): boolean {
  return !isLoopback(endpointHost) || isLoopback(requesterHost);
}

export function announceEndpoint(userId: number, userName: string, host: string, port: number): void {
  endpoints.set(userId, { userId, userName, host: normaliseHost(host), port, announcedAt: now() });
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
