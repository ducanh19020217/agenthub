import dagre from 'dagre';
import { Task } from '../../types/api';

export interface DagNodeData {
  id: string;
  x: number;
  y: number;
  left: number;
  top: number;
  width: number;
  height: number;
  task: Task;
  isCritical: boolean;
  blockedCount: number;
  isMaxBlocker: boolean;
}

export interface DagEdgeData {
  from: string;
  to: string;
  points: Array<{ x: number; y: number }>;
  isCritical: boolean;
}

export interface DagLayoutResult {
  nodes: DagNodeData[];
  edges: DagEdgeData[];
  width: number;
  height: number;
  criticalPath: string[];
  maxBlockedCount: number;
  maxBlockingTaskId: string | null;
}

export function parseDependsOn(deps: string | string[] | undefined | null): string[] {
  if (!deps) return [];
  if (Array.isArray(deps)) return deps;
  if (typeof deps === 'string') {
    const trimmed = deps.trim();
    if (!trimmed || trimmed === '[]') return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      return trimmed.split(',').map((s) => s.trim()).filter(Boolean);
    }
  }
  return [];
}

export function normalizeTaskId(id: string): string {
  return id.replace('/', '~');
}

/**
 * Filter tasks for the DAG view:
 * - project: 'all' or specific project ID
 * - status: 'all' or specific status
 * - doneFilter:
 *   - 'active_chains' (default): only keep done tasks that are prerequisites of at least one unfinished task
 *   - '1d', '3d', '7d', '30d': keep done tasks updated within the last N days
 *   - 'all': keep all done tasks
 */
export function filterTasksForDag(
  tasks: Task[],
  options?: {
    project?: string;
    status?: string;
    doneFilter?: 'active_chains' | '1d' | '3d' | '7d' | '30d' | 'all';
  }
): Task[] {
  let list = [...tasks];

  if (options?.project && options.project !== 'all') {
    list = list.filter((t) => t.projectId === options.project);
  }

  if (options?.status && options.status !== 'all') {
    list = list.filter((t) => t.status === options.status);
  }

  const doneFilter = options?.doneFilter || 'active_chains';
  if (doneFilter === 'all') {
    return list;
  }

  // Parse days cutoff if e.g. "1d", "7d"
  let daysCutoff: number | null = null;
  const match = doneFilter.match(/^(\d+)d$/);
  if (match) {
    daysCutoff = parseInt(match[1], 10);
  }

  // Build index for parent/child relationships
  const taskMap = new Map<string, Task>();
  const slugMap = new Map<string, Task>();
  for (const t of list) {
    taskMap.set(t.id, t);
    taskMap.set(normalizeTaskId(t.id), t);
    taskMap.set(t.id.replace('~', '/'), t);
    slugMap.set(t.slug, t);
    slugMap.set(`${t.projectId}/${t.slug}`, t);
    slugMap.set(`${t.projectId}~${t.slug}`, t);
  }

  const downstreamMap = new Map<string, string[]>();
  for (const t of list) {
    const parentRefs = parseDependsOn(t.dependsOn);
    for (const ref of parentRefs) {
      const parent = taskMap.get(ref) || taskMap.get(normalizeTaskId(ref)) || slugMap.get(ref);
      if (parent && parent.id !== t.id) {
        const arr = downstreamMap.get(parent.id) || [];
        arr.push(t.id);
        downstreamMap.set(parent.id, arr);
      }
    }
  }

  const unfinishedIds = new Set(list.filter((t) => t.status !== 'done' && t.status !== 'pushed').map((t) => t.id));

  const hasUnfinishedDescendant = (taskId: string, visited = new Set<string>()): boolean => {
    if (visited.has(taskId)) return false;
    visited.add(taskId);
    const children = downstreamMap.get(taskId) || [];
    for (const childId of children) {
      if (unfinishedIds.has(childId)) return true;
      if (hasUnfinishedDescendant(childId, visited)) return true;
    }
    return false;
  };

  const now = Date.now();

  return list.filter((t) => {
    if (t.status !== 'done' && t.status !== 'pushed') return true;

    // Active chain: prerequisite for remaining unfinished work
    if (hasUnfinishedDescendant(t.id)) return true;

    if (daysCutoff != null) {
      const timeStr = t.updatedAt || t.createdAt;
      if (timeStr) {
        const time = new Date(timeStr).getTime();
        const ageDays = (now - time) / (1000 * 60 * 60 * 24);
        if (ageDays <= daysCutoff) return true;
      }
      return false;
    }

    // Default: hide completed tasks that have no unfinished descendants
    return false;
  });
}

