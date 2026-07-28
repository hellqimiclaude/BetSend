import { t } from '../i18n';

/**
 * Thin fetch wrapper. Every call carries the chosen identity in `X-User`;
 * admin calls add `X-Admin-Token`. Server errors always arrive as
 * `{ error: { code, message } }`, so the message is safe to show as-is.
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

let identity: string | null = null;
let adminToken: string | null = null;

export function setIdentity(name: string | null): void {
  identity = name;
}

export function setAdminToken(token: string | null): void {
  adminToken = token;
}

export function getAdminToken(): string | null {
  return adminToken;
}

function headers(extra?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { ...extra };
  if (identity) out['X-User'] = identity;
  if (adminToken) out['X-Admin-Token'] = adminToken;
  return out;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: headers(body === undefined ? undefined : { 'Content-Type': 'application/json' }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    // Network-level failure: the server is down or the Wi-Fi dropped.
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
    throw new ApiError(response.status, error?.code ?? 'server_error', error?.message ?? t('error.generic'));
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
 * Downloads go through a hidden iframe-free anchor click so the browser's own
 * download manager handles them (native progress, pause/resume via Range).
 * The identity travels as a query parameter because a plain link cannot set
 * headers.
 */
export function downloadUrl(path: string): string {
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}user=${encodeURIComponent(identity ?? '')}`;
}

export function startDownload(path: string): void {
  const link = document.createElement('a');
  link.href = downloadUrl(path);
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
}
