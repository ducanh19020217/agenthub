import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';
import { AgentHubConfig } from '../config.js';
import { ensureWorktreeNodeModules } from '../cache.js';
import { projectSettings } from '../projects/settings.js';
import { reap, reapSyncForWorktree } from '../reaper.js';
import { isProjectWorktreeRootAccessible, projectWorktreeRoot, projectWorktreeRoots, resolveProjectFile } from '../projects/paths.js';

const execFileAsync = promisify(execFile);
const WORKTREE_GIT_TIMEOUT_MS = 10 * 60 * 1000;

export interface WorktreeInfo {
  worktreePath: string;
  slot: number;
}

export interface WorktreePoolOptions {
  projectPath: string;
  projectId: string;
  projectSettings?: string | null;
  slug: string;
  branch: string;
  baseRef: string;
  taskId?: string;
  diskAvailable?: () => boolean;
}

export interface WorktreeHookContext {
  slot?: number | null;
  slug?: string;
  projectId?: string;
  taskId?: string;
  hooks?: { onWorktreeRemoved?: string[] } | null;
  eventBus?: { emit: (type: string, taskId?: string, payload?: unknown) => boolean };
}

export interface DependencyContext {
  id: string;
  title: string;
  projectId?: string;
  projectName?: string;
  repoPath?: string;
  isCrossProject?: boolean;
  doneContent?: string;
  review?: string;
  diffStat?: string;
}

export interface KnowledgeContext {
  content: string;
  taskId: string;
  pinned: number;
  createdAt: string;
}

export function resolveReal(target: string): string {
  const resolved = path.resolve(target);
  try {
    return fs.realpathSync(resolved);
  } catch {
    // If target does not exist, walk up to find the nearest existing ancestor,
    // resolve its real path, and append the non-existent relative segments.
    // Handles macOS symlinked temp directories (e.g. /var -> /private/var).
    let cur = resolved;
    const parts: string[] = [];
    while (cur !== path.dirname(cur)) {
      parts.unshift(path.basename(cur));
      cur = path.dirname(cur);
      try {
        const realParent = fs.realpathSync(cur);
        return path.join(realParent, ...parts);
      } catch {
        // Continue walking up
      }
    }
    return resolved;
  }
}

/**
 * A path may only be deleted by AgentHub if it lies strictly inside the hub's worktrees
 * directory and is neither a project root nor an ancestor of one.
 *
 * Sự cố 16/10: task import từ thời agy-run có worktreePath = thư mục gốc repo; `git worktree
 * remove` từ chối worktree chính và nhánh fallback rmSync đã xóa cả repo (kèm .git).
 */