/**
 * Calculates blocked task counts for each task:
 * For unfinished tasks, counts reachable unfinished downstream tasks.
 * For done tasks, returns 0.
 */
export function calculateBlockedCounts(
  tasks: Task[],
  edges: Array<{ from: string; to: string }>
): {
  counts: Map<string, number>;
  maxCount: number;
  maxTaskId: string | null;
} {
  const unfinishedIds = new Set(tasks.filter((t) => t.status !== 'done' && t.status !== 'pushed').map((t) => t.id));
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    const arr = adj.get(e.from) || [];
    arr.push(e.to);
    adj.set(e.from, arr);
  }

  const counts = new Map<string, number>();
  let maxCount = 0;
  let maxTaskId: string | null = null;

  for (const task of tasks) {
    if (task.status === 'done' || task.status === 'pushed') {
      counts.set(task.id, 0);
      continue;
    }

    const visited = new Set<string>();
    const queue = [task.id];
    let count = 0;

    while (queue.length > 0) {
      const curr = queue.shift()!;
      const children = adj.get(curr) || [];
      for (const childId of children) {
        if (!visited.has(childId)) {
          visited.add(childId);
          if (unfinishedIds.has(childId)) {
            count++;
          }
          queue.push(childId);
        }
      }
    }

    counts.set(task.id, count);
    if (count > maxCount) {
      maxCount = count;
      maxTaskId = task.id;
    }
  }

  return { counts, maxCount, maxTaskId };
}

/**
 * Calculates critical path: the longest chain of unfinished tasks in the DAG.
 */
export function calculateCriticalPath(
  tasks: Task[],
  edges: Array<{ from: string; to: string }>
): string[] {
  const unfinishedIds = new Set(tasks.filter((t) => t.status !== 'done' && t.status !== 'pushed').map((t) => t.id));
  if (unfinishedIds.size === 0) return [];

  // Edges between unfinished tasks
  const adj = new Map<string, string[]>();
  for (const u of unfinishedIds) {
    adj.set(u, []);
  }
  for (const e of edges) {
    if (unfinishedIds.has(e.from) && unfinishedIds.has(e.to)) {
      adj.get(e.from)!.push(e.to);
    }
  }

  const memo = new Map<string, string[]>();
  const visiting = new Set<string>();

  function dfs(nodeId: string): string[] {
    if (visiting.has(nodeId)) {
      return [nodeId]; // cycle breaking
    }
    if (memo.has(nodeId)) {
      return memo.get(nodeId)!;
    }

    visiting.add(nodeId);
    const successors = adj.get(nodeId) || [];
    let bestTail: string[] = [];

    for (const next of successors) {
      const path = dfs(next);
      if (path.length > bestTail.length) {
        bestTail = path;
      }
    }

    visiting.delete(nodeId);
    const res = [nodeId, ...bestTail];
    memo.set(nodeId, res);
    return res;
  }

  let criticalPath: string[] = [];
  for (const u of unfinishedIds) {
    const path = dfs(u);
    if (path.length > criticalPath.length) {
      criticalPath = path;
    }
  }

  return criticalPath;
}

/**
 * Layout the tasks in a DAG left-to-right (LR) using dagre.
 */
