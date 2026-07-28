import { useEffect, useState } from 'react';
import { useApp } from '../state/AppContext';
import { api, ApiError } from '../lib/api';
import { t } from '../i18n';
import { classNames, formatBytes, formatDuration, formatWhen } from '../lib/format';
import { Badge, Button, Card, ConfirmDialog, EmptyState, LoadingState, ProgressBar } from '../components/ui';
import { IconCheck, IconClock, IconFile, IconSent, IconTrash } from '../components/Icons';
import type { TransferView } from '../types';

export function SentView() {
  const { sent, loadingSent, refreshSent, toast } = useApp();
  const [now, setNow] = useState(() => Date.now());
  const [confirming, setConfirming] = useState<string | null>(null);

  useEffect(() => {
    void refreshSent();
  }, [refreshSent]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  async function revoke(id: string) {
    setConfirming(null);
    try {
      await api.post(`/api/transfers/${id}/revoke`);
      toast('success', t('sent.revoked'));
      void refreshSent();
    } catch (error) {
      toast('error', (error as ApiError).message);
    }
  }

  if (loadingSent && sent.length === 0) return <LoadingState />;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t('sent.title')}</h1>
      </header>

      {sent.length === 0 ? (
        <EmptyState icon={<IconSent className="h-10 w-10" />} title={t('sent.empty')} hint={t('sent.emptyHint')} />
      ) : (
        <div className="flex flex-col gap-3 pb-8">
          {sent.map((transfer) => (
            <SentCard key={transfer.id} transfer={transfer} now={now} onRevoke={() => setConfirming(transfer.id)} />
          ))}
        </div>
      )}

      <ConfirmDialog
        open={confirming !== null}
        title={t('sent.revokeConfirm')}
        body={t('sent.revokeBody')}
        confirmLabel={t('sent.revoke')}
        danger
        onCancel={() => setConfirming(null)}
        onConfirm={() => void revoke(confirming!)}
      />
    </div>
  );
}

function stateBadge(transfer: TransferView) {
  switch (transfer.state) {
    case 'revoked':
      return <Badge tone="red">{t('sent.stateRevoked')}</Badge>;
    case 'expired':
      return <Badge tone="slate">{t('sent.stateExpired')}</Badge>;
    case 'completed':
      return <Badge tone="green">{t('sent.stateCompleted')}</Badge>;
    default:
      return null;
  }
}

function SentCard({
  transfer,
  now,
  onRevoke,
}: {
  transfer: TransferView;
  now: number;
  onRevoke: () => void;
}) {
  const recipients = transfer.recipients ?? [];
  const done = recipients.filter((recipient) => recipient.downloadedAt).length;
  const remaining = transfer.expiresAt - now;
  const live = transfer.state === 'active';

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              {t('sent.to', { count: recipients.length })}
            </h2>
            {stateBadge(transfer)}
          </div>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            {formatWhen(transfer.createdAt)} · {transfer.fileCount} file
            {transfer.fileCount === 1 ? '' : 's'} · {formatBytes(transfer.totalSize)}
          </p>
        </div>

        {live ? (
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
              <IconClock className="h-3.5 w-3.5" />
              {formatDuration(remaining)}
            </span>
            <Button
              variant="danger"
              className="px-2 py-1"
              icon={<IconTrash className="h-4 w-4" />}
              onClick={onRevoke}
            >
              <span className="sr-only sm:not-sr-only">{t('sent.revoke')}</span>
            </Button>
          </div>
        ) : null}
      </div>

      {transfer.note ? (
        <p className="mt-3 whitespace-pre-wrap rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700 dark:bg-slate-800/70 dark:text-slate-200">
          {transfer.note}
        </p>
      ) : null}

      <div className="mt-3">
        <div className="mb-1.5 flex items-baseline justify-between text-xs text-slate-500 dark:text-slate-400">
          <span>{t('sent.progress', { done, total: recipients.length })}</span>
        </div>
        <ProgressBar
          value={recipients.length === 0 ? 0 : done / recipients.length}
          tone={done === recipients.length ? 'green' : 'brand'}
        />
      </div>

      <ul className="mt-3 flex flex-wrap gap-1.5">
        {recipients.map((recipient) => (
          <li
            key={recipient.name}
            className={classNames(
              'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs',
              recipient.downloadedAt
                ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300'
                : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
            )}
            title={
              recipient.downloadedAt
                ? `${t('sent.picked')} ${formatWhen(recipient.downloadedAt)}`
                : recipient.seenAt
                  ? `${t('sent.opened')} ${formatWhen(recipient.seenAt)}`
                  : t('sent.waiting')
            }
          >
            {recipient.downloadedAt ? (
              <IconCheck className="h-3 w-3" />
            ) : (
              <span
                className={classNames(
                  'h-1.5 w-1.5 rounded-full',
                  recipient.online ? 'bg-emerald-400' : 'bg-slate-300 dark:bg-slate-600',
                )}
              />
            )}
            {recipient.name}
          </li>
        ))}
      </ul>

      <ul className="mt-3 border-t border-slate-100 pt-2 dark:border-slate-800">
        {transfer.files.map((file) => (
          <li key={file.id} className="flex items-center gap-2 py-1 text-sm">
            <IconFile className="h-3.5 w-3.5 shrink-0 text-slate-400" />
            <span className="min-w-0 flex-1 truncate text-slate-600 dark:text-slate-300">{file.name}</span>
            <span className="shrink-0 text-xs tabular-nums text-slate-400">{formatBytes(file.size)}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
