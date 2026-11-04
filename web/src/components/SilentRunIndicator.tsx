import React, { useEffect, useState } from 'react';
import { parseApiTime } from '../lib/time';
import { useLocale } from '../context/LocaleContext';

export const SilentRunIndicator: React.FC<{ lastActivityAt?: string | null; paused?: boolean }> = ({ lastActivityAt, paused }) => {
  const { t } = useLocale();
  const [, refresh] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => refresh((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  if (paused || !lastActivityAt) return null;
  const minutes = Math.floor(Math.max(0, Date.now() - parseApiTime(lastActivityAt)) / 60000);
  if (minutes <= 3) return null;
  return (
    <span className="inline-flex items-center rounded bg-[color-mix(in_srgb,var(--t-warn)_15%,transparent)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--t-warn)]">
      {t('extra.silentRun', { minutes })}
    </span>
  );
};
