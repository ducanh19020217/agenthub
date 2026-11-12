import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  ArrowUpRight,
  CircleCheck,
  CircleX,
  Clock,
  FilePen,
  Flame,
  FlaskConical,
  Hourglass,
  OctagonAlert,
  Play,
  Rocket,
  ScanEye,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { getProjects, getTasksPage, type PageResponse } from '../api/client';
import { useLocale } from '../context/LocaleContext';
import type { Task, TaskStatus } from '../types/api';
import { StatusBadge } from './StatusBadge';
import { Modal } from './ui';
import { ProjectTag } from './ProjectTag';
import { useProjectColor } from '../utils/projectColor';
import { formatDateTime, formatStatusTimeLabel } from '../lib/time';

/** Sơ đồ quy trình: mỗi node là một trạng thái task, bấm vào để xem danh sách task. */

export const FLOW_ACTIVE_REFETCH_INTERVAL = 5_000;
export const FLOW_IDLE_REFETCH_INTERVAL = 30_000;
export const ACTIVE_STATUSES: readonly TaskStatus[] = ['running', 'checking', 'review'] as const;

export function getFlowRefetchInterval(activeCount: number): number {
  return activeCount > 0 ? FLOW_ACTIVE_REFETCH_INTERVAL : FLOW_IDLE_REFETCH_INTERVAL;
}

const EDGE_STYLE = { stroke: 'var(--t-text-3)', strokeOpacity: 0.6 } as const;

const STATUS_ICON: Record<TaskStatus, LucideIcon> = {
  draft: FilePen,
  queued: Clock,
  running: Play,
  checking: FlaskConical,
  waiting_quota: Hourglass,
  review: ScanEye,
  blocked: OctagonAlert,
  failed: CircleX,
  done: CircleCheck,
  pushed: Rocket,
  cancelled: CircleX,
};

interface FlowNodeDef {
  status: TaskStatus;
  col: number;
  row: number;
  gridClass: string;
}

const NODE_DEFS: FlowNodeDef[] = [
  // Hàng chính (row 1): 7 cột
  { status: 'draft', col: 0, row: 1, gridClass: 'col-start-1 row-start-1' },
  { status: 'queued', col: 1, row: 1, gridClass: 'col-start-2 row-start-1' },
  { status: 'running', col: 2, row: 1, gridClass: 'col-start-3 row-start-1' },
  { status: 'checking', col: 3, row: 1, gridClass: 'col-start-4 row-start-1' },
  { status: 'review', col: 4, row: 1, gridClass: 'col-start-5 row-start-1' },
  { status: 'done', col: 5, row: 1, gridClass: 'col-start-6 row-start-1' },
  { status: 'pushed', col: 6, row: 1, gridClass: 'col-start-7 row-start-1' },
  // Hàng nhánh lỗi (row 2): dưới running, checking, review
  { status: 'waiting_quota', col: 2, row: 2, gridClass: 'col-start-3 row-start-2' },
  { status: 'failed', col: 3, row: 2, gridClass: 'col-start-4 row-start-2' },
  { status: 'blocked', col: 4, row: 2, gridClass: 'col-start-5 row-start-2' },
];

export const FLOW_STATUSES: readonly TaskStatus[] = NODE_DEFS.map((node) => node.status);
export const MAX_RUNNING_PREVIEW = 3;

const statusColor = (status: TaskStatus) => `var(--status-${status}-color, var(--t-accent))`;
const taskHref = (task: Task) => `/tasks/${encodeURIComponent(task.id.replace('/', '~'))}`;

interface NodeRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const getFallbackBox = (status: TaskStatus): NodeRect => {
  const def = NODE_DEFS.find((n) => n.status === status) || NODE_DEFS[0];
  const colW = 160;
  const gapX = 32;
  const x = 24 + def.col * (colW + gapX);
  const y = def.row === 1 ? 52 : 240;
  return { x, y, w: colW, h: 88 };
};

