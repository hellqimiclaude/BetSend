import { useCallback, useMemo, useRef, useState } from 'react';
import { useApp } from '../state/AppContext';
import { api, ApiError } from '../lib/api';
import { t } from '../i18n';
import { classNames, formatBytes, formatEta } from '../lib/format';
import { UploadBatch, type BatchProgress } from '../lib/uploader';
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

  const batchRef = useRef<UploadBatch | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dragDepth = useRef(0);

  const maxSize = bootstrap?.maxUploadSize ?? 0;
  const busy = phase !== 'idle';

  const directory = useMemo(() => users.filter((person) => person.name !== user?.name), [users, user]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return directory;
    return directory.filter((person) => person.name.toLowerCase().includes(needle));
  }, [directory, query]);

  const totalBytes = useMemo(() => files.reduce((sum, file) => sum + file.size, 0), [files]);

  const addFiles = useCallback(
    (incoming: FileList | File[]) => {
      const list = Array.from(incoming);
      if (list.length === 0) return;

      const oversized = maxSize > 0 ? list.filter((file) => file.size > maxSize) : [];
      if (oversized.length > 0) {
        setError(t('send.tooBig', { name: oversized[0].name, limit: formatBytes(maxSize) }));
      }

      const accepted = maxSize > 0 ? list.filter((file) => file.size <= maxSize) : list;
      setFiles((current) => {
        // Same name + size + mtime means the user picked the same file twice.
        const signature = new Set(current.map((file) => `${file.name}:${file.size}:${file.lastModified}`));
        const fresh = accepted.filter((file) => !signature.has(`${file.name}:${file.size}:${file.lastModified}`));
        return [...current, ...fresh];
      });
    },
    [maxSize],
  );

  function toggleRecipient(name: string) {
    setSelected((current) =>
      current.includes(name) ? current.filter((item) => item !== name) : [...current, name],
    );
  }

  function reset() {
    setFiles([]);
    setSelected([]);
    setNote('');
    setQuery('');
    setProgress(null);
    setError(null);
    if (inputRef.current) inputRef.current.value = '';
  }

  async function send() {
    setError(null);
    if (files.length === 0) return setError(t('send.needFiles'));
    if (selected.length === 0) return setError(t('send.needRecipients'));

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

  async function cancel() {
    await batchRef.current?.abort();
    batchRef.current = null;
    setPhase('idle');
    setProgress(null);
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
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

      {files.length > 0 ? (
        <Card className="p-4">
          <SectionTitle hint={formatBytes(totalBytes)}>
            {t('send.filesTitle', { count: files.length })}
          </SectionTitle>
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {files.map((file, index) => {
              const item = progress?.items[index];
              const fraction = item && item.size > 0 ? item.bytesUploaded / item.size : 0;
              return (
                <li key={`${file.name}-${file.size}-${file.lastModified}`} className="py-2.5">
                  <div className="flex items-center gap-3">
                    <IconFile className="h-4 w-4 shrink-0 text-slate-400" />
                    <span className="min-w-0 flex-1 truncate text-sm text-slate-700 dark:text-slate-200">
                      {file.name}
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-slate-500 dark:text-slate-400">
                      {formatBytes(file.size)}
                    </span>
                    {!busy ? (
                      <button
                        type="button"
                        aria-label={`Remove ${file.name}`}
                        onClick={() => setFiles((current) => current.filter((_, i) => i !== index))}
                        className="shrink-0 rounded p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800"
                      >
                        <IconX className="h-4 w-4" />
                      </button>
                    ) : (
                      <span className="w-12 shrink-0 text-right text-xs tabular-nums text-slate-500">
                        {item?.status === 'done' ? '100%' : `${Math.floor(fraction * 100)}%`}
                      </span>
                    )}
                  </div>
                  {busy ? (
                    <ProgressBar
                      className="mt-2"
                      value={fraction}
                      tone={item?.status === 'done' ? 'green' : 'brand'}
                    />
                  ) : null}
                  {item?.status === 'error' ? (
                    <p className="mt-1.5 text-xs text-red-600 dark:text-red-400">{item.error}</p>
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
              <Button variant="ghost" onClick={() => setFiles([])}>
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
          maxLength={500}
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

      {busy && progress ? (
        <Card className="p-4">
          <div className="flex items-baseline justify-between text-sm">
            <span className="font-medium text-slate-800 dark:text-slate-100">
              {phase === 'committing'
                ? t('send.submitting')
                : t('send.uploading', { done: progress.filesDone, total: progress.items.length })}
            </span>
            <span className="tabular-nums text-slate-500 dark:text-slate-400">
              {formatBytes(progress.bytesUploaded)} / {formatBytes(progress.bytesTotal)}
            </span>
          </div>
          <ProgressBar className="mt-2.5 h-2" value={progress.fraction} />
          <div className="mt-2 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
            <span className="tabular-nums">
              {progress.bytesPerSecond > 0 ? t('send.speed', { speed: formatBytes(progress.bytesPerSecond) }) : '—'}
            </span>
            <span className="tabular-nums">
              {progress.secondsRemaining > 0 ? t('send.remaining', { time: formatEta(progress.secondsRemaining) }) : ''}
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
          disabled={files.length === 0 || selected.length === 0}
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
