import type { FastifyInstance } from 'fastify';
import { currentUser } from './auth.js';
import { badRequest, forbidden, notFound } from '../util/errors.js';
import { getSettings } from '../services/settings.js';
import {
  checkLink,
  createLink,
  findLinkByToken,
  liveLinkFor,
  revokeLink,
  type DownloadLinkRow,
  type LinkRefusal,
} from '../repos/links.js';
import { logEvent, requireTransfer } from '../repos/transfers.js';
import { findById } from '../repos/users.js';
import { buildTransferViews } from '../views.js';
import { appBaseUrl } from '../util/baseurl.js';

/**
 * Download links: access to a transfer's files that travels with a URL
 * rather than with the recipient list.
 *
 * Signing in is still required. A link that ends up outside the company --
 * forwarded, screenshotted, pasted in the wrong task -- is worth nothing to
 * whoever finds it, because they have no BetSend account. Inside the
 * company it is deliberately permissive: anybody signed in who has the link
 * may download, which is exactly how somebody covering for a colleague gets
 * the files they were never sent.
 *
 * Every download through a link is recorded against the account that made
 * it, so there is always an answer to "who took these files, and when".
 */
export default async function linkRoutes(app: FastifyInstance): Promise<void> {
  /** Create or replace the link for a transfer. Sender only. */
  app.post('/api/transfers/:id/link', async (request) => {
    const user = currentUser(request);
    const { id } = request.params as { id: string };
    const transfer = requireTransfer(id);
    const settings = getSettings();

    if (transfer.sender_id !== user.id) {
      throw forbidden('Only the sender can create a link for a transfer.', 'not_sender');
    }
    if (transfer.delivery === 'direct') {
      // There is nothing here to serve: those bytes went machine to machine.
      throw badRequest(
        'That transfer went straight to their PC, so there is no copy here to link to. Send it through the server to get a link.',
        'direct_transfer',
      );
    }
    if (transfer.purged_at !== null || (transfer.state !== 'active' && transfer.state !== 'completed')) {
      throw badRequest('Those files are no longer on the server.', 'files_gone');
    }

    const body = (request.body ?? {}) as { days?: unknown };
    const days = Math.round(Number(body.days ?? settings.linkDefaultDays));

    if (!Number.isInteger(days) || days < 1) {
      throw badRequest('Choose how many days the link should last.', 'bad_days');
    }
    if (days > settings.linkMaxDays) {
      throw badRequest(
        `A link can last at most ${settings.linkMaxDays} days. An administrator can raise that.`,
        'too_many_days',
      );
    }

    const link = createLink(id, user.id, days);
    logEvent('link.created', id, user.id, `${days} day(s)`);

    return { link: toLinkView(link) };
  });

  /** Stop a link working, everywhere, immediately. */
  app.delete('/api/transfers/:id/link', async (request) => {
    const user = currentUser(request);
    const { id } = request.params as { id: string };
    const transfer = requireTransfer(id);

    if (transfer.sender_id !== user.id) {
      throw forbidden('Only the sender can revoke a link.', 'not_sender');
    }

    const revoked = revokeLink(id);
    if (revoked) logEvent('link.revoked', id, user.id);

    /*
     * The files are not deleted here. Retention still has the transfer
     * marked to be kept until the link's original expiry, and shortening
     * that would reach past the link into a transfer the recipients can
     * still legitimately download.
     */
    return { ok: true, revoked };
  });

  /**
   * What a link points at, for the page somebody lands on.
   *
   * Signing in comes first. Somebody who is not signed in gets a 401 and the
   * page sends them to sign in and then back here, rather than being told
   * the link is broken.
   */
  app.get('/api/link/:token', async (request) => {
    const user = currentUser(request);
    const { token } = request.params as { token: string };

    const outcome = checkLink(token);
    if ('refused' in outcome) {
      // The reason matters: somebody clicking a six-month-old task deserves
      // to be told it expired, and when, rather than that nothing was ever
      // there.
      throw notFound(refusalMessage(outcome.refused, findLinkByToken(token)), `link_${outcome.refused}`);
    }

    const transfer = requireTransfer(outcome.link.transfer_id);
    const senderName = findById(transfer.sender_id)?.name ?? '';
    const [view] = buildTransferViews([transfer], { senderName: () => senderName });

    logEvent('link.opened', transfer.id, user.id);
    return { transfer: view, link: toLinkView(outcome.link) };
  });
}

/** "5 December", for a message somebody reads weeks after the fact. */
const WHEN = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long' });

function refusalMessage(refused: LinkRefusal, link: DownloadLinkRow | undefined): string {
  switch (refused) {
    case 'revoked':
      return 'The sender has turned this link off.';
    case 'expired':
      return link
        ? `This link expired on ${WHEN.format(new Date(link.expires_at))}. Ask the sender to send the files again.`
        : 'This link has expired. Ask the sender to send the files again.';
    default:
      return 'That link does not exist. It may have been replaced by a newer one.';
  }
}

export interface LinkView {
  token: string;
  /**
   * The whole URL, built here rather than in the page.
   *
   * The page only knows the address its own browser used, and on the
   * server PC that is routinely localhost -- which points at a different
   * machine for everyone the link is given to. It can also be the
   * computer's name, which Windows machines resolve and phones do not.
   * The server knows its configured public address, or failing that its
   * address on the network, and either is reachable from anywhere a
   * colleague might open the link.
   */
  url: string;
  createdAt: number;
  expiresAt: number;
}

export function toLinkView(link: DownloadLinkRow): LinkView {
  return {
    token: link.token,
    url: `${appBaseUrl()}/#/d/${link.token}`,
    createdAt: link.created_at,
    expiresAt: link.expires_at,
  };
}

export { liveLinkFor };
