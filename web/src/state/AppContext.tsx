import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api, ApiError, setAdminToken, setSignedOutHandler } from '../lib/api';
import { forgetName, rememberName } from '../lib/identity';
import { LiveConnection } from '../lib/ws';
import { applyTheme, isDark, storedTheme, watchSystemTheme, type Theme } from '../lib/theme';
import { t } from '../i18n';
import type { Bootstrap, ServerEvent, TransferView, UserView } from '../types';

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error';
  message: string;
}

interface AppState {
  ready: boolean;
  bootstrap: Bootstrap | null;
  bootError: string | null;
  user: UserView | null;
  users: UserView[];
  online: Set<string>;
  connected: boolean;
  inbox: TransferView[];
  sent: TransferView[];
  unread: number;
  loadingInbox: boolean;
  loadingSent: boolean;
  toasts: Toast[];
  theme: Theme;
  /** Whether dark styling is currently applied (resolves `system`). */
  dark: boolean;

  signIn: (name: string, password: string) => Promise<void>;
  completeSetup: (input: { token?: string; name?: string; password: string }) => Promise<void>;
  signOut: () => Promise<void>;
  refreshUsers: () => Promise<void>;
  refreshInbox: () => Promise<void>;
  refreshSent: () => Promise<void>;
  markSeen: (transferId: string) => Promise<void>;
  toast: (kind: Toast['kind'], message: string) => void;
  dismissToast: (id: number) => void;
  setTheme: (theme: Theme) => void;
  retryBoot: () => void;
}

const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const context = useContext(AppContext);
  if (!context) throw new Error('useApp must be used inside <AppProvider>');
  return context;
}

let toastId = 0;