export function useStatusTotal(
  project: string,
  status: TaskStatus,
  search: string,
  refetchInterval?: number,
) {
  const queryClient = useQueryClient();
  const getInterval = () => {
    if (refetchInterval !== undefined) return refetchInterval;
    let count = 0;
    for (const s of ACTIVE_STATUSES) {
      const cached = queryClient.getQueryData<PageResponse<Task>>(['tasks-kanban', 'flow-count', project, s, search]);
      if (cached?.total) count += cached.total;
    }
    return getFlowRefetchInterval(count);
  };

  return useQuery({
    // Đặt dưới 'tasks-kanban' để SSE làm mới cùng lúc với Kanban.
    queryKey: ['tasks-kanban', 'flow-count', project, status, search],
    queryFn: () => getTasksPage({ project, status, search, limit: 1, sort: 'createdAt', order: 'desc' }),
    refetchInterval: refetchInterval !== undefined ? refetchInterval : getInterval,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });
}

const FlowNodeCard: React.FC<{
  node: FlowNodeDef;
  project: string;
  search: string;
  onOpen: (status: TaskStatus) => void;
  total?: number;
  isLoading?: boolean;
  refetchInterval?: number;
  registerRef: (status: TaskStatus, el: HTMLDivElement | null) => void;
}> = ({ node, project, search, onOpen, total: propTotal, isLoading: propIsLoading, refetchInterval, registerRef }) => {
  const { t } = useLocale();
  const query = useStatusTotal(project, node.status, search, refetchInterval);
  const total = propTotal !== undefined ? propTotal : (query.data?.total ?? 0);
  const isLoading = propIsLoading !== undefined ? propIsLoading : query.isLoading;
  const color = statusColor(node.status);
  const label = t(`status.${node.status}`);
  const hasTasks = total > 0;
  const isNodeActive = (node.status === 'running' || node.status === 'checking' || node.status === 'review') && hasTasks;
  const Icon = STATUS_ICON[node.status];
  const open = () => onOpen(node.status);

  // Count bounce effect on change between fetches
  const isInitialLoadRef = useRef(true);
  const prevTotalRef = useRef<number | null>(null);
  const [isBouncing, setIsBouncing] = useState(false);

  useEffect(() => {
    if (isLoading) return;

    if (isInitialLoadRef.current) {
      isInitialLoadRef.current = false;
      prevTotalRef.current = total;
      return;
    }

    if (prevTotalRef.current !== null && prevTotalRef.current !== total) {
      setIsBouncing(true);
      const timer = setTimeout(() => setIsBouncing(false), 400);
      prevTotalRef.current = total;
      return () => clearTimeout(timer);
    }
    prevTotalRef.current = total;
  }, [total, isLoading]);

  // Details of running tasks inside the 'running' node
  const isRunning = node.status === 'running';
  const showRunningDetails = isRunning && hasTasks;

  const { data: runningData } = useQuery({
    queryKey: ['tasks-kanban', 'flow-running-tasks', project, search],
    queryFn: () => getTasksPage({ project, status: 'running', search, limit: MAX_RUNNING_PREVIEW, sort: 'createdAt', order: 'desc' }),
    enabled: showRunningDetails,
    refetchInterval: refetchInterval ?? FLOW_ACTIVE_REFETCH_INTERVAL,
    refetchIntervalInBackground: false,
  });

  const { data: projects = [] } = useQuery({
    queryKey: ['projects'],
    queryFn: getProjects,
    enabled: showRunningDetails,
  });

  const runningTasks = runningData?.items ?? [];
  const getProjectName = (pId: string) => projects.find((p) => p.id === pId)?.name || pId;

  return (
    <div
      ref={(el) => registerRef(node.status, el)}
      role="button"
      tabIndex={0}
      data-testid={`flow-node-${node.status}`}
      data-count={isLoading ? '' : String(total)}
      data-active={isNodeActive ? 'true' : undefined}
      aria-label={t('tasks.flow.nodeAria', { status: label, count: String(total) })}
      onClick={open}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          open();
        }
      }}
      style={{
        '--node-color': color,
        borderColor: isNodeActive ? color : hasTasks ? `color-mix(in srgb, ${color} 65%, var(--t-border))` : 'var(--t-border)',
        backgroundColor: `color-mix(in srgb, ${color} ${hasTasks ? 12 : 4}%, var(--t-surface-2))`,
      } as React.CSSProperties}
      className={`group relative flex flex-col justify-between self-start rounded-2xl border p-3.5 transition-all duration-150 outline-hidden select-none cursor-pointer focus-visible:ring-2 focus-visible:ring-[var(--t-accent)] ${
        isNodeActive
          ? 'flow-node-pulse border-2 shadow-sm'
          : hasTasks
            ? 'border-2 hover:border-[var(--t-accent)] shadow-xs'
            : 'hover:border-[var(--t-border-hover)]'
      } ${node.gridClass}`}
    >
      {/* Top Section: Icon + Label & Count */}
      <div className="flex items-start gap-3">
        {/* Icon wrapper (animation class placed on span wrapper, NOT on SVG) */}
        <div
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl"
          style={{
            backgroundColor: `color-mix(in srgb, ${color} ${hasTasks ? 28 : 14}%, transparent)`,
          }}
        >
          <span
            className={isNodeActive ? `flow-icon-${node.status}` : undefined}
            style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <Icon className="h-5 w-5" strokeWidth={2.2} style={{ color }} aria-hidden="true" />
          </span>
        </div>

        {/* Label & Count */}
        <div className="min-w-0 flex-1">
          <div
            className="truncate text-[15px] font-semibold"
            style={{ color: hasTasks ? 'var(--t-text)' : 'var(--t-text-2)' }}
            title={label}
          >
            {label}
          </div>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span
              className={`inline-block tabular-nums font-mono text-[28px] font-bold leading-none ${isBouncing ? 'flow-count-bounce' : ''}`}
              style={{ color: hasTasks ? color : 'var(--t-text-3)' }}
            >
              {isLoading ? '…' : total}
            </span>
            <span className="text-xs font-normal text-[var(--t-text-3)]">
              {t('tasks.flow.taskUnit')}
            </span>
          </div>
        </div>
      </div>

      {/* Details of running tasks */}
      {showRunningDetails && (
        <div
          data-testid="flow-running-tasks"
          className="mt-3 space-y-1.5 border-t border-[var(--t-border)] pt-2"
        >
          {runningTasks.slice(0, MAX_RUNNING_PREVIEW).map((task) => (
            <div key={task.id} className="flex items-center gap-1.5 min-w-0">
              <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--t-ok)] flow-dot-pulse" />
              <Link
                to={taskHref(task)}
                onClick={(e) => e.stopPropagation()}
                title={`${getProjectName(task.projectId)} · ${task.slug}`}
                className="truncate font-mono text-xs text-[var(--t-text-2)] hover:text-[var(--t-accent)] hover:underline"
              >
                <span className="font-semibold text-[var(--t-text)]">{getProjectName(task.projectId)}</span>
                <span className="text-[var(--t-text-3)]"> · </span>
                <span className="truncate">{task.slug}</span>
              </Link>
            </div>
          ))}
          {runningTasks.length > 0 && (() => {
            const shown = Math.min(runningTasks.length, MAX_RUNNING_PREVIEW);
            return total > shown ? (
              <div className="text-xs font-semibold text-[var(--t-accent)] pl-3.5">
                {t('tasks.flow.runningMore', { count: String(total - shown) })}
              </div>
            ) : null;
          })()}
        </div>
      )}
    </div>
  );
};

