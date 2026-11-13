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

export function clearGitCheckCache(identifier?: string): void {
  if (!identifier) {
    gitCheckCache.clear();
    return;
  }
  for (const key of gitCheckCache.keys()) {
    if (key.includes(identifier)) {
      gitCheckCache.delete(key);
    }
  }
}

export function isGitAncestor(repoPath: string, commitOrBranch: string, targetBranch: string): boolean {
  if (!repoPath || !fs.existsSync(repoPath)) return false;
  const key = `ancestor:${repoPath}:${commitOrBranch}:${targetBranch}`;
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

  const ttl = result ? 3600_000 : 15_000;
  gitCheckCache.set(key, { result, expiresAt: now + ttl });
  return result;
}

export function isGitPushed(repoPath: string, commitOrBranch: string, targetBranch: string): boolean {
  if (!repoPath || !fs.existsSync(repoPath)) return false;
  const key = `pushed:${repoPath}:${commitOrBranch}:${targetBranch}`;
  const now = Date.now();
  const cached = gitCheckCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.result;
  }

  let result = false;
  try {
    const isLocal = isGitAncestor(repoPath, commitOrBranch, targetBranch);
    if (!isLocal) {
      result = false;
    } else {
      const remoteRef = `origin/${targetBranch}`;
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
        result = isGitAncestor(repoPath, commitOrBranch, remoteRef);
      } else {
        result = isLocal;
      }
    }
  } catch {
    result = false;
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

    if (task.pushResult) {
      try {
        const pr = typeof task.pushResult === 'string' ? JSON.parse(task.pushResult) : task.pushResult;
        if (pr && typeof pr === 'object') {
          if (pr.state === 'push_failed' || (pr.error && !task.pushedAt)) {
            pushFailed = true;
            pushError = String(pr.error || 'Push lên git thất bại');
            pushFailedAt = pr.failedAt || task.updatedAt || task.createdAt;
          }
        }
      } catch {
        // ignore malformed JSON
      }
    }

    const pushFailedEvent = events.filter((e) => e.type === 'task.push_failed').at(-1);
    const pushedEvent = events.filter((e) => e.type === 'task.pushed').at(-1);

    if (pushFailedEvent) {
      const isPushedAfter = pushedEvent && new Date(pushedEvent.ts).getTime() >= new Date(pushFailedEvent.ts).getTime();
      if (!isPushedAfter && !task.pushedAt) {
        pushFailed = true;
        if (!pushFailedAt) pushFailedAt = toApiTime(pushFailedEvent.ts) || pushFailedEvent.ts;
        if (!pushError && pushFailedEvent.payload) {
          try {
            const p = typeof pushFailedEvent.payload === 'string' ? JSON.parse(pushFailedEvent.payload) : pushFailedEvent.payload;
            pushError = String(p.error || p.message || 'Push lên git thất bại');
          } catch {
            // ignore
          }
        }
      } else {
        pushFailed = false;
      }
    }

    if (task.pushedAt) {
      pushFailed = false;
    }

    if (pushFailed) {
      let alreadyOnTarget = false;
      if (project?.path) {
        const settings = projectSettings(project);
        const targetBranch = settings.publish?.branch || project.defaultBranch || 'main';
        const taskRef = resolveTaskGitRef(task, project.path);
        if (taskRef) {
          alreadyOnTarget = isPushed(project.path, taskRef, targetBranch);
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
        if (settings.integration?.branch) {
          candidates.push(settings.integration.branch);
        }
        candidates.push('agenthub/integration');
        if (task.baseRef) {
          candidates.push(task.baseRef);
        }
        if (project.defaultBranch) {
          candidates.push(project.defaultBranch);
        }
        const taskRef = resolveTaskGitRef(task, project.path);
        if (taskRef) {
          for (const target of new Set(candidates)) {
            if (isAncestor(project.path, taskRef, target)) {
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
