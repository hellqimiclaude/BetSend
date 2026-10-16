/**
 * Turning what somebody types into an address the app can open.
 *
 * This is the first thing a new user sees, so it has to accept what people
 * actually type rather than a URL. All of these mean the same server:
 *
 *     betsend-pc            192.168.1.5:8080
 *     192.168.1.5           http://192.168.1.5:8080/
 *     BETSEND-PC/           https://files.betlive.com
 *
 * Nothing here touches the network. `candidates()` returns the addresses
 * worth trying, in order, and the caller decides which one answers.
 */

export interface GoodAddress {
  ok: true;
  /** Addresses to try, in order. Always at least one, always an origin. */
  candidates: string[];
}

export interface BadAddress {
  ok: false;
  error: string;
}

export type AddressResult = GoodAddress | BadAddress;

/**
 * The port the installer defaults to. Somebody who types a bare machine name
 * almost certainly means this, but might mean port 80 if whoever installed it
 * chose that so the address could be typed without a port. Try both rather
 * than making them guess which.
 */
const INSTALLER_DEFAULT_PORT = 8080;

export function parseAddress(raw: string): AddressResult {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return { ok: false, error: 'Enter the address of your BetSend server.' };

  // A bare host is not a URL, so give it a scheme before parsing. Plain http
  // is the right default: this is an office LAN, and a server behind HTTPS is
  // reached through a name somebody will have written out in full anyway.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, error: `"${trimmed}" is not an address BetSend can open.` };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'The address has to start with http:// or https://.' };
  }
  if (!url.hostname) {
    return { ok: false, error: 'That address is missing a computer name.' };
  }
  if (url.username || url.password) {
    return { ok: false, error: 'Leave the username and password out of the address.' };
  }

  // Everything after the origin is dropped: the app always opens the root, and
  // a pasted deep link should not pin it to one page forever.
  //
  // url.port is no use for telling whether one was typed: URL erases the
  // default, so http://host:80 and http://host both leave it empty. Somebody
  // who wrote :80 has chosen a port and should not have 8080 tried first, so
  // read it off the text instead.
  const authority = withScheme.slice(withScheme.indexOf('://') + 3).split(/[/?#]/)[0];
  if (/:\d+$/.test(authority)) return { ok: true, candidates: [url.origin] };

  // No port given. For https, 443 is almost certainly meant. For http, the
  // installer's 8080 is the likelier answer, but 80 is what somebody gets if
  // they chose it so colleagues could leave the port off.
  if (url.protocol === 'https:') return { ok: true, candidates: [url.origin] };

  return {
    ok: true,
    candidates: [`http://${url.host}:${INSTALLER_DEFAULT_PORT}`, `http://${url.host}`],
  };
}

/** Where the health endpoint lives for a given origin. */
export function healthUrl(origin: string): string {
  return `${origin.replace(/\/+$/, '')}/api/health`;
}

/**
 * Is this a page the app window is allowed to show?
 *
 * The window exists to display one server. Anything else -- a link somebody
 * put in a transfer note, a redirect to a sign-in portal -- belongs in the
 * real browser, where the user can see the address bar and judge it.
 */
export function isSameServer(origin: string, target: string): boolean {
  try {
    return new URL(target).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}
