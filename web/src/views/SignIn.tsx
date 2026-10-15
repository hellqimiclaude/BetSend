import { useState, type ReactNode } from 'react';
import { useApp } from '../state/AppContext';
import { api, ApiError } from '../lib/api';
import { rememberedEmail } from '../lib/identity';
import { t } from '../i18n';
import { Button, Card } from '../components/ui';
import { IconLock, IconUpload } from '../components/Icons';

/** Shared shell, so sign in, register and reset look like one flow. */
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

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
      {children}
    </p>
  );
}

/** The example address, built from whatever domain this office uses. */
export function exampleAddress(domains: string[] | undefined): string {
  return `j.johnson@${domains?.[0] ?? 'company.com'}`;
}

export function SignIn({ onRegister, onForgot }: { onRegister: () => void; onForgot: () => void }) {
  const { bootstrap, signIn, toast } = useApp();
  const canRegister = Boolean(bootstrap?.mailConfigured);

  const [email, setEmail] = useState(() => rememberedEmail());
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
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
          if (email.trim() && password) void submit();
        }}
      >
        <label htmlFor="email" className="mb-1 block text-sm font-medium">
          {t('signin.email')}
        </label>
        <input
          id="email"
          name="username"
          type="email"
          autoComplete="username"
          autoFocus={!email}
          spellCheck={false}
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            setError(null);
          }}
          placeholder={exampleAddress(bootstrap?.emailDomains)}
          className={fieldClass}
        />

        <div className="mb-1 mt-4 flex items-baseline justify-between">
          <label htmlFor="password" className="block text-sm font-medium">
            {t('signin.password')}
          </label>
          {canRegister ? (
            <button
              type="button"
              onClick={onForgot}
              className="text-xs text-brand-600 underline-offset-2 transition hover:underline dark:text-brand-400"
            >
              {t('signin.forgot')}
            </button>
          ) : null}
        </div>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          autoFocus={Boolean(email)}
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
            setError(null);
          }}
          className={fieldClass}
        />

        {error ? <ErrorNote>{error}</ErrorNote> : null}

        <Button
          type="submit"
          variant="primary"
          loading={busy}
          disabled={!email.trim() || !password}
          className="mt-4 w-full"
        >
          {busy ? t('signin.working') : t('signin.submit')}
        </Button>
      </form>

      <div className="mt-6 border-t border-slate-100 pt-4 text-sm text-slate-500 dark:border-slate-800 dark:text-slate-400">
        {canRegister ? (
          <>
            <span className="font-medium text-slate-600 dark:text-slate-300">{t('signin.firstTime')}</span>{' '}
            <button
              type="button"
              onClick={onRegister}
              className="text-brand-600 underline-offset-2 transition hover:underline dark:text-brand-400"
            >
              {t('signin.createAccount')}
            </button>
          </>
        ) : (
          <span>{t('signin.noMail')}</span>
        )}
      </div>
    </AuthShell>
  );
}

/** Ask for a link — used for both "I'm new" and "I forgot". */
export function RequestLink({ mode, onBack }: { mode: 'register' | 'forgot'; onBack: () => void }) {
  const { bootstrap } = useApp();
  const [email, setEmail] = useState(() => rememberedEmail());
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const domains = bootstrap?.emailDomains ?? [];

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.post(mode === 'register' ? '/api/register' : '/api/password/forgot', {
        email: email.trim(),
      });
      setSent(true);
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <AuthShell>
        <h2 className="text-xl font-semibold">{t('request.sentTitle')}</h2>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
          {t('request.sentBody', { email: email.trim() })}
        </p>
        <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">{t('request.sentHint')}</p>
        <Button variant="secondary" className="mt-5 w-full" onClick={onBack}>
          {t('signin.backToSignIn')}
        </Button>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <h2 className="text-xl font-semibold">
        {mode === 'register' ? t('request.registerTitle') : t('request.forgotTitle')}
      </h2>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        {mode === 'register' ? t('request.registerBody') : t('request.forgotBody')}
      </p>

      <form
        className="mt-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (email.trim()) void submit();
        }}
      >
        <label htmlFor="request-email" className="mb-1 block text-sm font-medium">
          {t('signin.email')}
        </label>
        <input
          id="request-email"
          type="email"
          autoComplete="username"
          autoFocus
          spellCheck={false}
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            setError(null);
          }}
          placeholder={exampleAddress(domains)}
          className={fieldClass}
        />

        {error ? (
          <ErrorNote>{error}</ErrorNote>
        ) : domains.length > 0 ? (
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            {t('request.domainHint', { domains: domains.map((d) => '@' + d).join(' or ') })}
          </p>
        ) : null}

        <Button type="submit" variant="primary" loading={busy} disabled={!email.trim()} className="mt-4 w-full">
          {busy ? t('request.sending') : t('request.send')}
        </Button>
      </form>

      <button
        type="button"
        onClick={onBack}
        className="mt-4 w-full text-center text-sm text-slate-500 underline-offset-2 transition hover:text-brand-600 hover:underline dark:text-slate-400"
      >
        {t('signin.backToSignIn')}
      </button>
    </AuthShell>
  );
}
