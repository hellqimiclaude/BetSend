import { useState } from 'react';
import { useApp } from '../state/AppContext';
import { ApiError } from '../lib/api';
import { t } from '../i18n';
import { Button } from '../components/ui';
import { AuthShell, ErrorNote, exampleAddress, fieldClass } from './SignIn';

/**
 * The very first screen on a new server, shown while nobody has an account.
 *
 * Without it a fresh install is a locked door: registering needs a mail relay
 * to verify the address, and the relay is configured on the Admin page, which
 * needs an account. The admin token the installer prints breaks the circle —
 * whoever holds it installed the server.
 */
export function FirstRun() {
  const { bootstrap, completeFirstRun } = useApp();
  const minLength = bootstrap?.minPasswordLength ?? 10;

  const [adminToken, setAdminToken] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mismatch = confirm.length > 0 && password !== confirm;
  const ready = adminToken.trim() && email.trim() && password.length >= minLength && !mismatch;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await completeFirstRun({ adminToken: adminToken.trim(), email: email.trim(), password });
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell>
      <h2 className="text-xl font-semibold">{t('firstRun.title')}</h2>
      <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">{t('firstRun.intro')}</p>

      <form
        className="mt-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready && !busy) void submit();
        }}
      >
        <label htmlFor="adminToken" className="mb-1 block text-sm font-medium">
          {t('firstRun.token')}
        </label>
        <input
          id="adminToken"
          type="text"
          autoFocus
          spellCheck={false}
          autoComplete="off"
          value={adminToken}
          onChange={(event) => {
            setAdminToken(event.target.value);
            setError(null);
          }}
          className={fieldClass}
        />
        <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">{t('firstRun.tokenHint')}</p>

        <label htmlFor="email" className="mb-1 mt-4 block text-sm font-medium">
          {t('firstRun.email')}
        </label>
        <input
          id="email"
          type="email"
          name="username"
          autoComplete="username"
          spellCheck={false}
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            setError(null);
          }}
          placeholder={exampleAddress(bootstrap?.emailDomains)}
          className={fieldClass}
        />

        <label htmlFor="password" className="mb-1 mt-4 block text-sm font-medium">
          {t('firstRun.password')}
        </label>
        <input
          id="password"
          type="password"
          name="new-password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
            setError(null);
          }}
          className={fieldClass}
        />
        <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
          {t('setup.hint', { min: minLength })}
        </p>

        <label htmlFor="confirm" className="mb-1 mt-4 block text-sm font-medium">
          {t('firstRun.confirm')}
        </label>
        <input
          id="confirm"
          type="password"
          name="confirm-password"
          autoComplete="new-password"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          className={fieldClass}
        />
        {mismatch ? (
          <p className="mt-1.5 text-xs text-red-600 dark:text-red-400">{t('setup.mismatch')}</p>
        ) : null}

        {error ? <ErrorNote>{error}</ErrorNote> : null}

        <Button type="submit" variant="primary" className="mt-5 w-full" loading={busy} disabled={!ready}>
          {t('firstRun.submit')}
        </Button>
      </form>
    </AuthShell>
  );
}
