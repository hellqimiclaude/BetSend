import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import { encodeLine, PROTOCOL_VERSION } from './protocol.js';
import { SocketReader } from './receiver.js';

/**
 * The connecting half: streaming files to a colleague's machine.
 *
 * Reads from disk and writes to the socket a chunk at a time, so a 10 GB
 * file costs the same memory as a small one -- the same property the
 * server path has, for the same reason.
 */

export interface SendableFile {
  path: string;
  name: string;
  size: number;
}

export interface DirectSendOptions {
  host: string;
  port: number;
  /** Issued by the server; the recipient checks it before accepting a byte. */
  token: string;
  files: readonly SendableFile[];
  onProgress?: (progress: { name: string; sent: number; totalSent: number; totalBytes: number }) => void;
  /** How long to wait for the recipient's app to answer at all. */
  connectTimeoutMs?: number;
}

export interface DirectSendResult {
  bytesSent: number;
  milliseconds: number;
}

export async function sendDirect(options: DirectSendOptions): Promise<DirectSendResult> {
  const startedAt = Date.now();

  const socket = await connect(options.host, options.port, options.connectTimeoutMs ?? 10_000);
  const reader = new SocketReader(socket);

  /**
   * Everything below races against this.
   *
   * Pushing bytes into a socket is not a conversation: if the recipient
   * refuses a file and hangs up, or the laptop at the other end shuts, the
   * next write simply never drains and the send waits forever. Forever is
   * the one outcome this feature cannot have -- falling back to the server
   * depends on noticing that the direct attempt failed.
   */
  const died = new Promise<never>((_, reject) => {
    const fail = (fallback: Error): void => reject(explain(reader) ?? fallback);
    socket.once('error', (err: Error) => fail(err));
    socket.once('close', () => fail(new Error('The other machine closed the connection.')));
  });
  // The race only ever reads one of the two; an unobserved rejection here
  // is normal and must not take the process down.
  died.catch(() => undefined);

  // A peer that stops reading without closing would otherwise stall us just
  // as effectively as one that disappears.
  socket.setTimeout(120_000, () => socket.destroy());

  try {
    return await Promise.race([transfer(socket, reader, options, startedAt), died]);
  } finally {
    socket.destroy();
  }
}

/**
 * The refusal the recipient sent just before the connection died, if it
 * sent one. "surprise.exe was not part of this transfer" is worth far more
 * to whoever is watching than "the connection closed".
 */
function explain(reader: SocketReader): Error | null {
  const line = reader.takeLine();
  if (line === null) return null;
  try {
    const value = JSON.parse(line) as { ok?: boolean; error?: unknown };
    if (value.ok === false && typeof value.error === 'string') return new Error(value.error);
  } catch {
    /* not something we said */
  }
  return null;
}

async function transfer(
  socket: net.Socket,
  reader: SocketReader,
  options: DirectSendOptions,
  startedAt: number,
): Promise<DirectSendResult> {
  const totalBytes = options.files.reduce((sum, file) => sum + file.size, 0);

  socket.write(encodeLine({ v: PROTOCOL_VERSION, token: options.token }));

  const greeting = JSON.parse(await reader.line()) as { ok?: boolean; error?: string };
  if (!greeting.ok) {
    throw new Error(greeting.error || 'The other machine refused the transfer.');
  }

  let totalSent = 0;
  for (const file of options.files) {
    totalSent = await sendOne(socket, file, totalSent, totalBytes, options.onProgress);
  }

  socket.write(encodeLine({ done: true }));

  const verdict = JSON.parse(await reader.line()) as { ok?: boolean; error?: string };
  if (!verdict.ok) throw new Error(verdict.error || 'The other machine did not accept the files.');

  return { bytesSent: totalSent, milliseconds: Math.max(1, Date.now() - startedAt) };
}

async function sendOne(
  socket: net.Socket,
  file: SendableFile,
  totalSentBefore: number,
  totalBytes: number,
  onProgress: DirectSendOptions['onProgress'],
): Promise<number> {
  socket.write(encodeLine({ name: file.name, size: file.size }));

  const hash = crypto.createHash('sha256');
  const source = fs.createReadStream(file.path, { highWaterMark: 1024 * 1024 });

  let sent = 0;
  let totalSent = totalSentBefore;

  try {
    for await (const chunk of source) {
      const bytes = chunk as Buffer;
      hash.update(bytes);
      if (!socket.write(bytes)) {
        // Backpressure: the socket is slower than the disk, which on a LAN
        // it usually is. Waiting here is what keeps memory flat.
        await new Promise<void>((resolve) => socket.once('drain', () => resolve()));
      }
      sent += bytes.length;
      totalSent += bytes.length;
      onProgress?.({ name: file.name, sent, totalSent, totalBytes });
    }
  } finally {
    source.destroy();
  }

  // The recipient checked the size against what the server promised, so a
  // file that changed under us would hand them a truncated or overlong
  // stream. Better to stop here than to send something wrong.
  if (sent !== file.size) {
    throw new Error(`${file.name} changed while it was being sent.`);
  }

  socket.write(encodeLine({ sha256: hash.digest('hex') }));
  return totalSent;
}

function connect(host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });

    const fail = (err: Error): void => {
      socket.destroy();
      reject(err);
    };

    socket.setTimeout(timeoutMs, () => fail(new Error('That machine did not answer in time.')));
    socket.once('error', fail);
    socket.once('connect', () => {
      socket.setTimeout(0);
      socket.removeListener('error', fail);
      resolve(socket);
    });
  });
}
