export interface GraphTaskItem {
  id: string;
  projectId: string;
  slug: string;
  title: string;
  status: string;
  level?: string;
  modelChain?: string[] | string | null;
  dependsOn?: string | string[];
  updatedAt?: string;
  createdAt?: string;
  currentRun?: {
    model?: string;
    profileName?: string;
    engine?: string | null;
  } | null;
}

export interface TaskGraphNode {
  id: string;
  projectId: string;
  slug: string;
  title: string;
  status: string;
  level: string;
  modelChain?: string[];
  currentRun?: {
    model?: string;
    profileName?: string;
    engine?: string | null;
  } | null;
  blockedCount: number;
  isCritical: boolean;
  isMaxBlocker: boolean;
}

export interface TaskGraphEdge {
  from: string;
  to: string;
  isCritical: boolean;
}

export interface TaskGraphResult {
  nodes: TaskGraphNode[];
  edges: TaskGraphEdge[];
  criticalPath: string[];
  maxBlockingTaskId: string | null;
  maxBlockedCount: number;
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
      // If not JSON, try comma-separated
      return trimmed.split(',').map((s) => s.trim()).filter(Boolean);
    }
  }
  return [];
}

function normalizeId(id: string): string {
  return id.replace('/', '~');
}

/**
 * Filter tasks according to includeDone option:
 * - 'true' / 'all': keep all done tasks
 * - 'false' / 'active_chains' (default): only keep done tasks that are prerequisites for at least one unfinished task
 * - number or '<N>d' (e.g. '7d'): keep done tasks updated within the last N days (or part of active chains)
 */
