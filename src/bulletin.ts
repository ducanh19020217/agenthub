import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { AgentHubConfig } from './config.js';
import { ProjectRepo, TaskRepo, TaskNoteRepo, TaskNoteRow, TaskRow } from './db/index.js';
import { EventBus } from './scheduler/index.js';

const execFileAsync = promisify(execFile);

export function parsePorcelainOutput(output: string): string[] {
  const files: string[] = [];
  const lines = output.split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    let filePath = line;
    if (line.includes(' -> ')) {
      filePath = line.split(' -> ')[1].trim();
    } else if (rawLine.length >= 3) {
      filePath = rawLine.slice(3).trim();
    }
    if (filePath.startsWith('"') && filePath.endsWith('"')) {
      filePath = filePath.slice(1, -1);
    }
    filePath = filePath.replace(/\\/g, '/');
    if (!filePath || filePath.startsWith('.agenthub/') || filePath.startsWith('.git/')) {
      continue;
    }
    files.push(filePath);
  }
  return files;
}

export function parseDiffOutput(output: string): string[] {
  const files: string[] = [];
  for (const rawLine of output.split('\n')) {
    let filePath = rawLine.trim();
    if (!filePath) continue;
    if (filePath.startsWith('"') && filePath.endsWith('"')) {
      filePath = filePath.slice(1, -1);
    }
    filePath = filePath.replace(/\\/g, '/');
    if (!filePath || filePath.startsWith('.agenthub/') || filePath.startsWith('.git/')) {
      continue;
    }
    files.push(filePath);
  }
  return files;
}

