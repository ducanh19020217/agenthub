import React, { useState } from 'react';
import { ArrowRight, Check, ChevronDown, Play, X } from 'lucide-react';
import { useLocale } from '../context/LocaleContext';
import { formatCheckName } from '../utils/events';
import { parseApiTime } from '../lib/time';
import type { CheckResult } from '../types/api';

export type { CheckResult };

interface CheckResultsProps {
  checks?: CheckResult[];
  onRerun?: () => void;
  rerunning?: boolean;
  onCreateTask?: (check: CheckResult) => void;
}

function getShortCheckName(name: string, t: (key: string) => string, locale: string): string {
  const shortKey = `checksShort.${name}`;
  const translated = t(shortKey);
  if (translated && translated !== shortKey) {
    return translated;
  }

  if (name === 'npm test' || name === 'pnpm test' || name === 'yarn test' || name === 'bun test') {
    return 'test';
  }
  if (name.includes('eslint') || name === 'lint') {
    return 'lint';
  }
  if (name.includes('tsc') || name.includes('typecheck')) {
    return 'typecheck';
  }

  const full = formatCheckName(name, locale as any);
  return full.length > 18 ? `${full.slice(0, 16)}…` : full;
}

function formatStartTime(value: string): string {
  const parsed = parseApiTime(value);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) {
    return value;
  }
  const d = new Date(parsed);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

