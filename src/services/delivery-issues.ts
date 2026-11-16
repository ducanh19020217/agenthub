import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { TaskRow, ProjectRow, EventRow } from '../db/index.js';
import { toApiTime } from '../db/time.js';
import { projectSettings } from '../projects/settings.js';

export interface DeliveryIssue {
  kind: 'merge_failed' | 'push_failed';
  error: string;
  failedAt: string;
  files?: string[];
}

interface CacheEntry {
  result: boolean;
  expiresAt: number;
}

const gitCheckCache = new Map<string, CacheEntry>();
const taskKeyMap = new Map<string, Set<string>>();

function recordTaskKey(taskId: string, key: string): void {
  let keys = taskKeyMap.get(taskId);
  if (!keys) {
    if (taskKeyMap.size > 2000) {
      const first = taskKeyMap.keys().next().value;
      if (first) taskKeyMap.delete(first);
    }
    keys = new Set();
    taskKeyMap.set(taskId, keys);
  }
  keys.add(key);
}

export function clearGitCheckCache(identifier?: string | { repoPath?: string; ref?: string; taskId?: string }): void {
  if (!identifier) {
    gitCheckCache.clear();
    taskKeyMap.clear();
    return;
  }
  if (typeof identifier === 'string') {
    const taskKeys = taskKeyMap.get(identifier);
    if (taskKeys) {
      for (const k of taskKeys) {
        gitCheckCache.delete(k);
      }
      taskKeyMap.delete(identifier);
    }
    for (const key of gitCheckCache.keys()) {
      if (key.includes(identifier)) {
        gitCheckCache.delete(key);
      }
    }
    return;
  }
  const { repoPath, ref, taskId } = identifier;
  if (taskId && taskKeyMap.has(taskId)) {
    const taskKeys = taskKeyMap.get(taskId)!;
    for (const k of taskKeys) {
      gitCheckCache.delete(k);
    }
    taskKeyMap.delete(taskId);
  }
  for (const key of gitCheckCache.keys()) {
    if ((repoPath && key.includes(repoPath)) || (ref && key.includes(ref))) {
      gitCheckCache.delete(key);
    }
  }
}

export function clearGitCheckCacheForTask(task: TaskRow, project?: ProjectRow | null): void {
  clearGitCheckCache(task.id);
  if (task.branch) clearGitCheckCache(task.branch);
  if (task.slug) {
    clearGitCheckCache(task.slug);
    clearGitCheckCache(`agenthub/${task.slug}`);
  }
  if (project?.path) {
    const resolved = resolveTaskGitRef(task, project.path);
    if (resolved) clearGitCheckCache(resolved);
    clearGitCheckCache(project.path);
  }
}

export function isGitAncestor(repoPath: string, commitOrBranch: string, targetBranch: string, taskId?: string): boolean {
  if (!repoPath || !fs.existsSync(repoPath)) return false;
  const key = `ancestor:${repoPath}:${commitOrBranch}:${targetBranch}`;
  if (taskId) {
    recordTaskKey(taskId, key);
  }
  const now = Date.now();
  const cached = gitCheckCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.result;
  }

  let result = false;
  try {
    try {
      execFileSync('git', ['-C', repoPath, 'rev-parse', '--verify', '--quiet', targetBranch], { stdio: 'ignore' });
    } catch {
      return false;
    }

    try {
      execFileSync('git', ['-C', repoPath, 'rev-parse', '--verify', '--quiet', commitOrBranch], { stdio: 'ignore' });
    } catch {
      return false;
    }

    execFileSync('git', ['-C', repoPath, 'merge-base', '--is-ancestor', commitOrBranch, targetBranch], { stdio: 'ignore' });
    result = true;
  } catch {
    result = false;
  }

  if (gitCheckCache.size > 5000) {
    const first = gitCheckCache.keys().next().value;
    if (first) gitCheckCache.delete(first);
  }
  const ttl = result ? 3600_000 : 15_000;
  gitCheckCache.set(key, { result, expiresAt: now + ttl });
  return result;
}

export function isGitPushed(repoPath: string, commitOrBranch: string, targetBranch: string, taskId?: string): boolean {
  if (!repoPath || !fs.existsSync(repoPath)) return false;
  const key = `pushed:${repoPath}:${commitOrBranch}:${targetBranch}`;
  if (taskId) {
    recordTaskKey(taskId, key);
  }
  const now = Date.now();
  const cached = gitCheckCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.result;
  }

  let result = false;
  try {
    const localBranch = targetBranch.replace(/^origin\//, '');
    const isLocal = isGitAncestor(repoPath, commitOrBranch, localBranch, taskId);
    if (isLocal) {
      result = true;
    } else {
      const remoteRef = targetBranch.startsWith('origin/') ? targetBranch : `origin/${targetBranch}`;
      let hasRemote = false;
      try {
        execFileSync('git', ['-C', repoPath, 'rev-parse', '--verify', '--quiet', `refs/remotes/${remoteRef}`], { stdio: 'ignore' });
        hasRemote = true;
      } catch {
        try {
          execFileSync('git', ['-C', repoPath, 'rev-parse', '--verify', '--quiet', remoteRef], { stdio: 'ignore' });
          hasRemote = true;
        } catch {
          hasRemote = false;
        }
      }

      if (hasRemote) {
        result = isGitAncestor(repoPath, commitOrBranch, remoteRef, taskId);
      }
    }
  } catch {
    result = false;
  }

  if (gitCheckCache.size > 5000) {
    const first = gitCheckCache.keys().next().value;
    if (first) gitCheckCache.delete(first);
  }
  const ttl = result ? 3600_000 : 15_000;
  gitCheckCache.set(key, { result, expiresAt: now + ttl });
  return result;
}