export function getChangedFilesForWorktree(
  worktreePath: string,
  baseRef: string,
  exec?: (cmd: string, args: string[], opts?: { encoding: 'utf-8' }) => string,
): Set<string> {
  const changed = new Set<string>();
  if (!fs.existsSync(worktreePath)) return changed;

  const runCmd = (args: string[]): string => {
    if (exec) {
      return exec('git', args, { encoding: 'utf-8' });
    }
    try {
      return execFileSync('git', args, { cwd: worktreePath, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      return '';
    }
  };

  // 1. git diff --name-only <baseRef>
  let diffOut = runCmd(['-C', worktreePath, 'diff', '--name-only', baseRef]);
  if (!diffOut) {
    diffOut = runCmd(['-C', worktreePath, 'diff', '--name-only', 'HEAD']);
  }
  for (const f of parseDiffOutput(diffOut)) {
    changed.add(f);
  }

  // 2. git status --porcelain
  const statusOut = runCmd(['-C', worktreePath, 'status', '--porcelain']);
  for (const f of parsePorcelainOutput(statusOut)) {
    changed.add(f);
  }

  return changed;
}

const GIT_ASYNC_TIMEOUT_MS = 30_000;

/** Async variant: runs git diff + git status concurrently, timeout 30 s. */
async function getChangedFilesForWorktreeAsync(worktreePath: string, baseRef: string): Promise<Set<string>> {
  const changed = new Set<string>();
  if (!fs.existsSync(worktreePath)) return changed;

  const runGit = async (args: string[]): Promise<string> => {
    try {
      const { stdout } = await execFileAsync('git', args, {
        cwd: worktreePath,
        encoding: 'utf-8',
        timeout: GIT_ASYNC_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
      });
      return stdout;
    } catch {
      return '';
    }
  };

  const [diffOut1, statusOut] = await Promise.all([
    runGit(['-C', worktreePath, 'diff', '--name-only', baseRef]),
    runGit(['-C', worktreePath, 'status', '--porcelain']),
  ]);

  let diffOut = diffOut1;
  if (!diffOut) {
    diffOut = await runGit(['-C', worktreePath, 'diff', '--name-only', 'HEAD']);
  }

  for (const f of parseDiffOutput(diffOut)) changed.add(f);
  for (const f of parsePorcelainOutput(statusOut)) changed.add(f);
  return changed;
}

export function formatBulletinMarkdown(
  task: TaskRow,
  projectNotes: TaskNoteRow[],
): string {
  const relatedOverlaps = projectNotes.filter(
    (n) =>
      n.kind === 'overlap' &&
      (n.taskId === task.id ||
        n.content.includes(task.id) ||
        n.content.includes(task.slug)),
  );

  const otherNotes = projectNotes.filter(
    (n) => n.kind === 'note' && n.taskId !== task.id,
  );

  const lines: string[] = ['# Bảng tin dự án', ''];

  lines.push('## Cảnh báo trùng file liên quan');
  if (relatedOverlaps.length > 0) {
    for (const o of relatedOverlaps) {
      lines.push(`- **[TRÙNG FILE]** ${o.content} (${o.createdAt})`);
    }
  } else {
    lines.push('- Không có cảnh báo trùng file nào.');
  }
  lines.push('');

  lines.push('## Tin từ các task khác');
  if (otherNotes.length > 0) {
    for (const n of otherNotes) {
      lines.push(`- **[${n.taskId}]** (${n.createdAt}): ${n.content}`);
    }
  } else {
    lines.push('- Không có tin tức mới từ các task khác.');
  }
  lines.push('');

  return lines.join('\n');
}

export interface BulletinServiceOptions {
  config: AgentHubConfig;
  taskRepo: TaskRepo;
  projectRepo: ProjectRepo;
  taskNoteRepo: TaskNoteRepo;
  eventBus: EventBus;
  exec?: (cmd: string, args: string[], opts?: { encoding: 'utf-8' }) => string;
}

export class BulletinService {
  private config: AgentHubConfig;
  private taskRepo: TaskRepo;
  private projectRepo: ProjectRepo;
  private taskNoteRepo: TaskNoteRepo;
  private eventBus: EventBus;
  private exec?: (cmd: string, args: string[], opts?: { encoding: 'utf-8' }) => string;
  private timer: NodeJS.Timeout | null = null;
  private isChecking = false;

  constructor(opts: BulletinServiceOptions) {
    this.config = opts.config;
    this.taskRepo = opts.taskRepo;
    this.projectRepo = opts.projectRepo;
    this.taskNoteRepo = opts.taskNoteRepo;
    this.eventBus = opts.eventBus;
    this.exec = opts.exec;
  }

  start(): void {
    if (this.timer) return;
    const intervalSec = Math.max(1, this.config.context?.overlapCheckSec ?? 60);
    this.timer = setInterval(() => {
      void this.checkOverlaps();
    }, intervalSec * 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  checkOverlaps(): Promise<{
    overlapsFound: Array<{ taskId: string; otherTaskId: string; file: string }>;
  }> {
    if (this.isChecking) return Promise.resolve({ overlapsFound: [] });
    this.isChecking = true;

    return this._doCheckOverlaps().finally(() => {
      this.isChecking = false;
    });
  }

  private async _doCheckOverlaps(): Promise<{
    overlapsFound: Array<{ taskId: string; otherTaskId: string; file: string }>;
  }> {
    const runningTasks = this.taskRepo.getByStatus('running');
    const tasksByProject = new Map<string, TaskRow[]>();
    for (const t of runningTasks) {
      const list = tasksByProject.get(t.projectId) || [];
      list.push(t);
      tasksByProject.set(t.projectId, list);
    }

    const overlapsFound: Array<{ taskId: string; otherTaskId: string; file: string }> = [];

    for (const [projectId, tasks] of tasksByProject.entries()) {
      const project = this.projectRepo.get(projectId);
      if (tasks.length < 2) {
        continue;
      }

      // Collect changed files for each task in parallel (max 2 concurrent git processes)
      const CONCURRENCY = 2;
      const filesByTask = new Map<string, Set<string>>();
      const eligible = tasks.filter((t) => t.worktreePath && fs.existsSync(t.worktreePath));

      for (let i = 0; i < eligible.length; i += CONCURRENCY) {
        const batch = eligible.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map(async (task) => {
          const baseRef = task.baseRef || project?.defaultBranch || 'main';
          const files = this.exec
            ? getChangedFilesForWorktree(task.worktreePath!, baseRef, this.exec)
            : await getChangedFilesForWorktreeAsync(task.worktreePath!, baseRef);
          filesByTask.set(task.id, files);
        }));
      }

      let newOverlapsInProject = false;

      for (let i = 0; i < tasks.length; i++) {
        for (let j = i + 1; j < tasks.length; j++) {
          const taskA = tasks[i];
          const taskB = tasks[j];
          const filesA = filesByTask.get(taskA.id);
          const filesB = filesByTask.get(taskB.id);
          if (!filesA || !filesB) continue;

          const pairFiles: string[] = [];
          for (const file of filesA) {
            if (filesB.has(file)) {
              const hasA = this.taskNoteRepo.hasOverlap(taskA.id, taskB.id, file);
              const hasB = this.taskNoteRepo.hasOverlap(taskB.id, taskA.id, file);

              if (!hasA || !hasB) {
                if (!hasA) {
                  this.taskNoteRepo.insert({
                    projectId: taskA.projectId,
                    taskId: taskA.id,
                    kind: 'overlap',
                    content: `Trùng sửa file ${file} với task ${taskB.id}`,
                  });
                }
                if (!hasB) {
                  this.taskNoteRepo.insert({
                    projectId: taskB.projectId,
                    taskId: taskB.id,
                    kind: 'overlap',
                    content: `Trùng sửa file ${file} với task ${taskA.id}`,
                  });
                }

                newOverlapsInProject = true;
                overlapsFound.push({
                  taskId: taskA.id,
                  otherTaskId: taskB.id,
                  file,
                });
                pairFiles.push(file);
              }
            }
          }
          // One notification per task pair, not one per shared file.
          if (pairFiles.length > 0) {
            this.eventBus.emit('task.overlap', taskA.id, {
              otherTaskId: taskB.id,
              file: pairFiles.length === 1 ? pairFiles[0] : `${pairFiles[0]} (+${pairFiles.length - 1} file)`,
              files: pairFiles,
              projectId,
            });
          }
        }
      }

      if (newOverlapsInProject) {
        this.updateBulletinsForProject(projectId);
      }
    }

    return { overlapsFound };
  }

  updateBulletinForTask(task: TaskRow): void {
    if (!task.worktreePath || !fs.existsSync(task.worktreePath)) return;
    const contextDir = path.join(task.worktreePath, '.agenthub', 'context');
    if (!fs.existsSync(contextDir)) {
      fs.mkdirSync(contextDir, { recursive: true });
    }
    const notes = this.taskNoteRepo.getByProject(task.projectId);
    const md = formatBulletinMarkdown(task, notes);
    fs.writeFileSync(path.join(contextDir, 'bulletin.md'), md, 'utf-8');
  }

  updateBulletinsForProject(projectId: string): void {
    const runningTasks = this.taskRepo
      .getByStatus('running')
      .filter((t) => t.projectId === projectId);
    for (const task of runningTasks) {
      this.updateBulletinForTask(task);
    }
  }
}
