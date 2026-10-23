import path from 'node:path';

/**
 * The wire protocol between two BetSend apps.
 *
 * Deliberately plain: newline-delimited JSON for anything structural, raw
 * bytes for file contents. There is no framing cleverness because there is
 * nothing to be clever about -- one connection carries one transfer, files
 * in order, each announced before it arrives.
 *
 *   -> { v: 1, token }                 the sender identifies the transfer
 *   <- { ok: true } | { ok, error }    the recipient, after asking the server
 *   -> { name, size }                  then exactly `size` bytes
 *   -> { sha256 }                      a trailer, so corruption is caught
 *   ... repeated per file ...
 *   -> { done: true }
 *   <- { ok: true } | { ok, error }
 *
 * The hash is computed while the bytes stream past rather than in a pass of
 * its own, so it costs no extra reading. TCP's own checksum is 16 bits,
 * which is not much reassurance spread over ten gigabytes.
 */

export const PROTOCOL_VERSION = 1;

/** Nothing structural in this protocol is anywhere near this long. */
export const MAX_LINE_BYTES = 64 * 1024;

export function encodeLine(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
}

export interface Hello {
  v: number;
  token: string;
}

export interface FileHeader {
  name: string;
  size: number;
}

export function parseHello(line: string): Hello | null {
  const value = safeParse(line);
  if (!value) return null;
  const hello = value as Partial<Hello>;
  if (typeof hello.token !== 'string' || !hello.token) return null;
  if (hello.v !== PROTOCOL_VERSION) return null;
  return { v: hello.v, token: hello.token };
}

export function parseFileHeader(line: string): FileHeader | { done: true } | null {
  const value = safeParse(line);
  if (!value) return null;
  const header = value as Partial<FileHeader> & { done?: boolean };

  if (header.done === true) return { done: true };
  if (typeof header.name !== 'string' || !header.name) return null;

  const size = Number(header.size);
  if (!Number.isInteger(size) || size < 0) return null;

  return { name: header.name, size };
}

function safeParse(line: string): unknown {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === 'object' && value !== null ? value : null;
  } catch {
    return null;
  }
}

/**
 * A name that is safe to write into the downloads folder.
 *
 * The name arrives from another machine, so it is treated as hostile: no
 * directory separators, no climbing out with "..", no device names Windows
 * still reserves, and nothing empty. The sender's filename is a suggestion,
 * not an instruction.
 */
export function safeFilename(raw: string): string {
  // The last component, whichever separator was used, so a sender cannot
  // choose a directory.
  const base = raw.split(/[\\/]/).pop() ?? '';

  let cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f<>:"|?*]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    // Windows silently drops a trailing dot or space, which would turn
    // "report.pdf." into a different file from the one that was checked.
    .replace(/[. ]+$/, '');

  if (!cleaned) cleaned = 'file';

  // CON, PRN, AUX, NUL, COM1-9 and LPT1-9 are reserved whatever follows.
  const dot = cleaned.indexOf('.');
  const stem = dot === -1 ? cleaned : cleaned.slice(0, dot);
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) cleaned = `_${cleaned}`;

  // Leave room for the " (2)" an existing file would need.
  return cleaned.length > 200 ? cleaned.slice(0, 200) : cleaned;
}

/**
 * The first name in `directory` that is not taken, in the style Windows
 * uses: report.pdf, report (2).pdf, report (3).pdf.
 */
export function uniqueFilename(
  directory: string,
  name: string,
  exists: (file: string) => boolean,
): string {
  const safe = safeFilename(name);
  if (!exists(path.join(directory, safe))) return safe;

  const extension = path.extname(safe);
  const stem = safe.slice(0, safe.length - extension.length);

  for (let n = 2; n < 10_000; n++) {
    const candidate = `${stem} (${n})${extension}`;
    if (!exists(path.join(directory, candidate))) return candidate;
  }
  // Ten thousand files of the same name is somebody else's problem.
  return `${stem} (${Date.now()})${extension}`;
}
