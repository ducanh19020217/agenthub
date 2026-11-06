import React, { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowUpRight, CircleCheck, CircleX, Clock, FilePen, Flame, FlaskConical, Hourglass, OctagonAlert, Play, ScanEye, Zap, type LucideIcon } from 'lucide-react';
import { getTasksPage } from '../api/client';
import { useLocale } from '../context/LocaleContext';
import type { Task, TaskStatus } from '../types/api';
import { StatusBadge } from './StatusBadge';
import { Modal } from './ui';
import { ProjectTag } from './ProjectTag';
import { useProjectColor } from '../utils/projectColor';

/** Sơ đồ quy trình: mỗi node là một trạng thái task, bấm vào để xem danh sách task. */

const NODE_W = 172;
const NODE_H = 80;
const TOP_Y = 64;
const BOTTOM_Y = 248;
const LANE_Y = 372;
const VIEW_W = 1240;
const VIEW_H = 400;
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
  cancelled: CircleX,
};
const COL_X = [20, 224, 428, 632, 836, 1040];

interface FlowNode { status: TaskStatus; x: number; y: number }

const NODES: FlowNode[] = [
  { status: 'draft', x: COL_X[0], y: TOP_Y },
  { status: 'queued', x: COL_X[1], y: TOP_Y },
  { status: 'running', x: COL_X[2], y: TOP_Y },
  { status: 'checking', x: COL_X[3], y: TOP_Y },
  { status: 'review', x: COL_X[4], y: TOP_Y },
  { status: 'done', x: COL_X[5], y: TOP_Y },
  { status: 'waiting_quota', x: COL_X[2], y: BOTTOM_Y },
  { status: 'failed', x: COL_X[3], y: BOTTOM_Y },
  { status: 'blocked', x: COL_X[4], y: BOTTOM_Y },
];

export const FLOW_STATUSES = NODES.map((node) => node.status);

const nodeOf = (status: TaskStatus) => NODES.find((node) => node.status === status)!;
const statusColor = (status: TaskStatus) => `var(--status-${status}-color, var(--t-accent))`;
const taskHref = (task: Task) => `/tasks/${encodeURIComponent(task.id.replace('/', '~'))}`;

function useStatusTotal(project: string, status: TaskStatus, search: string) {
  return useQuery({
    // Đặt dưới 'tasks-kanban' để SSE làm mới cùng lúc với Kanban.
    queryKey: ['tasks-kanban', 'flow-count', project, status, search],
    queryFn: () => getTasksPage({ project, status, search, limit: 1, sort: 'createdAt', order: 'desc' }),
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  });
}

const FlowNodeView: React.FC<{
  node: FlowNode;
  project: string;
  search: string;
  onOpen: (status: TaskStatus) => void;
}> = ({ node, project, search, onOpen }) => {
  const { t } = useLocale();
  const { data, isLoading } = useStatusTotal(project, node.status, search);
  const total = data?.total ?? 0;
  const color = statusColor(node.status);
  const label = t(`status.${node.status}`);
  const active = total > 0;
  const Icon = STATUS_ICON[node.status];
  const open = () => onOpen(node.status);

  return (
    <g
      role="button"
      tabIndex={0}
      data-testid={`flow-node-${node.status}`}
      data-count={isLoading ? '' : String(total)}
      aria-label={t('tasks.flow.nodeAria', { status: label, count: String(total) })}
      className="group cursor-pointer outline-hidden [&:focus-visible>rect.flow-node-frame]:stroke-[3]"
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          open();
        }
      }}
    >
      <title>{label}</title>
      {active && (
        <rect
          x={node.x - 4}
          y={node.y - 4}
          width={NODE_W + 8}
          height={NODE_H + 8}
          rx={18}
          fill="none"
          style={{ stroke: color, opacity: 0.35 }}
          strokeWidth={2}
          className={node.status === 'running' ? 'animate-pulse' : undefined}
        />
      )}
      <rect
        className="flow-node-frame transition-[stroke-width] group-hover:stroke-[2.5]"
        x={node.x}
        y={node.y}
        width={NODE_W}
        height={NODE_H}
        rx={14}
        style={{
          fill: `color-mix(in srgb, ${color} ${active ? 12 : 4}%, var(--t-surface-2))`,
          stroke: color,
        }}
        strokeWidth={active ? 2 : 1.25}
        strokeOpacity={active ? 1 : 0.45}
      />
      <rect
        x={node.x + 14}
        y={node.y + 18}
        width={44}
        height={44}
        rx={12}
        style={{ fill: `color-mix(in srgb, ${color} ${active ? 26 : 14}%, transparent)` }}
      />
      <Icon x={node.x + 25} y={node.y + 29} width={22} height={22} strokeWidth={2.2} style={{ color }} aria-hidden="true" />
      <text x={node.x + 70} y={node.y + 34} fontSize={13.5} fontWeight={600} style={{ fill: active ? 'var(--t-text)' : 'var(--t-text-2)' }}>
        {label}
      </text>
      <text x={node.x + 70} y={node.y + 64} style={{ fill: 'var(--t-text-3)' }}>
        <tspan
          fontSize={24}
          fontWeight={700}
          fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
          style={{ fill: active ? color : 'var(--t-text-3)' }}
        >
          {isLoading ? '…' : total}
        </tspan>
        <tspan dx={6} fontSize={12}>{t('tasks.flow.taskUnit')}</tspan>
      </text>
    </g>
  );
};