const Edge: React.FC<{
  d: string;
  label?: string;
  lx?: number;
  ly?: number;
  dashed?: boolean;
  animated?: boolean;
  anchor?: 'start' | 'middle' | 'end';
}> = ({ d, label, lx, ly, dashed, animated, anchor = 'middle' }) => (
  <g>
    <path
      d={d}
      fill="none"
      strokeWidth={animated ? 2 : 1.75}
      strokeDasharray={animated || dashed ? '6 5' : undefined}
      markerEnd="url(#flow-arrow)"
      style={EDGE_STYLE}
      className={animated ? 'flow-edge-animated' : undefined}
      data-animated={animated ? 'true' : undefined}
    />
    {label && lx !== undefined && ly !== undefined && (
      <text
        x={lx}
        y={ly}
        fontSize={11.5}
        textAnchor={anchor}
        className="select-none fill-[var(--t-text-3)] font-medium"
        style={{
          paintOrder: 'stroke fill',
          stroke: 'var(--t-surface)',
          strokeWidth: 3,
          strokeLinejoin: 'round',
        }}
      >
        {label}
      </text>
    )}
  </g>
);

const FlowEdges: React.FC<{
  counts: Record<TaskStatus, number>;
  getNodeBox: (status: TaskStatus) => NodeRect;
}> = ({ counts, getNodeBox }) => {
  const { t } = useLocale();

  const isStatusActive = (s: TaskStatus) =>
    (s === 'running' || s === 'checking' || s === 'review') && (counts[s] ?? 0) > 0;

  const main: Array<[TaskStatus, TaskStatus]> = [
    ['draft', 'queued'],
    ['queued', 'running'],
    ['running', 'checking'],
    ['checking', 'review'],
    ['review', 'done'],
    ['done', 'pushed'],
  ];

  const down: Array<{ from: TaskStatus; to: TaskStatus; label: string }> = [
    { from: 'running', to: 'waiting_quota', label: t('tasks.flow.edgeQuota') },
    { from: 'checking', to: 'failed', label: t('tasks.flow.edgeFailed') },
    { from: 'review', to: 'blocked', label: t('tasks.flow.edgeBlocked') },
  ];

  const bWaiting = getNodeBox('waiting_quota');
  const bFailed = getNodeBox('failed');
  const bBlocked = getNodeBox('blocked');
  const maxBottom = Math.max(
    bWaiting.y + bWaiting.h,
    bFailed.y + bFailed.h,
    bBlocked.y + bBlocked.h,
  );
  const laneY = maxBottom + 28;

  const bQueued = getNodeBox('queued');
  const queuedX = bQueued.x + bQueued.w / 2;
  const queuedBottom = bQueued.y + bQueued.h + 6;
  const laneStart = bBlocked.x + bBlocked.w / 2 + 24;

  const retryAnimated = (counts.waiting_quota ?? 0) > 0 || (counts.failed ?? 0) > 0 || (counts.blocked ?? 0) > 0;
  const reworkAnimated = (counts.review ?? 0) > 0;

  const bReview = getNodeBox('review');
  const bRunning = getNodeBox('running');
  const reworkStartX = bReview.x + bReview.w / 2;
  const reworkStartY = bReview.y - 2;
  const reworkEndX = bRunning.x + bRunning.w / 2;
  const reworkEndY = bRunning.y - 8;
  const reworkArchY = Math.min(bReview.y, bRunning.y) - 38;

  return (
    <g data-testid="flow-edges">
      {/* 1. Main flow edges */}
      {main.map(([from, to]) => {
        const bFrom = getNodeBox(from);
        const bTo = getNodeBox(to);
        const startX = bFrom.x + bFrom.w + 2;
        const endX = bTo.x - 6;
        const midY = bFrom.y + 28; // Align horizontally with icon center
        const animated = isStatusActive(from) || isStatusActive(to);
        const isDoneToPushed = from === 'done' && to === 'pushed';

        return (
          <g key={`${from}-${to}`}>
            <Edge
              d={`M ${startX} ${midY} L ${endX} ${midY}`}
              animated={animated}
            />
            {isDoneToPushed && (
              <text
                data-testid="flow-merge-label"
                data-placement="above-node"
                x={(startX + endX) / 2}
                y={Math.min(bFrom.y, bTo.y) - 10}
                fontSize={11.5}
                textAnchor="middle"
                className="select-none fill-[var(--t-text-3)] font-medium"
                style={{
                  paintOrder: 'stroke fill',
                  stroke: 'var(--t-surface)',
                  strokeWidth: 3,
                  strokeLinejoin: 'round',
                }}
              >
                {t('tasks.flow.edgeAutoMergePush')}
              </text>
            )}
          </g>
        );
      })}

      {/* 2. Downward branch edges */}
      {down.map(({ from, to, label }) => {
        const bFrom = getNodeBox(from);
        const bTo = getNodeBox(to);
        const startX = bFrom.x + bFrom.w / 2 - 24;
        const startY = bFrom.y + bFrom.h + 2;
        const endX = bTo.x + bTo.w / 2 - 24;
        const endY = bTo.y - 6;
        const animated = isStatusActive(from);

        return (
          <Edge
            key={`${from}-${to}`}
            d={`M ${startX} ${startY} L ${endX} ${endY}`}
            label={label}
            lx={startX + 8}
            ly={(startY + endY) / 2 + 4}
            anchor="start"
            animated={animated}
          />
        );
      })}

      {/* 3. Drop lines to bottom return lane */}
      {(['waiting_quota', 'failed', 'blocked'] as TaskStatus[]).map((status) => {
        const b = getNodeBox(status);
        const dropX = b.x + b.w / 2 + 24;
        const dropStartY = b.y + b.h + 2;
        const animated = (counts[status] ?? 0) > 0;

        return (
          <path
            key={`lane-${status}`}
            d={`M ${dropX} ${dropStartY} L ${dropX} ${laneY}`}
            fill="none"
            strokeWidth={animated ? 2 : 1.75}
            strokeDasharray="6 5"
            style={EDGE_STYLE}
            className={animated ? 'flow-edge-animated' : undefined}
            data-animated={animated ? 'true' : undefined}
          />
        );
      })}

      {/* 4. Bottom return lane to queued */}
      <Edge
        d={`M ${laneStart} ${laneY} L ${queuedX} ${laneY} L ${queuedX} ${queuedBottom}`}
        dashed
        animated={retryAnimated}
        label={t('tasks.flow.edgeRetry')}
        lx={queuedX + 10}
        ly={laneY - 8}
        anchor="start"
      />

      {/* 5. Reviewer rework curve back to running */}
      <Edge
        d={`M ${reworkStartX} ${reworkStartY} C ${reworkStartX} ${reworkArchY}, ${reworkEndX} ${reworkArchY}, ${reworkEndX} ${reworkEndY}`}
        dashed
        animated={reworkAnimated}
        label={t('tasks.flow.edgeRework')}
        lx={(reworkStartX + reworkEndX) / 2}
        ly={reworkArchY + 6}
      />
    </g>
  );
};