export function filterTasksForGraph(
  tasks: GraphTaskItem[],
  options?: {
    project?: string;
    includeDone?: string | boolean;
  }
): GraphTaskItem[] {
  let list = [...tasks];
  if (options?.project && options.project !== 'all') {
    list = list.filter((t) => t.projectId === options.project);
  }

  const includeDone = options?.includeDone;
  if (includeDone === true || includeDone === 'true' || includeDone === 'all') {
    return list;
  }

  // Parse days cutoff if e.g. "7" or "7d"
  let daysCutoff: number | null = null;
  if (typeof includeDone === 'string' && includeDone !== 'false' && includeDone !== 'active_chains') {
    const match = includeDone.match(/^(\d+)(?:d)?$/);
    if (match) {
      daysCutoff = parseInt(match[1], 10);
    }
  }

  // Build downstream map to determine if a done task has unfinished descendants
  const taskMap = new Map<string, GraphTaskItem>();
  const slugMap = new Map<string, GraphTaskItem>();
  for (const t of list) {
    taskMap.set(t.id, t);
    taskMap.set(normalizeId(t.id), t);
    taskMap.set(t.id.replace('~', '/'), t);
    slugMap.set(t.slug, t);
    slugMap.set(`${t.projectId}/${t.slug}`, t);
    slugMap.set(`${t.projectId}~${t.slug}`, t);
  }

  const downstreamMap = new Map<string, string[]>();
  for (const t of list) {
    const parentIds = parseDependsOn(t.dependsOn);
    for (const p of parentIds) {
      const parent = taskMap.get(p) || taskMap.get(normalizeId(p)) || slugMap.get(p);
      if (parent && parent.id !== t.id) {
        const arr = downstreamMap.get(parent.id) || [];
        arr.push(t.id);
        downstreamMap.set(parent.id, arr);
      }
    }
  }

  // Check if a task has any unfinished descendant
  const unfinishedIds = new Set(list.filter((t) => t.status !== 'done').map((t) => t.id));
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
    if (t.status !== 'done') return true;

    // Active chain check: part of a chain with remaining work
    if (hasUnfinishedDescendant(t.id)) return true;

    // If days cutoff is specified, check updatedAt / createdAt
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

export function computeTaskGraph(tasks: GraphTaskItem[]): TaskGraphResult {
  // Index tasks
  const taskMap = new Map<string, GraphTaskItem>();
  const slugMap = new Map<string, GraphTaskItem>();
  for (const t of tasks) {
    taskMap.set(t.id, t);
    taskMap.set(normalizeId(t.id), t);
    taskMap.set(t.id.replace('~', '/'), t);
    slugMap.set(t.slug, t);
    slugMap.set(`${t.projectId}/${t.slug}`, t);
    slugMap.set(`${t.projectId}~${t.slug}`, t);
  }

  // Build edges: parent -> child (prerequisite -> dependent)
  const edgesMap = new Map<string, Set<string>>();
  const rawEdges: Array<{ from: string; to: string }> = [];

  for (const task of tasks) {
    const parentRefs = parseDependsOn(task.dependsOn);
    for (const ref of parentRefs) {
      const parent = taskMap.get(ref) || taskMap.get(normalizeId(ref)) || slugMap.get(ref);
      if (parent && parent.id !== task.id) {
        const from = parent.id;
        const to = task.id;
        if (!edgesMap.has(from)) {
          edgesMap.set(from, new Set());
        }
        if (!edgesMap.get(from)!.has(to)) {
          edgesMap.get(from)!.add(to);
          rawEdges.push({ from, to });
        }
      }
    }
  }

  // 1. Calculate blocked counts for each task:
  // Count reachable unfinished tasks downstream from task (only if task is unfinished)
  const unfinishedTasks = tasks.filter((t) => t.status !== 'done');
  const unfinishedIdSet = new Set(unfinishedTasks.map((t) => t.id));

  const blockedCounts = new Map<string, number>();
  for (const task of tasks) {
    if (task.status === 'done') {
      blockedCounts.set(task.id, 0);
      continue;
    }

    // Traverse downstream
    const visited = new Set<string>();
    const queue = [task.id];
    let count = 0;

    while (queue.length > 0) {
      const curr = queue.shift()!;
      const children = edgesMap.get(curr);
      if (children) {
        for (const childId of children) {
          if (!visited.has(childId)) {
            visited.add(childId);
            if (unfinishedIdSet.has(childId)) {
              count++;
            }
            queue.push(childId);
          }
        }
      }
    }
    blockedCounts.set(task.id, count);
  }

  let maxBlockedCount = 0;
  let maxBlockingTaskId: string | null = null;
  for (const [id, count] of blockedCounts.entries()) {
    if (count > maxBlockedCount) {
      maxBlockedCount = count;
      maxBlockingTaskId = id;
    }
  }

  // 2. Compute critical path: longest chain of unfinished tasks
  // Unfinished subgraph edges: u -> v where both u, v in unfinishedIdSet and u -> v in edgesMap
  const unfinishedAdj = new Map<string, string[]>();
  for (const u of unfinishedIdSet) {
    const children = edgesMap.get(u);
    if (children) {
      const validChildren = Array.from(children).filter((c) => unfinishedIdSet.has(c));
      unfinishedAdj.set(u, validChildren);
    } else {
      unfinishedAdj.set(u, []);
    }
  }

  const memo = new Map<string, string[]>();
  const visiting = new Set<string>();

  function getLongestPath(nodeId: string): string[] {
    if (visiting.has(nodeId)) {
      return [nodeId]; // cycle prevention
    }
    if (memo.has(nodeId)) {
      return memo.get(nodeId)!;
    }

    visiting.add(nodeId);
    const successors = unfinishedAdj.get(nodeId) || [];
    let bestTail: string[] = [];

    for (const next of successors) {
      const nextPath = getLongestPath(next);
      if (nextPath.length > bestTail.length) {
        bestTail = nextPath;
      }
    }

    visiting.delete(nodeId);
    const result = [nodeId, ...bestTail];
    memo.set(nodeId, result);
    return result;
  }

  let criticalPath: string[] = [];
  for (const u of unfinishedIdSet) {
    const path = getLongestPath(u);
    if (path.length > criticalPath.length) {
      criticalPath = path;
    }
  }

  const criticalPathNodeSet = new Set(criticalPath);
  const criticalEdgeSet = new Set<string>();
  for (let i = 0; i < criticalPath.length - 1; i++) {
    criticalEdgeSet.add(`${criticalPath[i]}->${criticalPath[i + 1]}`);
  }

  // 3. Assemble nodes and edges
  const nodes: TaskGraphNode[] = tasks.map((task) => {
    let modelChain: string[] | undefined;
    if (task.modelChain) {
      if (Array.isArray(task.modelChain)) {
        modelChain = task.modelChain;
      } else if (typeof task.modelChain === 'string') {
        try {
          modelChain = JSON.parse(task.modelChain);
        } catch {
          modelChain = [task.modelChain];
        }
      }
    }

    const count = blockedCounts.get(task.id) || 0;
    const isCritical = criticalPathNodeSet.has(task.id);
    const isMaxBlocker = maxBlockedCount > 0 && count === maxBlockedCount;

    return {
      id: task.id,
      projectId: task.projectId,
      slug: task.slug,
      title: task.title,
      status: task.status,
      level: task.level || 'easy',
      modelChain,
      currentRun: task.currentRun,
      blockedCount: count,
      isCritical,
      isMaxBlocker,
    };
  });

  const edges: TaskGraphEdge[] = rawEdges.map((e) => ({
    from: e.from,
    to: e.to,
    isCritical: criticalEdgeSet.has(`${e.from}->${e.to}`),
  }));

  return {
    nodes,
    edges,
    criticalPath,
    maxBlockingTaskId,
    maxBlockedCount,
  };
}

/**
 * Detects if there is a cycle in task dependencies.
 * Returns the cycle path (e.g. ['a', 'b', 'a']) if a cycle is found, or null if acyclic.
 */
export function detectCycle(
  tasks: Array<{ id: string; slug?: string; projectId?: string; dependsOn?: string | string[] }>,
): string[] | null {
  const taskMap = new Map<string, string>();
  for (const t of tasks) {
    const id = t.id;
    taskMap.set(id, id);
    taskMap.set(id.replace('/', '~'), id);
    taskMap.set(id.replace('~', '/'), id);
    if (t.slug) {
      taskMap.set(t.slug, id);
      if (t.projectId) {
        taskMap.set(`${t.projectId}/${t.slug}`, id);
        taskMap.set(`${t.projectId}~${t.slug}`, id);
      }
    }
  }

  const adj = new Map<string, string[]>();
  for (const t of tasks) {
    const fromId = t.id;
    if (!adj.has(fromId)) adj.set(fromId, []);
    const deps = parseDependsOn(t.dependsOn);
    for (const dep of deps) {
      let resolved = taskMap.get(dep);
      if (!resolved && t.projectId && !dep.includes('/') && !dep.includes('~')) {
        resolved = taskMap.get(`${t.projectId}/${dep}`);
      }
      if (resolved) {
        adj.get(fromId)!.push(resolved);
      }
    }
  }

  const visited = new Set<string>();
  const recStack = new Set<string>();
  const stack: string[] = [];

  function dfs(curr: string): string[] | null {
    visited.add(curr);
    recStack.add(curr);
    stack.push(curr);

    const neighbors = adj.get(curr) || [];
    for (const next of neighbors) {
      if (!visited.has(next)) {
        const cycle = dfs(next);
        if (cycle) return cycle;
      } else if (recStack.has(next)) {
        const startIndex = stack.indexOf(next);
        if (startIndex !== -1) {
          return [...stack.slice(startIndex), next];
        }
        return [next, curr, next];
      }
    }

    stack.pop();
    recStack.delete(curr);
    return null;
  }

  for (const t of tasks) {
    if (!visited.has(t.id)) {
      const cycle = dfs(t.id);
      if (cycle) return cycle;
    }
  }

  return null;
}
