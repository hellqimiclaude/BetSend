import { useEffect, useState } from 'react';
import { useApp } from '../state/AppContext';
import { api, ApiError } from '../lib/api';
import { t } from '../i18n';
import { Button, LoadingState } from '../components/ui';
import { AuthShell, fieldClass } from './SignIn';

interface CheckedLink {
  name: string;
  email: string | null;
  isReset: boolean;
}

/**
 * Two ways to land here:
 *   with a token  — an admin sent a one-time setup or reset link
 *   without one   — self-service sign-up, when the admin has allowed it
 */
export function SetPassword({ token, onBack }: { token: string | null; onBack: () => void }) {
  const { bootstrap, completeSetup } = useApp();
  const minLength = bootstrap?.minPasswordLength ?? 10;

  const [checking, setChecking] = useState(true);
  const [linkUser, setLinkUser] = useState<CheckedLink | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Validate the link before showing the form, so an expired one is not
  // discovered only after typing a password twice.
  useEffect(() => {
    if (!token) {
      setLinkError(t('setup.badLink'));
      setChecking(false);
      return;
    }
    let cancelled = false;

    api
      .get<CheckedLink>(`/api/setup/check?token=${encodeURIComponent(token)}`)
      .then((data) => {
        if (!cancelled) setLinkUser(data);
      })
      .catch((err: ApiError) => {
        if (!cancelled) setLinkError(err.code === 'offline' ? err.message : t('setup.badLink'));
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  async function submit() {
    setError(null);

    if (password.length < minLength) return setError(t('setup.tooShort', { min: minLength }));
    if (password !== confirm) return setError(t('setup.mismatch'));

    setBusy(true);
    try {
      await completeSetup({ token: token!, password });
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  if (checking) {
    return (
      <AuthShell>
        <LoadingState label={t('setup.checking')} />
      </AuthShell>
    );
  }

  if (linkError) {
    return (
      <AuthShell>
        <p className="rounded-lg bg-red-50 px-3 py-2.5 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
          {linkError}
        </p>
        <Button variant="secondary" className="mt-4 w-full" onClick={onBack}>
          {t('signin.backToSignIn')}
        </Button>
      </AuthShell>
    );
  }

  const subtitle = linkUser
    ? `${
        linkUser.isReset
          ? t('setup.resetSubtitle', { name: linkUser.name })
          : t('setup.subtitle', { name: linkUser.name })
      }${linkUser.email ? ' ' + t('setup.forEmail', { email: linkUser.email }) : ''}`
    : t('setup.subtitleGeneric');

  return (
    <AuthShell>
      <h2 className="text-xl font-semibold">{t('setup.title')}</h2>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{subtitle}</p>

      <form
        className="mt-5"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label htmlFor="setup-password" className="mb-1 block text-sm font-medium">
          {t('setup.password')}
        </label>
        <input
          id="setup-password"
          type="password"
          autoComplete="new-password"
          autoFocus={Boolean(linkUser)}
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
            setError(null);
          }}
          className={fieldClass}
        />

        <label htmlFor="setup-confirm" className="mb-1 mt-4 block text-sm font-medium">
          {t('setup.confirm')}
        </label>
        <input
          id="setup-confirm"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(event) => {
            setConfirm(event.target.value);
            setError(null);
          }}
          className={fieldClass}
        />

        {error ? (
          <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
            {error}
          </p>
        ) : (
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">{t('setup.hint', { min: minLength })}</p>
        )}

        <Button
          type="submit"
          variant="primary"
          loading={busy}
          disabled={!password || !confirm}
          className="mt-4 w-full"
        >
          {busy ? t('setup.working') : t('setup.submit')}
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
