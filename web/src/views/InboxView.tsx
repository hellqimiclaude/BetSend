import { useEffect, useState } from 'react';
import { useApp } from '../state/AppContext';
import { startDownload } from '../lib/api';
import { t } from '../i18n';
import { classNames, formatBytes, formatDuration, formatWhen } from '../lib/format';
import { Badge, Button, Card, EmptyState, LoadingState } from '../components/ui';
import { IconClock, IconDownload, IconFile, IconInbox } from '../components/Icons';
import type { TransferView } from '../types';

/** Re-render once a minute so the expiry countdowns stay honest. */
function useTicker(intervalMs = 30_000): number {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setTick(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return tick;
}

export function InboxView() {
  const { inbox, loadingInbox, refreshInbox, markSeen } = useApp();
  const now = useTicker();

  useEffect(() => {
    void refreshInbox();
  }, [refreshInbox]);

  // Opening the Inbox is what "reading" means — clear the badge for what is shown.
  useEffect(() => {
    for (const transfer of inbox) {
      if (transfer.me && !transfer.me.seenAt) void markSeen(transfer.id);
    }
  }, [inbox, markSeen]);

  if (loadingInbox && inbox.length === 0) return <LoadingState />;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <header className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">{t('inbox.title')}</h1>
        {inbox.length > 0 ? (
          <span className="text-sm text-slate-500 dark:text-slate-400">{inbox.length}</span>
        ) : null}
      </header>

      {inbox.length === 0 ? (
        <EmptyState
          icon={<IconInbox className="h-10 w-10" />}
          title={t('inbox.empty')}
          hint={t('inbox.emptyHint')}
        />
      ) : (
        <div className="flex flex-col gap-3 pb-8">
          {inbox.map((transfer) => (
            <InboxCard key={transfer.id} transfer={transfer} now={now} />
          ))}
        </div>
      )}
    </div>
  );
}

function InboxCard({ transfer, now }: { transfer: TransferView; now: number }) {
  const remaining = transfer.expiresAt - now;
  const soon = remaining < 6 * 3600_000;
  /*
   * A direct transfer is downloaded by definition -- the bytes were on this
   * machine's disk before the server was told about it -- so "new" has to
   * mean unread here rather than not-yet-fetched.
   */
  const direct = transfer.delivery === 'direct';
  const isNew = direct ? !transfer.me?.seenAt : !transfer.me?.downloadedAt;

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-base font-semibold text-slate-900 dark:text-slate-100">
              {t('inbox.from', { name: transfer.sender.name })}
            </h2>
            {isNew ? <Badge tone="green">{t('inbox.new')}</Badge> : null}
          </div>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            {formatWhen(transfer.createdAt)} · {formatBytes(transfer.totalSize)}
          </p>
        </div>

        {direct ? (
          <Badge tone="slate">{t('direct.badge')}</Badge>
        ) : (
          <span
            className={classNames(
              'inline-flex items-center gap-1.5 text-xs',
              soon ? 'text-amber-600 dark:text-amber-400' : 'text-slate-500 dark:text-slate-400',
            )}
          >
            <IconClock className="h-3.5 w-3.5" />
            {t('inbox.expiresIn', { time: formatDuration(remaining) })}
          </span>
        )}
      </div>

      {transfer.note ? (
        <p className="mt-3 whitespace-pre-wrap rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700 dark:bg-slate-800/70 dark:text-slate-200">
          {transfer.note}
        </p>
      ) : null}

      <ul className="mt-3 divide-y divide-slate-100 dark:divide-slate-800">
        {transfer.files.map((file) => (
          <li key={file.id} className="flex items-center gap-3 py-2">
            <IconFile className="h-4 w-4 shrink-0 text-slate-400" />
            <span className="min-w-0 flex-1 truncate text-sm text-slate-700 dark:text-slate-200">{file.name}</span>
            <span className="shrink-0 text-xs tabular-nums text-slate-500 dark:text-slate-400">
              {formatBytes(file.size)}
            </span>
            {direct ? null : (
              <Button
                variant="ghost"
                className="shrink-0 px-2 py-1"
                icon={<IconDownload className="h-4 w-4" />}
                onClick={() => startDownload(`/api/transfers/${transfer.id}/files/${file.id}`)}
              >
                <span className="sr-only sm:not-sr-only">{t('inbox.download')}</span>
              </Button>
            )}
          </li>
        ))}
      </ul>

      {direct ? (
        /*
         * Where the files went, rather than a button that cannot work. The
         * page is also served to browsers, where there is no desktop app to
         * have put them anywhere, so the wording does not assume one is
         * running now -- only that one was when they arrived.
         */
        <p className="mt-3 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          {t('direct.inboxWhere', { name: transfer.sender.name })}
        </p>
      ) : (
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {transfer.files.length > 1 ? (
          <Button
            variant="primary"
            icon={<IconDownload className="h-4 w-4" />}
            onClick={() => startDownload(`/api/transfers/${transfer.id}/zip`)}
          >
            {t('inbox.downloadAll', { count: transfer.files.length })}
          </Button>
        ) : (
          <Button
            variant="primary"
            icon={<IconDownload className="h-4 w-4" />}
            onClick={() => startDownload(`/api/transfers/${transfer.id}/files/${transfer.files[0]?.id}`)}
          >
            {t('inbox.download')}
          </Button>
        )}
        {transfer.me?.downloadedAt ? (
          <span className="text-xs text-emerald-600 dark:text-emerald-400">
            {t('inbox.downloaded')} · {formatWhen(transfer.me.downloadedAt)}
          </span>
        ) : null}
      </div>
      )}
    </Card>
  );
}
