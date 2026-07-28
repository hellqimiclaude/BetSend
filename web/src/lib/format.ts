import { t } from '../i18n';

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function formatBytes(bytes: number, decimals = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1);
  const value = bytes / 1024 ** exponent;
  const digits = exponent === 0 ? 0 : value >= 100 ? 0 : decimals;
  return `${value.toFixed(digits)} ${UNITS[exponent]}`;
}

/** Compact duration for countdowns: 2d 4h, 45m, 30s. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return t('time.expired');
  const seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days > 0) return `${t('time.days', { n: days })} ${t('time.hours', { n: hours })}`;
  if (hours > 0) return `${t('time.hours', { n: hours })} ${t('time.minutes', { n: minutes })}`;
  if (minutes > 0) return t('time.minutes', { n: minutes });
  return t('time.seconds', { n: seconds % 60 });
}

export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  return formatDuration(seconds * 1000);
}

const dateTime = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

export function formatWhen(timestamp: number): string {
  const delta = Date.now() - timestamp;
  if (delta < 60_000) return t('time.justNow');
  if (delta < 86_400_000) {
    return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(timestamp);
  }
  return dateTime.format(timestamp);
}

export function classNames(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}
