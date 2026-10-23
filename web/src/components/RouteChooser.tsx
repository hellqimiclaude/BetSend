import { useState } from 'react';
import { t } from '../i18n';
import { classNames, formatBytes } from '../lib/format';
import { Button } from './ui';
import type { HostRoutes } from '../lib/host';

/**
 * Which way the files should go.
 *
 * Only shown when there is a real choice to make. If nobody the user picked
 * has BetSend open, direct is not an option and asking about it would be a
 * dialog whose answer does not matter -- the Send screen says so in a line
 * of text instead.
 *
 * The times are measured, not calculated from a link speed nobody told us.
 * Until the app has done one transfer of each kind it says it does not
 * know, which is less use than a number and more use than a wrong one.
 */
export function RouteChooser({
  routes,
  recipients,
  onChoose,
  onCancel,
}: {
  routes: HostRoutes;
  recipients: string[];
  onChoose: (route: 'direct' | 'server') => void;
  onCancel: () => void;
}) {
  const [choice, setChoice] = useState<'direct' | 'server'>('direct');
  const partial = routes.unreachable.length > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={t('route.title')}
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md animate-slide-in rounded-xl bg-white p-5 shadow-xl dark:bg-slate-900"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
          {t('route.title')}
        </h3>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          {t('route.subtitle', { size: formatBytes(routes.bytes), names: recipients.join(', ') })}
        </p>

        <div className="mt-4 flex flex-col gap-2">
          <Option
            selected={choice === 'direct'}
            onSelect={() => setChoice('direct')}
            title={t('route.direct')}
            time={routes.direct.text}
            body={t('route.directBody')}
            footnote={
              partial
                ? t('route.directPartial', { names: routes.reachable.join(', ') })
                : undefined
            }
          />
          <Option
            selected={choice === 'server'}
            onSelect={() => setChoice('server')}
            title={t('route.server')}
            time={routes.server.text}
            body={t('route.serverBody')}
          />
        </div>

        {routes.direct.seconds === null || routes.server.seconds === null ? (
          <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">{t('route.unknownTime')}</p>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            {t('send.cancel')}
          </Button>
          <Button variant="primary" onClick={() => onChoose(choice)}>
            {t('route.choose')}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Option({
  selected,
  onSelect,
  title,
  time,
  body,
  footnote,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  time: string;
  body: string;
  footnote?: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={classNames(
        'rounded-lg border p-3 text-left transition',
        selected
          ? 'border-brand-500 bg-brand-50 dark:border-brand-500 dark:bg-brand-950/40'
          : 'border-slate-200 hover:border-slate-300 dark:border-slate-700 dark:hover:border-slate-600',
      )}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium text-slate-900 dark:text-slate-100">{title}</span>
        <span className="shrink-0 text-xs tabular-nums text-slate-500 dark:text-slate-400">{time}</span>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-slate-600 dark:text-slate-400">{body}</p>
      {footnote ? (
        <p className="mt-1.5 text-xs leading-relaxed text-amber-700 dark:text-amber-400">{footnote}</p>
      ) : null}
    </button>
  );
}
