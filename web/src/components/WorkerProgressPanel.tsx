import React, { useEffect, useState } from 'react';
import { parseApiTime } from '../lib/time';
import { useLocale } from '../context/LocaleContext';

interface WorkerProgress {
  startedAt?: string | null;
  lastActivityAt?: string | null;
  activitySource?: string | null;
  newCommitCount?: number | null;
  lastCommitAt?: string | null;
  changedFileCount?: number | null;
}

function relativeTime(
  isoTs: string | undefined | null,
  t: (key: string, params?: Record<string, string | number | undefined | null>) => string,
): string {
  if (!isoTs) return '';
  const parsed = parseApiTime(isoTs);
  if (isNaN(parsed) || parsed <= 0) return '';
  const ms = Math.max(0, Date.now() - parsed);
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return t('extra.justNow');
  if (minutes < 60) return t('extra.minutesAgo', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('extra.hoursAgo', { count: hours });
  return t('extra.updatedDays', { count: Math.floor(hours / 24) });
}

/**
 * Threshold (in non-empty lines) below which a worker log is considered "sparse".
 * In agy runs without streaming, the log typically contains 0 to 1-2 lines (e.g. startup warnings or error: interrupted)
 * while the worker is actively progressing.
 */
export const SPARSE_LOG_LINE_THRESHOLD = 5;

/**
 * Returns true if a log is empty or sparse (fewer than or equal to threshold non-empty lines).
 */
export function isLogSparse(log: string | undefined | null, threshold = SPARSE_LOG_LINE_THRESHOLD): boolean {
  if (!log || !log.trim()) return true;
  const lines = log.trim().split('\n').filter((line) => line.trim().length > 0);
  return lines.length <= threshold;
}

export interface WorkerProgressPanelProps {
  currentRun: WorkerProgress | null | undefined;
  /** @deprecated use logSparse */
  logEmpty?: boolean;
  logSparse?: boolean;
}

/**
 * Shows a compact worker-progress summary when the log is empty or sparse.
 * Renders: spawn time · activity source · commits · last-commit time · changed files.
 * Hides itself entirely when there is nothing meaningful to show.
 */
export const WorkerProgressPanel: React.FC<WorkerProgressPanelProps> = ({
  currentRun,
  logEmpty,
  logSparse,
}) => {
  const { t } = useLocale();
  const [, tick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => tick((v) => v + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  if (!currentRun) return null;

  const { startedAt, lastActivityAt, activitySource, newCommitCount, lastCommitAt, changedFileCount } = currentRun;

  const isSparse = logSparse !== undefined ? logSparse : Boolean(logEmpty);

  // Only show when log is empty/sparse or we have useful extra data
  const hasExtraData = newCommitCount != null || changedFileCount != null;
  if (!isSparse && !hasExtraData) return null;

  const spawnedAgo = relativeTime(startedAt, t);
  const activityAgo = relativeTime(lastActivityAt, t);
  const lastCommitAgo = lastCommitAt ? relativeTime(lastCommitAt, t) : null;

  return (
    <div
      data-testid="worker-progress-panel"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2 text-xs text-[var(--t-text-2)] mb-2"
    >
      {/* Spawn time */}
      {spawnedAgo && (
        <span>
          🚀 {t('extra.workerSpawnedAt', { time: spawnedAgo })}
        </span>
      )}

      {/* Last activity */}
      {activityAgo && (
        <span className="text-[var(--t-text-3)]">
          ·{' '}
          {t('extra.updatedAt')} {activityAgo}
          {activitySource && (
            <span className="ml-1 opacity-75">({activitySource})</span>
          )}
        </span>
      )}

      {/* Commits */}
      {newCommitCount != null && (
        <span>
          · {t('extra.workerCommits', { count: newCommitCount })}
          {lastCommitAgo && (
            <span className="ml-1 opacity-70">
              ({t('extra.workerLastCommit', { time: lastCommitAgo })})
            </span>
          )}
        </span>
      )}

      {/* Changed files */}
      {changedFileCount != null && (
        <span>
          · {t('extra.workerChangedFiles', { count: changedFileCount })}
        </span>
      )}
    </div>
  );
};