export function layoutTaskDag(
  tasks: Task[],
  options?: {
    nodeWidth?: number;
    nodeHeight?: number;
    rankdir?: 'LR' | 'TB';
    nodesep?: number;
    ranksep?: number;
  }
): DagLayoutResult {
  const nodeWidth = options?.nodeWidth ?? 220;
  const nodeHeight = options?.nodeHeight ?? 92;
  const rankdir = options?.rankdir ?? 'LR';
  const nodesep = options?.nodesep ?? 36;
  const ranksep = options?.ranksep ?? 72;

  if (tasks.length === 0) {
    return {
      nodes: [],
      edges: [],
      width: 0,
      height: 0,
      criticalPath: [],
      maxBlockedCount: 0,
      maxBlockingTaskId: null,
    };
  }

  // Index tasks
  const taskMap = new Map<string, Task>();
  const slugMap = new Map<string, Task>();
  for (const t of tasks) {
    taskMap.set(t.id, t);
    taskMap.set(normalizeTaskId(t.id), t);
    taskMap.set(t.id.replace('~', '/'), t);
    slugMap.set(t.slug, t);
    slugMap.set(`${t.projectId}/${t.slug}`, t);
    slugMap.set(`${t.projectId}~${t.slug}`, t);
  }

  // Find edges: from parent (prerequisite) to child (dependent)
  const rawEdges: Array<{ from: string; to: string }> = [];
  const edgeSet = new Set<string>();

  for (const task of tasks) {
    const parentRefs = parseDependsOn(task.dependsOn);
    for (const ref of parentRefs) {
      const parent = taskMap.get(ref) || taskMap.get(normalizeTaskId(ref)) || slugMap.get(ref);
      if (parent && parent.id !== task.id) {
        const edgeKey = `${parent.id}->${task.id}`;
        if (!edgeSet.has(edgeKey)) {
          edgeSet.add(edgeKey);
          rawEdges.push({ from: parent.id, to: task.id });
        }
      }
    }
  }

  // Calculate blocked counts and critical path
  const { counts: blockedCounts, maxCount: maxBlockedCount, maxTaskId: maxBlockingTaskId } =
    calculateBlockedCounts(tasks, rawEdges);
  const criticalPath = calculateCriticalPath(tasks, rawEdges);
  const criticalNodeSet = new Set(criticalPath);
  const criticalEdgeSet = new Set<string>();
  for (let i = 0; i < criticalPath.length - 1; i++) {
    criticalEdgeSet.add(`${criticalPath[i]}->${criticalPath[i + 1]}`);
  }

  // Configure Dagre Graph
  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir,
    nodesep,
    ranksep,
    marginx: 40,
    marginy: 40,
  });
  g.setDefaultEdgeLabel(() => ({}));

  for (const task of tasks) {
    g.setNode(task.id, { width: nodeWidth, height: nodeHeight });
  }

  for (const edge of rawEdges) {
    g.setEdge(edge.from, edge.to);
  }

  dagre.layout(g);

  const nodes: DagNodeData[] = tasks.map((task) => {
    const nodeMeta = g.node(task.id) || { x: nodeWidth / 2, y: nodeHeight / 2 };
    const count = blockedCounts.get(task.id) || 0;
    const isCritical = criticalNodeSet.has(task.id);
    const isMaxBlocker = maxBlockedCount > 0 && count === maxBlockedCount;

    return {
      id: task.id,
      x: nodeMeta.x,
      y: nodeMeta.y,
      left: nodeMeta.x - nodeWidth / 2,
      top: nodeMeta.y - nodeHeight / 2,
      width: nodeWidth,
      height: nodeHeight,
      task,
      isCritical,
      blockedCount: count,
      isMaxBlocker,
    };
  });

  const edges: DagEdgeData[] = rawEdges.map((e) => {
    const edgeMeta = g.edge(e.from, e.to);
    const points = edgeMeta?.points || [];
    const isCritical = criticalEdgeSet.has(`${e.from}->${e.to}`);

    return {
      from: e.from,
      to: e.to,
      points,
      isCritical,
    };
  });

  const graphMeta = g.graph() || {};
  const width = Math.max(300, (graphMeta.width || 0) + 80);
  const height = Math.max(200, (graphMeta.height || 0) + 80);

  return {
    nodes,
    edges,
    width,
    height,
    criticalPath,
    maxBlockedCount,
    maxBlockingTaskId,
  };
}