export function isDeletableWorktreePath(
  worktreesDir: string | string[],
  target: string | null | undefined,
  protectedPaths: Array<string | null | undefined> = [],
): boolean {
  if (!target) return false;
  const resolved = resolveReal(target);
  const bases = (Array.isArray(worktreesDir) ? worktreesDir : [worktreesDir]).map(resolveReal);
  if (!bases.some((base) => resolved.startsWith(base + path.sep))) return false;
  for (const p of protectedPaths) {
    if (!p) continue;
    const prot = resolveReal(p);
    if (resolved === prot || prot.startsWith(resolved + path.sep)) return false;
  }
  return true;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function shellWord(value: string): string {
  return /^[A-Za-z0-9_./:-]+$/.test(value) ? value : shellQuote(value);
}


export const MAX_WORKTREE_SLOTS = 30;
export class WorktreeService {
  private poolRefills = new Map<string, Promise<void>>();
  constructor(
    private config: AgentHubConfig,
    private eventBus?: { emit: (type: string, taskId?: string, payload?: unknown) => boolean },
  ) {}

  /**
   * Allocate a slot number (1-9) for a project.
   * Uses the smallest number not taken by currently running tasks.
   */
  allocateSlot(projectId: string, usedSlots: number[]): number {
    // Tasks parked in review keep their slot, so a small pool silently froze the queue.
    for (let i = 1; i <= MAX_WORKTREE_SLOTS; i++) {
      if (!usedSlots.includes(i)) return i;
    }
    throw new Error(`All ${MAX_WORKTREE_SLOTS} slots for project ${projectId} are in use`);
  }

  /**
   * Create a git worktree for a task.
   * Returns the worktree path.
   */
  create(opts: {
    projectPath: string;
    projectId: string;
    projectSettings?: string | null;
    slug: string;
    branch: string;
    baseRef: string;
  }): string {
    if (opts.slug === '.integration' || opts.slug === '.logs') {
      throw new Error(`Slug không được dùng tên dành riêng: ${opts.slug}`);
    }
    const project = { id: opts.projectId, path: opts.projectPath, settings: opts.projectSettings };
    if (!isProjectWorktreeRootAccessible(project)) {
      throw new Error(`Project worktree root không truy cập được: ${projectWorktreeRoot(project, this.config.hubHome, this.config.worktreesDir)}`);
    }
    const worktreePath = path.join(
      projectWorktreeRoot(project, this.config.hubHome, this.config.worktreesDir),
      opts.slug,
    );

    // Ensure parent directory exists
    const parentDir = path.dirname(worktreePath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    // Remove existing worktree if present
    if (fs.existsSync(worktreePath)) {
      this.remove(opts.projectPath, worktreePath, undefined, projectWorktreeRoots(project, this.config.hubHome, this.config.worktreesDir));
    }

    // Create worktree
    try {
      execFileSync('git', [
        '-C', opts.projectPath,
        'worktree', 'add',
        worktreePath,
        '-b', opts.branch,
        opts.baseRef,
      ]);
    } catch {
      // Branch might already exist, try without -b
      try {
        execFileSync('git', [
          '-C', opts.projectPath,
          'worktree', 'add',
          worktreePath,
          opts.branch,
        ]);
      } catch (e) {
        throw new Error(`Failed to create worktree: ${e}`);
      }
    }

    // Add .agenthub/ to .git/info/exclude
    this.addToExclude(worktreePath);

    return worktreePath;
  }

  /** Async counterpart used by the daemon so slow repositories do not block its event loop. */
  async createAsync(opts: {
    projectPath: string;
    projectId: string;
    projectSettings?: string | null;
    slug: string;
    branch: string;
    baseRef: string;
  }): Promise<string> {
    if (opts.slug === '.integration' || opts.slug === '.logs') {
      throw new Error(`Slug không được dùng tên dành riêng: ${opts.slug}`);
    }
    const project = { id: opts.projectId, path: opts.projectPath, settings: opts.projectSettings };
    if (!isProjectWorktreeRootAccessible(project)) {
      throw new Error(`Project worktree root không truy cập được: ${projectWorktreeRoot(project, this.config.hubHome, this.config.worktreesDir)}`);
    }
    const worktreePath = path.join(
      projectWorktreeRoot(project, this.config.hubHome, this.config.worktreesDir),
      opts.slug,
    );
    const parentDir = path.dirname(worktreePath);
    if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });

    if (fs.existsSync(worktreePath)) {
      await this.removeAsync(opts.projectPath, worktreePath, undefined, projectWorktreeRoots(project, this.config.hubHome, this.config.worktreesDir));
    }

    try {
      await execFileAsync('git', ['-C', opts.projectPath, 'worktree', 'add', worktreePath, '-b', opts.branch, opts.baseRef], {
        timeout: WORKTREE_GIT_TIMEOUT_MS,
      });
    } catch {
      try {
        await execFileAsync('git', ['-C', opts.projectPath, 'worktree', 'add', worktreePath, opts.branch], {
          timeout: WORKTREE_GIT_TIMEOUT_MS,
        });
      } catch (e) {
        throw new Error(`Failed to create worktree: ${e}`);
      }
    }

    await this.addToExcludeAsync(worktreePath);
    return worktreePath;
  }

  /** Move a prepared detached worktree into the task location and attach its branch. */
  async acquireFromPool(opts: WorktreePoolOptions): Promise<string | null> {
    const settings = projectSettings({ settings: opts.projectSettings });
    if (settings.worktree.warmPool <= 0) {
      this.eventBus?.emit('worktree.pool_miss', opts.taskId, { reason: 'disabled', projectId: opts.projectId });
      return null;
    }
    const project = { id: opts.projectId, path: opts.projectPath, settings: opts.projectSettings };
    const root = projectWorktreeRoot(project, this.config.hubHome, this.config.worktreesDir);
    const poolRoot = path.join(root, '.pool');
    const target = path.join(root, opts.slug);
    if (!fs.existsSync(poolRoot)) {
      this.eventBus?.emit('worktree.pool_miss', opts.taskId, { reason: 'empty', projectId: opts.projectId });
      return null;
    }
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(poolRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()); } catch {
      entries = [];
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
      const candidate = path.join(poolRoot, entry.name);
      try {
        await execFileAsync('git', ['-C', candidate, 'rev-parse', '--git-dir'], { timeout: 30_000 });
        await execFileAsync('git', ['-C', opts.projectPath, 'worktree', 'move', candidate, target], { timeout: WORKTREE_GIT_TIMEOUT_MS });
        await execFileAsync('git', ['-C', target, 'checkout', '-B', opts.branch, opts.baseRef], { timeout: WORKTREE_GIT_TIMEOUT_MS });
        await this.addToExcludeAsync(target);
        const status = await execFileAsync('git', ['-C', target, 'status', '--porcelain'], { encoding: 'utf8', timeout: 30_000 });
        if (status.stdout.trim()) throw new Error('pooled worktree is dirty');
        this.eventBus?.emit('worktree.pool_hit', opts.taskId, { projectId: opts.projectId, poolPath: candidate, worktreePath: target });
        return target;
      } catch (error) {
        if (fs.existsSync(target)) {
          await this.removeAsync(opts.projectPath, target, undefined, projectWorktreeRoots(project, this.config.hubHome, this.config.worktreesDir)).catch(() => undefined);
        }
        if (fs.existsSync(candidate)) {
          await this.removeAsync(opts.projectPath, candidate, undefined, projectWorktreeRoots(project, this.config.hubHome, this.config.worktreesDir)).catch(() => undefined);
        }
        this.eventBus?.emit('worktree.pool_miss', opts.taskId, { projectId: opts.projectId, reason: String(error) });
      }
    }
    return null;
  }

  /** Replenish detached worktrees in the background; calls for one project never overlap. */
  refillPool(opts: Omit<WorktreePoolOptions, 'slug' | 'branch' | 'taskId'>): Promise<void> {
    const project = { id: opts.projectId, path: opts.projectPath, settings: opts.projectSettings };
    const root = projectWorktreeRoot(project, this.config.hubHome, this.config.worktreesDir);
    const existing = this.poolRefills.get(root);
    if (existing) return existing;
    const promise = this.refillPoolInternal(opts).finally(() => {
      if (this.poolRefills.get(root) === promise) this.poolRefills.delete(root);
    });
    this.poolRefills.set(root, promise);
    return promise;
  }

  async removePoolAsync(project: { id: string; path: string; settings?: string | null }): Promise<void> {
    const root = projectWorktreeRoot(project, this.config.hubHome, this.config.worktreesDir);
    const poolRoot = path.join(root, '.pool');
    if (!fs.existsSync(poolRoot)) return;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(poolRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()); } catch { /* ignore */ }
    for (const entry of entries) {
      await this.removeAsync(project.path, path.join(poolRoot, entry.name), undefined, projectWorktreeRoots(project, this.config.hubHome, this.config.worktreesDir));
    }
    try { await fs.promises.rm(poolRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  private async refillPoolInternal(opts: Omit<WorktreePoolOptions, 'slug' | 'branch' | 'taskId'>): Promise<void> {
    const settings = projectSettings({ settings: opts.projectSettings });
    const project = { id: opts.projectId, path: opts.projectPath, settings: opts.projectSettings };
    const root = projectWorktreeRoot(project, this.config.hubHome, this.config.worktreesDir);
    const poolRoot = path.join(root, '.pool');
    if (settings.worktree.warmPool <= 0) {
      await this.removePoolAsync(project);
      return;
    }
    if (opts.diskAvailable?.() === false) return;
    fs.mkdirSync(poolRoot, { recursive: true });
    const poolEntries = fs.readdirSync(poolRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const extra of poolEntries.slice(settings.worktree.warmPool)) {
      await this.removeAsync(opts.projectPath, path.join(poolRoot, extra.name), undefined, projectWorktreeRoots(project, this.config.hubHome, this.config.worktreesDir));
    }
    for (let index = 1; index <= settings.worktree.warmPool && index <= MAX_WORKTREE_SLOTS; index++) {
      if (opts.diskAvailable?.() === false) break;
      const slot = path.join(poolRoot, String(index));
      if (fs.existsSync(slot)) continue;
      try {
        await execFileAsync('git', ['-C', opts.projectPath, 'worktree', 'add', '--detach', slot, opts.baseRef], { timeout: WORKTREE_GIT_TIMEOUT_MS });
        await this.addToExcludeAsync(slot);
        if (settings.worktree.install === 'auto') {
          const hasLock = (dir: string) => fs.existsSync(path.join(dir, 'package-lock.json')) || fs.existsSync(path.join(dir, 'pnpm-lock.yaml'));
          if (hasLock(slot) || hasLock(path.join(slot, 'web'))) {
            await ensureWorktreeNodeModules(slot, opts.projectPath, this.config.cacheDir, undefined, {
              maxEntries: this.config.cacheMaxEntries,
              maxBytes: this.config.cacheMaxGB * 1024 ** 3,
            });
          }
        }
      } catch (error) {
        console.warn(`[worktree] Failed to replenish pool ${slot}: ${error instanceof Error ? error.message : String(error)}`);
        if (fs.existsSync(slot)) await this.removeAsync(opts.projectPath, slot, undefined, projectWorktreeRoots(project, this.config.hubHome, this.config.worktreesDir)).catch(() => undefined);
      }
    }
  }

  /**
   * Add .agenthub/ and node_modules to .git/info/exclude of the worktree
   */
  private addToExclude(worktreePath: string): void {
    try {
      const excludePaths: string[] = [];

      try {
        const gitPath = execFileSync('git', ['-C', worktreePath, 'rev-parse', '--git-path', 'info/exclude'], {
          encoding: 'utf-8',
        }).trim();
        if (gitPath) {
          excludePaths.push(path.isAbsolute(gitPath) ? gitPath : path.join(worktreePath, gitPath));
        }
      } catch {
        // ignore
      }

      const gitDir = execFileSync('git', ['-C', worktreePath, 'rev-parse', '--git-dir'], {
        encoding: 'utf-8',
      }).trim();
      const resolvedGitDir = path.isAbsolute(gitDir) ? gitDir : path.join(worktreePath, gitDir);
      excludePaths.push(path.join(resolvedGitDir, 'info', 'exclude'));

      for (const excludePath of new Set(excludePaths)) {
        const infoDir = path.dirname(excludePath);
        if (!fs.existsSync(infoDir)) {
          fs.mkdirSync(infoDir, { recursive: true });
        }

        let content = '';
        if (fs.existsSync(excludePath)) {
          content = fs.readFileSync(excludePath, 'utf-8');
        }

        const lines = content.split('\n').map((l) => l.trim());
        let toAppend = '';
        if (!lines.includes('.agenthub/')) {
          toAppend += '\n.agenthub/\n';
        }
        if (!lines.includes('node_modules')) {
          toAppend += 'node_modules\n';
        }

        if (toAppend) {
          fs.appendFileSync(excludePath, toAppend);
        }
      }
    } catch {
      // non-critical
    }
  }

  private async addToExcludeAsync(worktreePath: string): Promise<void> {
    try {
      const excludePaths: string[] = [];
      try {
        const { stdout } = await execFileAsync('git', ['-C', worktreePath, 'rev-parse', '--git-path', 'info/exclude'], {
          timeout: 30_000,
          encoding: 'utf-8',
        });
        const gitPath = stdout.trim();
        if (gitPath) excludePaths.push(path.isAbsolute(gitPath) ? gitPath : path.join(worktreePath, gitPath));
      } catch {
        // ignore
      }
      const { stdout: gitDirOutput } = await execFileAsync('git', ['-C', worktreePath, 'rev-parse', '--git-dir'], {
        timeout: 30_000,
        encoding: 'utf-8',
      });
      const gitDir = gitDirOutput.trim();
      const resolvedGitDir = path.isAbsolute(gitDir) ? gitDir : path.join(worktreePath, gitDir);
      excludePaths.push(path.join(resolvedGitDir, 'info', 'exclude'));

      for (const excludePath of new Set(excludePaths)) {
        const infoDir = path.dirname(excludePath);
        if (!fs.existsSync(infoDir)) fs.mkdirSync(infoDir, { recursive: true });
        const content = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf-8') : '';
        const lines = content.split('\n').map((line) => line.trim());
        let toAppend = '';
        if (!lines.includes('.agenthub/')) toAppend += '\n.agenthub/\n';
        if (!lines.includes('node_modules')) toAppend += 'node_modules\n';
        if (toAppend) fs.appendFileSync(excludePath, toAppend);
      }
    } catch {
      // non-critical
    }
  }

  /**
   * Remove a worktree
   */
  remove(
    projectPath: string | null | undefined,
    worktreePath: string,
    context?: WorktreeHookContext,
    worktreeRoot: string | string[] = this.config.worktreesDir,
  ): boolean {
    if (!isDeletableWorktreePath(worktreeRoot, worktreePath, [projectPath, this.config.hubHome])) {
      console.error(`[worktree] REFUSED to remove ${worktreePath}: outside ${worktreeRoot} or a project root`);
      return false;
    }
    reapSyncForWorktree(worktreePath, {
      worktreesDir: worktreeRoot,
      protectedPaths: [projectPath, this.config.hubHome],
      graceMs: 5000,
    });
    if (projectPath && fs.existsSync(projectPath)) {
      try {
        execFileSync('git', ['-C', projectPath, 'worktree', 'remove', '--force', worktreePath], {
          timeout: 30000,
        });
      } catch {
        // fall through to manual cleanup (path already verified to be inside worktreesDir)
      }
    }
    if (fs.existsSync(worktreePath)) {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }
    if (fs.existsSync(worktreePath)) {
      console.error(`[worktree] Failed to remove worktree path: ${worktreePath}`);
      return false;
    }

    this.runOnWorktreeRemovedHooks(projectPath, worktreePath, context);
    return true;
  }

  private async runOnWorktreeRemovedHooksAsync(
    projectPath: string | null | undefined,
    worktreePath: string,
    context?: WorktreeHookContext,
  ): Promise<void> {
    const hooks = context?.hooks?.onWorktreeRemoved;
    if (!hooks || !Array.isArray(hooks) || hooks.length === 0) return;

    const eventBus = context?.eventBus || this.eventBus;
    const slug = context?.slug || path.basename(worktreePath);
    const taskId = context?.taskId || (context?.projectId ? `${context.projectId}/${slug}` : undefined);
    if (!slug || !/^[a-z0-9_-]+$/.test(slug)) {
      console.error(`[worktree] REFUSED hooks for ${worktreePath}: slug "${slug}" contains invalid characters (must match [a-z0-9_-])`);
      eventBus?.emit('worktree.hook', taskId, { hook: 'onWorktreeRemoved', ok: false, error: `Refused hooks: slug "${slug}" contains invalid characters (must match [a-z0-9_-])`, slug });
      return;
    }
    const slotStr = context?.slot != null ? String(context.slot) : '';
    const slugUnderscored = slug.replace(/-/g, '_');
    const project = context?.projectId || (projectPath ? path.basename(projectPath) : '');
    const cwd = projectPath || undefined;
    for (const rawCmd of hooks) {
      if (typeof rawCmd !== 'string' || !rawCmd.trim()) continue;
      const expandedCmd = rawCmd
        .replace(/\{slot\}/g, slotStr)
        .replace(/\{slug\}/g, slug)
        .replace(/\{slug_underscored\}/g, slugUnderscored)
        .replace(/\{worktree\}/g, shellWord(worktreePath))
        .replace(/\{project\}/g, shellWord(project));
      const startTime = Date.now();
      try {
        const { stdout } = await execFileAsync('sh', ['-c', expandedCmd], {
          cwd, timeout: 60000, encoding: 'utf-8', maxBuffer: 1024 * 1024,
          env: { ...process.env, AGENTHUB_WORKTREE: worktreePath, AGENTHUB_PROJECT_PATH: projectPath || '' },
        });
        eventBus?.emit('worktree.hook', taskId, { hook: 'onWorktreeRemoved', cmd: expandedCmd, rawCmd, ok: true, exitCode: 0, durationMs: Date.now() - startTime, output: stdout });
      } catch (err) {
        const error = err as { status?: number; killed?: boolean; stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
        const exitCode = typeof error.status === 'number' ? error.status : (error.killed ? 137 : 1);
        const output = (error.stdout ? String(error.stdout) : '') + (error.stderr ? String(error.stderr) : '');
        console.error(`[worktree] Hook command failed: ${expandedCmd} (exit ${exitCode}): ${error.message ?? String(err)}`);
        eventBus?.emit('worktree.hook', taskId, { hook: 'onWorktreeRemoved', cmd: expandedCmd, rawCmd, ok: false, exitCode, durationMs: Date.now() - startTime, error: error.message ?? String(err), output });
      }
    }
  }

  /** Async counterpart used by daemon cleanup and task startup. */
  async removeAsync(
    projectPath: string | null | undefined,
    worktreePath: string,
    context?: WorktreeHookContext,
    worktreeRoot: string | string[] = this.config.worktreesDir,
  ): Promise<boolean> {
    if (!isDeletableWorktreePath(worktreeRoot, worktreePath, [projectPath, this.config.hubHome])) {
      console.error(`[worktree] REFUSED to remove ${worktreePath}: outside ${worktreeRoot} or a project root`);
      return false;
    }
    await reap(worktreePath, {
      worktreesDir: worktreeRoot,
      protectedPaths: [projectPath, this.config.hubHome],
      graceMs: 5000,
    });
    if (projectPath && fs.existsSync(projectPath)) {
      try {
        await execFileAsync('git', ['-C', projectPath, 'worktree', 'remove', '--force', worktreePath], {
          timeout: WORKTREE_GIT_TIMEOUT_MS,
        });
      } catch {
        // fall through to manual cleanup (path already verified to be inside worktreesDir)
      }
    }
    if (fs.existsSync(worktreePath)) {
      await fs.promises.rm(worktreePath, { recursive: true, force: true });
    }
    if (fs.existsSync(worktreePath)) {
      console.error(`[worktree] Failed to remove worktree path: ${worktreePath}`);
      return false;
    }
    await this.runOnWorktreeRemovedHooksAsync(projectPath, worktreePath, context);
    return true;
  }

  private runOnWorktreeRemovedHooks(
    projectPath: string | null | undefined,
    worktreePath: string,
    context?: WorktreeHookContext,
  ): void {
    const hooks = context?.hooks?.onWorktreeRemoved;
    if (!hooks || !Array.isArray(hooks) || hooks.length === 0) {
      return;
    }

    const eventBus = context?.eventBus || this.eventBus;
    const slug = context?.slug || path.basename(worktreePath);
    const taskId = context?.taskId || (context?.projectId ? `${context.projectId}/${slug}` : undefined);

    // Security protection: slug only allows [a-z0-9_-], reject otherwise
    if (!slug || !/^[a-z0-9_-]+$/.test(slug)) {
      console.error(`[worktree] REFUSED hooks for ${worktreePath}: slug "${slug}" contains invalid characters (must match [a-z0-9_-])`);
      eventBus?.emit('worktree.hook', taskId, {
        hook: 'onWorktreeRemoved',
        ok: false,
        error: `Refused hooks: slug "${slug}" contains invalid characters (must match [a-z0-9_-])`,
        slug,
      });
      return;
    }

    const slotStr = context?.slot != null ? String(context.slot) : '';
    const slugUnderscored = slug.replace(/-/g, '_');
    const project = context?.projectId || (projectPath ? path.basename(projectPath) : '');
    const cwd = projectPath || undefined;

    for (const rawCmd of hooks) {
      if (typeof rawCmd !== 'string' || !rawCmd.trim()) continue;

      const expandedCmd = rawCmd
        .replace(/\{slot\}/g, slotStr)
        .replace(/\{slug\}/g, slug)
        .replace(/\{slug_underscored\}/g, slugUnderscored)
        .replace(/\{worktree\}/g, shellWord(worktreePath))
        .replace(/\{project\}/g, shellWord(project));

      const startTime = Date.now();
      try {
        const stdout = execFileSync('sh', ['-c', expandedCmd], {
          cwd,
          timeout: 60000,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            AGENTHUB_WORKTREE: worktreePath,
            AGENTHUB_PROJECT_PATH: projectPath || '',
          },
        });
        const durationMs = Date.now() - startTime;
        eventBus?.emit('worktree.hook', taskId, {
          hook: 'onWorktreeRemoved',
          cmd: expandedCmd,
          rawCmd,
          ok: true,
          exitCode: 0,
          durationMs,
          output: stdout,
        });
      } catch (err) {
        const error = err as { status?: number; killed?: boolean; stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
        const durationMs = Date.now() - startTime;
        const exitCode = typeof error.status === 'number' ? error.status : (error.killed ? 137 : 1);
        const output = (error.stdout ? String(error.stdout) : '') + (error.stderr ? String(error.stderr) : '');
        console.error(`[worktree] Hook command failed: ${expandedCmd} (exit ${exitCode}): ${error.message ?? String(err)}`);
        eventBus?.emit('worktree.hook', taskId, {
          hook: 'onWorktreeRemoved',
          cmd: expandedCmd,
          rawCmd,
          ok: false,
          exitCode,
          durationMs,
          error: error.message ?? String(err),
          output,
        });
      }
    }
  }

  /**
   * Clean node_modules inside worktree (both root and web/ if present)
   */
  cleanNodeModules(worktreePath: string): { removed: string[]; freedBytes: number } {
    const dirs = [
      path.join(worktreePath, 'node_modules'),
      path.join(worktreePath, 'web', 'node_modules'),
    ];
    const removed: string[] = [];
    let freedBytes = 0;
    for (const dir of dirs) {
      if (fs.existsSync(dir)) {
        try {
          freedBytes += this.getDirectorySize(dir);
          fs.rmSync(dir, { recursive: true, force: true });
          removed.push(dir);
        } catch {
          // ignore
        }
      }
    }
    return { removed, freedBytes };
  }

  /**
   * Calculate size of a directory recursively in bytes
   */
  getDirectorySize(dir: string): number {
    let size = 0;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        try {
          if (entry.isDirectory()) {
            size += this.getDirectorySize(fullPath);
          } else if (entry.isFile()) {
            size += fs.statSync(fullPath).size;
          }
        } catch {
          // ignore broken symlinks or unreadable files
        }
      }
    } catch {
      // ignore
    }
    return size;
  }

  /**
   * Write the task.md file (protocol + body) into the worktree
   */
  writeTaskFile(
    worktreePath: string,
    body: string,
    resume: boolean,
    feedback?: string,
    dependencies: DependencyContext[] = [],
    depsMaxChars = 16000,
    knowledge: KnowledgeContext[] = [],
    knowledgeMaxChars = 12000,
    references: Array<{ name: string; path: string; inject?: boolean }> = [],
    projectPath?: string,
    reviewChecklist: string[] = [],
  ): void {
    const agentHubDir = path.join(worktreePath, '.agenthub');
    if (!fs.existsSync(agentHubDir)) {
      fs.mkdirSync(agentHubDir, { recursive: true });
    }

    const knowledgePath = path.join(agentHubDir, 'context', 'knowledge.md');
    if (knowledge.length > 0) {
      fs.mkdirSync(path.dirname(knowledgePath), { recursive: true });
      fs.writeFileSync(knowledgePath, this.buildKnowledgeContext(knowledge, knowledgeMaxChars), 'utf-8');
    } else if (fs.existsSync(knowledgePath)) {
      fs.rmSync(knowledgePath, { force: true });
    }

    const referencesPath = path.join(agentHubDir, 'context', 'references.md');
    if (references.length > 0) {
      fs.mkdirSync(path.dirname(referencesPath), { recursive: true });
      fs.writeFileSync(referencesPath, this.buildReferencesContext(references), 'utf-8');
    } else if (fs.existsSync(referencesPath)) {
      fs.rmSync(referencesPath, { force: true });
    }

    const checklistPath = path.join(agentHubDir, 'context', 'review-checklist.md');
    if (reviewChecklist.length > 0) {
      fs.mkdirSync(path.dirname(checklistPath), { recursive: true });
      fs.writeFileSync(checklistPath, this.buildReviewChecklistContext(reviewChecklist, projectPath), 'utf-8');
    } else if (fs.existsSync(checklistPath)) {
      fs.rmSync(checklistPath, { force: true });
    }

    // Copy AGENTS.md if present in worktree or project root (<= 32KB)
    const contextAgentsPath = path.join(agentHubDir, 'context', 'AGENTS.md');
    const possibleAgents = [
      path.join(worktreePath, 'AGENTS.md'),
      ...(projectPath ? [path.join(projectPath, 'AGENTS.md')] : []),
    ];
    let agentsCopied = false;
    for (const p of possibleAgents) {
      if (fs.existsSync(p)) {
        try {
          const stat = fs.statSync(p);
          if (stat.isFile() && stat.size <= 32 * 1024) {
            fs.mkdirSync(path.dirname(contextAgentsPath), { recursive: true });
            fs.writeFileSync(contextAgentsPath, fs.readFileSync(p, 'utf-8'), 'utf-8');
            agentsCopied = true;
            break;
          }
        } catch {
          // ignore
        }
      }
    }
    if (!agentsCopied && fs.existsSync(contextAgentsPath)) {
      fs.rmSync(contextAgentsPath, { force: true });
    }

    let content = body;

    const contextPath = path.join(agentHubDir, 'context', 'deps.md');
    const contextPrompt = 'Đọc `.agenthub/context/deps.md` trước khi bắt đầu.';
    if (dependencies.length > 0) {
      const contextContent = this.buildDependencyContext(dependencies, depsMaxChars);
      fs.mkdirSync(path.dirname(contextPath), { recursive: true });
      fs.writeFileSync(contextPath, contextContent, 'utf-8');
      if (!content.startsWith(contextPrompt)) {
        content = `${contextPrompt}\n\n${content}`;
      }
    } else {
      if (fs.existsSync(contextPath)) {
        fs.rmSync(contextPath, { force: true });
      }
      if (content.startsWith(`${contextPrompt}\n\n`)) {
        content = content.slice(`${contextPrompt}\n\n`.length);
      }
    }

    if (feedback) {
      content += '\n\n## Feedback review\n\n' + feedback
        + '\n\nĐây là danh sách đầy đủ các mục cần sửa. Trước khi báo xong, hãy tự grep các chỗ tương tự trên toàn repo, sửa tất cả mục liên quan và ghi trong DONE: "đã kiểm tra tương tự ở: …".';
    }

    fs.writeFileSync(path.join(agentHubDir, 'task.md'), content, 'utf-8');

    // Remove old markers
    const donePath = path.join(agentHubDir, 'DONE');
    const blockedPath = path.join(agentHubDir, 'BLOCKED');
    if (fs.existsSync(donePath)) fs.unlinkSync(donePath);
    if (fs.existsSync(blockedPath)) fs.unlinkSync(blockedPath);
  }

  private buildDependencyContext(dependencies: DependencyContext[], maxChars: number): string {
    const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 16000;
    const sections = dependencies.map((dependency) => {
      const done = (dependency.doneContent || '').slice(0, 4000);
      const diff = (dependency.diffStat || '').split('\n').slice(0, 60).join('\n');
      const lines = [
        `## ${dependency.title} (${dependency.id})`,
      ];
      if (dependency.isCrossProject) {
        lines.push('');
        lines.push(`- Dự án: ${dependency.projectName ? `${dependency.projectName} (${dependency.projectId})` : (dependency.projectId || '')}`);
        lines.push(`- Repo: ${dependency.repoPath || '(không xác định)'}`);
      }
      lines.push(
        '',
        '### DONE',
        done || '(không có DONE)',
        '',
        '### Review cuối',
        dependency.review || '(chưa có review approved)',
        '',
        '### Diff stat',
        diff || '(không lấy được diff stat)',
      );
      return lines.join('\n');
    });
    const full = sections.join('\n\n');
    if (full.length <= limit) return full;

    const note = '\n\n[Đã cắt bớt context dependency vì vượt giới hạn cấu hình.]';
    const available = Math.max(0, limit - note.length);
    return full.slice(0, available) + note.slice(0, limit);
  }

  private buildKnowledgeContext(entries: KnowledgeContext[], maxChars: number): string {
    const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 12000;
    const full = ['# Sổ kiến thức dự án', '', ...entries.map((entry) => `- ${entry.content} _(task: ${entry.taskId})`)].join('\n');
    if (full.length <= limit) return full;
    return full.slice(0, limit);
  }

  private buildReferencesContext(references: Array<{ name: string; path: string; inject?: boolean }>): string {
    const lines: string[] = [
      '# Tài liệu tham chiếu (References)',
      '',
      'QUY TẮC BẮT BUỘC: CHỈ ĐỌC, không sửa, không commit các tài liệu tham chiếu này.',
      'Mọi hành vi sửa đổi tài liệu tham chiếu sẽ khiến task bị chặn (BLOCKED).',
      '',
    ];

    for (const ref of references) {
      const envName = `AGENTHUB_REF_${ref.name.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}`;
      lines.push(`## ${ref.name}`);
      lines.push(`- Đường dẫn: \`${ref.path}\``);
      lines.push(`- Biến môi trường: \`${envName}\``);

      if (!fs.existsSync(ref.path)) {
        lines.push(`> ⚠️ CẢNH BÁO: Đường dẫn tham chiếu không tồn tại: ${ref.path}`);
        console.warn(`[references] Reference '${ref.name}' path does not exist: ${ref.path}`);
        lines.push('');
        continue;
      }

      let stat: fs.Stats;
      try {
        stat = fs.statSync(ref.path);
      } catch (err) {
        lines.push(`> ⚠️ CẢNH BÁO: Không thể đọc thông tin đường dẫn: ${String(err)}`);
        lines.push('');
        continue;
      }

      if (ref.inject) {
        if (stat.isFile()) {
          const MAX_INJECT_SIZE = 64 * 1024; // 64KB
          if (stat.size <= MAX_INJECT_SIZE) {
            try {
              const fileContent = fs.readFileSync(ref.path, 'utf-8');
              lines.push('');
              lines.push('### Nội dung:');
              lines.push('```');
              lines.push(fileContent);
              lines.push('```');
            } catch (err) {
              lines.push(`> ⚠️ CẢNH BÁO: Không thể đọc nội dung file: ${String(err)}`);
            }
          } else {
            lines.push(`> ⚠️ CẢNH BÁO: File tham chiếu vượt quá giới hạn 64KB (${stat.size} bytes), không tự động inject nội dung.`);
            console.warn(`[references] Reference '${ref.name}' exceeds 64KB (${stat.size} bytes), skipping content injection: ${ref.path}`);
          }
        } else {
          lines.push('> ⚠️ CẢNH BÁO: Tham chiếu là thư mục, không tự động inject nội dung.');
          console.warn(`[references] Reference '${ref.name}' is a directory, skipping content injection: ${ref.path}`);
        }
      }

      lines.push('');
    }

    return lines.join('\n');
  }

  private buildReviewChecklistContext(checklist: string[], projectPath?: string): string {
    const lines = [
      '# CHECKLIST KHI DUYỆT',
      '',
      'Bộ não và worker bắt buộc đối chiếu thay đổi với từng file dưới đây khi duyệt task.',
      'Đây là tài liệu chỉ đọc; không sửa hoặc commit các file checklist.',
      '',
    ];
    for (const entry of checklist.slice(0, 5)) {
      const resolved = projectPath ? resolveProjectFile(projectPath, entry) : null;
      lines.push(`## ${entry}`, `- Đường dẫn: ${resolved}`);
      if (!resolved) {
        lines.push('- CẢNH BÁO: đường dẫn không hợp lệ hoặc nằm ngoài project.');
        lines.push('');
        continue;
      }
      try {
        const stat = fs.statSync(resolved);
        if (!stat.isFile()) {
          lines.push('- CẢNH BÁO: không phải file.');
        } else if (stat.size > 64 * 1024) {
          lines.push(`- CẢNH BÁO: file vượt giới hạn 64KB (${stat.size} bytes), hãy tự đọc khi cần.`);
        } else {
          lines.push('', '```', fs.readFileSync(resolved, 'utf8'), '```');
        }
      } catch {
        lines.push('- CẢNH BÁO: không thể đọc file, hãy tự kiểm tra đường dẫn khi cần.');
      }
      lines.push('');
    }
    return lines.join('\n');
  }

  /**
   * Generate env file in worktree based on project's envTemplate
   */
  generateEnvFile(
    worktreePath: string,
    envTemplate: { file: string; copyFrom?: string; vars?: Record<string, string> },
    slot: number,
    slug: string,
  ): void {
    const targetFile = path.join(worktreePath, envTemplate.file);

    // Copy base file if specified
    if (envTemplate.copyFrom) {
      const src = path.join(worktreePath, envTemplate.copyFrom);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, targetFile);
      }
    }

    // Read existing content or start empty
    let lines: string[] = [];
    if (fs.existsSync(targetFile)) {
      lines = fs.readFileSync(targetFile, 'utf-8').split('\n');
    }

    // Apply vars
    if (envTemplate.vars) {
      const slugUnderscored = slug.replace(/-/g, '_');
      for (const [key, template] of Object.entries(envTemplate.vars)) {
        const value = template
          .replace(/\{slot\}/g, String(slot))
          .replace(/\{slug\}/g, slug)
          .replace(/\{slug_underscored\}/g, slugUnderscored);

        // Find and replace existing key or append
        const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
        if (idx >= 0) {
          lines[idx] = `${key}=${value}`;
        } else {
          lines.push(`${key}=${value}`);
        }
      }
    }

    fs.writeFileSync(targetFile, lines.join('\n'), 'utf-8');
  }

  /**
   * Check if DONE or BLOCKED marker exists in the worktree
   */
  checkMarkers(worktreePath: string): { done: boolean; blocked: boolean; doneContent?: string; blockedContent?: string } {
    const agentHubDir = path.join(worktreePath, '.agenthub');
    const donePath = path.join(agentHubDir, 'DONE');
    const blockedPath = path.join(agentHubDir, 'BLOCKED');

    const result: { done: boolean; blocked: boolean; doneContent?: string; blockedContent?: string } = {
      done: false,
      blocked: false,
    };

    if (fs.existsSync(donePath)) {
      result.done = true;
      result.doneContent = fs.readFileSync(donePath, 'utf-8');
    }
    if (fs.existsSync(blockedPath)) {
      result.blocked = true;
      result.blockedContent = fs.readFileSync(blockedPath, 'utf-8');
    }

    return result;
  }
}
