import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {
  encodeLine,
  MAX_LINE_BYTES,
  parseFileHeader,
  parseHello,
  uniqueFilename,
} from './protocol.js';

/**
 * The listening half: accepting files sent straight from a colleague's
 * machine.
 *
 * This is a port open on somebody's PC on an office network, so it assumes
 * every connection is hostile until the server says otherwise. It reads one
 * line, asks the server whether that token is a real transfer addressed to
 * this user, and hangs up on anything else. Nothing is written to disk
 * before that answer comes back.
 */

export interface IncomingFile {
  name: string;
  size: number;
}

export interface ClaimResult {
  from: string;
  files: IncomingFile[];
  note: string;
}

export interface ReceiverOptions {
  /** Where finished files are written. */
  destination: string;
  /**
   * Hands the token to the server and returns what it says, or null if the
   * server refuses. Injected so the protocol can be tested without one.
   */
  claim: (token: string) => Promise<ClaimResult | null>;
  /** Told how it went, so the server can record delivery. */
  complete?: (token: string, ok: boolean) => Promise<void>;
  onProgress?: (progress: { from: string; name: string; received: number; total: number }) => void;
  onFinished?: (result: { from: string; files: string[]; note: string }) => void;
  onFailed?: (reason: string) => void;
}

/** Refuse a file whose header claims more than this. */
const MAX_FILE_BYTES = 1024 * 1024 * 1024 * 1024; // 1 TB

export class PeerReceiver {
  private server: net.Server | null = null;

  constructor(private readonly options: ReceiverOptions) {}

  /** Starts listening and resolves with the port the OS chose. */
  async listen(preferredPort = 0): Promise<number> {
    const server = net.createServer((socket) => void this.handle(socket));
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      // All interfaces: the point is that a colleague's machine can reach it.
      server.listen(preferredPort, '0.0.0.0', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });

    const address = server.address();
    return typeof address === 'object' && address ? address.port : 0;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  get port(): number {
    const address = this.server?.address();
    return typeof address === 'object' && address ? address.port : 0;
  }

  private async handle(socket: net.Socket): Promise<void> {
    const reader = new SocketReader(socket);
    let token = '';

    try {
      // A connection that says nothing useful quickly is not a colleague.
      socket.setTimeout(30_000, () => socket.destroy());

      const hello = parseHello(await reader.line());
      if (!hello) throw new Error('not a BetSend sender');
      token = hello.token;

      const offer = await this.options.claim(hello.token);
      if (!offer) {
        socket.write(encodeLine({ ok: false, error: 'That transfer is not for me.' }));
        socket.end();
        return;
      }

      socket.write(encodeLine({ ok: true }));
      // Plenty of time between chunks of a large file on a slow link.
      socket.setTimeout(120_000, () => socket.destroy());

      const written = await this.receiveFiles(reader, offer);

      socket.write(encodeLine({ ok: true }));
      socket.end();

      await this.options.complete?.(token, true);
      this.options.onFinished?.({ from: offer.from, files: written, note: offer.note });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      try {
        // end(), not write()+destroy(): destroy throws away anything still
        // queued, so the sender would learn only that the connection died
        // and never why. It needs the reason to decide whether falling back
        // to the server is worth trying.
        socket.end(encodeLine({ ok: false, error: reason }));
      } catch {
        /* the other end has probably gone */
      }
      // end() waits for the sender to stop talking, which a sender being
      // refused mid-file may take a while to do.
      setTimeout(() => socket.destroy(), 1000).unref();
      if (token) await this.options.complete?.(token, false).catch(() => undefined);
      this.options.onFailed?.(reason);
    }
  }

  private async receiveFiles(reader: SocketReader, offer: ClaimResult): Promise<string[]> {
    fs.mkdirSync(this.options.destination, { recursive: true });

    const written: string[] = [];
    const promised = new Map(offer.files.map((file) => [file.name, file.size]));

    for (;;) {
      const header = parseFileHeader(await reader.line());
      if (!header) throw new Error('the sender sent something unreadable');
      if ('done' in header) break;

      // Only what the server said was coming. A sender that announced one
      // file does not get to deliver a second.
      if (!promised.has(header.name)) throw new Error(`${header.name} was not part of this transfer`);
      if (promised.get(header.name) !== header.size) throw new Error(`${header.name} is not the size promised`);
      if (header.size > MAX_FILE_BYTES) throw new Error(`${header.name} is implausibly large`);
      promised.delete(header.name);

      written.push(await this.receiveOne(reader, offer.from, header.name, header.size));
    }

    return written;
  }

