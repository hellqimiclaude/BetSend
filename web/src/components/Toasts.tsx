import { useApp } from '../state/AppContext';
import { classNames } from '../lib/format';
import { IconAlert, IconCheck, IconBell, IconX } from './Icons';

const TONES = {
  info: 'ring-slate-200 dark:ring-slate-700',
  success: 'ring-emerald-200 dark:ring-emerald-900',
  error: 'ring-red-200 dark:ring-red-900',
};

const ICONS = {
  info: <IconBell className="h-5 w-5 text-brand-600" />,
  success: <IconCheck className="h-5 w-5 text-emerald-600" />,
  error: <IconAlert className="h-5 w-5 text-red-600" />,
};

export function Toasts() {
  const { toasts, dismissToast } = useApp();
  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-full max-w-sm flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role="status"
          className={classNames(
            'pointer-events-auto flex animate-slide-in items-start gap-3 rounded-xl bg-white p-3.5 shadow-lg ring-1 dark:bg-slate-900',
            TONES[toast.kind],
          )}
        >
          <div className="mt-0.5 shrink-0">{ICONS[toast.kind]}</div>
          <p className="flex-1 text-sm text-slate-700 dark:text-slate-200">{toast.message}</p>
          <button
            type="button"
            onClick={() => dismissToast(toast.id)}
            aria-label="Dismiss"
            className="shrink-0 rounded p-0.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800"
          >
            <IconX className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
