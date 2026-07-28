import { useApp } from '../state/AppContext';
import { classNames } from '../lib/format';
import { t } from '../i18n';
import { IconInbox, IconMoon, IconSent, IconSettings, IconSun, IconUpload } from './Icons';
import type { View } from '../App';

const NAV: { view: View; label: string; icon: typeof IconUpload }[] = [
  { view: 'send', label: t('nav.send'), icon: IconUpload },
  { view: 'inbox', label: t('nav.inbox'), icon: IconInbox },
  { view: 'sent', label: t('nav.sent'), icon: IconSent },
  { view: 'admin', label: t('nav.admin'), icon: IconSettings },
];

export function Sidebar({ view, onNavigate }: { view: View; onNavigate: (view: View) => void }) {
  const { user, unread, connected, dark, setTheme, switchUser } = useApp();

  return (
    <nav className="flex shrink-0 flex-col gap-1 border-b border-slate-200 bg-white px-3 py-3 dark:border-slate-800 dark:bg-slate-900 md:h-screen md:w-60 md:border-b-0 md:border-r md:py-5">
      <div className="mb-2 flex items-center justify-between px-2 md:mb-6">
        <div className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-600 text-white">
            <IconUpload className="h-4 w-4" />
          </span>
          <span className="text-lg font-semibold tracking-tight">{t('app.name')}</span>
        </div>
        <button
          type="button"
          onClick={() => setTheme(dark ? 'light' : 'dark')}
          title={dark ? t('nav.theme.light') : t('nav.theme.dark')}
          aria-label={dark ? t('nav.theme.light') : t('nav.theme.dark')}
          className="rounded-lg p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
        >
          {dark ? <IconSun className="h-4 w-4" /> : <IconMoon className="h-4 w-4" />}
        </button>
      </div>

      <div className="flex gap-1 md:flex-col">
        {NAV.map((item) => {
          const Icon = item.icon;
          const active = view === item.view;
          return (
            <button
              key={item.view}
              type="button"
              onClick={() => onNavigate(item.view)}
              aria-current={active ? 'page' : undefined}
              className={classNames(
                'flex flex-1 items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition md:flex-none',
                active
                  ? 'bg-brand-50 text-brand-700 dark:bg-brand-950/60 dark:text-brand-300'
                  : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100',
              )}
            >
              <Icon className="h-[18px] w-[18px]" />
              <span>{item.label}</span>
              {item.view === 'inbox' && unread > 0 ? (
                <span className="ml-auto grid min-w-[20px] place-items-center rounded-full bg-brand-600 px-1.5 py-0.5 text-xs font-semibold text-white">
                  {unread > 99 ? '99+' : unread}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      <div className="mt-auto hidden px-2 pt-6 md:block">
        {!connected ? (
          <p className="mb-3 flex items-center gap-2 text-xs text-amber-600 dark:text-amber-400">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
            {t('nav.offline')}
          </p>
        ) : null}
        <p className="truncate text-sm font-medium text-slate-800 dark:text-slate-200">{user?.name}</p>
        <button
          type="button"
          onClick={switchUser}
          className="mt-0.5 text-xs text-slate-500 underline-offset-2 transition hover:text-brand-600 hover:underline dark:text-slate-400"
        >
          {t('nav.switchUser')}
        </button>
      </div>
    </nav>
  );
}