const Edge: React.FC<{ d: string; label?: string; lx?: number; ly?: number; dashed?: boolean; anchor?: 'start' | 'middle' | 'end' }> = ({ d, label, lx, ly, dashed, anchor = 'middle' }) => (
  <g>
    <path
      d={d}
      fill="none"
      strokeWidth={1.75}
      strokeDasharray={dashed ? '6 5' : undefined}
      markerEnd="url(#flow-arrow)"
      style={EDGE_STYLE}
    />
    {label && lx !== undefined && ly !== undefined && (
      <text x={lx} y={ly} fontSize={11.5} textAnchor={anchor} style={{ fill: 'var(--t-text-3)' }}>
        {label}
      </text>
    )}
  </g>
);

const FlowEdges: React.FC = () => {
  const { t } = useLocale();
  const midY = TOP_Y + NODE_H / 2;
  const right = (s: TaskStatus) => nodeOf(s).x + NODE_W;
  const left = (s: TaskStatus) => nodeOf(s).x;
  const cx = (s: TaskStatus) => nodeOf(s).x + NODE_W / 2;
  const main: Array<[TaskStatus, TaskStatus]> = [['draft', 'queued'], ['queued', 'running'], ['running', 'checking'], ['checking', 'review'], ['review', 'done']];
  const down: Array<[TaskStatus, TaskStatus, string]> = [
    ['running', 'waiting_quota', t('tasks.flow.edgeQuota')],
    ['checking', 'failed', t('tasks.flow.edgeFailed')],
    ['review', 'blocked', t('tasks.flow.edgeBlocked')],
  ];
  const queuedX = cx('queued');
  const laneStart = cx('blocked') + 24;

  return (
    <g data-testid="flow-edges">
      {main.map(([from, to]) => (
        <Edge key={`${from}-${to}`} d={`M ${right(from) + 2} ${midY} L ${left(to) - 6} ${midY}`} />
      ))}
      {down.map(([from, to, label]) => (
        <Edge
          key={`${from}-${to}`}
          d={`M ${cx(from) - 24} ${TOP_Y + NODE_H + 2} L ${cx(to) - 24} ${BOTTOM_Y - 6}`}
          label={label}
          lx={cx(from) - 16}
          ly={(TOP_Y + NODE_H + BOTTOM_Y) / 2 + 4}
          anchor="start"
        />
      ))}
      {/* Nhánh quay lại: các trạng thái dưới đi xuống "làn" chung rồi về Chờ chạy. */}
      {(['waiting_quota', 'failed', 'blocked'] as TaskStatus[]).map((status) => (
        <path
          key={`lane-${status}`}
          d={`M ${cx(status) + 24} ${BOTTOM_Y + NODE_H + 2} L ${cx(status) + 24} ${LANE_Y}`}
          fill="none"
          strokeWidth={1.75}
          strokeDasharray="6 5"
          style={EDGE_STYLE}
        />
      ))}
      <Edge
        d={`M ${laneStart} ${LANE_Y} L ${queuedX} ${LANE_Y} L ${queuedX} ${TOP_Y + NODE_H + 6}`}
        dashed
        label={t('tasks.flow.edgeRetry')}
        lx={queuedX + 10}
        ly={LANE_Y - 8}
        anchor="start"
      />
      {/* Reviewer yêu cầu sửa: quay lại Đang chạy. */}
      <Edge
        d={`M ${cx('review')} ${TOP_Y - 2} C ${cx('review')} ${TOP_Y - 46}, ${cx('running')} ${TOP_Y - 46}, ${cx('running')} ${TOP_Y - 8}`}
        dashed
        label={t('tasks.flow.edgeRework')}
        lx={(cx('review') + cx('running')) / 2}
        ly={TOP_Y - 40}
      />
    </g>
  );
};

const FlowTaskList: React.FC<{ status: TaskStatus; project: string; search: string }> = ({ status, project, search }) => {
  const { t } = useLocale();
  const colorOf = useProjectColor();
  const pageSize = 20;
  const { data, isLoading, isError } = useQuery({
    queryKey: ['tasks-kanban', 'flow-list', project, status, search],
    queryFn: () => getTasksPage({ project, status, search, limit: pageSize, sort: 'createdAt', order: 'desc' }),
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
      const next = await getTasksPage({ project, status, search, limit: pageSize, cursor, sort: 'createdAt', order: 'desc' });
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
                <ProjectTag projectId={task.projectId} />
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
  const { t } = useLocale();
  const [openStatus, setOpenStatus] = useState<TaskStatus | null>(null);
  const openTotal = useStatusTotal(project, openStatus || 'draft', search).data?.total;

  return (
    <div className="pb-8" data-testid="flow-view-wrapper">
      <div className="overflow-x-auto rounded-xl border border-[var(--t-border)] bg-[var(--t-surface)] p-3" data-tour="task-columns">
        <svg
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          className="block h-auto w-full min-w-[900px]"
          role="group"
          aria-label={t('tasks.flow.ariaLabel')}
        >
          <defs>
            <marker id="flow-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" style={{ fill: 'var(--t-text-3)', fillOpacity: 0.6 }} />
            </marker>
          </defs>
          <FlowEdges />
          {NODES.map((node) => (
            <FlowNodeView key={node.status} node={node} project={project} search={search} onOpen={setOpenStatus} />
          ))}
        </svg>
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
            <span className="text-sm font-normal text-[var(--t-text-2)]">{t('tasks.flow.modalCount', { count: String(openTotal ?? 0) })}</span>
          </span>
        ) : undefined}
        ariaLabel={openStatus ? t(`status.${openStatus}`) : undefined}
      >
        {openStatus && <FlowTaskList status={openStatus} project={project} search={search} />}
      </Modal>
    </div>
  );
};
