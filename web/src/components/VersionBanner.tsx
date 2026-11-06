import React, { useEffect, useRef, useState, useCallback } from 'react';
import { getVersion, getToken } from '../api/client';
import { RefreshCw, X } from 'lucide-react';
import { useLocale } from '../context/LocaleContext';

export const VersionBanner: React.FC = () => {
  const { t } = useLocale();
  const [hasUpdate, setHasUpdate] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const initialBuildIdRef = useRef<string | null>(null);
  const isInitializedRef = useRef<boolean>(false);

  const checkVersion = useCallback(async () => {
    const token = getToken();
    if (!token) return;

    try {
      const data = await getVersion();
      if (!data || !data.webBuildId) return;

      if (!isInitializedRef.current) {
        initialBuildIdRef.current = data.webBuildId;
        isInitializedRef.current = true;
      } else if (
        initialBuildIdRef.current &&
        data.webBuildId !== initialBuildIdRef.current
      ) {
        setHasUpdate(true);
      }
    } catch {
      // Ignore 404 and other unavailable version endpoints.
    }
  }, []);

  useEffect(() => {
    checkVersion();

    const interval = setInterval(checkVersion, 60000);

    const onFocus = () => {
      checkVersion();
    };
    window.addEventListener('focus', onFocus);

    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, [checkVersion]);

  if (!hasUpdate || dismissed) return null;

  return (
    <aside
      data-tour="updates"
      role="alert"
      aria-live="polite"
      className="fixed top-[68px] right-4 sm:right-6 z-50 select-none animate-in fade-in slide-in-from-top-4 duration-300"
    >
      <div className="flex items-center gap-3 rounded-2xl border border-[var(--t-border)] bg-[var(--t-surface)]/95 px-4 py-3 text-sm text-[var(--t-text)] shadow-2xl shadow-black/30 backdrop-blur-md ring-1 ring-[var(--t-accent)]/20 hover:border-[var(--t-accent)]/40 transition-all">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--t-accent)]/15 text-[var(--t-accent)]">
          <RefreshCw className="h-4 w-4 animate-spin" style={{ animationDuration: '3s' }} />
        </div>
        <div className="flex flex-col pr-1">
          <div className="flex items-center gap-1.5">
            <span className="font-semibold text-xs text-[var(--t-text)] tracking-tight">
              {t('extra.updateAvailable')}
            </span>
            <span className="rounded-full bg-[var(--t-accent)]/15 px-1.5 py-0.2 text-[9px] font-bold text-[var(--t-accent)] uppercase tracking-wider">
              NEW
            </span>
          </div>
          <span className="text-[11px] text-[var(--t-text-3)]">
            {t('extra.updateHint')}
          </span>
        </div>
        <div className="flex items-center gap-1.5 pl-2 border-l border-[var(--t-border)]">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="flex items-center gap-1.5 rounded-lg bg-[var(--t-accent)] px-3 py-1.5 text-xs font-semibold text-[var(--t-on-accent)] shadow-xs hover:opacity-90 active:scale-95 transition-all cursor-pointer"
          >
            <RefreshCw className="h-3 w-3" />
            <span>{t('extra.reload')}</span>
          </button>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            aria-label={t('common.close')}
            title={t('common.close')}
            className="rounded-lg p-1.5 text-[var(--t-text-3)] hover:bg-[var(--t-hover)] hover:text-[var(--t-text)] active:scale-95 transition-all cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    </aside>
  );
};
