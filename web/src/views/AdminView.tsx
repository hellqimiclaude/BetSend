import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, setAdminToken } from '../lib/api';
import { useApp } from '../state/AppContext';
import { t } from '../i18n';
import { classNames, formatBytes, formatDuration, formatWhen } from '../lib/format';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  LoadingState,
  SectionTitle,
} from '../components/ui';
import { IconLock, IconRefresh, IconTrash, IconUsers } from '../components/Icons';
import type { AdminOverview, AdminTransfer, AdminUserView, RuntimeSettings } from '../types';

const TOKEN_KEY = 'betsend.adminToken';

/** The token lives in sessionStorage: it survives navigation, not a closed tab. */
function readToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function AdminView() {
  const [token, setToken] = useState<string | null>(() => readToken());

  // Registered during render rather than in an effect: the panel's first
  // request is fired from a child effect, which runs *before* a parent effect
  // would have set the header. Reloading straight onto #/admin used to 403.
  setAdminToken(token);

  // Leaving the page drops the token from outgoing requests.
  useEffect(() => () => setAdminToken(null), []);

  function unlock(value: string) {
    try {
      sessionStorage.setItem(TOKEN_KEY, value);
    } catch {
      /* still works for this page load */
    }
    setToken(value);
  }

  function lock() {
    try {
      sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      /* ignore */
    }
    setAdminToken(null);
    setToken(null);
  }

  if (!token) return <TokenGate onUnlock={unlock} />;
  return <AdminPanel onLock={lock} />;
}

function TokenGate({ onUnlock }: { onUnlock: (token: string) => void }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    setAdminToken(value);
    try {
      await api.post('/api/admin/verify');
      onUnlock(value);
    } catch (err) {
      setAdminToken(null);
      setError((err as ApiError).status === 403 ? t('admin.tokenBad') : (err as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-md pt-10">
      <Card className="p-6">
        <div className="mb-4 flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            <IconLock className="h-4 w-4" />
          </span>
          <div>
            <h1 className="text-base font-semibold">{t('admin.tokenPrompt')}</h1>
            <p className="text-xs text-slate-500 dark:text-slate-400">{t('admin.tokenHint')}</p>
          </div>
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (value) void submit();
          }}
        >
          <input
            type="password"
            autoFocus
            value={value}
            onChange={(event) => setValue(event.target.value)}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100 dark:border-slate-700 dark:bg-slate-950 dark:focus:ring-brand-950"
          />
          {error ? <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p> : null}
          <Button type="submit" variant="primary" loading={busy} disabled={!value} className="mt-4 w-full">
            {t('admin.unlock')}
          </Button>
        </form>
      </Card>
    </div>
  );
}

function AdminPanel({ onLock }: { onLock: () => void }) {
  const { toast, refreshUsers, bootstrap } = useApp();
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [users, setUsers] = useState<AdminUserView[]>([]);
  const [transfers, setTransfers] = useState<AdminTransfer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [overviewData, usersData, transfersData] = await Promise.all([
        api.get<AdminOverview>('/api/admin/overview'),
        api.get<{ users: AdminUserView[] }>('/api/admin/users'),
        api.get<{ transfers: AdminTransfer[] }>('/api/admin/transfers'),
      ]);
      setOverview(overviewData);
      setUsers(usersData.users);
      setTransfers(transfersData.transfers);
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !overview) return <LoadingState />;
  if (error && !overview) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!overview) return null;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 pb-10">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{t('admin.title')}</h1>
        <div className="flex gap-2">
          <Button variant="ghost" icon={<IconRefresh className="h-4 w-4" />} onClick={() => void load()}>
            {t('error.retry')}
          </Button>
          <Button variant="ghost" onClick={onLock}>
            {t('admin.lock')}
          </Button>
        </div>
      </header>

      <StatsGrid overview={overview} />
      <SettingsForm
        initial={overview.settings}
        onSaved={(settings, restartRequired) => {
          setOverview({ ...overview, settings });
          toast('success', restartRequired ? t('admin.restartNeeded') : t('admin.saved'));
        }}
        onError={(message) => toast('error', message)}
      />
      <UsersSection
        users={users}
        example={bootstrap?.nameExample ?? 'J.Johnson'}
        onChanged={() => {
          void load();
          void refreshUsers();
        }}
        onMessage={(kind, message) => toast(kind, message)}
      />
      <TransfersSection transfers={transfers} onChanged={() => void load()} onError={(m) => toast('error', m)} />

      <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <p className="text-sm font-medium">{t('admin.cleanup')}</p>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Runs automatically every {overview.server.cleanupIntervalMinutes} minutes.
          </p>
        </div>
        <Button
          variant="secondary"
          onClick={async () => {
            try {
              const result = await api.post<{ sweep: { deletedBlobs: number; freedBytes: number } }>(
                '/api/admin/cleanup',
              );
              toast(
                'success',
                t('admin.cleanupDone', {
                  blobs: result.sweep.deletedBlobs,
                  freed: formatBytes(result.sweep.freedBytes),
                }),
              );
              void load();
            } catch (err) {
              toast('error', (err as ApiError).message);
            }
          }}
        >
          {t('admin.cleanup')}
        </Button>
      </Card>
    </div>
  );
}

