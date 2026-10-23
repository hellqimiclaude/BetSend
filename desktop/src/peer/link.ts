import type { ClaimResult } from './receiver.js';

/**
 * The desktop app's side of the server's peer API.
 *
 * The server never carries the bytes on this path, but it is still the only
 * thing either end trusts: it knows who is signed in, where their apps are
 * listening, and it issues the token that lets a recipient be sure the
 * machine connecting to it is a colleague and not whoever found the port.
 *
 * Nothing here imports Electron, so it can be tested against a real server.
 */

export interface DirectTarget {
  name: string;
  token: string;
  host: string;
  port: number;
}

export interface Offer {
  ready: DirectTarget[];
  unreachable: string[];
}

export interface PeerFile {
  name: string;
  size: number;
}

export class PeerLink {
  constructor(
    private readonly origin: string,
    private readonly cookie: string,
  ) {}

  /** "My app is listening on this port." The server reads the host off the connection. */
  async announce(port: number): Promise<void> {
    await this.post('/api/peer/announce', { port });
  }

  async unannounce(): Promise<void> {
    await this.send('DELETE', '/api/peer/announce', undefined);
  }

  /**
   * "Can this person take a direct transfer right now?"
   *
   * Separate from offer() on purpose: an offer mints a token and hands
   * over an address, and merely opening the chooser should not give
   * anybody the right to connect to a colleague's machine.
   */
  async canTakeDirect(name: string): Promise<boolean> {
    try {
      const body = (await this.send('GET', `/api/peer/${encodeURIComponent(name)}`, undefined)) as {
        direct?: unknown;
      } | null;
      return body?.direct === true;
    } catch {
      return false;
    }
  }

  /** Asks for a token and an address per recipient who can take a direct transfer. */
  async offer(recipients: string[], files: PeerFile[], note: string): Promise<Offer> {
    const body = await this.post('/api/peer/offer', { recipients, files, note });
    const raw = body as { ready?: unknown; unreachable?: unknown };

    return {
      ready: Array.isArray(raw.ready) ? (raw.ready as DirectTarget[]) : [],
      unreachable: Array.isArray(raw.unreachable)
        ? raw.unreachable.filter((n): n is string => typeof n === 'string')
        : [],
    };
  }

  /**
   * "Who is this, and what did they say they would send?"
   *
   * Null rather than a throw when the server refuses: a token it does not
   * recognise is the ordinary answer to a stranger connecting, not a fault.
   */
  async claim(token: string): Promise<ClaimResult | null> {
    try {
      const body = (await this.post('/api/peer/claim', { token })) as {
        from?: unknown;
        files?: unknown;
        note?: unknown;
      };
      return {
        from: typeof body.from === 'string' ? body.from : 'Somebody',
        files: Array.isArray(body.files) ? (body.files as ClaimResult['files']) : [],
        note: typeof body.note === 'string' ? body.note : '',
      };
    } catch {
      return null;
    }
  }

  /** "It arrived." Recorded so the sender's Sent page can say so. */
  async complete(token: string, ok: boolean): Promise<void> {
    await this.post('/api/peer/complete', { token, ok });
  }

  private async post(route: string, body: unknown): Promise<unknown> {
    return this.send('POST', route, body);
  }

  private async send(method: string, route: string, body: unknown): Promise<unknown> {
    const response = await fetch(`${this.origin.replace(/\/+$/, '')}${route}`, {
      method,
      headers: {
        cookie: this.cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });

    const payload = (await response.json().catch(() => null)) as
      | { error?: { message?: string } }
      | null;

    if (!response.ok) {
      throw new Error(payload?.error?.message ?? `The server answered with ${response.status}.`);
    }
    return payload;
  }
}
