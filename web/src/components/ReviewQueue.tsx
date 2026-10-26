import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Task } from '../types/api';
import { getTasksPage } from '../api/client';
import { ClipboardCheck, ArrowRight, Eye } from 'lucide-react';
import { useLocale } from '../context/LocaleContext';
import { getReviewerEngine } from '../utils/reviewer';

export interface ReviewQueueProps {
  tasks?: Task[];
  activeTaskId?: string | null;
  pollingInterval?: number;
}

export const ReviewQueue: React.FC<ReviewQueueProps> = ({
  tasks: propTasks,
  activeTaskId,
  pollingInterval = 15_000,
}) => {
  const { t } = useLocale();
  const { data: fetchedTasks } = useQuery({
    queryKey: ['tasks', 'review'],
    queryFn: async () => (await getTasksPage({ status: 'review', limit: 20, sort: 'createdAt', order: 'desc' })).items,
    enabled: propTasks === undefined,
    refetchInterval: pollingInterval,
    refetchIntervalInBackground: false,
    retry: false,
  });

  const allTasks = propTasks !== undefined ? propTasks : fetchedTasks || [];
  const reviewTasks = allTasks.filter((t) => t.status === 'review');

  const isCurrentTask = (taskId: string): boolean => {
    if (!activeTaskId) return false;
    const normalizedTarget = activeTaskId.replace('/', '~');
    const normalizedTask = taskId.replace('/', '~');
    return normalizedTask === normalizedTarget;
  };

  return (
    <div
      data-testid="review-queue"
      className="bg-[var(--t-surface)] rounded-xl border border-[var(--t-border)] overflow-hidden shadow-xs transition-colors"
    >
      <div className="px-6 py-4 border-b border-[var(--t-border)] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ClipboardCheck className="w-5 h-5 text-[var(--t-purple)]" />
          <h2 className="text-base font-semibold text-[var(--t-text)]">
            {t('extra.reviewQueue')}
          </h2>
        </div>
        <span
          data-testid="review-queue-count"
          className="text-xs px-2.5 py-0.5 rounded-full font-medium bg-[color-mix(in_srgb,var(--t-purple)_15%,transparent)] text-[var(--t-purple)] border border-[var(--t-purple)]"
        >
          {t('extra.reviewCount', { count: reviewTasks.length })}
        </span>
      </div>

      {reviewTasks.length === 0 ? (
        <div
          data-testid="review-queue-empty"
          className="p-8 text-center text-[var(--t-text-2)] text-sm"
        >
          {t('extra.noReview')}
        </div>
      ) : (
        <ul className="divide-y divide-[var(--t-border)]">
          {reviewTasks.map((task) => {
            const routeId = task.id.replace('/', '~');
            const watching = isCurrentTask(task.id);
            const displayTitle = task.title || task.id;

            return (
              <li
                key={task.id}
                data-testid={`review-task-${routeId}`}
                className={`px-6 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-[var(--t-hover)] transition-colors ${
                  watching ? 'bg-[var(--t-surface-2)]' : ''
                }`}
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Link
                      to={`/tasks/${encodeURIComponent(routeId)}`}
                      className="font-medium text-sm text-[var(--t-text)] hover:text-[var(--t-accent)] hover:underline"
                    >
                      {displayTitle}
                    </Link>

                    <span
                      data-testid="reviewer-badge"
                      className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full text-[var(--t-on-accent)] shadow-2xs ${
                        getReviewerEngine(task) === 'claude' ? 'bg-[var(--t-claude)]' : 'bg-[var(--t-ok)]'
                      }`}
                      style={getReviewerEngine(task) === 'claude' ? { backgroundColor: 'var(--t-claude)' } : undefined}
                    >
                      {getReviewerEngine(task) === 'claude' ? 'Claude' : 'Codex'}
                    </span>

                    {watching ? (
                      <span
                        data-testid="review-watching-badge"
                        className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full text-[var(--t-on-accent)] shadow-2xs"
                        style={{ backgroundColor: 'var(--t-claude)' }}
                      >
                        <Eye className="w-3 h-3" />
                        {t('extra.claudeReviewing')}
                      </span>
                    ) : (
                      <span
                        data-testid="review-waiting-note"
                        className="text-xs text-[var(--t-text-3)] italic"
                      >
                        {t('extra.waitingReview')}
                      </span>
                    )}
                    {task.reviewerEscalated ? (
                      <span className="inline-flex text-xs font-semibold px-2 py-0.5 rounded-full bg-[color-mix(in_srgb,var(--t-warn)_15%,transparent)] text-[var(--t-warn)]">
                        {t('extra.waitingApprover')}
                      </span>
                    ) : null}
                  </div>

                  <div className="flex items-center gap-2 text-xs text-[var(--t-text-2)] font-mono">
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-[var(--t-surface-2)] border border-[var(--t-border)]">
                      {task.projectId || task.id.split('/')[0]}
                    </span>
                    <span>{task.id}</span>
                  </div>
                  {task.reviewChain && task.reviewChain.length > 0 ? (
                    <div className="flex flex-wrap gap-1 pt-1">
                      {task.reviewChain.map((step, index) => (
                        <span key={`${step.reviewer}-${index}`} className={`rounded-full px-1.5 py-0.5 border text-[10px] ${index < (task.reviewStep ?? 0) ? 'border-[var(--t-ok)] text-[var(--t-ok)]' : index === (task.reviewStep ?? 0) ? 'border-[var(--t-accent)] text-[var(--t-accent)]' : 'border-[var(--t-border)] text-[var(--t-text-3)]'}`}>
                          {step.reviewer}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>

                <div className="self-end sm:self-center shrink-0">
                  <Link
                    to={`/tasks/${encodeURIComponent(routeId)}`}
                    className="text-xs font-medium text-[var(--t-accent)] hover:text-[var(--t-accent-hover)] inline-flex items-center gap-1"
                  >
                    {t('extra.view')} <ArrowRight className="w-3.5 h-3.5" />
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};
