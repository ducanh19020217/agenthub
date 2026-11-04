import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { getProjects, getStatus, getTaskGraph, getTasks, getTasksPage, resumeTask } from '../api/client';
import { StatusBadge } from '../components/StatusBadge';
import { KANBAN_STATUSES } from '../utils/tasks';
import { Task } from '../types/api';
import { Plus, Filter, ArrowUpRight, Zap, Flame, LayoutGrid, Network, List, FolderKanban, Play } from 'lucide-react';
import { SilentRunIndicator } from '../components/SilentRunIndicator';
import { useLocale } from '../context/LocaleContext';
import { TaskDag } from '../components/dag';
import { filterTasksForDag } from '../components/dag/dagUtils';
import { DataTable } from '../components/ui';
import { useShowMore } from '../components/CollapsibleList';

export interface KanbanColumnProps {
  statusKey: (typeof KANBAN_STATUSES)[number];
  project: string;
  search: string;
}

const KanbanColumnComponent: React.FC<KanbanColumnProps> = ({ statusKey, project, search }) => {
  const { t } = useLocale();
  const queryClient = useQueryClient();
  const resumeMutation = useMutation({
    mutationFn: (id: string) => resumeTask(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks-kanban'] });
      queryClient.invalidateQueries({ queryKey: ['status'] });
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
  // Dùng chung cache ['status'] giữa các cột, chỉ để hiện dung lượng đĩa trong nhãn "Chờ ổ đĩa".
  const { data: hubStatus } = useQuery({
    queryKey: ['status'],
    queryFn: getStatus,
    refetchInterval: 10_000,
  });

  const pageSize = statusKey === 'done' || statusKey === 'cancelled' ? 10 : 20;
  const { data, isLoading } = useQuery({
    queryKey: ['tasks-kanban', project, statusKey, search, pageSize],
    queryFn: () => getTasksPage({ project, status: statusKey, search, limit: pageSize, sort: 'createdAt', order: 'desc' }),
    // Columns are cursor-paged. Polling page one would discard loaded pages
    // and make cards move unexpectedly; SSE invalidation refreshes this view.
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
  const [visibleItems, setVisibleItems] = useState<Task[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  useEffect(() => {
    setVisibleItems(data?.items || []);
    setNextCursor(data?.nextCursor || null);
  }, [data]);
  const showMore = async () => {
    if (!nextCursor || isLoadingMore) return;
    setIsLoadingMore(true);
    try {
      const next = await getTasksPage({ project, status: statusKey, search, limit: pageSize, cursor: nextCursor, sort: 'createdAt', order: 'desc' });
      setVisibleItems((current) => [...current, ...next.items]);
      setNextCursor(next.nextCursor);
    } finally {
      setIsLoadingMore(false);
    }
  };
  const remaining = Math.max(0, (data?.total || 0) - visibleItems.length);
  const nextStep = Math.min(pageSize, remaining);

  return (
    <div
      data-testid={`kanban-column-${statusKey}`}
      style={{
        borderColor: 'var(--t-border)',
      }}
      className="relative flex flex-col rounded-xl border bg-[var(--t-surface-2)] p-3 min-h-[420px] transition-colors overflow-hidden"
    >
      <div
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-[3px]"
        style={{
          backgroundColor: `var(--status-${statusKey}-color, var(--t-accent))`,
        }}
      />

      {/* Column Header */}
      <div className="flex items-center justify-between px-1 py-1.5 mb-3">
        <div className="flex items-center gap-2">
          <StatusBadge status={statusKey} size="sm" />
        </div>
        <span className="text-xs font-bold font-mono px-2 py-0.5 rounded-full bg-[var(--t-surface)] border border-[var(--t-border)] text-[var(--t-text)]">
          {data?.total || 0}
        </span>
      </div>

      {/* Cards List */}
      <div className="space-y-2.5 flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="h-24 flex items-center justify-center text-xs text-[var(--t-text-3)]">{t('pagination.loading')}</div>
        ) : visibleItems.length === 0 ? (
          <div className="h-24 border border-dashed border-[var(--t-border)] rounded-lg flex items-center justify-center text-xs text-[var(--t-text-3)] italic">
            {t('common.empty')}
          </div>
        ) : (
          visibleItems.map((task) => (
            <Link
              key={task.id}
              to={`/tasks/${encodeURIComponent(task.id.replace('/', '~'))}`}
              className="block bg-[var(--t-surface)] p-3.5 rounded-lg border border-[var(--t-border)] shadow-xs hover:border-[var(--t-accent)] hover:shadow-sm transition-all group"
            >
              <div className="flex items-start justify-between gap-2 mb-1.5">
                <span className="text-xs font-mono text-[var(--t-text-2)] font-medium">
                  {task.slug}
                </span>
                {task.checks && task.checks.length > 0 && (
                  <span
                    title={
                      task.checks.every((check) => check.ok)
                        ? t('extra.checkPassed')
                        : t('extra.checkFailed')
                    }
                    className={
                      task.checks.every((check) => check.ok)
                        ? 'text-[var(--t-ok)]'
                        : 'text-[var(--t-crit)]'
                    }
                  >
                    {task.checks.every((check) => check.ok) ? '✓' : '✗'}
                  </span>
                )}
                <ArrowUpRight className="w-3.5 h-3.5 text-[var(--t-text-3)] group-hover:text-[var(--t-accent)] transition-colors" />
              </div>

              <h3 className="text-sm font-semibold text-[var(--t-text)] line-clamp-2 mb-2.5">
                {task.title}
              </h3>

              {task.reviewerEscalated ? (
                <span className="inline-flex mb-2 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-[color-mix(in_srgb,var(--t-warn)_15%,transparent)] text-[var(--t-warn)]">
                  {t('extra.waitingApprover')}
                </span>
              ) : null}
              {task.status === 'review' ? (
                <span data-testid={`task-review-round-${task.id}`} className="inline-flex mb-2 text-[11px] font-medium text-[var(--t-text-2)]">
                  {t('extra.reviewRound', { current: task.reviewRound ?? 1, max: task.reviewMaxRounds ?? 2 })}
                </span>
              ) : null}

              {task.waitReason && (
                <div className="mb-2">
                  <StatusBadge
                    status={task.status}
                    waitReason={task.waitReason}
                    blockingDisk={task.blockingDisk}
                    diskFreeGB={task.blockingDisk?.freeGB ?? hubStatus?.disk?.freeGB}
                    diskMinFreeGB={task.blockingDisk?.minFreeGB ?? hubStatus?.disk?.minFreeGB}
                    diskLabel={task.blockingDisk?.label}
                    projectId={task.projectId}
                    size="sm"
                  />
                </div>
              )}

              {task.status === 'running' && (
                <div className="flex items-center gap-1.5 flex-wrap mb-2">
                  {(task.paused || task.currentRun?.paused) ? (
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span
                        data-testid={`task-paused-badge-${task.id}`}
                        className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-semibold border ${
                          (task.pauseReason === 'load' || task.pauseReason === 'brain_load' || task.currentRun?.pauseReason === 'load' || task.currentRun?.pauseReason === 'brain_load')
                            ? 'bg-[color-mix(in_srgb,var(--t-warn)_15%,transparent)] text-[var(--t-warn)] border-[color-mix(in_srgb,var(--t-warn)_30%,transparent)]'
                            : 'bg-[var(--t-surface-2)] text-[var(--t-text-2)] border-[var(--t-border)]'
                        }`}
                      >
                        {(task.pauseReason === 'load' || task.pauseReason === 'brain_load' || task.currentRun?.pauseReason === 'load' || task.currentRun?.pauseReason === 'brain_load')
                          ? t('status.pausedOverload')
                          : (task.pauseReason === 'focus' || task.currentRun?.pauseReason === 'focus')
                            ? t('status.pausedFocus')
                            : t('status.pausedManual')}
                      </span>
                      <button
                        type="button"
                        data-testid={`task-resume-btn-${task.id}`}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          resumeMutation.mutate(task.id);
                        }}
                        disabled={resumeMutation.isPending}
                        title={t('common.resume')}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold bg-[color-mix(in_srgb,var(--t-ok)_15%,transparent)] hover:bg-[color-mix(in_srgb,var(--t-ok)_25%,transparent)] text-[var(--t-on-accent)] border border-[color-mix(in_srgb,var(--t-ok)_30%,transparent)] shadow-2xs cursor-pointer transition-colors"
                      >
                        <Play className="w-3 h-3 fill-current" />
                        <span>{t('common.resume')}</span>
                      </button>
                    </div>
                  ) : (
                    <SilentRunIndicator lastActivityAt={task.currentRun?.lastActivityAt} paused={Boolean(task.paused || task.currentRun?.paused)} />
                  )}
                  {task.currentRun?.noCommitMinutes != null && task.currentRun.noCommitMinutes > 0 && (
                    <span className="inline-flex items-center rounded bg-[color-mix(in_srgb,var(--t-warn)_15%,transparent)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--t-warn)] border border-[color-mix(in_srgb,var(--t-warn)_30%,transparent)]">
                      {t('extra.noCommit', { minutes: task.currentRun.noCommitMinutes })}
                    </span>
                  )}
                  {task.currentRun?.isLooping && (
                    <span className="inline-flex items-center rounded bg-[color-mix(in_srgb,var(--t-crit)_15%,transparent)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--t-crit)] border border-[color-mix(in_srgb,var(--t-crit)_30%,transparent)]">
                      {t('extra.looping')}
                    </span>
                  )}
                </div>
              )}

              <div className="flex items-center justify-between gap-2 pt-2 border-t border-[var(--t-border)] text-[11px]">
                <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-[var(--t-surface-2)] font-medium text-[var(--t-text-2)] border border-[var(--t-border)]">
                  {task.projectId}
                </span>

                <div className="flex items-center gap-1.5">
                  {task.level === 'hard' ? (
                    <span className="inline-flex items-center gap-0.5 text-[var(--t-purple)] font-medium">
                      <Flame className="w-3 h-3" /> {t('common.hard')}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-0.5 text-[var(--t-ok)] font-medium">
                      <Zap className="w-3 h-3" /> {t('common.easy')}
                    </span>
                  )}

                  {task.attempt > 0 && (
                    <span className="font-mono text-[var(--t-text-3)]">#{task.attempt}</span>
                  )}
                </div>
              </div>
            </Link>
          ))
        )}

        {nextCursor && (
          <div className="flex items-center justify-center gap-3 pt-2">
            <button type="button" onClick={() => void showMore()} disabled={isLoadingMore} className="text-xs font-medium text-[var(--t-accent)] hover:underline cursor-pointer disabled:opacity-50">
              {isLoadingMore ? t('pagination.loading') : `${t('tasks.showMore')} ${nextStep} (${t('tasks.remaining', { count: remaining })})`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export const KanbanColumn = memo(KanbanColumnComponent);

const ProjectTaskGroup: React.FC<{ project: { id: string; name: string }; tasks: Task[] }> = ({ project, tasks }) => {
  const { t } = useLocale();
  const visible = useShowMore(tasks, 20, 20, `agenthub:tasks:project:${project.id}`);
  return (
    <section className="rounded-xl border border-[var(--t-border)] bg-[var(--t-surface-2)] overflow-hidden">
      <div className="flex items-center gap-2 p-3 sm:p-4">
        <FolderKanban className="h-4 w-4 text-[var(--t-accent)]" />
        <span className="font-semibold text-[var(--t-text)]">{project.name}</span>
      </div>
      <div className="border-t border-[var(--t-border)] p-3 sm:p-4">
        {visible.visibleItems.length > 0 ? <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">{visible.visibleItems.map((task) => (
          <div key={task.id} className="rounded-lg border border-[var(--t-border)] bg-[var(--t-surface)] p-3 hover:border-[var(--t-accent)] transition-colors flex flex-col justify-between">
            <Link to={`/tasks/${encodeURIComponent(task.id.replace('/', '~'))}`} className="block">
              <div className="text-xs font-mono text-[var(--t-text-2)] truncate">{task.slug}</div>
              <div className="mt-1 text-sm font-semibold text-[var(--t-text)] line-clamp-2">{task.title}</div>
            </Link>
            {task.externalRef && (
              <a href={task.externalRef} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs text-[var(--t-accent)] hover:underline" data-testid="openproject-ticket-link">
                {task.externalRef}
              </a>
            )}
            <div className="mt-2">
              <StatusBadge
                status={task.status}
                waitReason={task.waitReason}
                blockingDisk={task.blockingDisk}
                diskFreeGB={task.blockingDisk?.freeGB}
                diskMinFreeGB={task.blockingDisk?.minFreeGB}
                diskLabel={task.blockingDisk?.label}
                projectId={task.projectId}
                size="sm"
              />
            </div>
          </div>
        ))}</div> : <div className="rounded-lg border border-dashed border-[var(--t-border)] p-5 text-center text-xs italic text-[var(--t-text-3)]">{t('common.empty')}</div>}
        {visible.hasMore && <button type="button" onClick={visible.showMore} className="mt-3 text-xs font-medium text-[var(--t-accent)] hover:underline">{t('tasks.showMore')}</button>}
      </div>
    </section>
  );
};

export const TasksPage: React.FC = () => {
  const { t } = useLocale();
  const navigate = useNavigate();
  const [urlParams, setUrlParams] = useSearchParams();
  const [viewMode, setViewMode] = useState<'kanban' | 'dag' | 'list' | 'project'>((urlParams.get('view') as 'kanban' | 'dag' | 'list' | 'project') || 'kanban');
  const [selectedProject, setSelectedProject] = useState<string>(urlParams.get('project') || 'all');
  const [selectedStatus, setSelectedStatus] = useState<string>(urlParams.get('status') || 'all');
  const [doneFilter, setDoneFilter] = useState<'active_chains' | '1d' | '3d' | '7d' | '30d' | 'all'>('active_chains');
  const [search, setSearch] = useState<string>(urlParams.get('search') || '');
  const [page, setPage] = useState(Number(urlParams.get('page') || 1));
  const [pageSize, setPageSize] = useState(Number(urlParams.get('pageSize') || 20));
  const [sortKey, setSortKey] = useState<'createdAt' | 'updatedAt' | 'title' | 'slug'>((urlParams.get('sort') as 'createdAt' | 'updatedAt' | 'title' | 'slug') || 'createdAt');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>((urlParams.get('order') as 'asc' | 'desc') || 'desc');
  const [cursors, setCursors] = useState<Record<number, string | undefined>>({});
  const cursor = cursors[page - 1];

  const { data: projects = [] } = useQuery({
    queryKey: ['projects'],
    queryFn: getProjects,
  });
  const { data: projectTasks = [] } = useQuery({
    queryKey: ['tasks-project-view'],
    queryFn: getTasks,
    enabled: viewMode === 'project',
  });

  const { data, isLoading: isPageLoading } = useQuery({
    queryKey: ['tasks', selectedProject, selectedStatus, search, page, pageSize, cursor, sortKey, sortDirection],
    queryFn: () => getTasksPage({ project: selectedProject, status: selectedStatus, search, limit: pageSize, cursor, offset: cursor ? undefined : (page - 1) * pageSize, sort: sortKey, order: sortDirection }),
    enabled: viewMode === 'list',
    refetchInterval: 5000,
    placeholderData: keepPreviousData,
  });
  const { data: taskGraph, isLoading: isGraphLoading } = useQuery({
    queryKey: ['tasks-graph', selectedProject, doneFilter],
    queryFn: () => getTaskGraph({ project: selectedProject, includeDone: doneFilter === 'all' }),
    enabled: viewMode === 'dag',
    refetchInterval: 5000,
    placeholderData: keepPreviousData,
  });
  const initialFilters = useRef(true);
  useEffect(() => {
    if (data?.nextCursor) setCursors((current) => ({ ...current, [page]: data.nextCursor || undefined }));
  }, [data?.nextCursor, page]);
  useEffect(() => {
    const next = new URLSearchParams(urlParams);
    const values: Record<string, string> = { project: selectedProject, status: selectedStatus, search, page: String(page), pageSize: String(pageSize), view: viewMode, sort: sortKey, order: sortDirection };
    for (const [key, value] of Object.entries(values)) {
      if (value && value !== 'all' && value !== '1' && !(key === 'pageSize' && value === '20') && !(key === 'view' && value === 'kanban')) next.set(key, value);
      else next.delete(key);
    }
    if (next.toString() !== urlParams.toString()) setUrlParams(next, { replace: true });
  }, [selectedProject, selectedStatus, search, page, pageSize, viewMode, sortKey, sortDirection, setUrlParams, urlParams]);
  useEffect(() => {
    if (initialFilters.current) {
      initialFilters.current = false;
      return;
    }
    setPage(1);
    setCursors({});
  }, [selectedProject, search, selectedStatus, pageSize]);
  const graphTasks = useMemo<Task[]>(() => {
    if (!taskGraph) return [];
    const dependencies = new Map<string, string[]>();
    for (const edge of taskGraph.edges) dependencies.set(edge.to, [...(dependencies.get(edge.to) || []), edge.from]);
    return taskGraph.nodes.map((node) => ({
      ...node,
      dependsOn: dependencies.get(node.id) || [],
      currentRun: null,
      attempt: 0,
      resume: 0,
      createdAt: '',
      updatedAt: '',
    }));
  }, [taskGraph]);
  const tasks = graphTasks;

  const dagTasks = useMemo(() => {
    return filterTasksForDag(tasks, {
      project: selectedProject,
      status: selectedStatus,
      doneFilter,
    });
  }, [tasks, search, selectedProject, selectedStatus, doneFilter]);

  return (
    <div className="space-y-6" data-tour="task-lifecycle">
      {/* Top Bar: Filter & New Task Button */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4" data-tour="task-filters">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-[var(--t-text)]">
            {t('tasks.title')}
          </h1>
          <p className="text-sm text-[var(--t-text-2)]">{t('tasks.subtitle')}</p>
        </div>

        <div className="flex items-center gap-3 flex-wrap sm:flex-nowrap">
          {/* View Mode Toggle: Kanban <-> Sơ đồ (DAG) */}
          <div className="flex items-center bg-[var(--t-surface)] border border-[var(--t-border)] rounded-lg p-0.5 shadow-xs" data-tour="task-views">
            <button
              type="button"
              onClick={() => setViewMode('kanban')}
              data-testid="view-toggle-kanban"
              aria-label={t('dag.toggleKanban')}
              title={t('dag.toggleKanban')}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium cursor-pointer transition-colors ${
                viewMode === 'kanban'
                  ? 'bg-[var(--t-accent)] text-[var(--t-on-accent)] shadow-xs font-semibold'
                  : 'text-[var(--t-text-2)] hover:text-[var(--t-text)]'
              }`}
            >
              <LayoutGrid className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{t('dag.toggleKanban')}</span>
            </button>
            <button type="button" onClick={() => setViewMode('project')} data-testid="view-toggle-project" aria-label={t('tasks.projectView')} title={t('tasks.projectView')} className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium cursor-pointer transition-colors ${viewMode === 'project' ? 'bg-[var(--t-accent)] text-[var(--t-on-accent)] shadow-xs font-semibold' : 'text-[var(--t-text-2)] hover:text-[var(--t-text)]'}`}>
              <FolderKanban className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{t('tasks.projectView')}</span>
            </button>
            <button
              type="button"
              onClick={() => setViewMode('list')}
              data-testid="view-toggle-list"
              aria-label={t('tasks.listView')}
              title={t('tasks.listView')}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium cursor-pointer transition-colors ${viewMode === 'list' ? 'bg-[var(--t-accent)] text-[var(--t-on-accent)] shadow-xs font-semibold' : 'text-[var(--t-text-2)] hover:text-[var(--t-text)]'}`}
            >
              <List className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{t('tasks.listView')}</span>
            </button>
            <button
              type="button"
              onClick={() => setViewMode('dag')}
              data-testid="view-toggle-dag"
              aria-label={t('dag.toggleDag')}
              title={t('dag.toggleDag')}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium cursor-pointer transition-colors ${
                viewMode === 'dag'
                  ? 'bg-[var(--t-accent)] text-[var(--t-on-accent)] shadow-xs font-semibold'
                  : 'text-[var(--t-text-2)] hover:text-[var(--t-text)]'
              }`}
            >
              <Network className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{t('dag.toggleDag')}</span>
            </button>
          </div>

          {/* Quick Filter (Slug / Title) */}
          <div className="flex items-center gap-2 bg-[var(--t-surface)] border border-[var(--t-border)] rounded-lg px-3 py-1.5 shadow-xs">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('tasks.filterQuick')}
              aria-label={t('tasks.filterQuick')}
              className="text-xs font-medium bg-transparent border-none text-[var(--t-text)] placeholder-[var(--t-text-3)] focus:outline-none w-36 sm:w-48"
            />
          </div>

          {/* Project Filter */}
          <div className="flex items-center gap-2 bg-[var(--t-surface)] border border-[var(--t-border)] rounded-lg px-3 py-1.5 shadow-xs">
            <Filter className="w-4 h-4 text-[var(--t-text-2)]" />
            <select
              value={selectedProject}
              onChange={(e) => setSelectedProject(e.target.value)}
              aria-label={t('tasks.filterProject')}
              className="text-xs font-medium bg-transparent border-none text-[var(--t-text)] focus:outline-none cursor-pointer"
            >
              <option value="all" className="bg-[var(--t-surface)] text-[var(--t-text)]">
                {t('tasks.allProjects')}
              </option>
              {projects.map((p) => (
                <option
                  key={p.id}
                  value={p.id}
                  className="bg-[var(--t-surface)] text-[var(--t-text)]"
                >
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          {/* DAG-specific filters (Status & Done cutoff) */}
          {viewMode !== 'kanban' && viewMode !== 'project' && (
            <>
              {/* Status Filter */}
              <div className="flex items-center gap-2 bg-[var(--t-surface)] border border-[var(--t-border)] rounded-lg px-3 py-1.5 shadow-xs">
                <select
                  value={selectedStatus}
                  onChange={(e) => setSelectedStatus(e.target.value)}
                  aria-label={t('dag.filterStatus')}
                  className="text-xs font-medium bg-transparent border-none text-[var(--t-text)] focus:outline-none cursor-pointer"
                >
                  <option value="all" className="bg-[var(--t-surface)] text-[var(--t-text)]">
                    {t('dag.allStatuses')}
                  </option>
                  {KANBAN_STATUSES.map((st) => (
                    <option
                      key={st}
                      value={st}
                      className="bg-[var(--t-surface)] text-[var(--t-text)]"
                    >
                      {t(`status.${st}`)}
                    </option>
                  ))}
                </select>
              </div>

              {/* Done tasks filter */}
              <div className="flex items-center gap-2 bg-[var(--t-surface)] border border-[var(--t-border)] rounded-lg px-3 py-1.5 shadow-xs">
                <select
                  value={doneFilter}
                  onChange={(e) => setDoneFilter(e.target.value as any)}
                  aria-label={t('dag.hideDone')}
                  className="text-xs font-medium bg-transparent border-none text-[var(--t-text)] focus:outline-none cursor-pointer"
                >
                  <option value="active_chains" className="bg-[var(--t-surface)] text-[var(--t-text)]">
                    {t('dag.activeChains')}
                  </option>
                  <option value="1d" className="bg-[var(--t-surface)] text-[var(--t-text)]">
                    {t('dag.done1d')}
                  </option>
                  <option value="3d" className="bg-[var(--t-surface)] text-[var(--t-text)]">
                    {t('dag.done3d')}
                  </option>
                  <option value="7d" className="bg-[var(--t-surface)] text-[var(--t-text)]">
                    {t('dag.done7d')}
                  </option>
                  <option value="30d" className="bg-[var(--t-surface)] text-[var(--t-text)]">
                    {t('dag.done30d')}
                  </option>
                  <option value="all" className="bg-[var(--t-surface)] text-[var(--t-text)]">
                    {t('dag.doneAll')}
                  </option>
                </select>
              </div>
            </>
          )}

          {/* New Task Button */}
          <button
            type="button"
            onClick={() => navigate('/tasks/new')}
            data-tour="task-actions"
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[var(--t-accent)] hover:bg-[var(--t-accent-hover)] text-[var(--t-on-accent)] text-xs font-semibold shadow-xs cursor-pointer transition-colors shrink-0"
          >
            <Plus className="w-4 h-4" />
            <span>{t('tasks.createTask')}</span>
          </button>
        </div>
      </div>

      {viewMode === 'project' ? (
        <div className="space-y-4 pb-8" data-testid="project-view-wrapper">
          {projects.map((project) => <ProjectTaskGroup key={project.id} project={project} tasks={projectTasks.filter((task) => task.projectId === project.id)} />)}
        </div>
      ) : viewMode === 'list' ? (
        <DataTable
          rows={data?.items || []}
          loading={isPageLoading}
          columns={[
            { key: 'slug', title: t('tasks.slug'), sortable: true, sortValue: (task) => task.slug, render: (task) => <Link className="font-mono text-[var(--t-accent)] hover:underline" to={`/tasks/${encodeURIComponent(task.id.replace('/', '~'))}`}>{task.slug}</Link> },
            { key: 'title', title: t('tasks.title'), sortable: true, sortValue: (task) => task.title, render: (task) => (
              <div>
                <span className="truncate block" title={task.title}>{task.title}</span>
                {task.externalRef && (
                  <a href={task.externalRef} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-[var(--t-accent)] hover:underline" data-testid="openproject-ticket-link">
                    {task.externalRef}
                  </a>
                )}
              </div>
            ) },
            {
              key: 'status',
              title: t('tasks.status'),
              render: (task) => (
                <StatusBadge
                  status={task.status}
                  waitReason={task.waitReason}
                  blockingDisk={task.blockingDisk}
                  diskFreeGB={task.blockingDisk?.freeGB}
                  diskMinFreeGB={task.blockingDisk?.minFreeGB}
                  diskLabel={task.blockingDisk?.label}
                  projectId={task.projectId}
                  size="sm"
                />
              ),
            },
            { key: 'project', title: t('tasks.project'), render: (task) => <span>{task.projectId}</span> },
          ]}
          page={page}
          pageSize={pageSize}
          total={data?.total ?? 0}
          onPageChange={setPage}
          onPageSizeChange={(size) => { setPageSize(size); setPage(1); setCursors({}); }}
          sortKey={sortKey}
          sortDirection={sortDirection}
          onSortChange={(key, direction) => { setSortKey(key as typeof sortKey); setSortDirection(direction); setPage(1); setCursors({}); }}
        />
      ) : viewMode === 'dag' && isGraphLoading ? (
        <div className="flex items-center justify-center min-h-[40vh]">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--t-accent)]" />
        </div>
      ) : viewMode === 'dag' ? (
        <div data-testid="dag-view-wrapper" className="pb-8">
          <TaskDag tasks={dagTasks} />
        </div>
      ) : (
        /* Kanban Board Grid */
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 pb-8" data-tour="task-columns">
          {KANBAN_STATUSES.map((statusKey) => (
            <KanbanColumn
              key={`${statusKey}-${selectedProject}-${search}`}
              statusKey={statusKey}
              project={selectedProject}
              search={search}
            />
          ))}
        </div>
      )}
    </div>
  );
};