export function AppProvider({ children }: { children: ReactNode }): JSX.Element {
  const [ready, setReady] = useState(false);
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [user, setUser] = useState<UserView | null>(null);
  const [users, setUsers] = useState<UserView[]>([]);
  const [online, setOnline] = useState<Set<string>>(new Set());
  const [connected, setConnected] = useState(false);
  const [inbox, setInbox] = useState<TransferView[]>([]);
  const [sent, setSent] = useState<TransferView[]>([]);
  const [unread, setUnread] = useState(0);
  const [loadingInbox, setLoadingInbox] = useState(false);
  const [loadingSent, setLoadingSent] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [theme, setThemeState] = useState<Theme>(() => storedTheme());
  const [dark, setDark] = useState<boolean>(() => isDark(storedTheme()));
  const [bootNonce, setBootNonce] = useState(0);

  const liveRef = useRef<LiveConnection | null>(null);

  const toast = useCallback((kind: Toast['kind'], message: string) => {
    const id = ++toastId;
    setToasts((current) => [...current, { id, kind, message }]);
    window.setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), 6000);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((item) => item.id !== id));
  }, []);

  // ---- theme -------------------------------------------------------------

  useEffect(() => {
    applyTheme(theme);
    setDark(isDark(theme));
  }, [theme]);

  useEffect(() => {
    if (theme !== 'system') return;
    return watchSystemTheme(() => {
      applyTheme('system');
      setDark(isDark('system'));
    });
  }, [theme]);

  const setTheme = useCallback((next: Theme) => setThemeState(next), []);

  // ---- boot --------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    setBootError(null);

    // The session cookie decides whether we are signed in — bootstrap simply
    // reports what the server sees.
    api
      .get<Bootstrap>('/api/bootstrap')
      .then((data) => {
        if (cancelled) return;
        setBootstrap(data);
        if (data.user) {
          setUser(data.user);
          setUnread(data.unread);
          rememberName(data.user.name);
        }
        setReady(true);
      })
      .catch((error: ApiError) => {
        if (cancelled) return;
        setBootError(error.message);
        setReady(true);
      });

    return () => {
      cancelled = true;
    };
  }, [bootNonce]);

  /** A revoked or expired session anywhere drops us back to the sign-in screen. */
  useEffect(() => {
    setSignedOutHandler(() => {
      setUser(null);
      setInbox([]);
      setSent([]);
      setUnread(0);
    });
    return () => setSignedOutHandler(null);
  }, []);

  const retryBoot = useCallback(() => {
    setReady(false);
    setBootNonce((n) => n + 1);
  }, []);

  // ---- data loaders ------------------------------------------------------

  const refreshUsers = useCallback(async () => {
    try {
      const data = await api.get<{ users: UserView[] }>('/api/users');
      setUsers(data.users);
    } catch {
      /* the picker keeps the last known list rather than emptying itself */
    }
  }, []);

  const refreshInbox = useCallback(async () => {
    setLoadingInbox(true);
    try {
      const data = await api.get<{ transfers: TransferView[]; unread: number }>('/api/inbox');
      setInbox(data.transfers);
      setUnread(data.unread);
    } catch (error) {
      if ((error as ApiError).code !== 'offline') toast('error', (error as ApiError).message);
    } finally {
      setLoadingInbox(false);
    }
  }, [toast]);

  const refreshSent = useCallback(async () => {
    setLoadingSent(true);
    try {
      const data = await api.get<{ transfers: TransferView[] }>('/api/sent');
      setSent(data.transfers);
    } catch (error) {
      if ((error as ApiError).code !== 'offline') toast('error', (error as ApiError).message);
    } finally {
      setLoadingSent(false);
    }
  }, [toast]);

  const markSeen = useCallback(async (transferId: string) => {
    try {
      const data = await api.post<{ unread: number }>(`/api/transfers/${transferId}/seen`);
      setUnread(data.unread);
      setInbox((current) =>
        current.map((item) =>
          item.id === transferId ? { ...item, me: { ...item.me!, seenAt: item.me?.seenAt ?? Date.now() } } : item,
        ),
      );
    } catch {
      /* purely cosmetic — the badge will correct itself on the next load */
    }
  }, []);

  // ---- identity ----------------------------------------------------------

  const adopt = useCallback((data: { user: UserView; unread: number }) => {
    rememberName(data.user.name);
    setUser(data.user);
    setUnread(data.unread);
  }, []);

  const signIn = useCallback(
    async (name: string, password: string) => {
      adopt(await api.post<{ user: UserView; unread: number }>('/api/session', { name, password }));
    },
    [adopt],
  );

  const completeSetup = useCallback(
    async (input: { token?: string; name?: string; password: string }) => {
      adopt(await api.post<{ user: UserView; unread: number }>('/api/setup', input));
    },
    [adopt],
  );

  const signOut = useCallback(async () => {
    liveRef.current?.close();
    liveRef.current = null;
    try {
      await api.del('/api/session');
    } catch {
      // Even if the server never heard us, clear locally — the cookie is gone
      // from this browser's point of view either way.
    }
    setAdminToken(null);
    forgetName();
    setUser(null);
    setInbox([]);
    setSent([]);
    setUnread(0);
    setConnected(false);
  }, []);

  // ---- live connection ---------------------------------------------------

  const handleEvent = useCallback(
    (event: ServerEvent) => {
      switch (event.type) {
        case 'hello':
          setUnread(event.unread);
          break;

        case 'presence':
          setOnline(new Set(event.online.map((name) => name.toLowerCase())));
          break;

        case 'transfer:new': {
          setUnread(event.unread);
          void refreshInbox();
          const message = t('toast.newTransfer', { name: event.from, count: event.fileCount });
          toast('info', message);
          showDesktopNotification(event.from, event.fileCount);
          break;
        }

        case 'transfer:revoked':
          setUnread(event.unread);
          setInbox((current) => current.filter((item) => item.id !== event.transferId));
          toast('info', t('toast.revoked', { name: event.from }));
          break;

        case 'transfer:expired':
          setUnread(event.unread);
          setInbox((current) => current.filter((item) => item.id !== event.transferId));
          break;

        case 'transfer:downloaded':
          toast('success', t('toast.downloaded', { name: event.by }));
          void refreshSent();
          break;

        case 'transfer:seen':
          void refreshSent();
          break;

        case 'inbox:changed':
          setUnread(event.unread);
          void refreshInbox();
          break;
      }
    },
    [refreshInbox, refreshSent, toast],
  );

  const handleEventRef = useRef(handleEvent);
  handleEventRef.current = handleEvent;

  useEffect(() => {
    if (!user) return;

    const live = new LiveConnection();
    liveRef.current = live;
    const offEvent = live.on((event) => handleEventRef.current(event));
    const offStatus = live.onStatus(setConnected);
    live.connect();

    void refreshUsers();
    void refreshInbox();
    void refreshSent();

    return () => {
      offEvent();
      offStatus();
      live.close();
      liveRef.current = null;
    };
    // Reconnect only when the identity changes, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.name]);

  // Presence for the current user is implied by our own socket.
  useEffect(() => {
    if (!user) return;
    setOnline((current) => {
      if (!connected) return current;
      const next = new Set(current);
      next.add(user.name.toLowerCase());
      return next;
    });
  }, [connected, user]);

  const value = useMemo<AppState>(
    () => ({
      ready,
      bootstrap,
      bootError,
      user,
      users,
      online,
      connected,
      inbox,
      sent,
      unread,
      loadingInbox,
      loadingSent,
      toasts,
      theme,
      dark,
      signIn,
      completeSetup,
      signOut,
      refreshUsers,
      refreshInbox,
      refreshSent,
      markSeen,
      toast,
      dismissToast,
      setTheme,
      retryBoot,
    }),
    [
      ready,
      bootstrap,
      bootError,
      user,
      users,
      online,
      connected,
      inbox,
      sent,
      unread,
      loadingInbox,
      loadingSent,
      toasts,
      theme,
      dark,
      signIn,
      completeSetup,
      signOut,
      refreshUsers,
      refreshInbox,
      refreshSent,
      markSeen,
      toast,
      dismissToast,
      setTheme,
      retryBoot,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

function showDesktopNotification(from: string, fileCount: number): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible') return; // the in-app toast is enough
  try {
    new Notification(t('notify.title', { name: from }), {
      body: t('notify.body', { count: fileCount }),
      tag: 'betsend-transfer',
    });
  } catch {
    /* some browsers require a service worker — the toast still fires */
  }
}
