import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config.js';

/**
 * Sending mail through the office Exchange relay.
 *
 * Internal relays are not the public internet: they usually accept
 * unauthenticated mail from an internal address on port 25, and often present
 * a certificate signed by the company's own CA. The defaults here reflect
 * that rather than what a hosted mail provider would want.
 *
 * Mail is best-effort. A relay being down must never stop somebody sending a
 * file, so every send is caught and logged; only the explicit "send a test
 * message" path reports failure to the caller.
 */

export interface MailLogger {
  info: (o: unknown, m?: string) => void;
  warn: (o: unknown, m?: string) => void;
  error: (o: unknown, m?: string) => void;
}

let transport: Transporter | null = null;
let logger: MailLogger | null = null;

export function setMailLogger(log: MailLogger): void {
  logger = log;
}

export function mailConfigured(): boolean {
  return Boolean(config.smtpHost && config.smtpFrom);
}

function getTransport(): Transporter {
  if (transport) return transport;

  transport = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    requireTLS: config.smtpRequireTls || undefined,
    // Only authenticate when credentials were given; Exchange usually wants
    // none from an internal host, and sending empty ones makes it refuse.
    auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPassword } : undefined,
    tls: { rejectUnauthorized: config.smtpRejectUnauthorized },
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });

  return transport;
}

/** Drop the cached transport so changed settings take effect. */
export function resetTransport(): void {
  transport?.close?.();
  transport = null;
}

export interface Message {
  to: string;
  subject: string;
  text: string;
}

/** Send, swallowing failures. Returns whether it got through. */
export async function send(message: Message): Promise<boolean> {
  if (!mailConfigured()) return false;
  try {
    await getTransport().sendMail({
      from: config.smtpFrom,
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
    logger?.info({ to: message.to, subject: message.subject }, 'mail sent');
    return true;
  } catch (err) {
    logger?.error({ err, to: message.to, subject: message.subject }, 'mail failed');
    return false;
  }
}

/** Send and let the error through — for the admin page's test button. */
export async function sendOrThrow(message: Message): Promise<void> {
  if (!mailConfigured()) {
    throw new Error('No mail server is configured. Set smtpHost and smtpFrom first.');
  }
  await getTransport().sendMail({
    from: config.smtpFrom,
    to: message.to,
    subject: message.subject,
    text: message.text,
  });
}

/** Check the relay is reachable without sending anything. */
export async function verifyConnection(): Promise<void> {
  if (!mailConfigured()) {
    throw new Error('No mail server is configured. Set smtpHost and smtpFrom first.');
  }
  await getTransport().verify();
}

// --- the messages ----------------------------------------------------------

const SIGN_OFF = '\n\n--\nBetSend';

export function verifyAddressMessage(to: string, link: string): Message {
  return {
    to,
    subject: 'Finish setting up BetSend',
    text:
      `Someone — probably you — asked to use BetSend with this address.\n\n` +
      `Open the link below to choose a password. It works once and expires in 72 hours.\n\n` +
      `${link}\n\n` +
      `If this was not you, ignore this message and nothing will happen.` +
      SIGN_OFF,
  };
}

export function resetPasswordMessage(to: string, link: string): Message {
  return {
    to,
    subject: 'Reset your BetSend password',
    text:
      `Open the link below to choose a new password. It works once and expires in 72 hours.\n\n` +
      `${link}\n\n` +
      `Your current password keeps working until you do. If you did not ask for this, ignore it.` +
      SIGN_OFF,
  };
}

export interface TransferMail {
  to: string;
  from: string;
  fileCount: number;
  totalSize: string;
  note: string | null;
  expires: string;
  link: string;
}

export function newTransferMessage(details: TransferMail): Message {
  const files = details.fileCount === 1 ? '1 file' : `${details.fileCount} files`;
  return {
    to: details.to,
    subject: `${details.from} sent you ${files}`,
    text:
      `${details.from} has sent you ${files} (${details.totalSize}) on BetSend.\n\n` +
      (details.note ? `Their note:\n  ${details.note}\n\n` : '') +
      `Collect them here:\n${details.link}\n\n` +
      `They are deleted ${details.expires}, so do not leave it too long.` +
      SIGN_OFF,
  };
}

export function testMessage(to: string): Message {
  return {
    to,
    subject: 'BetSend test message',
    text:
      'If you are reading this, BetSend can send mail through your relay.\n\n' +
      'Password resets, sign-up links and "you have files waiting" notices will reach people.' +
      SIGN_OFF,
  };
}
