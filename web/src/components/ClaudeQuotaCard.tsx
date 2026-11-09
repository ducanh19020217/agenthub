import { Clock, Gauge, RefreshCw } from 'lucide-react';
import { useLocale } from '../context/LocaleContext';
import { formatReset, formatTime, formatTimeTitle, formatIsoTitle } from '../lib/time';
import type { ClaudeQuota } from '../types/api';

type QuotaTone = 'ok' | 'warn' | 'crit' | 'unknown';

interface QuotaRow {
  key: string;
  name: string | null;
  status: string | null;
  limited: boolean;
  resetsAt: number | null;
  observedAt: string | null;
  source: string;
}

const TONE_COLOR: Record<QuotaTone, string> = {
  ok: 'var(--t-ok)',
  warn: 'var(--t-warn)',
  crit: 'var(--t-crit)',
  unknown: 'var(--t-text-3)',
};

function toneOf(row: QuotaRow): QuotaTone {
  if (row.limited) return 'crit';
  if (row.status === 'allowed') return 'ok';
  if (row.status === 'allowed_warning') return 'warn';
  return 'unknown';
}

export function ClaudeQuotaCard({ quota, className = '' }: { quota: ClaudeQuota; className?: string }) {
  const { t, locale } = useLocale();

  const rows: QuotaRow[] = quota.profiles?.length
    ? quota.profiles.map((p) => ({
      key: p.profileName,
      name: p.profileName,
      status: p.status,
      limited: p.limited,
      resetsAt: p.resetsAt,
      observedAt: p.observedAt,
      source: p.source,
    }))
    : [{
      key: '__aggregate__',
      name: null,
      status: quota.status ?? null,
      limited: Boolean(quota.limited),
      resetsAt: quota.resetsAt ?? null,
      observedAt: quota.observedAt || null,
      source: '/usage',
    }];

  const statusLabel = (row: QuotaRow) => {
    if (row.status === 'allowed') return t('extra.claudeQuotaAvailable');
    if (row.status === 'allowed_warning') return t('extra.claudeQuotaWarning');
    if (row.limited) return t('extra.claudeQuotaRejected');
    return row.status || t('extra.unknown');
  };

  const okCount = rows.filter((row) => toneOf(row) === 'ok').length;

  return (
    <section data-testid="claude-quota-card" className={`rounded-xl border border-[var(--t-border)] bg-[var(--t-surface)] p-4 ${className}`}>
      <header className="mb-3 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--t-text)]">
          <Gauge className="h-4 w-4 text-[var(--t-accent)]" />
          {t('extra.claudeQuota')}
        </h2>
        {quota.profiles?.length ? (
          <span className="rounded-full bg-[var(--t-surface-2)] px-2.5 py-0.5 text-xs text-[var(--t-text-2)]">
            {t('extra.claudeQuotaSummary', { ok: String(okCount), total: String(rows.length) })}
          </span>
        ) : null}
      </header>
      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
        {rows.map((row) => {
          const tone = toneOf(row);
          const color = TONE_COLOR[tone];
          return (
            <li
              key={row.key}
              data-testid="claude-quota-item"
              data-tone={tone}
              title={formatTimeTitle(row.resetsAt, locale, row.source, row.observedAt)}
              className="relative min-w-0 overflow-hidden rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] py-2.5 pl-4 pr-3"
            >
              <span className="absolute inset-y-0 left-0 w-1" style={{ background: color }} />
              <div className="flex items-center justify-between gap-2">
                {row.name && <span className="truncate text-sm font-semibold text-[var(--t-text)]">{row.name}</span>}
                <span
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium"
                  style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}
                >
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
                  {statusLabel(row)}
                </span>
              </div>
              {row.resetsAt ? (
                <div className="mt-1.5 flex items-center gap-1.5 text-xs text-[var(--t-text-2)]">
                  <Clock className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{formatReset(row.resetsAt, Date.now(), locale)}</span>
                </div>
              ) : null}
              <div
                className="mt-1 flex items-center gap-1.5 text-[11px] text-[var(--t-text-3)]"
                title={formatIsoTitle(row.observedAt)}
              >
                <RefreshCw className="h-3 w-3 shrink-0" />
                <span className="truncate">
                  {t('extra.updatedAt')} {row.observedAt ? formatTime(row.observedAt, locale) : t('extra.unknown')}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