  private async receiveOne(
    reader: SocketReader,
    from: string,
    name: string,
    size: number,
  ): Promise<string> {
    const finalName = uniqueFilename(this.options.destination, name, fs.existsSync);
    const finalPath = path.join(this.options.destination, finalName);
    // Written beside its destination under a different name, so a transfer
    // that fails never leaves something that looks like a finished file.
    const partPath = `${finalPath}.part`;

    const sink = fs.createWriteStream(partPath);
    const hash = crypto.createHash('sha256');
    let received = 0;

    try {
      while (received < size) {
        const chunk = await reader.bytes(Math.min(size - received, 1024 * 1024));
        hash.update(chunk);
        received += chunk.length;
        if (!sink.write(chunk)) await once(sink, 'drain');
        this.options.onProgress?.({ from, name, received, total: size });
      }
      await new Promise<void>((resolve, reject) => sink.end((err?: Error) => (err ? reject(err) : resolve())));

      const trailer = JSON.parse(await reader.line()) as { sha256?: unknown };
      const expected = typeof trailer.sha256 === 'string' ? trailer.sha256 : '';
      const actual = hash.digest('hex');
      if (expected && expected !== actual) {
        throw new Error(`${name} arrived corrupted`);
      }

      fs.renameSync(partPath, finalPath);
      return finalName;
    } catch (err) {
      sink.destroy();
      fs.rmSync(partPath, { force: true });
      throw err;
    }
  }
}

function once(emitter: NodeJS.EventEmitter, event: string): Promise<void> {
  return new Promise((resolve) => emitter.once(event, () => resolve()));
}

/**
 * Reads lines and exact byte counts off a socket.
 *
 * Sockets deliver whatever arrived, not whatever was asked for, so both
 * halves of the protocol need buffering. The line length is capped because
 * a sender that never sends a newline would otherwise grow this buffer
 * until the app died.
 */
export class SocketReader {
  private buffer: Buffer = Buffer.alloc(0);
  private ended = false;
  private error: Error | null = null;
  private wake: (() => void) | null = null;

  constructor(private readonly socket: net.Socket) {
    socket.on('data', (chunk: Buffer) => {
      this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
      this.wake?.();
    });
    socket.on('end', () => {
      this.ended = true;
      this.wake?.();
    });
    socket.on('close', () => {
      this.ended = true;
      this.wake?.();
    });
    socket.on('error', (err: Error) => {
      this.error = err;
      this.ended = true;
      this.wake?.();
    });
  }

  async line(): Promise<string> {
    for (;;) {
      const line = this.takeLine();
      if (line !== null) return line;
      if (this.buffer.length > MAX_LINE_BYTES) throw new Error('the sender sent an overlong line');
      await this.more();
    }
  }

  /**
   * A complete line already in the buffer, without waiting for one.
   *
   * The sending half uses this to find out why a connection died: the
   * refusal arrives just before the socket closes, so by the time the close
   * is noticed the explanation is already sitting here.
   */
  takeLine(): string | null {
    const newline = this.buffer.indexOf(0x0a);
    if (newline === -1) return null;
    const line = this.buffer.subarray(0, newline).toString('utf8');
    this.buffer = this.buffer.subarray(newline + 1);
    return line;
  }

  async bytes(count: number): Promise<Buffer> {
    while (this.buffer.length === 0) await this.more();
    const take = Math.min(count, this.buffer.length);
    const chunk = this.buffer.subarray(0, take);
    this.buffer = this.buffer.subarray(take);
    return chunk;
  }

  private async more(): Promise<void> {
    if (this.error) throw this.error;
    if (this.ended) throw new Error('the connection closed before the transfer finished');
    await new Promise<void>((resolve) => {
      this.wake = () => {
        this.wake = null;
        resolve();
      };
    });
    if (this.error) throw this.error;
  }
}
