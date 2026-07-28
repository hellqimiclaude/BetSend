import { useEffect, useState } from 'react';
import { useApp } from './state/AppContext';
import { Sidebar } from './components/Sidebar';
import { Toasts } from './components/Toasts';
import { SignIn } from './views/SignIn';
import { SetPassword } from './views/SetPassword';
import { SendView } from './views/SendView';
import { InboxView } from './views/InboxView';
import { SentView } from './views/SentView';
import { AdminView } from './views/AdminView';
import { Button, ErrorState, LoadingState } from './components/ui';
import { IconBell, IconX } from './components/Icons';
import { t } from './i18n';

export type View = 'send' | 'inbox' | 'sent' | 'admin';

const VIEWS: View[] = ['send', 'inbox', 'sent', 'admin'];

function viewFromHash(): View {
  const hash = window.location.hash.replace(/^#\/?/, '').split('?')[0];
  return (VIEWS as string[]).includes(hash) ? (hash as View) : 'send';
}

interface AuthRoute {
  screen: 'signin' | 'setup';
  token: string | null;
}

/** Setup links look like `#/setup?token=…`, so the token survives a refresh. */
function authFromHash(): AuthRoute {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const [path, query] = raw.split('?');
  if (path === 'setup') {
    return { screen: 'setup', token: new URLSearchParams(query ?? '').get('token') };
  }
  return { screen: 'signin', token: null };
}

export function App() {
  const { ready, bootError, user, retryBoot } = useApp();
  const [view, setView] = useState<View>(() => viewFromHash());
  const [auth, setAuth] = useState<AuthRoute>(() => authFromHash());

  // Hash routing keeps the current screen across a refresh, no router needed.
  useEffect(() => {
    const onHashChange = () => {
      setView(viewFromHash());
      setAuth(authFromHash());
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // Once signed in, drop a spent setup link out of the address bar.
  useEffect(() => {
    if (user && window.location.hash.startsWith('#/setup')) {
      window.location.hash = '/send';
    }
  }, [user]);

  function navigate(next: View) {
    window.location.hash = `/${next}`;
    setView(next);
  }

  function goAuth(screen: AuthRoute['screen']) {
    window.location.hash = screen === 'setup' ? '/setup' : '/signin';
    setAuth({ screen, token: null });
  }

  if (!ready) {
    return (
      <div className="grid min-h-screen place-items-center">
        <LoadingState />
      </div>
    );
  }

  if (bootError) {
    return (
      <div className="grid min-h-screen place-items-center p-4">
        <div className="w-full max-w-md">
          <ErrorState message={bootError} onRetry={retryBoot} />
        </div>
      </div>
    );
  }

  if (!user) {
    // A setup link points at #/setup?token=… — honour it before the sign-in form.
    if (auth.screen === 'setup') {
      return <SetPassword token={auth.token} onBack={() => goAuth('signin')} />;
    }
    return <SignIn onNeedSetup={() => goAuth('setup')} />;
  }

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <Sidebar view={view} onNavigate={navigate} />
      <main className="flex-1 overflow-y-auto px-4 py-6 md:h-screen md:px-8 md:py-8">
        <NotificationPrompt />
        {view === 'send' ? <SendView /> : null}
        {view === 'inbox' ? <InboxView /> : null}
        {view === 'sent' ? <SentView /> : null}
        {view === 'admin' ? <AdminView /> : null}
      </main>
      <Toasts />
    </div>
  );
}

const NOTIFY_DISMISSED = 'betsend.notifyDismissed';

/**
 * Asked once, quietly, and never again if declined. Browsers ignore permission
 * requests that are not tied to a click, so this has to be a button.
 */
function NotificationPrompt() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission !== 'default') return;
    try {
      if (localStorage.getItem(NOTIFY_DISMISSED) === '1') return;
    } catch {
      /* ignore */
    }
    setVisible(true);
  }, []);

  function dismiss() {
    try {
      localStorage.setItem(NOTIFY_DISMISSED, '1');
    } catch {
      /* ignore */
    }
    setVisible(false);
  }

  if (!visible) return null;

  return (
    <div className="mx-auto mb-5 flex w-full max-w-3xl items-center gap-3 rounded-xl bg-brand-50 px-4 py-3 text-sm ring-1 ring-brand-100 dark:bg-brand-950/40 dark:ring-brand-900/60">
      <IconBell className="h-4 w-4 shrink-0 text-brand-600 dark:text-brand-400" />
      <p className="flex-1 text-slate-700 dark:text-slate-200">{t('notify.prompt')}</p>
      <Button
        variant="primary"
        className="px-3 py-1.5"
        onClick={() => {
          void Notification.requestPermission().finally(dismiss);
        }}
      >
        {t('notify.enable')}
      </Button>
      <button
        type="button"
        onClick={dismiss}
        aria-label={t('notify.dismiss')}
        className="rounded p-1 text-slate-400 transition hover:bg-white/60 hover:text-slate-700 dark:hover:bg-slate-800"
      >
        <IconX className="h-4 w-4" />
      </button>
    </div>
  );
}
