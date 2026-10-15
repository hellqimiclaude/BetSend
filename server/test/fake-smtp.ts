import net from 'node:net';

/**
 * A minimal SMTP sink, so the mail path is tested through nodemailer for real
 * rather than mocked away. It speaks just enough of the protocol to accept a
 * message and hand back what it received — which is what an office relay
 * looks like from here.
 */

export interface CapturedMail {
  from: string;
  to: string[];
  /**
   * Exactly what came down the wire, headers and all. Long lines are folded
   * with soft `=` breaks, so a link in here is split across lines - read
   * `text` instead unless the encoding itself is what is being tested.
   */
  body: string;
  /** The body with quoted-printable decoded, as a mail client would show it. */
  text: string;
}

/**
 * Undo quoted-printable. nodemailer uses it for anything with a long line or
 * a non-ASCII character, so a link in the raw body is split across lines with
 * soft `=` breaks and its own `=` encoded as `=3D`. Real clients decode this;
 * tests should read what the recipient reads.
 */
export function decodeQuotedPrintable(input: string): string {
  return input
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
}

export interface FakeSmtp {
  port: number;
  received: CapturedMail[];
  /** Wait for the next message, so a test need not poll. */
  next(timeoutMs?: number): Promise<CapturedMail>;
  close(): Promise<void>;
}

export async function startFakeSmtp(): Promise<FakeSmtp> {
  const received: CapturedMail[] = [];
  const waiters: ((mail: CapturedMail) => void)[] = [];

  const server = net.createServer((socket) => {
    let buffer = '';
    let inData = false;
    let current: CapturedMail = { from: '', to: [], body: '', text: '' };

    socket.write('220 fake-smtp ready\r\n');

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');

      for (;;) {
        const index = buffer.indexOf('\r\n');
        if (index < 0) break;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);

        if (inData) {
          if (line === '.') {
            inData = false;
            current.text = decodeQuotedPrintable(current.body);
            received.push(current);
            const waiter = waiters.shift();
            if (waiter) waiter(current);
            current = { from: '', to: [], body: '', text: '' };
            socket.write('250 queued\r\n');
          } else {
            // A leading dot is doubled by the sender; undo it.
            current.body += (line.startsWith('..') ? line.slice(1) : line) + '\n';
          }
          continue;
        }

        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
          socket.write('250-fake-smtp\r\n250 8BITMIME\r\n');
        } else if (upper.startsWith('MAIL FROM')) {
          current.from = line.slice(line.indexOf(':') + 1).trim();
          socket.write('250 ok\r\n');
        } else if (upper.startsWith('RCPT TO')) {
          current.to.push(line.slice(line.indexOf(':') + 1).trim().replace(/^<|>$/g, ''));
          socket.write('250 ok\r\n');
        } else if (upper.startsWith('DATA')) {
          inData = true;
          socket.write('354 go ahead\r\n');
        } else if (upper.startsWith('QUIT')) {
          socket.write('221 bye\r\n');
          socket.end();
        } else if (upper.startsWith('RSET') || upper.startsWith('NOOP')) {
          socket.write('250 ok\r\n');
        } else {
          socket.write('250 ok\r\n');
        }
      }
    });

    socket.on('error', () => socket.destroy());
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address !== 'object') throw new Error('fake smtp did not bind');

  return {
    port: address.port,
    received,
    next(timeoutMs = 5000) {
      if (received.length > 0) return Promise.resolve(received[received.length - 1]);
      return new Promise<CapturedMail>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no mail arrived in time')), timeoutMs);
        waiters.push((mail) => {
          clearTimeout(timer);
          resolve(mail);
        });
      });
    },
    close() {
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
