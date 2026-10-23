import type { DirectTarget, Offer, PeerFile } from './link.js';
import type { SendableFile } from './sender.js';

/**
 * Getting the files to everybody, by whichever route works.
 *
 * The user picks direct or via the server, but "direct" can only ever be a
 * preference: somebody's PC may be off, or their app not running, or a
 * switch may drop the connection halfway through a four-gigabyte file. None
 * of that should cost them the transfer, so anybody the direct route cannot
 * reach -- before or during -- goes through the server instead, and the
 * person sending is told which happened.
 *
 * All the awkward parts are injected, so the decisions below can be tested
 * without a network, a server or an Electron app.
 */

export type Route = 'direct' | 'server';

export interface Timing {
  bytes: number;
  milliseconds: number;
}

export interface DeliveryOptions {
  route: Route;
  recipients: string[];
  files: readonly SendableFile[];
  note: string;
  offer: (recipients: string[], files: PeerFile[], note: string) => Promise<Offer>;
  direct: (target: DirectTarget, files: readonly SendableFile[]) => Promise<Timing>;
  viaServer: (recipients: string[], files: readonly SendableFile[], note: string) => Promise<Timing>;
  /** Told how each completed leg went, so future estimates are measured. */
  onTiming?: (route: Route, timing: Timing) => void;
}

export interface DeliveryReport {
  /** Who got the files straight from this machine. */
  direct: string[];
  /** Who got them through the server. */
  viaServer: string[];
  /** Those who were meant to get them directly and did not, and why. */
  fellBack: { name: string; reason: string }[];
  /** Who did not get them at all. */
  failed: { name: string; reason: string }[];
}

export async function deliver(options: DeliveryOptions): Promise<DeliveryReport> {
  const report: DeliveryReport = { direct: [], viaServer: [], fellBack: [], failed: [] };

  if (options.recipients.length === 0) return report;

  const throughServer: string[] = [];

  if (options.route === 'server') {
    throughServer.push(...options.recipients);
  } else {
    const offer = await askForTokens(options, report);

    for (const name of offer.unreachable) throughServer.push(name);

    for (const target of offer.ready) {
      try {
        const timing = await options.direct(target, options.files);
        options.onTiming?.('direct', timing);
        report.direct.push(target.name);
      } catch (err) {
        // Mid-transfer failures land here too, which is the whole point:
        // the file is still on this disk, so sending it again through the
        // server costs time and nothing else.
        report.fellBack.push({ name: target.name, reason: reasonFor(err) });
        throughServer.push(target.name);
      }
    }
  }

  if (throughServer.length > 0) {
    try {
      const timing = await options.viaServer(throughServer, options.files, options.note);
      options.onTiming?.('server', timing);
      report.viaServer.push(...throughServer);
    } catch (err) {
      const reason = reasonFor(err);
      report.failed.push(...throughServer.map((name) => ({ name, reason })));
    }
  }

  return report;
}

/**
 * Ask the server who can take a direct transfer.
 *
 * If that call itself fails there is nothing to fall back from -- the whole
 * thing goes through the server, which is where it would have gone anyway
 * had the user chosen the other option.
 */
async function askForTokens(options: DeliveryOptions, report: DeliveryReport): Promise<Offer> {
  const files: PeerFile[] = options.files.map((file) => ({ name: file.name, size: file.size }));
  try {
    return await options.offer(options.recipients, files, options.note);
  } catch (err) {
    const reason = reasonFor(err);
    report.fellBack.push(...options.recipients.map((name) => ({ name, reason })));
    return { ready: [], unreachable: options.recipients };
  }
}

function reasonFor(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * What to tell the person who sent it.
 *
 * One sentence, and it names the route, because a transfer that quietly
 * took ten minutes through the server when they asked for direct is a
 * support call waiting to happen.
 */
export function describeDelivery(report: DeliveryReport): string {
  const parts: string[] = [];

  if (report.direct.length > 0) parts.push(`${report.direct.join(', ')} — sent directly.`);
  if (report.viaServer.length > 0) parts.push(`${report.viaServer.join(', ')} — sent through the server.`);

  if (report.fellBack.length > 0) {
    const [first] = report.fellBack;
    parts.push(
      report.fellBack.length === 1
        ? `${first.name} could not be reached directly: ${first.reason}`
        : `${report.fellBack.length} people could not be reached directly: ${first.reason}`,
    );
  }

  if (report.failed.length > 0) {
    parts.push(`Not sent to ${report.failed.map((f) => f.name).join(', ')}: ${report.failed[0].reason}`);
  }

  return parts.join(' ');
}
