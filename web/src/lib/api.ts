import { t } from '../i18n';

/**
 * Thin fetch wrapper.
 *
 * Identity is a session cookie set by the server at sign-in — nothing is kept
 * in JavaScript, so an XSS bug cannot read it, and plain download links carry
 * it automatically. Admin calls add the shared token header when the signed-in
 * account is not itself an admin.
 */

export class ApiError extends Error {
  code: string;
  status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

let adminToken: string | null = null;
let onSignedOut: (() => void) | null = null;

export function setAdminToken(token: string | null): void {
  adminToken = token;
}

export function getAdminToken(): string | null {
  return adminToken;
}

/** Registered by the app so any 401 drops the user back to the sign-in screen. */
export function setSignedOutHandler(handler: (() => void) | null): void {
  onSignedOut = handler;
}

/** Trigger that handler from outside this module (uploads bypass `request`). */
export function notifySignedOut(): void {
  onSignedOut?.();
}

function headers(extra?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { ...extra };
  if (adminToken) out['X-Admin-Token'] = adminToken;
  return out;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin', // send the session cookie
      headers: headers(body === undefined ? undefined : { 'Content-Type': 'application/json' }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    // Network-level failure: the server is down or the connection dropped.
    throw new ApiError(0, 'offline', t('error.offline'));
  }

  if (response.status === 204) return undefined as T;

  let payload: unknown = null;
  const text = await response.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string } })?.error;
    const code = error?.code ?? 'server_error';

    // The session expired or was revoked — stop pretending we are signed in.
    if (response.status === 401 && code === 'not_signed_in') {
      onSignedOut?.();
    }

    throw new ApiError(response.status, code, error?.message ?? t('error.generic'));
  }

  return payload as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body ?? {}),
  del: <T>(path: string) => request<T>('DELETE', path),
};

/**
 * Downloads go through a normal link click so the browser's own download
 * manager handles them — native progress, and Range-based pause/resume. The
 * session cookie rides along with the navigation, so no identity ever appears
 * in the URL where it could end up in a proxy log or a Referer header.
 */
export function startDownload(path: string): void {
  const link = document.createElement('a');
  link.href = path;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
}
