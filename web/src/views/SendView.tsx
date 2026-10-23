import { useCallback, useMemo, useRef, useState } from 'react';
import { useApp } from '../state/AppContext';
import { api, ApiError } from '../lib/api';
import { t } from '../i18n';
import { classNames, formatBytes, formatEta } from '../lib/format';
import { UploadBatch, type BatchProgress } from '../lib/uploader';
import { useHostFiles } from '../lib/useHostFiles';
import type { HostRoutes } from '../lib/host';
import { RouteChooser } from '../components/RouteChooser';
import { Button, Card, Chip, ProgressBar, SectionTitle } from '../components/ui';
import { IconFile, IconPlus, IconSearch, IconUpload, IconX } from '../components/Icons';

type Phase = 'idle' | 'uploading' | 'committing';

/**
 * The main screen: drop files, pick people, send. Everything else in the app is
 * secondary to this being obvious in ten seconds.
 */
export function SendView() {
  const { bootstrap, users, online, user, toast, refreshSent, refreshUsers } = useApp();

  const [files, setFiles] = useState<File[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [note, setNote] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState<BatchProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  /** Set while the chooser is open, i.e. only when there is a choice to make. */
  const [routes, setRoutes] = useState<HostRoutes | null>(null);

  /**
   * In the desktop app the files live in the app, not the page: a file the
   * user right-clicked in Explorer is a path, and a page cannot read a path.
   * The app holds them and does the uploading; this screen still collects the
   * recipients and shows the progress. In a browser `host` is null and
   * everything below takes the original route.
   */
  const { host, staged, progress: hostProgress, stagePicked, unstage, clear: clearHost } = useHostFiles();

  const batchRef = useRef<UploadBatch | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dragDepth = useRef(0);

  const maxSize = bootstrap?.maxUploadSize ?? 0;
  const busy = phase !== 'idle';

  const directory = useMemo(() => users.filter((person) => person.name !== user?.name), [users, user]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return directory;
    // Match the address as well: two people can share a display name, and
    // typing the start of an address is how most people search.
    return directory.filter(
      (person) =>
        person.name.toLowerCase().includes(needle) ||
        (person.email ?? '').toLowerCase().includes(needle),
    );
  }, [directory, query]);

  /**
   * One list for the screen to draw, from whichever side is holding the
   * files. Everything below this works off rows and never asks which.
   */
  interface Row {
    key: string;
    name: string;
    size: number;
    bytesUploaded: number;
    status?: string;
    error?: string;
    remove: () => void;
  }

  const rows = useMemo<Row[]>(() => {
    if (host) {
      return staged.map((file) => {
        const live = hostProgress?.files.find((f) => f.id === file.id);
        return {
          key: file.id,
          name: file.name,
          size: file.size,
          bytesUploaded: live?.bytesUploaded ?? 0,
          status: live?.status,
          error: live?.error,
          remove: () => void unstage(file.id),
        };
      });
    }
    return files.map((file, index) => {
      const live = progress?.items[index];
      return {
        key: `${file.name}-${file.size}-${file.lastModified}`,
        name: file.name,
        size: file.size,
        bytesUploaded: live?.bytesUploaded ?? 0,
        status: live?.status,
        error: live?.error,
        remove: () => setFiles((current) => current.filter((_, i) => i !== index)),
      };
    });
  }, [host, staged, hostProgress, files, progress]);

  const totalBytes = useMemo(() => rows.reduce((sum, row) => sum + row.size, 0), [rows]);

  /**
   * Overall progress, from whichever side is doing the uploading. The host
   * reports no speed or estimate -- it uploads one file at a time and the
   * per-file bars already show where it has got to.
   */
  const overall = useMemo(() => {
    const source = host ? hostProgress : progress;
    if (!source) return null;
    return {
      filesDone: source.filesDone,
      fileCount: host ? (source as NonNullable<typeof hostProgress>).files.length : (source as BatchProgress).items.length,
      bytesUploaded: source.bytesUploaded,
      bytesTotal: source.bytesTotal,
      fraction: source.fraction,
      bytesPerSecond: host ? 0 : (source as BatchProgress).bytesPerSecond,
      secondsRemaining: host ? 0 : (source as BatchProgress).secondsRemaining,
    };
  }, [host, hostProgress, progress]);

  const addFiles = useCallback(
    (incoming: FileList | File[]) => {
      const list = Array.from(incoming);
      if (list.length === 0) return;

      const oversized = maxSize > 0 ? list.filter((file) => file.size > maxSize) : [];
      if (oversized.length > 0) {
        setError(t('send.tooBig', { name: oversized[0].name, limit: formatBytes(maxSize) }));
      }

      const accepted = maxSize > 0 ? list.filter((file) => file.size <= maxSize) : list;

      // In the desktop app these go to the app too, so a dropped file and a
      // right-clicked one travel by the same road rather than two.
      if (host) {
        void stagePicked(accepted).then((skipped) => {
          if (skipped.length > 0) setError(`${skipped[0].name} — ${skipped[0].reason}`);
        });
        return;
      }

      setFiles((current) => {
        // Same name + size + mtime means the user picked the same file twice.
        const signature = new Set(current.map((file) => `${file.name}:${file.size}:${file.lastModified}`));
        const fresh = accepted.filter((file) => !signature.has(`${file.name}:${file.size}:${file.lastModified}`));
        return [...current, ...fresh];
      });
    },
    [maxSize, host, stagePicked],
  );

  function toggleRecipient(name: string) {
    setSelected((current) =>
      current.includes(name) ? current.filter((item) => item !== name) : [...current, name],
    );
  }

  function reset() {
    setFiles([]);
    if (host) void clearHost();
    setSelected([]);
    setNote('');
    setQuery('');
    setProgress(null);
    setError(null);
    if (inputRef.current) inputRef.current.value = '';
  }

  async function send() {
    setError(null);
    if (rows.length === 0) return setError(t('send.needFiles'));
    if (selected.length === 0) return setError(t('send.needRecipients'));

    // The desktop app uploads and commits in one call: it is holding the
    // files, so there is nothing for this side to upload.
    if (host) {
      /*
       * Ask first only when the answer can differ. If nobody picked has
       * BetSend open there is no direct route to choose, and a dialog
       * whose outcome is fixed is just a click somebody has to make.
       */
      const available = host.routes ? await host.routes(selected).catch(() => null) : null;
      if (available && available.reachable.length > 0) {
        setRoutes(available);
        return;
      }
      if (available && available.unreachable.length > 0) setError(t('route.noneDirect'));
      await sendByRoute('server');
      return;
    }

    const batch = new UploadBatch(files, {
      endpoint: bootstrap?.uploadEndpoint ?? '/api/uploads',
      chunkSize: bootstrap?.chunkSize ?? 8 * 1024 * 1024,
      concurrency: 2,
      onProgress: setProgress,
    });
    batchRef.current = batch;
    setPhase('uploading');

    let uploadIds: string[];
    try {
      uploadIds = await batch.start();
    } catch (err) {
      batchRef.current = null;
      setPhase('idle');
      if ((err as DOMException).name === 'AbortError') return; // user pressed cancel
      setError((err as Error).message);
      return;
    }

    setPhase('committing');
    try {
      await api.post('/api/transfers', { uploads: uploadIds, recipients: selected, note });
      toast('success', t('send.success', { names: selected.join(', ') }));
      reset();
      void refreshSent();
      void refreshUsers();
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      batchRef.current = null;
      setPhase('idle');
    }
  }

  /** Hand the transfer to the desktop app and report how it went. */
  async function sendByRoute(route: 'direct' | 'server') {
    if (!host) return;
    setRoutes(null);
    setPhase('uploading');
    const result = await host.send(selected, note, route);
    setPhase('idle');

    if (!result.ok) {
      setError(result.error ?? 'The transfer could not be sent.');
      return;
    }
    toast('success', t('send.success', { names: selected.join(', ') }));
    setSelected([]);
    setNote('');
    setQuery('');
    setError(null);
    void refreshSent();
    void refreshUsers();
  }

  async function cancel() {
    if (host) {
      await host.cancel();
      setPhase('idle');
      return;
    }
    await batchRef.current?.abort();
    batchRef.current = null;
    setPhase('idle');
    setProgress(null);
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      {routes ? (
        <RouteChooser
          routes={routes}
          recipients={selected}
          onChoose={(route) => void sendByRoute(route)}
          onCancel={() => setRoutes(null)}
        />
      ) : null}
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t('send.title')}</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{t('send.offlineOk')}</p>
      </header>

      {/* ---- 1. files ---- */}
      <div
        onDragEnter={(event) => {
          event.preventDefault();
          dragDepth.current += 1;
          setDragging(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={() => {
          dragDepth.current -= 1;
          if (dragDepth.current <= 0) setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          if (!busy && event.dataTransfer.files.length) addFiles(event.dataTransfer.files);
        }}
      >
        <button
          type="button"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          className={classNames(
            'flex w-full flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-12 text-center transition',
            'disabled:cursor-not-allowed disabled:opacity-60',
            dragging
              ? 'border-brand-500 bg-brand-50 dark:bg-brand-950/40'
              : 'border-slate-300 bg-white hover:border-brand-400 hover:bg-brand-50/50 dark:border-slate-700 dark:bg-slate-900 dark:hover:border-brand-700 dark:hover:bg-slate-800/60',
          )}
        >
          <IconUpload className={classNames('mb-3 h-8 w-8', dragging ? 'text-brand-600' : 'text-slate-400')} />
          <span className="text-base font-medium text-slate-800 dark:text-slate-100">
            {dragging ? t('send.dropActive') : t('send.dropTitle')}
          </span>
          <span className="mt-1 text-sm text-slate-500 dark:text-slate-400">{t('send.dropSubtitle')}</span>
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => {
            if (event.target.files) addFiles(event.target.files);
            event.target.value = '';
          }}
        />
      </div>

      {rows.length > 0 ? (
        <Card className="p-4">
          <SectionTitle hint={formatBytes(totalBytes)}>
            {t('send.filesTitle', { count: rows.length })}
          </SectionTitle>
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {rows.map((row) => {
              const fraction = row.size > 0 ? row.bytesUploaded / row.size : 0;
              return (
                <li key={row.key} className="py-2.5">
                  <div className="flex items-center gap-3">
                    <IconFile className="h-4 w-4 shrink-0 text-slate-400" />
                    <span className="min-w-0 flex-1 truncate text-sm text-slate-700 dark:text-slate-200">
                      {row.name}
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-slate-500 dark:text-slate-400">
                      {formatBytes(row.size)}
                    </span>
                    {!busy ? (
                      <button
                        type="button"
                        aria-label={`Remove ${row.name}`}
                        onClick={row.remove}
                        className="shrink-0 rounded p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800"
                      >
                        <IconX className="h-4 w-4" />
                      </button>
                    ) : (
                      <span className="w-12 shrink-0 text-right text-xs tabular-nums text-slate-500">
                        {row.status === 'done' ? '100%' : `${Math.floor(fraction * 100)}%`}
                      </span>
                    )}
                  </div>
                  {busy ? (
                    <ProgressBar
                      className="mt-2"
                      value={fraction}
                      tone={row.status === 'done' ? 'green' : 'brand'}
                    />
                  ) : null}
                  {row.status === 'error' ? (
                    <p className="mt-1.5 text-xs text-red-600 dark:text-red-400">{row.error}</p>
                  ) : null}
                </li>
              );
            })}
          </ul>

          {!busy ? (
            <div className="mt-3 flex gap-2">
              <Button variant="ghost" icon={<IconPlus className="h-4 w-4" />} onClick={() => inputRef.current?.click()}>
                {t('send.addMore')}
              </Button>
              <Button variant="ghost" onClick={() => (host ? void clearHost() : setFiles([]))}>
                {t('send.clearFiles')}
              </Button>
            </div>
          ) : null}
        </Card>
      ) : null}

      {/* ---- 2. people ---- */}
      <Card className="p-4">
        <SectionTitle hint={selected.length > 0 ? `${selected.length} selected` : undefined}>
          {t('send.to')}
        </SectionTitle>

        <div className="relative">
          <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            value={query}
            disabled={busy}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('send.searchPeople')}
            type="search"
            className="w-full rounded-lg border border-slate-300 bg-white py-2 pl-9 pr-3 text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-950 dark:focus:ring-brand-950"
          />
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {directory.length === 0 ? (
            <p className="py-2 text-sm text-slate-500 dark:text-slate-400">{t('send.noPeople')}</p>
          ) : matches.length === 0 ? (
            <p className="py-2 text-sm text-slate-500 dark:text-slate-400">{t('send.noMatches', { query })}</p>
          ) : (
            matches.map((person) => (
              <Chip
                key={person.name}
                active={selected.includes(person.name)}
                online={online.has(person.name.toLowerCase())}
                onClick={busy ? undefined : () => toggleRecipient(person.name)}
                title={person.email ?? undefined}
              >
                {person.name}
              </Chip>
            ))
          )}
        </div>

        {directory.length > 0 && !busy ? (
          <div className="mt-3 flex gap-2 border-t border-slate-100 pt-3 dark:border-slate-800">
            <Button variant="ghost" onClick={() => setSelected(matches.map((person) => person.name))}>
              {t('send.selectAll')}
            </Button>
            {selected.length > 0 ? (
              <Button variant="ghost" onClick={() => setSelected([])}>
                {t('send.clearSelection')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </Card>

      {/* ---- 3. note ---- */}
      <Card className="p-4">
        <SectionTitle>{t('send.note')}</SectionTitle>
        <textarea
          value={note}
          disabled={busy}
          rows={2}
          onChange={(event) => setNote(event.target.value)}
          placeholder={t('send.notePlaceholder')}
          className="w-full resize-y rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-950 dark:focus:ring-brand-950"
        />
      </Card>

      {/* ---- 4. send ---- */}
      {error ? (
        <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 ring-1 ring-red-100 dark:bg-red-950/40 dark:text-red-300 dark:ring-red-900/50">
          {error}
        </p>
      ) : null}

      {busy && overall ? (
        <Card className="p-4">
          <div className="flex items-baseline justify-between text-sm">
            <span className="font-medium text-slate-800 dark:text-slate-100">
              {phase === 'committing'
                ? t('send.submitting')
                : t('send.uploading', { done: overall.filesDone, total: overall.fileCount })}
            </span>
            <span className="tabular-nums text-slate-500 dark:text-slate-400">
              {formatBytes(overall.bytesUploaded)} / {formatBytes(overall.bytesTotal)}
            </span>
          </div>
          <ProgressBar className="mt-2.5 h-2" value={overall.fraction} />
          <div className="mt-2 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
            <span className="tabular-nums">
              {overall.bytesPerSecond > 0 ? t('send.speed', { speed: formatBytes(overall.bytesPerSecond) }) : '—'}
            </span>
            <span className="tabular-nums">
              {overall.secondsRemaining > 0 ? t('send.remaining', { time: formatEta(overall.secondsRemaining) }) : ''}
            </span>
          </div>
        </Card>
      ) : null}

      <div className="flex items-center gap-3 pb-8">
        {busy ? (
          <Button variant="secondary" onClick={() => void cancel()}>
            {t('send.cancelAll')}
          </Button>
        ) : null}
        <Button
          variant="primary"
          loading={busy}
          disabled={rows.length === 0 || selected.length === 0}
          onClick={() => void send()}
          className="min-w-32"
        >
          {busy ? t('send.submitting') : t('send.submit')}
        </Button>
        {!busy && bootstrap ? (
          <span className="text-xs text-slate-400 dark:text-slate-500">
            {t('send.expiresIn', { hours: bootstrap.retentionHours })}
          </span>
        ) : null}
      </div>
    </div>
  );
}