export function extractConflictFiles(errorMsg: string): string[] {
  if (!errorMsg) return [];
  const files: string[] = [];
  const match = errorMsg.match(/Xung đột merge ở:\s*(.+)/i);
  if (match && match[1]) {
    const rawFiles = match[1].split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
    files.push(...rawFiles);
  } else if (/CONFLICT/i.test(errorMsg)) {
    const lines = errorMsg.split('\n');
    for (const line of lines) {
      const conflictMatch = line.match(/Merge conflict in\s+(.+)/i);
      if (conflictMatch && conflictMatch[1]) {
        files.push(conflictMatch[1].trim());
      }
    }
  }
  return Array.from(new Set(files));
}

export function resolveTaskGitRef(task: TaskRow, _projectPath?: string): string | null {
  if (task.branch) return task.branch;
  if (task.slug) return `agenthub/${task.slug}`;
  if (task.worktreePath && fs.existsSync(task.worktreePath)) {
    try {
      const headSha = execFileSync('git', ['-C', task.worktreePath, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
      if (headSha) return headSha;
    } catch {
      // ignore
    }
  }
  return null;
}

export function computeDeliveryIssue(
  task: TaskRow,
  events: EventRow[],
  project?: ProjectRow | null,
  options?: {
    isAncestorFn?: (repoPath: string, commitOrBranch: string, targetBranch: string) => boolean;
    isPushedFn?: (repoPath: string, commitOrBranch: string, targetBranch: string) => boolean;
  },
): DeliveryIssue | null {
  const isAncestor = options?.isAncestorFn || isGitAncestor;
  const isPushed = options?.isPushedFn || isGitPushed;

  // 1. push_failed: task done có pushResult lỗi gần nhất (task.push_failed), chưa có task.pushed sau đó, và commit của task chưa có trên nhánh đích (local và remote).
  if (task.status === 'done') {
    let pushFailed = false;
    let pushError = '';
    let pushFailedAt = '';
    let actualFailureTs: number | undefined;

    let pushResultHasError = false;
    let pushResultError = '';
    let pushResultFailedAt: string | undefined;
    let pushResultTs: number | undefined;

    if (task.pushResult) {
      try {
        const pr = typeof task.pushResult === 'string' ? JSON.parse(task.pushResult) : task.pushResult;
        if (pr && typeof pr === 'object') {
          if (pr.state === 'push_failed' || pr.error) {
            pushResultHasError = true;
            pushResultError = String(pr.error || 'Push lên git thất bại');
            if (pr.failedAt) {
              const ts = new Date(pr.failedAt).getTime();
              if (!isNaN(ts)) {
                pushResultFailedAt = pr.failedAt;
                pushResultTs = ts;
              }
            }
          }
        }
      } catch {
        // ignore malformed JSON
      }
    }

    const pushFailedEvent = events.filter((e) => e.type === 'task.push_failed').at(-1);
    let eventHasError = false;
    let eventError = '';
    let eventFailedAt: string | undefined;
    let eventTs: number | undefined;

    if (pushFailedEvent) {
      eventHasError = true;
      const ts = new Date(pushFailedEvent.ts).getTime();
      if (!isNaN(ts)) {
        eventTs = ts;
        eventFailedAt = toApiTime(pushFailedEvent.ts) || pushFailedEvent.ts;
      }
      if (pushFailedEvent.payload) {
        try {
          const p = typeof pushFailedEvent.payload === 'string' ? JSON.parse(pushFailedEvent.payload) : pushFailedEvent.payload;
          eventError = String(p.error || p.message || 'Push lên git thất bại');
        } catch {
          // ignore
        }
      }
    }

    if (pushResultHasError || eventHasError) {
      pushFailed = true;

      // Determine actual failure timestamp and error/time strings independently
      if (pushResultTs !== undefined && eventTs !== undefined) {
        if (pushResultTs > eventTs) {
          actualFailureTs = pushResultTs;
          pushFailedAt = pushResultFailedAt!;
          pushError = pushResultError || eventError || 'Push lên git thất bại';
        } else {
          actualFailureTs = eventTs;
          pushFailedAt = eventFailedAt || toApiTime(pushFailedEvent!.ts) || pushFailedEvent!.ts;
          pushError = eventError || pushResultError || 'Push lên git thất bại';
        }
      } else if (eventTs !== undefined) {
        actualFailureTs = eventTs;
        pushFailedAt = eventFailedAt || toApiTime(pushFailedEvent!.ts) || pushFailedEvent!.ts;
        pushError = eventError || pushResultError || 'Push lên git thất bại';
      } else if (pushResultTs !== undefined) {
        actualFailureTs = pushResultTs;
        pushFailedAt = pushResultFailedAt!;
        pushError = pushResultError || 'Push lên git thất bại';
      } else {
        // Error recorded in pushResult without failedAt and no task.push_failed event
        actualFailureTs = undefined;
        pushFailedAt = toApiTime(task.updatedAt) || task.updatedAt || toApiTime(task.createdAt) || task.createdAt;
        pushError = pushResultError || eventError || 'Push lên git thất bại';
      }
    }

    if (pushFailed) {
      const pushedEvent = events.filter((e) => e.type === 'task.pushed').at(-1);
      if (pushedEvent) {
        const pushedTs = new Date(pushedEvent.ts).getTime();
        if (!isNaN(pushedTs)) {
          if (actualFailureTs === undefined || pushedTs >= actualFailureTs) {
            pushFailed = false;
          }
        }
      }

      if (task.pushedAt) {
        const pushedAtTs = new Date(task.pushedAt).getTime();
        if (isNaN(pushedAtTs) || actualFailureTs === undefined || pushedAtTs >= actualFailureTs) {
          pushFailed = false;
        }
      }
    }

    if (pushFailed) {
      let alreadyOnTarget = false;
      if (project?.path) {
        const settings = projectSettings(project);
        const targetBranch = settings.publish?.branch || project.defaultBranch || 'main';
        const taskRef = resolveTaskGitRef(task, project.path);
        if (taskRef) {
          alreadyOnTarget = isPushed(project.path, taskRef, targetBranch, task.id);
        }
      }

      if (!alreadyOnTarget) {
        return {
          kind: 'push_failed',
          error: pushError || 'Push lên git thất bại',
          failedAt: toApiTime(pushFailedAt) || pushFailedAt || toApiTime(task.updatedAt) || task.updatedAt,
        };
      }
    }
  }

  // 2. merge_failed: task không ở trạng thái kết thúc khác (pushed/cancelled/failed), có lần merge vào integration (hoặc nhánh đích nếu project không dùng integration) thất bại gần nhất, và nhánh task thực sự chưa được merge.
  const TERMINAL_EXCLUDED = ['pushed', 'cancelled', 'failed'];
  if (!TERMINAL_EXCLUDED.includes(task.status)) {
    const mergeEvents = events.filter((e) =>
      e.type === 'merge.conflict' ||
      e.type === 'merge.failed' ||
      e.type === 'task.merged' ||
      (e.type === 'review.auto_merge_skipped' && (() => {
        try {
          const p = typeof e.payload === 'string' ? JSON.parse(e.payload) : e.payload;
          return p?.reason === 'merge_failed';
        } catch {
          return false;
        }
      })())
    );

    const lastEvent = mergeEvents.at(-1);
    if (lastEvent && lastEvent.type !== 'task.merged') {
      let error = '';
      let files: string[] = [];
      const failedAt = toApiTime(lastEvent.ts) || lastEvent.ts;

      if (lastEvent.payload) {
        try {
          const p = typeof lastEvent.payload === 'string' ? JSON.parse(lastEvent.payload) : lastEvent.payload;
          error = String(p.message || p.error || (lastEvent.type === 'merge.conflict' ? 'Merge bị xung đột' : 'Merge thất bại'));
          if (Array.isArray(p.files)) {
            files = p.files.map(String).filter(Boolean);
          } else if (typeof p.files === 'string') {
            files = p.files.split(',').map((s: string) => s.trim()).filter(Boolean);
          }
        } catch {
          // ignore
        }
      }

      if (!error) {
        error = lastEvent.type === 'merge.conflict' ? 'Merge bị xung đột' : 'Merge thất bại';
      }

      if (files.length === 0) {
        files = extractConflictFiles(error);
      }

      let alreadyMerged = false;
      if (project?.path) {
        const settings = projectSettings(project);
        const candidates: string[] = [];
        if (settings.integration.enabled) {
          candidates.push(settings.integration.branch || 'agenthub/integration');
        } else {
          candidates.push(settings.publish?.branch || task.baseRef || project.defaultBranch || 'main');
        }
        const taskRef = resolveTaskGitRef(task, project.path);
        if (taskRef) {
          for (const target of new Set(candidates)) {
            if (isAncestor(project.path, taskRef, target, task.id)) {
              alreadyMerged = true;
              break;
            }
          }
        }
      }

      if (!alreadyMerged) {
        return {
          kind: 'merge_failed',
          error,
          failedAt,
          ...(files.length > 0 ? { files } : {}),
        };
      }
    }
  }

  return null;
}
