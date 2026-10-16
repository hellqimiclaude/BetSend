/**
 * Turning a failed connection into a sentence that suggests what to do.
 *
 * Node's fetch reports every network problem as `TypeError: fetch failed` and
 * hides the real reason in `cause`. Showing that to somebody who has just
 * typed their office PC's name tells them nothing: a typo in the name, a
 * wrong port and a PC that is switched off all read the same.
 */

/** Walk the cause chain for the first thing that looks like a syscall error. */
function errnoOf(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    const candidate = current as { code?: unknown; name?: unknown; cause?: unknown };
    if (typeof candidate.code === 'string') return candidate.code;
    if (candidate.name === 'TimeoutError' || candidate.name === 'AbortError') return 'ETIMEDOUT';
    current = candidate.cause;
  }
  return '';
}

/**
 * fetch refuses a list of ports outright -- 21, 25, 110 and a few dozen more
 * that predate the web -- and reports it as "bad port" with no error code.
 * Somebody who types their mail server's address by mistake lands here, and
 * deserves better than the generic answer.
 */
function isBlockedPort(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    const candidate = current as { message?: unknown; cause?: unknown };
    if (typeof candidate.message === 'string' && candidate.message.toLowerCase() === 'bad port') return true;
    current = candidate.cause;
  }
  return false;
}

export function explainNetworkFailure(error: unknown): string {
  if (isBlockedPort(error)) {
    return 'That port cannot be used for web traffic. BetSend normally runs on 8080 or 80.';
  }

  switch (errnoOf(error)) {
    case 'ECONNREFUSED':
      return 'That computer answered, but nothing is listening on that port. Check the port number.';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'No computer with that name could be found. Check the spelling, or use its IP address.';
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
    case 'UND_ERR_HEADERS_TIMEOUT':
      return 'It did not answer in time. It may be switched off, or blocked by a firewall.';
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return 'That computer could not be reached from this network. Are you on the office network or VPN?';
    case 'ECONNRESET':
      return 'The connection closed before it answered.';
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return 'Its security certificate could not be trusted.';
    case 'CERT_HAS_EXPIRED':
      return 'Its security certificate has expired.';
    default:
      return 'It could not be reached.';
  }
}

/** The whole message for an address that did not work out. */
export function unreachableMessage(candidates: string[], firstFailure: string): string {
  if (candidates.length > 1) {
    return `Nothing answered at ${candidates.join(' or ')}. Check the address, and that the BetSend PC is switched on.`;
  }
  return `Nothing answered at ${candidates[0]}. ${firstFailure}`;
}
