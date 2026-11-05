import { useEffect, useState } from 'react';
import { api, ApiError, startDownload } from '../lib/api';
import { t } from '../i18n';
import { formatBytes, formatUntil, formatWhen } from '../lib/format';
import { Button, Card, EmptyState, LoadingState } from '../components/ui';
import { IconDownload, IconFile, IconX } from '../components/Icons';
import type { TransferView } from '../types';

/**
 * The page a shared link opens.
 *
 * Whoever follows the link is signed in — the server refuses otherwise — but
 * they are usually not a recipient and may have nothing to do with the
 * transfer. So the page says plainly who sent what and when, and offers the
 * files. It does not show the recipient list: who else was sent these is not
 * the business of whoever happens to hold the link.
 *
 * A link that has expired or been turned off explains which, because the
 * person clicking it is often working from a months-old task and the useful
 * answer is "this ran out on 5 December, ask them again" rather than a dead
 * page.
 */
export function DownloadView({ token }: { token: string }) {
  const [transfer, setTransfer] = useState<TransferView | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    api
      .get<{ transfer: TransferView; link: { expiresAt: number } }>(`/api/link/${encodeURIComponent(token)}`)
      .then((body) => {
        if (cancelled) return;
        setTransfer(body.transfer);
        setExpiresAt(body.link.expiresAt);
      })
      .catch((err: ApiError) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  if (loading) return <LoadingState />;

  if (error || !transfer) {
    return (
      <div className="mx-auto w-full max-w-2xl">
        <EmptyState
          icon={<IconX className="h-10 w-10" />}
          title={t('link.notAvailable')}
          hint={error ?? undefined}
        />
      </div>
    );
  }

  const url = (path: string) => `${path}?link=${encodeURIComponent(token)}`;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-5">
      <header>
        <h1 className="font-display text-2xl font-semibold tracking-tight">{t('link.title')}</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          {t('link.sharedBy', { name: transfer.sender.name, when: formatWhen(transfer.createdAt) })}
        </p>
      </header>

      <Card className="p-4">
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {transfer.fileCount} {transfer.fileCount === 1 ? 'file' : 'files'} ·{' '}
          {formatBytes(transfer.totalSize)}
          {expiresAt ? ` · ${t('link.availableUntil', { when: formatUntil(expiresAt) })}` : ''}
        </p>

        {transfer.note ? (
          <p className="mt-3 whitespace-pre-wrap rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700 dark:bg-slate-800/70 dark:text-slate-200">
            {transfer.note}
          </p>
        ) : null}

        <ul className="mt-3 divide-y divide-slate-100 dark:divide-slate-800">
          {transfer.files.map((file) => (
            <li key={file.id} className="flex items-center gap-3 py-2">
              <IconFile className="h-4 w-4 shrink-0 text-slate-400" />
              <span className="min-w-0 flex-1 truncate text-sm text-slate-700 dark:text-slate-200">
                {file.name}
              </span>
              <span className="shrink-0 text-xs tabular-nums text-slate-500 dark:text-slate-400">
                {formatBytes(file.size)}
              </span>
              <Button
                variant="ghost"
                className="shrink-0 px-2 py-1"
                icon={<IconDownload className="h-4 w-4" />}
                onClick={() => startDownload(url(`/api/transfers/${transfer.id}/files/${file.id}`))}
              >
                <span className="sr-only sm:not-sr-only">{t('inbox.download')}</span>
              </Button>
            </li>
          ))}
        </ul>

        <div className="mt-4">
          {transfer.files.length > 1 ? (
            <Button
              variant="primary"
              icon={<IconDownload className="h-4 w-4" />}
              onClick={() => startDownload(url(`/api/transfers/${transfer.id}/zip`))}
            >
              {t('inbox.downloadAll', { count: transfer.files.length })}
            </Button>
          ) : (
            <Button
              variant="primary"
              icon={<IconDownload className="h-4 w-4" />}
              onClick={() =>
                startDownload(url(`/api/transfers/${transfer.id}/files/${transfer.files[0]?.id}`))
              }
            >
              {t('inbox.download')}
            </Button>
          )}
        </div>
      </Card>

      <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">{t('link.footnote')}</p>
    </div>
  );
}
