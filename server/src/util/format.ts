/** Encode a filename for Content-Disposition, safe for non-ASCII names. */
export function contentDisposition(filename: string, type: 'attachment' | 'inline' = 'attachment'): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** Strip path separators and control characters out of a client-supplied filename. */
export function sanitizeFilename(name: string): string {
  const base = String(name ?? '')
    .replace(/[\\/]+/g, '_')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f<>:"|?*]/g, '_')
    .replace(/^\.+/, '_')
    .trim();
  return base.slice(0, 255) || 'file';
}

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** Human-readable size, for messages people actually read. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), SIZE_UNITS.length - 1);
  const value = bytes / 1024 ** exponent;
  const digits = exponent === 0 ? 0 : value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${SIZE_UNITS[exponent]}`;
}
