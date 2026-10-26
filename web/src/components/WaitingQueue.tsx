import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Task } from '../types/api';
import { getTasksPage } from '../api/client';
import { Clock, ArrowRight } from 'lucide-react';
import { useLocale } from '../context/LocaleContext';
import { StatusBadge } from './StatusBadge';

export interface WaitingQueueProps {
  tasks?: Task[];
  diskFreeGB?: number;
  diskMinFreeGB?: number;
  diskLabel?: string;
}

export const WaitingQueue: React.FC<WaitingQueueProps> = ({
  tasks: propTasks,
  diskFreeGB,
  diskMinFreeGB,
  diskLabel,
}) => {
  const { t } = useLocale();
  const { data: fetchedTasks } = useQuery({
    queryKey: ['tasks', 'waiting'],
    queryFn: async () => {
      const [quota, queued] = await Promise.all([
        getTasksPage({ status: 'waiting_quota', limit: 20, sort: 'createdAt', order: 'desc' }),
        getTasksPage({ status: 'queued', limit: 20, sort: 'createdAt', order: 'desc' }),
      ]);
      return [...quota.items, ...queued.items].filter((task, index, items) => items.findIndex((item) => item.id === task.id) === index);
    },
    enabled: propTasks === undefined,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    retry: false,
  });

  const allTasks = propTasks !== undefined ? propTasks : fetchedTasks || [];
  const waitingTasks = allTasks.filter((task) => task.status === 'waiting_quota' || task.waitReason === 'parallel' || task.waitReason === 'profile_busy' || task.waitReason === 'focus');

  return (
    <div
      data-testid="waiting-queue"
      className="bg-[var(--t-surface)] rounded-xl border border-[var(--t-border)] overflow-hidden shadow-xs transition-colors"
    >
      <div className="px-6 py-4 border-b border-[var(--t-border)] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Clock className="w-5 h-5 text-[var(--t-warn)]" />
          <h2 className="text-base font-semibold text-[var(--t-text)]">
            {t('extra.waitingQueue')}
          </h2>
        </div>
        <span
          data-testid="waiting-queue-count"
          className="text-xs px-2.5 py-0.5 rounded-full font-medium bg-[color-mix(in_srgb,var(--t-warn)_15%,transparent)] text-[var(--t-warn)] border border-[var(--t-warn)]"
        >
          {t('extra.waitingCount', { count: waitingTasks.length })}
        </span>
      </div>

      {waitingTasks.length === 0 ? (
        <div
          data-testid="waiting-queue-empty"
          className="p-8 text-center text-[var(--t-text-2)] text-sm"
        >
          {t('extra.noWaitingTasks')}
        </div>
      ) : (
        <ul className="divide-y divide-[var(--t-border)]">
          {waitingTasks.map((task) => {
            const routeId = task.id.replace('/', '~');
            const displayTitle = task.title || task.id;

            return (
              <li
                key={task.id}
                data-testid={`waiting-task-${routeId}`}
                className="px-6 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-[var(--t-hover)] transition-colors"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Link
                      to={`/tasks/${encodeURIComponent(routeId)}`}
                      className="font-medium text-sm text-[var(--t-text)] hover:text-[var(--t-accent)] hover:underline"
                    >
                      {displayTitle}
                    </Link>

                    <StatusBadge
                      status={task.status}
                      waitReason={task.waitReason}
                      diskFreeGB={diskFreeGB}
                      diskMinFreeGB={diskMinFreeGB}
                      diskLabel={diskLabel}
                      size="sm"
                    />
                  </div>

                  <div className="flex items-center gap-2 text-xs text-[var(--t-text-2)] font-mono">
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-[var(--t-surface-2)] border border-[var(--t-border)]">
                      {task.projectId || task.id.split('/')[0]}
                    </span>
                    <span>{task.id}</span>
                  </div>
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
