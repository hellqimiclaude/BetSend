import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../state/AppContext';
import { api, ApiError } from '../lib/api';
import { t } from '../i18n';
import { Button, Card } from '../components/ui';
import { IconSearch, IconUpload } from '../components/Icons';
import { classNames } from '../lib/format';
import type { UserView } from '../types';

/**
 * First visit. In `open` mode the user types their name; in `list` mode they
 * pick from the imported staff list. Either way the choice is remembered in
 * localStorage, so this screen is seen once.
 */
export function Onboarding() {
  const { bootstrap, claim, toast } = useApp();
  const mode = bootstrap?.registrationMode ?? 'open';
  const example = bootstrap?.nameExample ?? 'J.Johnson';

  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  const [people, setPeople] = useState<UserView[]>([]);
  const [loading, setLoading] = useState(mode === 'list');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== 'list') return;
    api
      .get<{ users: UserView[] }>('/api/users')
      .then((data) => setPeople(data.users))
      .catch((err: ApiError) => setError(err.message))
      .finally(() => setLoading(false));
  }, [mode]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return people;
    return people.filter((person) => person.name.toLowerCase().includes(needle));
  }, [people, query]);

  async function pick(chosen: string) {
    setBusy(true);
    setError(null);
    try {
      await claim(chosen);
    } catch (err) {
      const apiError = err as ApiError;
      setError(apiError.message);
      toast('error', apiError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-4 dark:bg-slate-950">
      <Card className="w-full max-w-md p-7">
        <div className="mb-6 flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-brand-600 text-white">
            <IconUpload className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">{t('app.name')}</h1>
            <p className="text-sm text-slate-500 dark:text-slate-400">{t('app.tagline')}</p>
          </div>
        </div>

        <h2 className="text-xl font-semibold">{t('onboarding.title')}</h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          {mode === 'list' ? t('onboarding.subtitleList') : t('onboarding.subtitleOpen')}
        </p>

        {mode === 'open' ? (
          <form
            className="mt-5"
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim()) void pick(name.trim());
            }}
          >
            <label htmlFor="name" className="sr-only">
              {t('onboarding.title')}
            </label>
            <input
              id="name"
              autoFocus
              autoComplete="off"
              spellCheck={false}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setError(null);
              }}
              placeholder={t('onboarding.placeholder', { example })}
              className={classNames(
                'w-full rounded-lg border px-3.5 py-2.5 text-base outline-none transition',
                'bg-white dark:bg-slate-950',
                error
                  ? 'border-red-400 focus:ring-2 focus:ring-red-200'
                  : 'border-slate-300 focus:border-brand-500 focus:ring-2 focus:ring-brand-100 dark:border-slate-700 dark:focus:ring-brand-950',
              )}
            />
            <p className={classNames('mt-2 text-sm', error ? 'text-red-600 dark:text-red-400' : 'text-slate-500 dark:text-slate-400')}>
              {error ?? t('onboarding.hint', { example })}
            </p>
            <Button type="submit" variant="primary" loading={busy} disabled={!name.trim()} className="mt-4 w-full">
              {t('onboarding.continue')}
            </Button>
          </form>
        ) : (
          <div className="mt-5">
            <div className="relative">
              <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('onboarding.search')}
                className="w-full rounded-lg border border-slate-300 bg-white py-2.5 pl-9 pr-3 text-base outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100 dark:border-slate-700 dark:bg-slate-950 dark:focus:ring-brand-950"
              />
            </div>

            <div className="mt-3 max-h-72 overflow-y-auto rounded-lg ring-1 ring-slate-200 dark:ring-slate-800">
              {loading ? (
                <p className="p-4 text-sm text-slate-500">{t('error.loading')}</p>
              ) : people.length === 0 ? (
                <p className="p-4 text-sm text-slate-500 dark:text-slate-400">{t('onboarding.emptyList')}</p>
              ) : matches.length === 0 ? (
                <p className="p-4 text-sm text-slate-500 dark:text-slate-400">
                  {t('onboarding.noMatches', { query })}
                </p>
              ) : (
                <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                  {matches.map((person) => (
                    <li key={person.name}>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void pick(person.name)}
                        className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-sm transition hover:bg-brand-50 disabled:opacity-60 dark:hover:bg-slate-800"
                      >
                        <span
                          className={classNames(
                            'h-1.5 w-1.5 rounded-full',
                            person.online ? 'bg-emerald-400' : 'bg-slate-300 dark:bg-slate-600',
                          )}
                        />
                        {person.name}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {error ? <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p> : null}
          </div>
        )}

        <p className="mt-6 border-t border-slate-100 pt-4 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
          {t('onboarding.trust')}
        </p>
      </Card>
    </div>
  );
}