export const CheckResults: React.FC<CheckResultsProps> = ({ checks = [], onRerun, rerunning = false, onCreateTask }) => {
  const { t, locale } = useLocale();
  const [expanded, setExpanded] = useState<string | null>(null);

  const totalDurationMs = checks.reduce((sum, c) => sum + (c.durationMs || 0), 0);
  const runStartedAt = checks.find((c) => Boolean(c.runStartedAt))?.runStartedAt;

  const handleStepClick = (key: string, rowId: string) => {
    setExpanded(key);
    if (typeof document !== 'undefined') {
      const el = document.getElementById(rowId);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }
  };

  return (
    <section aria-label={t('extra.checkResults')} data-tour="task-review" className="bg-[var(--t-surface)] rounded-xl border border-[var(--t-border)] p-5 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="font-semibold text-[var(--t-text)]">{t('extra.checkResults')}</h2>
        </div>
        <div className="flex items-center gap-3">
          {(totalDurationMs > 0 || runStartedAt) && (
            <div data-testid="checks-summary-meta" className="text-xs text-[var(--t-text-3)] flex items-center gap-2">
              {totalDurationMs > 0 && (
                <span>{t('extra.checkTotalDuration', { duration: `${(totalDurationMs / 1000).toFixed(1)}s` })}</span>
              )}
              {totalDurationMs > 0 && runStartedAt && <span aria-hidden="true">•</span>}
              {runStartedAt && (
                <span title={runStartedAt}>
                  {t('extra.checkStartedAt', { time: formatStartTime(runStartedAt) })}
                </span>
              )}
            </div>
          )}
          {onRerun && (
            <button type="button" onClick={onRerun} disabled={rerunning} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--t-accent)] hover:bg-[var(--t-accent-hover)] text-[var(--t-on-accent)] text-xs font-semibold disabled:opacity-50 transition-colors cursor-pointer">
              <Play className="w-3.5 h-3.5" /> {rerunning ? t('common.loading') : t('extra.rerunCheck')}
            </button>
          )}
        </div>
      </div>

      {checks.length === 0 ? (
        <p className="text-xs text-[var(--t-text-3)]">{t('extra.noCheckResults')}</p>
      ) : (
        <>
          {/* Stepper horizontal flow */}
          <div
            data-testid="checks-stepper"
            aria-label={t('extra.checkFlow')}
            className="flex items-center gap-1.5 overflow-x-auto pb-1 text-xs select-none scrollbar-thin"
          >
            {checks.map((check, index) => {
              const seq = check.seq ?? index + 1;
              const key = `${check.name}-${index}`;
              const rowId = `check-row-${index}`;
              const shortName = getShortCheckName(check.name, t, locale);
              const isSkipped = Boolean(check.skipped);
              const isPass = !isSkipped && check.ok;

              const statusClass = isSkipped
                ? 'border-[var(--t-border)] text-[var(--t-text-3)] bg-[var(--t-surface-2)]'
                : isPass
                ? 'border-[var(--t-ok)] text-[var(--t-ok)] bg-[var(--t-ok-bg)]'
                : 'border-[var(--t-crit)] text-[var(--t-crit)] bg-[var(--t-crit-bg)]';

              return (
                <React.Fragment key={`step-${key}`}>
                  <button
                    type="button"
                    aria-label={t('extra.checkStep', { seq })}
                    onClick={() => handleStepClick(key, rowId)}
                    data-testid={`stepper-node-${index}`}
                    data-status={isSkipped ? 'skipped' : isPass ? 'passed' : 'failed'}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-medium shrink-0 transition-opacity hover:opacity-80 cursor-pointer ${statusClass}`}
                    title={`${seq}. ${formatCheckName(check.name, locale as any)}`}
                  >
                    <span className="inline-flex items-center justify-center w-4 h-4 rounded-full text-[10px] font-bold border border-current shrink-0">
                      {seq}
                    </span>
                    <span className="truncate max-w-[120px]">{shortName}</span>
                  </button>
                  {index < checks.length - 1 && (
                    <ArrowRight className="w-3.5 h-3.5 text-[var(--t-text-3)] shrink-0" aria-hidden="true" />
                  )}
                </React.Fragment>
              );
            })}
          </div>

          {/* Checks list */}
          <div className="space-y-1.5">
            {checks.map((check, index) => {
              const seq = check.seq ?? index + 1;
              const key = `${check.name}-${index}`;
              const rowId = `check-row-${index}`;
              const isOpen = expanded === key;
              return (
                <div id={rowId} key={key} className="rounded-lg border border-[var(--t-border)] overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setExpanded(isOpen ? null : key)}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs text-[var(--t-text)] hover:bg-[var(--t-hover)] transition-colors cursor-pointer"
                  >
                    <span
                      data-testid={`check-seq-${index}`}
                      className="inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-semibold bg-[var(--t-surface-2)] text-[var(--t-text-3)] border border-[var(--t-border)] shrink-0"
                    >
                      {seq}
                    </span>
                    {check.ok ? (
                      <Check aria-label={t('extra.checkPassed')} className="w-4 h-4 text-[var(--t-ok)] shrink-0" />
                    ) : (
                      <X aria-label={t('extra.checkFailed')} className="w-4 h-4 text-[var(--t-crit)] shrink-0" />
                    )}
                    <span className="font-mono flex-1 truncate" title={check.name}>
                      {formatCheckName(check.name, locale as any)}
                    </span>
                    <span className="text-[var(--t-text-3)] shrink-0">
                      {(check.durationMs / 1000).toFixed(1)}s
                    </span>
                    <ChevronDown
                      className={`w-3.5 h-3.5 text-[var(--t-text-3)] shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`}
                    />
                  </button>
                  {isOpen && (
                    <div className="border-t border-[var(--t-border)] bg-[var(--t-surface-2)]">
                      <pre className="text-[var(--t-text)] p-3 text-[11px] font-mono whitespace-pre-wrap max-h-64 overflow-auto">
                        {check.outputTail || t('extra.noOutput')}
                      </pre>
                      {onCreateTask && !check.ok && (
                        <button
                          type="button"
                          data-tour="task-capture"
                          onClick={() => onCreateTask(check)}
                          className="mx-3 mb-3 px-2.5 py-1.5 rounded-md bg-[var(--t-accent)] text-[var(--t-on-accent)] text-xs font-semibold cursor-pointer"
                        >
                          {t('extra.captureFix')}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
};