export const FlowTaskList: React.FC<{ status: TaskStatus; project?: string; search?: string }> = ({ status, project = '', search = '' }) => {
  const { t, locale } = useLocale();
  const colorOf = useProjectColor();
  const pageSize = 20;
  const { data, isLoading, isError } = useQuery({
    queryKey: ['tasks-kanban', 'flow-list', project, status, search],
    queryFn: () => getTasksPage({ project, status, search, limit: pageSize, sort: 'statusChangedAt', order: 'desc' }),
  });
  const [items, setItems] = useState<Task[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => {
    setItems(data?.items || []);
    setCursor(data?.nextCursor || null);
  }, [data]);

  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await getTasksPage({ project, status, search, limit: pageSize, cursor, sort: 'statusChangedAt', order: 'desc' });
      setItems((current) => [...current, ...next.items]);
      setCursor(next.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  };

  if (isLoading) return <p className="py-8 text-center text-sm text-[var(--t-text-3)]">{t('pagination.loading')}</p>;
  if (isError) return <p role="alert" className="py-8 text-center text-sm text-[var(--t-crit)]">{t('tasks.flow.loadError')}</p>;
  if (items.length === 0) {
    return <p className="rounded-lg border border-dashed border-[var(--t-border)] py-8 text-center text-sm italic text-[var(--t-text-3)]">{t('tasks.flow.empty')}</p>;
  }

  const remaining = Math.max(0, (data?.total || 0) - items.length);
  return (
    <div className="space-y-3">
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="flow-task-list">
        {items.map((task) => (
          <li key={task.id}>
            <Link
              to={taskHref(task)}
              className="group flex h-full flex-col rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] p-3.5 transition-colors hover:border-[var(--t-accent)]"
              style={{ borderLeft: `3px solid ${colorOf(task.projectId)}` }}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="truncate font-mono text-xs text-[var(--t-text-2)]">{task.slug}</span>
                <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-[var(--t-text-3)] group-hover:text-[var(--t-accent)]" />
              </div>
              <div className="mt-1 line-clamp-2 text-sm font-semibold text-[var(--t-text)]">{task.title}</div>
              <div className="mt-auto flex items-center justify-between gap-2 pt-3 text-xs">
                <div className="flex min-w-0 items-center gap-1.5">
                  <ProjectTag projectId={task.projectId} />
                  {task.statusChangedAt && (
                    <span
                      className="truncate text-[11px] text-[var(--t-text-3)]"
                      title={formatDateTime(task.statusChangedAt, locale)}
                      data-testid="task-status-time"
                    >
                      {formatStatusTimeLabel(task.status, task.statusChangedAt, locale, undefined, t)}
                    </span>
                  )}
                </div>
                <span className="inline-flex shrink-0 items-center gap-1 text-[var(--t-text-3)]">
                  {task.level === 'hard' ? <Flame className="h-3 w-3" /> : <Zap className="h-3 w-3" />}
                  {task.level === 'hard' ? t('tasks.flow.levelHard') : t('tasks.flow.levelEasy')}
                </span>
              </div>
            </Link>
          </li>
        ))}
      </ul>
      {cursor && (
        <button
          type="button"
          onClick={loadMore}
          disabled={loadingMore}
          className="w-full rounded-lg border border-[var(--t-border)] py-2 text-xs font-medium text-[var(--t-text-2)] hover:bg-[var(--t-hover)] disabled:opacity-50"
        >
          {loadingMore ? t('pagination.loading') : t('tasks.flow.showMore', { count: String(Math.min(pageSize, remaining)) })}
        </button>
      )}
    </div>
  );
};

