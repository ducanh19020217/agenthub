import React, { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { getSavings, getProjects } from '../api/client';
import { Project } from '../types/api';
import {
  Sparkles,
  Code2,
  CheckCircle2,
  RotateCcw,
  Info,
  Calendar,
  Filter,
  ArrowUpRight,
} from 'lucide-react';
import { useLocale } from '../context/LocaleContext';
import { ModelBadge } from '../components/ModelBadge';
import { formatNumber as formatNum, formatSigned } from '../utils/format';
import { Pagination } from '../components/ui/Pagination';

export const SavingsPage: React.FC = () => {
  const { t, locale } = useLocale();
  const [projectFilter, setProjectFilter] = useState<string>('');
  const [sinceFilter, setSinceFilter] = useState<string>('');
  const [taskPage, setTaskPage] = useState(1);
  const taskPageSize = 20;
  const formatNumber = (value: number | null | undefined, decimals?: number) =>
    formatNum(value, { decimals, locale });

  const { data: projects = [] } = useQuery<Project[]>({
    queryKey: ['projects'],
    queryFn: getProjects,
  });

  const {
    data: savings,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['savings', projectFilter, sinceFilter, taskPage],
    queryFn: () =>
      getSavings({
        project: projectFilter || undefined,
        since: sinceFilter || undefined,
        limit: taskPageSize,
        offset: (taskPage - 1) * taskPageSize,
      }),
  });
  useEffect(() => { setTaskPage(1); }, [projectFilter, sinceFilter]);

  const formatDuration = (ms: number | null | undefined) => {
    if (!ms || ms <= 0) return '0s';
    const totalSec = Math.floor(ms / 1000);
    const hours = Math.floor(totalSec / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = totalSec % 60;
    if (hours > 0) return `${hours}h ${mins}m`;
    if (mins > 0) return `${mins}m ${secs}s`;
    return `${secs}s`;
  };

  const summary = savings?.summary;
  const tasks = savings?.tasks || [];
  const byDay = savings?.byDay || [];

  // Chart max calculation
  const maxDayTokens = Math.max(
    1,
    ...byDay.map((d) => Math.max(d.geminiTokens, d.codexTokens, d.totalTokens)),
  );

  return (
    <div className="space-y-8 max-w-7xl mx-auto">
      {/* Header and Filters */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('savings.title')}</h1>
          <p className="text-sm text-[var(--t-text-2)] mt-1">
            {t('savings.subtitle')}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1.5 bg-[var(--t-surface)] border border-[var(--t-border)] rounded-lg px-2.5 py-1.5 text-xs shadow-xs">
            <Filter className="w-3.5 h-3.5 text-[var(--t-text-2)]" />
            <select
              value={projectFilter}
              onChange={(e) => setProjectFilter(e.target.value)}
              aria-label={t('tasks.filterProject')}
              className="bg-transparent border-none text-[var(--t-text)] focus:outline-none cursor-pointer"
            >
              <option value="">{t('tasks.allProjects')}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name || p.id}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-1.5 bg-[var(--t-surface)] border border-[var(--t-border)] rounded-lg px-2.5 py-1.5 text-xs shadow-xs">
            <Calendar className="w-3.5 h-3.5 text-[var(--t-text-2)]" />
            <input
              type="date"
              value={sinceFilter}
              onChange={(e) => setSinceFilter(e.target.value)}
              aria-label={t('savings.fromDate')}
              className="bg-transparent border-none text-[var(--t-text)] focus:outline-none cursor-pointer text-xs"
            />
          </div>

          {(projectFilter || sinceFilter) && (
            <button
              type="button"
              onClick={() => {
                setProjectFilter('');
                setSinceFilter('');
              }}
              className="text-xs text-[var(--t-info)] hover:underline px-2 py-1"
            >
              {t('savings.clearFilters')}
            </button>
          )}
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center p-16">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--t-info)]" />
        </div>
      ) : error ? (
        <div className="p-8 text-center text-[var(--t-crit)] text-sm">
          {t('savings.loadError')}
        </div>
      ) : (
        <>
          {/* 4 Metric Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Card 1: avoided Claude work */}
            <div className="bg-[var(--t-surface)] rounded-xl border border-[var(--t-border)] p-5 shadow-xs flex flex-col justify-between">
              <div className="flex items-center justify-between text-[var(--t-text-2)] mb-2">
                <span className="text-xs font-semibold uppercase tracking-wider">
                  {t('savings.claudeSaved')}
                </span>
                <div className="p-2 rounded-lg bg-[var(--t-info-bg)] text-[var(--t-info)]">
                  <Sparkles className="w-4 h-4" />
                </div>
              </div>
              <div>
                <div className="text-2xl font-bold tracking-tight text-[var(--t-text)]">
                  {summary ? formatNumber(summary.claudeSavedTokens) : '0'}
                  <span className="text-xs font-normal text-[var(--t-text-2)] ml-1">
                    tokens
                  </span>
                </div>
                <div className="mt-2 flex items-center gap-1.5 text-xs text-[var(--t-ok)] font-medium">
                  <span className="px-1.5 py-0.5 rounded bg-[var(--t-ok-bg)] border border-[var(--t-ok)]/30">
                    {formatNumber((summary?.savingsRatio || 0) * 100, 1)}%
                  </span>
                  <span>{t('savings.savingRate')}</span>
                </div>
              </div>
            </div>

            {/* Card 2: worker-written code */}
            <div className="bg-[var(--t-surface)] rounded-xl border border-[var(--t-border)] p-5 shadow-xs flex flex-col justify-between">
              <div className="flex items-center justify-between text-[var(--t-text-2)] mb-2">
                <span className="text-xs font-semibold uppercase tracking-wider">
                  {t('savings.codeWritten')}
                </span>
                <div className="p-2 rounded-lg bg-[var(--t-ok-bg)] text-[var(--t-ok)]">
                  <Code2 className="w-4 h-4" />
                </div>
              </div>
              <div>
                <div className="text-2xl font-bold tracking-tight text-[var(--t-text)]">
                  {formatSigned(summary?.totalLinesAdded, { locale, positivePrefix: '+' })}
                  <span className="text-xs font-normal text-[var(--t-text-2)] ml-1">
                    {t('savings.lines')}
                  </span>
                </div>
                <div className="mt-2 text-xs text-[var(--t-text-2)]">
                  {formatSigned(summary?.totalLinesDeleted ? -summary.totalLinesDeleted : 0, { locale, negativePrefix: '-' })} {t('savings.linesDeleted')}
                </div>
              </div>
            </div>

            {/* Card 3: approved tasks */}
            <div className="bg-[var(--t-surface)] rounded-xl border border-[var(--t-border)] p-5 shadow-xs flex flex-col justify-between">
              <div className="flex items-center justify-between text-[var(--t-text-2)] mb-2">
                <span className="text-xs font-semibold uppercase tracking-wider">
                  {t('savings.approvedTasks')}
                </span>
                <div className="p-2 rounded-lg bg-[var(--t-purple-bg)] text-[var(--t-purple)]">
                  <CheckCircle2 className="w-4 h-4" />
                </div>
              </div>
              <div>
                <div className="text-2xl font-bold tracking-tight text-[var(--t-text)]">
                  {summary?.tasksApprovedCount || 0}
                  <span className="text-xs font-normal text-[var(--t-text-2)] ml-1">
                    task
                  </span>
                </div>
                <div className="mt-2 text-xs text-[var(--t-text-2)]">
                  {t('savings.totalTasks', { count: tasks.length })}
                </div>
              </div>
            </div>

            {/* Card 4: average review rounds */}
            <div className="bg-[var(--t-surface)] rounded-xl border border-[var(--t-border)] p-5 shadow-xs flex flex-col justify-between">
              <div className="flex items-center justify-between text-[var(--t-text-2)] mb-2">
                <span className="text-xs font-semibold uppercase tracking-wider">
                  {t('savings.avgReviewRounds')}
                </span>
                <div className="p-2 rounded-lg bg-[var(--t-warn-bg)] text-[var(--t-warn)]">
                  <RotateCcw className="w-4 h-4" />
                </div>
              </div>
              <div>
                <div className="text-2xl font-bold tracking-tight text-[var(--t-text)]">
                  {formatNumber(summary?.avgReviewRounds, 1)}
                  <span className="text-xs font-normal text-[var(--t-text-2)] ml-1">
                    {t('savings.rounds')}
                  </span>
                </div>
                <div className="mt-2 text-xs text-[var(--t-text-2)]">
                  {t('savings.changesRound')}
                </div>
              </div>
            </div>
          </div>

          {/* Bar Chart: Daily Token Usage by Engine */}
          <div className="bg-[var(--t-surface)] rounded-xl border border-[var(--t-border)] p-6 shadow-xs space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div>
                <h2 className="text-base font-semibold text-[var(--t-text)]">
                  {t('savings.tokensByDay')}
                </h2>
                <p className="text-xs text-[var(--t-text-2)]">
                  {t('savings.tokensByDayDesc')}
                </p>
              </div>

              {/* Legend */}
              <div className="flex items-center gap-4 text-xs">
                <div className="flex items-center gap-1.5">
                  <div className="w-3 h-3 rounded-xs bg-[var(--t-chart-1)]" />
                  <span className="text-[var(--t-text-2)]">Gemini (agy)</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="w-3 h-3 rounded-xs bg-[var(--t-chart-3)]" />
                  <span className="text-[var(--t-text-2)]">Codex</span>
                </div>
              </div>
            </div>

            {byDay.length === 0 ? (
              <div className="py-12 text-center text-xs text-[var(--t-text-2)]">
                {t('savings.noDailyData')}
              </div>
            ) : (
              <div className="w-full overflow-x-auto">
                <div className="min-w-[600px] h-64 flex flex-col justify-end pt-4 pb-2">
                  {/* SVG Chart */}
                  <svg className="w-full h-48" viewBox={`0 0 ${Math.max(600, byDay.length * 60)} 200`}>
                    <defs>
                      <linearGradient id="geminiGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--t-chart-1)" stopOpacity="0.9" />
                        <stop offset="100%" stopColor="var(--t-chart-2)" stopOpacity="0.7" />
                      </linearGradient>
                      <linearGradient id="codexGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--t-chart-3)" stopOpacity="0.9" />
                        <stop offset="100%" stopColor="var(--t-chart-4)" stopOpacity="0.7" />
                      </linearGradient>
                    </defs>

                    {/* Horizontal grid lines */}
                    {[0.25, 0.5, 0.75, 1].map((pct) => (
                      <line
                        key={pct}
                        x1="0"
                        y1={180 - pct * 160}
                        x2="100%"
                        y2={180 - pct * 160}
                        stroke="currentColor"
                        strokeDasharray="4 4"
                        className="text-[var(--t-border)] opacity-40"
                      />
                    ))}

                    {/* Bars */}
                    {byDay.map((d, idx) => {
                      const totalWidth = Math.max(600, byDay.length * 60);
                      const groupWidth = totalWidth / byDay.length;
                      const xBase = idx * groupWidth + groupWidth * 0.15;
                      const barW = Math.min(20, groupWidth * 0.35);

                      const geminiH = Math.max(4, (d.geminiTokens / maxDayTokens) * 160);
                      const codexH = Math.max(4, (d.codexTokens / maxDayTokens) * 160);

                      return (
                        <g key={d.date} className="cursor-pointer group">
                          {/* Gemini bar */}
                          <rect
                            x={xBase}
                            y={180 - geminiH}
                            width={barW}
                            height={geminiH}
                            rx="3"
                            fill="url(#geminiGrad)"
                            className="transition-all hover:opacity-100 opacity-90"
                          >
                            <title>{`${d.date} - Gemini: ${formatNumber(d.geminiTokens)} tokens`}</title>
                          </rect>

                          {/* Codex bar */}
                          <rect
                            x={xBase + barW + 4}
                            y={180 - codexH}
                            width={barW}
                            height={codexH}
                            rx="3"
                            fill="url(#codexGrad)"
                            className="transition-all hover:opacity-100 opacity-90"
                          >
                            <title>{`${d.date} - Codex: ${formatNumber(d.codexTokens)} tokens`}</title>
                          </rect>

                          {/* Date label */}
                          <text
                            x={xBase + barW}
                            y="196"
                            textAnchor="middle"
                            className="text-[10px] fill-[var(--t-text-2)] font-mono"
                          >
                            {d.date.slice(5)}
                          </text>
                        </g>
                      );
                    })}
                  </svg>
                </div>
              </div>
            )}
          </div>

          {/* Table by Task */}
      <div className="bg-[var(--t-surface)] rounded-xl border border-[var(--t-border)] shadow-xs overflow-hidden">
            <div className="px-6 py-4 border-b border-[var(--t-border)] flex items-center justify-between">
              <div>
                <h2 className="text-base font-semibold text-[var(--t-text)]">
                  {t('savings.byTask')}
                </h2>
                <p className="text-xs text-[var(--t-text-2)] mt-0.5">
                    {t('savings.byTaskDesc')}
                </p>
              </div>
              <span className="text-xs text-[var(--t-text-2)]">
                {t('savings.taskCount', { count: savings?.tasksTotal || 0 })}
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-xs">
                <thead className="bg-[var(--t-hover)] border-b border-[var(--t-border)] text-[var(--t-text-2)] font-semibold uppercase tracking-wider">
                  <tr>
                    <th className="px-6 py-3 whitespace-nowrap">{t('extra.task')}</th>
                    <th className="px-6 py-3 whitespace-nowrap">{t('extra.model')}</th>
                    <th className="px-6 py-3 text-right whitespace-nowrap">{t('savings.linesChange')}</th>
                    <th className="px-6 py-3 text-right whitespace-nowrap">{t('savings.workerTokens')}</th>
                    <th className="px-6 py-3 text-center whitespace-nowrap">Claude</th>
                    <th className="px-6 py-3 text-center whitespace-nowrap">{t('savings.reviewRounds')}</th>
                    <th className="px-6 py-3 text-right whitespace-nowrap">{t('taskDetail.thDuration')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--t-border)] text-[var(--t-text)]">
                  {tasks.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-6 py-8 text-center text-[var(--t-text-2)]">
                        {t('savings.noMatchingTasks')}
                      </td>
                    </tr>
                  ) : (
                    tasks.map((task) => (
                      <tr
                        key={task.taskId}
                        className="hover:bg-[var(--t-hover)] transition-colors"
                      >
                        <td className="px-6 py-3.5 whitespace-nowrap">
                          <Link
                            to={`/tasks/${encodeURIComponent(task.taskId)}`}
                            className="font-medium hover:text-[var(--t-info)] flex items-center gap-1 group"
                          >
                            <span>{task.title || task.slug}</span>
                            <ArrowUpRight className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                          </Link>
                          <div className="text-[11px] font-mono text-[var(--t-text-2)] mt-0.5">
                            {task.taskId}
                          </div>
                        </td>
                        <td className="px-6 py-3.5 whitespace-nowrap">
                          <ModelBadge model={task.model} engine={task.engine} profileName={task.profileName} />
                        </td>
                        <td className="px-6 py-3.5 text-right font-mono tabular-nums whitespace-nowrap">
                          {task.linesAdded === 0 && task.linesDeleted === 0 ? (
                            <span className="text-[var(--t-text-3)] opacity-70">—</span>
                          ) : (
                            <span>
                              <span className="text-[var(--t-ok)] font-medium">
                                {formatSigned(task.linesAdded, { locale, positivePrefix: '+' })}
                              </span>
                            <span className="text-[var(--t-text-3)] mx-1">/</span>
                              <span className="text-[var(--t-crit)] font-medium">
                                {formatSigned(task.linesDeleted ? -task.linesDeleted : 0, { locale, negativePrefix: '−' })}
                              </span>
                            </span>
                          )}
                        </td>
                        <td className="px-6 py-3.5 text-right font-mono tabular-nums font-medium whitespace-nowrap">
                          {task.estimated && (
                            <span
                              title={t('savings.estimatedTitle')}
                              className="text-[var(--t-warn)] mr-1 select-none"
                            >
                              ≈
                            </span>
                          )}
                          <span>{formatNumber(task.tokens)}</span>
                        </td>
                        <td className="px-6 py-3.5 text-center font-mono tabular-nums whitespace-nowrap">
                          {task.reviewRounds > 0 ? (
                            <span className="px-1.5 py-0.5 rounded bg-[var(--t-warn-bg)] text-[var(--t-warn)] font-semibold text-[11px]">
                              {task.reviewRounds}
                            </span>
                          ) : (
                            <span className="text-[var(--t-text-2)]">0</span>
                          )}
                        </td>
                        <td className="px-6 py-3.5 text-center whitespace-nowrap">
                          <span className={task.claudeCostSource === 'measured' ? 'text-[var(--t-ok)]' : 'text-[var(--t-warn)]'}>
                            {task.claudeCostSource === 'measured' ? 'measured' : 'estimated'}
                          </span>
                          {task.claudeEffectiveTokens ? <div className="text-[11px] font-mono text-[var(--t-text-2)]">{formatNumber(task.claudeEffectiveTokens)}</div> : null}
                        </td>
                        <td className="px-6 py-3.5 text-right font-mono tabular-nums text-[var(--t-text-2)] whitespace-nowrap">
                          {formatDuration(task.durationMs)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <Pagination page={taskPage} pageSize={taskPageSize} total={savings?.tasksTotal || 0} onPageChange={setTaskPage} />
          </div>

          {/* Explanation Callout */}
          <div className="p-4 rounded-xl bg-[var(--t-info-bg)] border border-[var(--t-info)]/30 text-xs text-[var(--t-info)] flex items-start gap-3">
            <Info className="w-5 h-5 text-[var(--t-info)] shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-semibold">{t('savings.methodTitle')}</p>
              <p className="text-[var(--t-text-2)] leading-relaxed">
                {t('savings.methodDesc')}
                {t('savings.factorsPrefix')} (<code>bucketTokens</code>, <code>claudeFactor</code>, <code>claudeOverheadPerTask</code>) {t('savings.factorsSuffix')}{' '}
                <Link to="/settings" className="font-semibold underline hover:text-[var(--t-info)]">
                  {t('common.settings')}
                </Link>.
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
