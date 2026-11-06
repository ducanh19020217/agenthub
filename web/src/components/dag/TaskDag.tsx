import React, { useState, useRef, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Task } from '../../types/api';
import { layoutTaskDag, normalizeTaskId, DagNodeData, DagEdgeData } from './dagUtils';
import { StatusBadge } from '../StatusBadge';
import { useLocale } from '../../context/LocaleContext';
import {
  ZoomIn,
  ZoomOut,
  Maximize2,
  AlertTriangle,
  Flame,
  ArrowUpRight,
  Cpu,
} from 'lucide-react';

export interface TaskDagProps {
  tasks: Task[];
  onSelectTask?: (task: Task) => void;
  className?: string;
  hideControls?: boolean;
}

export const TaskDag: React.FC<TaskDagProps> = ({
  tasks,
  onSelectTask,
  className = '',
  hideControls = false,
}) => {
  const { t } = useLocale();
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement>(null);

  // Pan and Zoom state
  const [scale, setScale] = useState<number>(1);
  const [offset, setOffset] = useState<{ x: number; y: number }>({ x: 20, y: 20 });
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [dragStart, setDragStart] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  // Compute DAG Layout
  const layout = useMemo(() => {
    return layoutTaskDag(tasks, {
      nodeWidth: 230,
      nodeHeight: 96,
      rankdir: 'LR',
      nodesep: 40,
      ranksep: 80,
    });
  }, [tasks]);

  // Handle task selection
  const handleNodeClick = useCallback(
    (task: Task) => {
      if (onSelectTask) {
        onSelectTask(task);
      } else {
        const routeId = normalizeTaskId(task.id);
        navigate(`/tasks/${encodeURIComponent(routeId)}`);
      }
    },
    [onSelectTask, navigate]
  );

  // Mouse drag handlers for panning
  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return; // Only left click
    // Only pan if clicking canvas background or svg, not inside interactive buttons
    const target = e.target as HTMLElement;
    if (target.closest('button') || target.closest('[data-dag-interactive]')) {
      return;
    }
    setIsDragging(true);
    setDragStart({ x: e.clientX - offset.x, y: e.clientY - offset.y });
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDragging) return;
    setOffset({
      x: e.clientX - dragStart.x,
      y: e.clientY - dragStart.y,
    });
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  // Zoom wheel handler
  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
    setScale((prev) => Math.min(2.5, Math.max(0.25, Number((prev * zoomFactor).toFixed(2)))));
  };

  const zoomIn = () => {
    setScale((prev) => Math.min(2.5, Number((prev + 0.15).toFixed(2))));
  };

  const zoomOut = () => {
    setScale((prev) => Math.max(0.25, Number((prev - 0.15).toFixed(2))));
  };

  const fitView = () => {
    if (!containerRef.current || layout.width === 0 || layout.height === 0) {
      setScale(1);
      setOffset({ x: 20, y: 20 });
      return;
    }
    const containerWidth = containerRef.current.clientWidth - 40;
    const containerHeight = containerRef.current.clientHeight - 40;
    const scaleX = containerWidth / layout.width;
    const scaleY = containerHeight / layout.height;
    const newScale = Math.min(1.2, Math.max(0.3, Math.min(scaleX, scaleY)));
    setScale(Number(newScale.toFixed(2)));
    setOffset({ x: 20, y: 20 });
  };

  if (tasks.length === 0) {
    return (
      <div
        data-testid="task-dag-empty"
        className={`flex flex-col items-center justify-center p-12 rounded-xl border border-dashed border-[var(--t-border)] bg-[var(--t-surface)] min-h-[420px] text-[var(--t-text-3)] text-sm ${className}`}
      >
        <p className="italic">{t('dag.empty')}</p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      data-testid="task-dag-container"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onWheel={handleWheel}
      className={`relative w-full rounded-xl border border-[var(--t-border)] bg-[var(--t-surface)] overflow-hidden select-none min-h-[500px] h-[640px] cursor-grab active:cursor-grabbing ${className}`}
    >
      {/* Background Dot Grid */}
      <svg
        className="absolute inset-0 w-full h-full pointer-events-none opacity-20"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <pattern id="dag-dot-pattern" x="0" y="0" width="24" height="24" patternUnits="userSpaceOnUse">
            <circle cx="2" cy="2" r="1.2" fill="currentColor" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#dag-dot-pattern)" />
      </svg>

      {/* Top Overlay: Stats & Legend */}
      <div className="absolute top-3 left-3 z-10 flex items-center gap-2 flex-wrap pointer-events-none">
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[var(--t-surface)]/90 backdrop-blur-md border border-[var(--t-border)] shadow-xs pointer-events-auto text-xs font-medium text-[var(--t-text)]">
          <span>{t('dag.totalTasks', { count: tasks.length })}</span>
          {layout.criticalPath.length > 0 && (
            <>
              <span className="w-1 h-1 rounded-full bg-[var(--t-border)]" />
              <span className="inline-flex items-center gap-1 text-[var(--t-warn)] font-semibold">
                <Flame className="w-3.5 h-3.5" />
                {t('dag.criticalPathCount', { count: layout.criticalPath.length })}
              </span>
            </>
          )}
          {layout.maxBlockedCount > 0 && (
            <>
              <span className="w-1 h-1 rounded-full bg-[var(--t-border)]" />
              <span className="inline-flex items-center gap-1 text-[var(--t-crit)] font-semibold">
                <AlertTriangle className="w-3.5 h-3.5" />
                {t('dag.maxBlockerLabel', { count: layout.maxBlockedCount })}
              </span>
            </>
          )}
        </div>
      </div>

      {/* Bottom-right Overlay: Zoom / Pan Controls */}
      {!hideControls && (
        <div className="absolute bottom-3 right-3 z-10 flex items-center gap-1 p-1 rounded-lg bg-[var(--t-surface)]/90 backdrop-blur-md border border-[var(--t-border)] shadow-xs">
          <button
            type="button"
            onClick={zoomIn}
            title={t('dag.zoomIn')}
            aria-label={t('dag.zoomIn')}
            className="p-1.5 rounded hover:bg-[var(--t-surface-2)] text-[var(--t-text-2)] hover:text-[var(--t-text)] cursor-pointer transition-colors"
          >
            <ZoomIn className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={zoomOut}
            title={t('dag.zoomOut')}
            aria-label={t('dag.zoomOut')}
            className="p-1.5 rounded hover:bg-[var(--t-surface-2)] text-[var(--t-text-2)] hover:text-[var(--t-text)] cursor-pointer transition-colors"
          >
            <ZoomOut className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={fitView}
            title={t('dag.fitView')}
            aria-label={t('dag.fitView')}
            className="p-1.5 rounded hover:bg-[var(--t-surface-2)] text-[var(--t-text-2)] hover:text-[var(--t-text)] cursor-pointer transition-colors"
          >
            <Maximize2 className="w-4 h-4" />
          </button>
          <span className="px-2 text-[11px] font-mono font-medium text-[var(--t-text-3)] border-l border-[var(--t-border)]">
            {Math.round(scale * 100)}%
          </span>
        </div>
      )}

      {/* Main Graph SVG Canvas */}
      <svg
        data-testid="task-dag-svg"
        className="w-full h-full block"
        style={{ width: '100%', height: '100%' }}
      >
        <defs>
          {/* Arrowhead marker for normal edges */}
          <marker
            id="dag-arrow-normal"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto"
          >
            <path d="M 0 1 L 9 5 L 0 9 z" fill="var(--t-border)" />
          </marker>

          {/* Arrowhead marker for critical path edges */}
          <marker
            id="dag-arrow-critical"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto"
          >
            <path d="M 0 1 L 9 5 L 0 9 z" fill="var(--t-warn)" />
          </marker>
        </defs>

        <g transform={`translate(${offset.x}, ${offset.y}) scale(${scale})`}>
          {/* Edges Layer */}
          <g data-testid="dag-edges-layer">
            {layout.edges.map((edge: DagEdgeData, idx: number) => {
              const pts = edge.points;
              if (!pts || pts.length < 2) return null;

              let d = '';
              if (pts.length === 2) {
                const p0 = pts[0];
                const p1 = pts[1];
                const dx = p1.x - p0.x;
                d = `M ${p0.x} ${p0.y} C ${p0.x + dx / 2} ${p0.y}, ${p1.x - dx / 2} ${p1.y}, ${p1.x} ${p1.y}`;
              } else {
                d = `M ${pts[0].x} ${pts[0].y}`;
                for (let i = 1; i < pts.length; i++) {
                  d += ` L ${pts[i].x} ${pts[i].y}`;
                }
              }

              return (
                <path
                  key={`edge-${edge.from}-${edge.to}-${idx}`}
                  data-testid={`dag-edge-${edge.from}-${edge.to}`}
                  data-critical={edge.isCritical}
                  d={d}
                  fill="none"
                  stroke={edge.isCritical ? 'var(--t-warn)' : 'var(--t-border)'}
                  strokeWidth={edge.isCritical ? 2.5 : 1.5}
                  strokeDasharray={edge.isCritical ? 'none' : undefined}
                  markerEnd={
                    edge.isCritical ? 'url(#dag-arrow-critical)' : 'url(#dag-arrow-normal)'
                  }
                  className="transition-colors duration-200"
                />
              );
            })}
          </g>

          {/* Nodes Layer */}
          <g data-testid="dag-nodes-layer">
            {layout.nodes.map((node: DagNodeData) => {
              const task = node.task;
              const runningModel =
                task.currentRun?.model ||
                (task.modelChain && Array.isArray(task.modelChain) ? task.modelChain[0] : null);
              const runningProfile = task.currentRun?.profileName;
              const runningEngine = task.currentRun?.engine;

              return (
                <foreignObject
                  key={`node-${node.id}`}
                  x={node.left}
                  y={node.top}
                  width={node.width}
                  height={node.height}
                  className="overflow-visible"
                >
                  <div
                    data-testid={`dag-node-${node.id}`}
                    data-task-id={node.id}
                    data-status={task.status}
                    data-critical={node.isCritical}
                    data-max-blocker={node.isMaxBlocker}
                    data-dag-interactive="true"
                    role="button"
                    tabIndex={0}
                    onClick={() => handleNodeClick(task)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleNodeClick(task);
                      }
                    }}
                    style={{
                      borderLeftColor: `var(--status-${task.status}-color, var(--t-accent))`,
                    }}
                    className={`group relative flex flex-col justify-between w-full h-full p-2.5 rounded-lg border border-[var(--t-border)] border-l-4 bg-[var(--t-surface)] hover:border-[var(--t-accent)] hover:shadow-md transition-all cursor-pointer ${
                      node.isCritical
                        ? 'ring-2 ring-[var(--t-warn)] shadow-[0_0_12px_var(--t-warn-glow)]'
                        : ''
                    } ${
                      node.isMaxBlocker
                        ? 'ring-1 ring-[var(--t-crit)]'
                        : ''
                    }`}
                  >
                    {/* Top Row: Slug & Status / Badges */}
                    <div className="flex items-center justify-between gap-1.5">
                      <span className="text-[11px] font-mono font-bold text-[var(--t-text-2)] truncate max-w-[120px]">
                        {task.slug}
                      </span>

                      <div className="flex items-center gap-1 shrink-0">
                        {node.isCritical && (
                          <span
                            title={t('dag.criticalPath')}
                            className="inline-flex items-center gap-0.5 text-[9px] font-bold px-1 py-0.2 rounded bg-[color-mix(in_srgb,var(--t-warn)_15%,transparent)] text-[var(--t-warn)] border border-[color-mix(in_srgb,var(--t-warn)_30%,transparent)]"
                          >
                            <Flame className="w-2.5 h-2.5" />
                          </span>
                        )}
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

                    {/* Middle: Shortened Title */}
                    <div className="my-1">
                      <h4
                        title={task.title}
                        className="text-xs font-semibold text-[var(--t-text)] line-clamp-1 group-hover:text-[var(--t-accent)] transition-colors"
                      >
                        {task.title}
                      </h4>
                    </div>

                    {/* Bottom Row: Metadata & Blocker indicator */}
                    <div className="flex items-center justify-between gap-1 pt-1 border-t border-[var(--t-border)] text-[10px]">
                      {/* Running Model / Profile or Project */}
                      {task.status === 'running' && (runningModel || runningProfile) ? (
                        <div
                          title={`${runningEngine ? `${runningEngine} / ` : ''}${runningProfile ? `${runningProfile} / ` : ''}${runningModel || ''}`}
                          className="flex items-center gap-1 text-[var(--t-accent)] truncate max-w-[130px] font-medium"
                        >
                          <Cpu className="w-3 h-3 shrink-0 animate-pulse" />
                          <span className="truncate">{runningProfile && runningModel ? `${runningProfile} · ${runningModel}` : (runningModel || runningProfile)}</span>
                        </div>
                      ) : (
                        <span className="text-[var(--t-text-3)] truncate max-w-[100px]">
                          {task.projectId}
                        </span>
                      )}

                      {/* Blocker badge if any */}
                      {node.blockedCount > 0 ? (
                        <span
                          title={t('dag.blockingCount', { count: node.blockedCount })}
                          className={`inline-flex items-center gap-0.5 text-[9px] font-bold px-1.5 py-0.2 rounded-full ${
                            node.isMaxBlocker
                              ? 'bg-[color-mix(in_srgb,var(--t-crit)_15%,transparent)] text-[var(--t-crit)] border border-[color-mix(in_srgb,var(--t-crit)_30%,transparent)]'
                              : 'bg-[var(--t-surface-2)] text-[var(--t-text-3)] border border-[var(--t-border)]'
                          }`}
                        >
                          <AlertTriangle className="w-2.5 h-2.5" />
                          <span>{t('dag.blockingCount', { count: node.blockedCount })}</span>
                        </span>
                      ) : (
                        <ArrowUpRight className="w-3 h-3 text-[var(--t-text-3)] group-hover:text-[var(--t-accent)] transition-colors" />
                      )}
                    </div>
                  </div>
                </foreignObject>
              );
            })}
          </g>
        </g>
      </svg>
    </div>
  );
};