export const TaskFlow: React.FC<{ project: string; search: string }> = ({ project, search }) => {
  const { t, locale } = useLocale();
  const [openStatus, setOpenStatus] = useState<TaskStatus | null>(null);

  // Queries for each status count
  const qDraft = useStatusTotal(project, 'draft', search);
  const qQueued = useStatusTotal(project, 'queued', search);
  const qRunning = useStatusTotal(project, 'running', search);
  const qChecking = useStatusTotal(project, 'checking', search);
  const qReview = useStatusTotal(project, 'review', search);
  const qDone = useStatusTotal(project, 'done', search);
  const qPushed = useStatusTotal(project, 'pushed', search);
  const qWaitingQuota = useStatusTotal(project, 'waiting_quota', search);
  const qFailed = useStatusTotal(project, 'failed', search);
  const qBlocked = useStatusTotal(project, 'blocked', search);

  const runningCount = qRunning.data?.total ?? 0;
  const checkingCount = qChecking.data?.total ?? 0;
  const reviewCount = qReview.data?.total ?? 0;
  const activeCount = runningCount + checkingCount + reviewCount;
  const refetchInterval = getFlowRefetchInterval(activeCount);

  const counts: Record<TaskStatus, number> = {
    draft: qDraft.data?.total ?? 0,
    queued: qQueued.data?.total ?? 0,
    running: runningCount,
    checking: checkingCount,
    review: reviewCount,
    done: qDone.data?.total ?? 0,
    pushed: qPushed.data?.total ?? 0,
    waiting_quota: qWaitingQuota.data?.total ?? 0,
    failed: qFailed.data?.total ?? 0,
    blocked: qBlocked.data?.total ?? 0,
    cancelled: 0,
  };

  const loading: Record<TaskStatus, boolean> = {
    draft: qDraft.isLoading,
    queued: qQueued.isLoading,
    running: qRunning.isLoading,
    checking: qChecking.isLoading,
    review: qReview.isLoading,
    done: qDone.isLoading,
    pushed: qPushed.isLoading,
    waiting_quota: qWaitingQuota.isLoading,
    failed: qFailed.isLoading,
    blocked: qBlocked.isLoading,
    cancelled: false,
  };

  const openTotal = openStatus ? counts[openStatus] : 0;

  // Measurement and ResizeObserver for edge coordinates
  const boardRef = useRef<HTMLDivElement>(null);
  const nodeEls = useRef<Partial<Record<TaskStatus, HTMLDivElement>>>({});
  const roRef = useRef<ResizeObserver | null>(null);
  const [coords, setCoords] = useState<Partial<Record<TaskStatus, NodeRect>>>({});

  const isSameCoord = (a?: NodeRect, b?: NodeRect) => {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return (
      Math.abs(a.x - b.x) < 0.5 &&
      Math.abs(a.y - b.y) < 0.5 &&
      Math.abs(a.w - b.w) < 0.5 &&
      Math.abs(a.h - b.h) < 0.5
    );
  };

  const updateCoords = useCallback(() => {
    if (!boardRef.current) return;
    const boardRect = boardRef.current.getBoundingClientRect();
    if (boardRect.width === 0) return;

    const snap = (v: number) => Math.round(v * 2) / 2;
    const next: Partial<Record<TaskStatus, NodeRect>> = {};
    for (const def of NODE_DEFS) {
      const el = nodeEls.current[def.status];
      if (el) {
        const rect = el.getBoundingClientRect();
        next[def.status] = {
          x: snap(rect.left - boardRect.left + boardRef.current.scrollLeft),
          y: snap(rect.top - boardRect.top + boardRef.current.scrollTop),
          w: snap(rect.width),
          h: snap(rect.height),
        };
      }
    }

    setCoords((prev) => {
      let changed = false;
      for (const def of NODE_DEFS) {
        if (!isSameCoord(prev[def.status], next[def.status])) {
          changed = true;
          break;
        }
      }
      return changed ? next : prev;
    });
  }, []);

  const registerRef = useCallback(
    (status: TaskStatus, el: HTMLDivElement | null) => {
      const prevEl = nodeEls.current[status];
      if (prevEl === el) return;
      if (prevEl && roRef.current) {
        roRef.current.unobserve(prevEl);
      }
      if (el) {
        nodeEls.current[status] = el;
        if (roRef.current) {
          roRef.current.observe(el);
        }
      } else {
        delete nodeEls.current[status];
      }
    },
    [],
  );

  useLayoutEffect(() => {
    updateCoords();
  }, [counts, locale, updateCoords]);

  useEffect(() => {
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => {
        updateCoords();
      });
      roRef.current = ro;
      if (boardRef.current) {
        ro.observe(boardRef.current);
      }
      for (const el of Object.values(nodeEls.current)) {
        if (el) ro.observe(el);
      }
    }

    updateCoords();
    window.addEventListener('resize', updateCoords);
    return () => {
      ro?.disconnect();
      roRef.current = null;
      window.removeEventListener('resize', updateCoords);
    };
  }, [updateCoords]);

  const getNodeBox = (status: TaskStatus): NodeRect => {
    const measured = coords[status];
    if (measured && measured.w > 0 && measured.h > 0) {
      return measured;
    }
    return getFallbackBox(status);
  };

  return (
    <div className="pb-8" data-testid="flow-view-wrapper">
      <div
        className="overflow-x-auto rounded-2xl border border-[var(--t-border)] bg-[var(--t-surface)] p-4 sm:p-6 shadow-xs"
        data-tour="task-columns"
      >
        <div
          ref={boardRef}
          className="relative min-w-[1240px] min-h-[max(480px,calc(100vh-280px))]"
          role="group"
          aria-label={t('tasks.flow.ariaLabel')}
        >
          {/* Background SVG for arrow edges */}
          <svg
            className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
            aria-hidden="true"
          >
            <defs>
              <marker
                id="flow-arrow"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" style={{ fill: 'var(--t-text-3)', fillOpacity: 0.6 }} />
              </marker>
            </defs>
            <FlowEdges counts={counts} getNodeBox={getNodeBox} />
          </svg>

          {/* HTML / CSS Grid for nodes */}
          <div className="relative z-1 grid min-h-[max(480px,calc(100vh-280px))] grid-cols-[repeat(7,minmax(150px,1fr))] content-between gap-x-6 gap-y-16 lg:gap-x-8 lg:gap-y-20 pt-12 pb-16">
            {NODE_DEFS.map((def) => (
              <FlowNodeCard
                key={def.status}
                node={def}
                project={project}
                search={search}
                total={counts[def.status]}
                isLoading={loading[def.status]}
                refetchInterval={refetchInterval}
                onOpen={setOpenStatus}
                registerRef={registerRef}
              />
            ))}
          </div>
        </div>
      </div>
      <p className="mt-2 text-xs text-[var(--t-text-3)]">{t('tasks.flow.hint')}</p>

      <Modal
        isOpen={openStatus !== null}
        onClose={() => setOpenStatus(null)}
        maxWidth="max-w-[95vw] md:max-w-[70vw]"
        className="h-[85vh] md:h-[70vh]"
        title={openStatus ? (
          <span className="flex items-center gap-2">
            <StatusBadge status={openStatus} size="sm" />
            <span className="text-sm font-normal text-[var(--t-text-2)]">{t('tasks.flow.modalCount', { count: String(openTotal) })}</span>
          </span>
        ) : undefined}
        ariaLabel={openStatus ? t(`status.${openStatus}`) : undefined}
      >
        {openStatus && <FlowTaskList status={openStatus} project={project} search={search} />}
      </Modal>
    </div>
  );
};