function StatsGrid({ overview }: { overview: AdminOverview }) {
  const stats = [
    { label: t('admin.usedByTransfers'), value: formatBytes(overview.storage.usedByTransfers) },
    { label: t('admin.diskFree'), value: formatBytes(overview.storage.diskFree) },
    { label: t('admin.activeTransfers'), value: String(overview.counts.activeTransfers) },
    {
      label: t('admin.people'),
      value: t('admin.peopleOnline', { online: overview.counts.online, total: overview.counts.users }),
    },
  ];

  const usedFraction =
    overview.storage.diskTotal > 0
      ? (overview.storage.diskTotal - overview.storage.diskFree) / overview.storage.diskTotal
      : 0;

  return (
    <Card className="p-4">
      <SectionTitle hint={overview.storage.directory}>{t('admin.storage')}</SectionTitle>
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {stats.map((stat) => (
          <div key={stat.label}>
            <dt className="text-xs text-slate-500 dark:text-slate-400">{stat.label}</dt>
            <dd className="mt-0.5 text-lg font-semibold tabular-nums">{stat.value}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
        <div
          className={classNames('h-full rounded-full', usedFraction > 0.9 ? 'bg-red-500' : 'bg-brand-600')}
          style={{ width: `${Math.min(100, usedFraction * 100)}%` }}
        />
      </div>
      <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
        {formatBytes(overview.storage.diskTotal - overview.storage.diskFree)} of{' '}
        {formatBytes(overview.storage.diskTotal)} used on this drive
      </p>
    </Card>
  );
}

function SettingsForm({
  initial,
  onSaved,
  onError,
}: {
  initial: RuntimeSettings;
  onSaved: (settings: RuntimeSettings, restartRequired: boolean) => void;
  onError: (message: string) => void;
}) {
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      const result = await api.put<{ settings: RuntimeSettings; restartRequired: boolean }>(
        '/api/admin/settings',
        form,
      );
      setForm(result.settings);
      onSaved(result.settings, result.restartRequired);
    } catch (err) {
      onError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  const inputClass =
    'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100 dark:border-slate-700 dark:bg-slate-950 dark:focus:ring-brand-950';

  return (
    <Card className="p-4">
      <SectionTitle>{t('admin.settings')}</SectionTitle>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-sm font-medium">{t('admin.retention')}</span>
          <input
            type="number"
            min={1}
            value={form.retentionHours}
            onChange={(event) => setForm({ ...form, retentionHours: Number(event.target.value) })}
            className={inputClass}
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium">{t('admin.maxSize')}</span>
          <input
            type="number"
            min={0}
            step={1024 * 1024}
            value={form.maxUploadSize}
            onChange={(event) => setForm({ ...form, maxUploadSize: Number(event.target.value) })}
            className={inputClass}
          />
          <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">
            {form.maxUploadSize > 0 ? formatBytes(form.maxUploadSize) : t('admin.maxSizeHint')}
          </span>
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium">{t('admin.registrationMode')}</span>
          <select
            value={form.registrationMode}
            onChange={(event) =>
              setForm({ ...form, registrationMode: event.target.value as RuntimeSettings['registrationMode'] })
            }
            className={inputClass}
          >
            <option value="open">{t('admin.modeOpen')}</option>
            <option value="list">{t('admin.modeList')}</option>
          </select>
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium">{t('admin.directory')}</span>
          <input
            value={form.storageDir}
            onChange={(event) => setForm({ ...form, storageDir: event.target.value })}
            className={inputClass}
          />
        </label>
      </div>

      <label className="mt-4 flex items-center gap-2.5">
        <input
          type="checkbox"
          checked={form.deleteAfterAllDownloaded}
          onChange={(event) => setForm({ ...form, deleteAfterAllDownloaded: event.target.checked })}
          className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
        />
        <span className="text-sm">{t('admin.deleteAfter')}</span>
      </label>

      <Button variant="primary" loading={busy} onClick={() => void save()} className="mt-4">
        {t('admin.save')}
      </Button>
    </Card>
  );
}

function UsersSection({
  users,
  example,
  onChanged,
  onMessage,
}: {
  users: AdminUserView[];
  example: string;
  onChanged: () => void;
  onMessage: (kind: 'success' | 'error' | 'info', message: string) => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const active = users.filter((user) => user.active);

  async function importNames() {
    setBusy(true);
    try {
      const result = await api.post<{ added: string[]; existing: string[]; invalid: { line: string }[] }>(
        '/api/admin/users/import',
        { text },
      );
      onMessage('success', t('admin.imported', { added: result.added.length, existing: result.existing.length }));
      if (result.invalid.length > 0) {
        onMessage('error', t('admin.importInvalid', { count: result.invalid.length, example }));
      }
      setText('');
      onChanged();
    } catch (err) {
      onMessage('error', (err as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(name: string) {
    setRemoving(null);
    try {
      await api.del(`/api/admin/users/${encodeURIComponent(name)}`);
      onChanged();
    } catch (err) {
      onMessage('error', (err as ApiError).message);
    }
  }

  return (
    <Card className="p-4">
      <SectionTitle hint={`${active.length}`}>{t('admin.users')}</SectionTitle>

      <div className="mb-4">
        <label className="mb-1 block text-sm font-medium">{t('admin.importTitle')}</label>
        <textarea
          rows={4}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={`${example}\nM.Smith\nA.Williams`}
          className="w-full resize-y rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100 dark:border-slate-700 dark:bg-slate-950 dark:focus:ring-brand-950"
        />
        <div className="mt-2 flex items-center gap-3">
          <Button variant="primary" loading={busy} disabled={!text.trim()} onClick={() => void importNames()}>
            {t('admin.import')}
          </Button>
          <span className="text-xs text-slate-500 dark:text-slate-400">{t('admin.importHint')}</span>
        </div>
      </div>

      {active.length === 0 ? (
        <EmptyState icon={<IconUsers className="h-8 w-8" />} title={t('admin.noUsers')} />
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {active.map((user) => (
            <li key={user.name} className="flex items-center gap-3 py-2">
              <span
                className={classNames(
                  'h-1.5 w-1.5 shrink-0 rounded-full',
                  user.online ? 'bg-emerald-400' : 'bg-slate-300 dark:bg-slate-600',
                )}
              />
              <span className="min-w-0 flex-1 truncate text-sm">{user.name}</span>
              <span className="hidden shrink-0 text-xs text-slate-400 sm:block">
                {user.lastSeenAt ? formatWhen(user.lastSeenAt) : '—'}
              </span>
              <Badge tone="slate">{user.source}</Badge>
              <Button
                variant="ghost"
                className="shrink-0 px-2 py-1"
                icon={<IconTrash className="h-4 w-4" />}
                onClick={() => setRemoving(user.name)}
              >
                <span className="sr-only">{t('admin.removeUser')}</span>
              </Button>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={removing !== null}
        title={t('admin.removeConfirm', { name: removing ?? '' })}
        body={t('admin.removeBody')}
        confirmLabel={t('admin.removeUser')}
        danger
        onCancel={() => setRemoving(null)}
        onConfirm={() => void remove(removing!)}
      />
    </Card>
  );
}

function TransfersSection({
  transfers,
  onChanged,
  onError,
}: {
  transfers: AdminTransfer[];
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [deleting, setDeleting] = useState<string | null>(null);

  async function remove(id: string) {
    setDeleting(null);
    try {
      await api.del(`/api/admin/transfers/${id}`);
      onChanged();
    } catch (err) {
      onError((err as ApiError).message);
    }
  }

  return (
    <Card className="p-4">
      <SectionTitle hint={`${transfers.length}`}>{t('admin.transfers')}</SectionTitle>

      {transfers.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">{t('admin.noTransfers')}</p>
      ) : (
        <div className="-mx-4 overflow-x-auto px-4">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-700 dark:text-slate-400">
                <th className="py-2 pr-3 font-medium">From</th>
                <th className="py-2 pr-3 font-medium">Files</th>
                <th className="py-2 pr-3 font-medium">Size</th>
                <th className="py-2 pr-3 font-medium">To</th>
                <th className="py-2 pr-3 font-medium">State</th>
                <th className="py-2 pr-3 font-medium">Expires</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {transfers.map((transfer) => (
                <tr key={transfer.id}>
                  <td className="py-2 pr-3">{transfer.sender}</td>
                  <td className="py-2 pr-3 tabular-nums">{transfer.fileCount}</td>
                  <td className="py-2 pr-3 tabular-nums">{formatBytes(transfer.totalSize)}</td>
                  <td className="py-2 pr-3 tabular-nums">{transfer.recipientCount}</td>
                  <td className="py-2 pr-3">
                    <Badge tone={transfer.state === 'active' ? 'green' : 'slate'}>{transfer.state}</Badge>
                  </td>
                  <td className="py-2 pr-3 text-xs text-slate-500 dark:text-slate-400">
                    {transfer.state === 'active' ? formatDuration(transfer.expiresAt - Date.now()) : '—'}
                  </td>
                  <td className="py-2 text-right">
                    <Button
                      variant="ghost"
                      className="px-2 py-1"
                      icon={<IconTrash className="h-4 w-4" />}
                      onClick={() => setDeleting(transfer.id)}
                    >
                      <span className="sr-only">{t('admin.deleteTransfer')}</span>
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmDialog
        open={deleting !== null}
        title={t('admin.deleteConfirm')}
        body={t('admin.deleteBody')}
        confirmLabel={t('admin.deleteTransfer')}
        danger
        onCancel={() => setDeleting(null)}
        onConfirm={() => void remove(deleting!)}
      />
    </Card>
  );
}
