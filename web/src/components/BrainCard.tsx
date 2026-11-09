import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { BrainStatus, BrainActivity, ClaudeQuota } from '../types/api';
import { AlertCircle, ExternalLink } from 'lucide-react';
import { useLocale } from '../context/LocaleContext';
import { formatReset, formatIsoTitle, parseApiTime } from '../lib/time';

export const BRAIN_ACTIVITY_LABELS: Record<BrainActivity, string> = {
  planning: 'extra.brainPlanning', dispatching: 'extra.brainDispatching', reviewing: 'extra.brainReviewing', merging: 'extra.brainMerging',
  deploying: 'extra.brainDeploying', waiting: 'extra.brainWaiting', idle: 'extra.brainIdle', talking: 'extra.brainTalking',
};

export function formatMinutesAgo(updatedAt?: string, now = Date.now(), translate: (key: string, params?: Record<string, string | number>) => string = (key) => key): string {
  if (!updatedAt) return '';
  const ts = parseApiTime(updatedAt);

  if (!Number.isFinite(ts)) return '';
  const diffSec = Math.max(0, Math.floor((now - ts) / 1000));
  const diffMins = Math.floor(diffSec / 60);

  if (diffMins === 0) return translate('extra.justNow');
  if (diffMins < 60) return translate('extra.updatedMinutes', { count: diffMins });
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return translate('extra.updatedHours', { count: diffHours });
  const diffDays = Math.floor(diffHours / 24);
  return translate('extra.updatedDays', { count: diffDays });
}

export interface BrainCardProps {
  brain?: BrainStatus | null;
  quota?: ClaudeQuota | null;
  onRetryLimit?: () => void;
}

export const BrainCard: React.FC<BrainCardProps> = ({ brain, quota, onRetryLimit }) => {
  const { t, locale } = useLocale();
  const [, setTick] = useState(0);

  // Re-render periodically to update the relative-time label.
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 60000);
    return () => clearInterval(timer);
  }, []);

  if (!brain) {
    return null;
  }

  const isStale = brain.stale;
  const activityLabel = t(BRAIN_ACTIVITY_LABELS[brain.activity] || 'extra.brainIdle');
  const timeAgoText = formatMinutesAgo(brain.updatedAt, Date.now(), t);
  const routeId = brain.taskId ? brain.taskId.replace('/', '~') : null;
  const quotaLimited = quota?.limited ?? (!!quota?.status && !/^allowed(?:$|[_-])/i.test(quota.status));
  const stateLabel = (state: string) => state === 'waiting' ? t('extra.brainStateWaiting') : state === 'working' ? t('extra.brainStateWorking') : t('extra.brainStateIdle');

  return (
    <div
      data-testid="brain-card"
      className={`p-5 rounded-xl border border-[var(--t-border)] bg-[var(--t-surface)] shadow-xs transition-all ${
        isStale ? 'opacity-60' : ''
      }`}
    >
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        {/* Left: Avatar & Info */}
        <div className="flex items-start sm:items-center gap-3.5 min-w-0">
          {/* Claude avatar */}
          <div
            className="w-11 h-11 rounded-full flex items-center justify-center font-bold text-[var(--t-on-accent)] text-lg shrink-0 shadow-xs select-none"
            style={{ backgroundColor: 'var(--t-claude)' }}
            title={t('extra.coordinator')}
            data-testid="brain-avatar"
          >
            C
          </div>

          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span
                className="text-xs font-semibold uppercase tracking-wider select-none"
                style={{ color: 'var(--t-claude)' }}
              >
                {t('extra.coordinator')}
              </span>
              {isStale && (
                <span
                  data-testid="brain-stale-badge"
                  className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-[var(--t-warn)]/15 text-[var(--t-warn)] border border-[var(--t-warn)]/30"
                >
                  <AlertCircle className="w-3 h-3" />
                  {t('extra.staleBrain')}
                </span>
              )}
            </div>

            <div className="flex items-baseline gap-2 flex-wrap">
              <h2
                data-testid="brain-activity"
                className="text-base font-bold text-[var(--t-text)]"
              >
                {brain.state ? stateLabel(brain.state) : activityLabel}
              </h2>

              {timeAgoText && (
                <span
                  data-testid="brain-time-ago"
                  className="text-xs text-[var(--t-text-3)]"
                  title={formatIsoTitle(brain.updatedAt)}
                >
                  · {timeAgoText}
                </span>
              )}
            </div>

            {brain.detail && (
              <p
                data-testid="brain-detail"
                className="text-sm text-[var(--t-text-2)] break-words"
              >
                {brain.detail}
              </p>
            )}
          </div>
        </div>

        {/* Right: Linked task if present */}
        {brain.taskId && routeId && (
          <div className="sm:self-center shrink-0">
            <Link
              to={`/tasks/${encodeURIComponent(routeId)}`}
              data-testid="brain-task-link"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-mono font-medium text-[var(--t-accent)] bg-[var(--t-selected)] border border-[var(--t-border)] hover:underline transition-colors"
            >
              <span>{brain.taskId}</span>
              <ExternalLink className="w-3 h-3" />
            </Link>
          </div>
        )}
      </div>
      {quota && <div className="mt-4 pt-3 border-t border-[var(--t-border)] text-xs flex items-center justify-between gap-3">
        <span className="text-[var(--t-text-2)]">{t('extra.claudeQuota')}</span>
        <span className={quotaLimited ? 'text-[var(--t-crit)]' : 'text-[var(--t-ok)]'}>
          {quota.status === 'allowed' ? t('extra.claudeQuotaAvailable') : quota.status === 'allowed_warning' ? t('extra.claudeQuotaWarning') : quotaLimited ? t('extra.claudeQuotaRejected') : (quota.status || t('extra.unknown'))} {quota.resetsAt && <span title={formatIsoTitle(quota.resetsAt)}>· {formatReset(quota.resetsAt, Date.now(), locale)}</span>}
        </span>
      </div>}
      {brain.state === 'waiting' && onRetryLimit && <button type="button" onClick={onRetryLimit} className="mt-3 px-3 py-1.5 rounded-lg text-xs font-semibold bg-[var(--t-warn)]/15 text-[var(--t-warn)] border border-[var(--t-warn)]/30">{t('extra.retryLimit')}</button>}
      {brain.sessions && brain.sessions.length > 0 && <div className="mt-4 pt-3 border-t border-[var(--t-border)] space-y-2" data-testid="brain-sessions">
        {brain.sessions.map((session) => <div key={session.sessionId} className="text-xs text-[var(--t-text-2)]">
          <a href={session.link} className="font-medium text-[var(--t-accent)] hover:underline">{session.title}</a>
          <span className="ml-2">· {stateLabel(session.state)}</span>
          {session.lastUserRequest && <div className="truncate" title={session.lastUserRequest}>{t('extra.requestLabel')}: {session.lastUserRequest}</div>}
          {session.lastTool && <div className="truncate">{t('extra.toolLabel')}: {session.lastTool.name}{session.lastTool.summary ? ` — ${session.lastTool.summary}` : ''}</div>}
          {session.tokens5h != null && <div>{t('extra.token')} 5h: {Math.round(session.tokens5h).toLocaleString()}</div>}
        </div>)}
      </div>}
    </div>
  );
};
