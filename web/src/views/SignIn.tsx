import { useState, type ReactNode } from 'react';
import { useApp } from '../state/AppContext';
import { ApiError } from '../lib/api';
import { rememberedName } from '../lib/identity';
import { t } from '../i18n';
import { Button, Card } from '../components/ui';
import { IconLock, IconUpload } from '../components/Icons';
import { classNames } from '../lib/format';

/** Shared shell so sign-in and password setup look like one flow. */
export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-4 dark:bg-slate-950">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-brand-600 text-white">
            <IconUpload className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">{t('app.name')}</h1>
            <p className="text-sm text-slate-500 dark:text-slate-400">{t('signin.subtitle')}</p>
          </div>
        </div>
        <Card className="p-7">{children}</Card>
      </div>
    </div>
  );
}

export const fieldClass =
  'w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-base outline-none transition ' +
  'focus:border-brand-500 focus:ring-2 focus:ring-brand-100 dark:border-slate-700 dark:bg-slate-950 ' +
  'dark:focus:ring-brand-950';

export function SignIn({ onNeedSetup }: { onNeedSetup: () => void }) {
  const { bootstrap, signIn, toast } = useApp();
  const example = bootstrap?.nameExample ?? 'J.Johnson';
  const canSelfServe = bootstrap?.signupMode === 'claim';

  const [name, setName] = useState(() => rememberedName());
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await signIn(name.trim(), password);
    } catch (err) {
      const apiError = err as ApiError;
      setError(apiError.message);
      setPassword('');
      if (apiError.code === 'offline') toast('error', apiError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell>
      <div className="mb-5 flex items-center gap-2.5">
        <span className="grid h-9 w-9 place-items-center rounded-lg bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
          <IconLock className="h-4 w-4" />
        </span>
        <h2 className="text-xl font-semibold">{t('signin.title')}</h2>
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() && password) void submit();
        }}
      >
        <label htmlFor="name" className="mb-1 block text-sm font-medium">
          {t('signin.name')}
        </label>
        <input
          id="name"
          name="username"
          autoComplete="username"
          autoFocus={!name}
          spellCheck={false}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setError(null);
          }}
          placeholder={t('signin.namePlaceholder', { example })}
          className={fieldClass}
        />

        <label htmlFor="password" className="mb-1 mt-4 block text-sm font-medium">
          {t('signin.password')}
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          autoFocus={Boolean(name)}
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
            setError(null);
          }}
          className={fieldClass}
        />

        {error ? (
          <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
            {error}
          </p>
        ) : (
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            {t('signin.nameHint', { example })}
          </p>
        )}

        <Button
          type="submit"
          variant="primary"
          loading={busy}
          disabled={!name.trim() || !password}
          className="mt-4 w-full"
        >
          {busy ? t('signin.working') : t('signin.submit')}
        </Button>
      </form>

      <div
        className={classNames(
          'mt-6 border-t border-slate-100 pt-4 text-sm dark:border-slate-800',
          'text-slate-500 dark:text-slate-400',
        )}
      >
        <span className="font-medium text-slate-600 dark:text-slate-300">{t('signin.firstTime')}</span>{' '}
        {canSelfServe ? (
          <button
            type="button"
            onClick={onNeedSetup}
            className="text-brand-600 underline-offset-2 transition hover:underline dark:text-brand-400"
          >
            {t('signin.firstTimeClaim')}
          </button>
        ) : (
          t('signin.firstTimeInvite')
        )}
      </div>

      {bootstrap && !bootstrap.publicMode ? (
        <p className="mt-3 text-xs text-slate-400 dark:text-slate-500">{t('signin.lanNote')}</p>
      ) : null}
    </AuthShell>
  );
}
