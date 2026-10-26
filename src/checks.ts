import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import type { ProjectRow, TaskRow } from './db/index.js';
import { runInProcessGroup } from './priority.js';
import { workerEnvironment } from './worker-guard.js';

const MAX_OUTPUT = 8192;
const CONFLICT_MARKER_REGEX = /^(<{7}|={7}|>{7})( |$)/m;
export interface CheckDefinition { name: string; cmd: string[]; timeoutSec?: number }
export interface CheckResult { name: string; ok: boolean; exitCode: number | null; durationMs: number; outputTail: string; runId?: string; runStartedAt?: string }
export interface CheckRunOptions { reuseSavedResults?: boolean }

/** Release packaging is deliberately opt-in: it may run npm ci and rebuild the hub. */
export function isHeavyReleaseCheck(check: CheckDefinition): boolean {
  return check.name === 'package-release' || check.name === 'package' || check.name === 'release';
}

export function detectChecks(projectPath: string): CheckDefinition[] {
  const read = (file: string): Record<string, unknown> | null => { try { return JSON.parse(fs.readFileSync(path.join(projectPath, file), 'utf8')) as Record<string, unknown>; } catch { return null; } };
  const pkg = read('package.json');
  const scripts = (pkg?.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {}) as Record<string, unknown>;
  const runner = fs.existsSync(path.join(projectPath, 'pnpm-lock.yaml')) ? 'pnpm' : 'npm';
  const result: CheckDefinition[] = [];
  for (const name of ['lint', 'typecheck', 'test', 'build']) if (typeof scripts[name] === 'string') result.push({ name, cmd: [runner, 'run', name, ...(name === 'test' && /vitest/.test(scripts[name] as string) ? ['--', '--run'] : [])] });
  const web = read('web/package.json');
  const webScripts = (web?.scripts && typeof web.scripts === 'object' ? web.scripts : {}) as Record<string, unknown>;
  if (typeof webScripts.build === 'string') result.push({ name: 'build:web', cmd: [runner, '--prefix', 'web', 'run', 'build'] });
  if (typeof webScripts.test === 'string') result.push({ name: 'test:web', cmd: [runner, '--prefix', 'web', 'run', 'test', '--', '--run'] });
  return result;
}

function isNodeModules(rel: string): boolean {
  return /(^|\/)node_modules(\/|$)/.test(rel);
}

function isGitIgnored(repo: string, rel: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', '--', rel], { cwd: repo, stdio: 'ignore' });
    return true;
  } catch {
    const alt = rel.endsWith('/') ? rel.replace(/\/+$/, '') : `${rel}/`;
    if (alt && alt !== rel) {
      try {
        execFileSync('git', ['check-ignore', '-q', '--', alt], { cwd: repo, stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

function changedFiles(repo: string, task: TaskRow, project: ProjectRow): string[] {
  const names = new Set<string>();
  try { for (const n of execFileSync('git', ['diff', '--name-only', `${task.baseRef || project.defaultBranch}...${task.branch || 'HEAD'}`], { cwd: repo, encoding: 'utf8' }).split('\n')) if (n) names.add(n); } catch { /* ignore */ }
  try {
    for (const line of execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).split('\n')) {
      if (!line.trim()) continue;
      const rel = line.slice(3).trim().replace(/^"|"$/g, '');
      if (!rel || rel === '.agenthub' || rel.startsWith('.agenthub/')) continue;
      if (isNodeModules(rel) || isGitIgnored(repo, rel)) continue;
      try {
        const cleanRel = rel.replace(/\/+$/, '');
        if (fs.lstatSync(path.join(repo, cleanRel)).isSymbolicLink()) continue;
      } catch {
        // ignore
      }
      names.add(rel);
    }
  } catch { /* ignore */ }
  return [...names];
}

function committedAgentHubFiles(repo: string, task: TaskRow, project: ProjectRow): string[] {
  try {
    return execFileSync('git', ['diff', '--name-only', `${task.baseRef || project.defaultBranch}...${task.branch || 'HEAD'}`], { cwd: repo, encoding: 'utf8' })
      .split('\n')
      .map((name) => name.trim())
      .filter((name) => name === '.agenthub' || name.startsWith('.agenthub/'));
  } catch {
    return [];
  }
}

export function mandatoryChecks(repo: string, task: TaskRow, project: ProjectRow): CheckDefinition[] {
  const files = changedFiles(repo, task, project);
  const checks = [
    { name: 'zero-byte', files },
    { name: 'uncommitted', files },
    { name: 'conflict-markers', files },
    { name: 'agenthub-files', files: committedAgentHubFiles(repo, task, project) },
  ].map(({ name, files: checkFiles }) => ({ name, cmd: [], timeoutSec: 30, _files: checkFiles } as CheckDefinition & { _files: string[] }));
  if (project.settings && (projectSettings(project).commitConvention.commitRegex || projectSettings(project).commitConvention.commitTemplate.includes('{ref}'))) {
    checks.push({ name: 'commit-message', cmd: [], timeoutSec: 30, _files: [] } as CheckDefinition & { _files: string[] });
  }
  return checks;
}
function tail(value: string): string { return value.length > MAX_OUTPUT ? value.slice(-MAX_OUTPUT) : value; }
function worktreeHead(repo: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}
function envFromFiles(repo: string, hubHome: string, project?: ProjectRow): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const file of ['.env', '.env.local']) if (fs.existsSync(path.join(repo, file))) for (const line of fs.readFileSync(path.join(repo, file), 'utf8').split('\n')) { const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/); if (m) env[m[1]] = m[2].replace(/^['"]|['"]$/g, ''); }
  return workerEnvironment(hubHome, env, { project, guards: false, workerCount: project?.maxParallel });
}
async function runOne(check: CheckDefinition, repo: string, hubHome: string, project?: ProjectRow, task?: TaskRow): Promise<CheckResult> {
  const started = Date.now();
  if (['zero-byte', 'uncommitted', 'conflict-markers', 'agenthub-files'].includes(check.name)) {
    const files = (check as CheckDefinition & { _files?: string[] })._files || []; let output = '';
    if (check.name === 'uncommitted') {
      try {
        const trackedModified = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: repo, encoding: 'utf8' })
          .split('\n')
          .map((x) => x.trimEnd())
          .filter(Boolean)
          .filter((x) => {
            const rel = x.slice(3).trim().replace(/^"|"$/g, '');
            if (!rel || rel === '.agenthub' || rel.startsWith('.agenthub/')) return false;
            return true;
          });
        const untracked = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' })
          .split('\n')
          .filter((x) => x.startsWith('?? '))
          .filter((x) => {
            const rel = x.slice(3).trim().replace(/^"|"$/g, '');
            if (!rel || rel === '.agenthub' || rel.startsWith('.agenthub/')) return false;
            if (isNodeModules(rel) || isGitIgnored(repo, rel)) return false;
            try {
              const cleanRel = rel.replace(/\/+$/, '');
              return !fs.lstatSync(path.join(repo, cleanRel)).isSymbolicLink();
            } catch {
              return false;
            }
          });
        output = [...trackedModified, ...untracked].join('\n');
      } catch (e) {
        output = String(e);
      }
    }
    else if (check.name === 'zero-byte') output = files.filter((f) => !f.endsWith('.gitkeep') && !f.endsWith('__init__.py') && fs.existsSync(path.join(repo, f)) && fs.statSync(path.join(repo, f)).size === 0).join('\n');
    else if (check.name === 'agenthub-files') output = files.length > 0
      ? `Không được commit file trong .agenthub/:\n${files.join('\n')}`
      : '';
    else output = files.filter((f) => { try { return CONFLICT_MARKER_REGEX.test(fs.readFileSync(path.join(repo, f), 'utf8')); } catch { return false; } }).join('\n');
    return { name: check.name, ok: !output, exitCode: output ? 1 : 0, durationMs: Date.now() - started, outputTail: tail(output || 'OK') };
  }
  if (check.name === 'commit-message' && project && task) {
    let output = '';
    const convention = projectSettings(project).commitConvention;
    try {
      const range = `${(task.baseRef || project.defaultBranch || 'main')}..HEAD`;
      const log = execFileSync('git', ['log', '--no-merges', '--format=%H%x00%s', range], { cwd: repo, encoding: 'utf8' });
      const regex = convention.commitRegex ? new RegExp(convention.commitRegex) : null;
      const bad: string[] = [];
      for (const line of log.split('\n').filter(Boolean)) {
        const [hash, message] = line.split('\0');
        if ((regex && !regex.test(message)) || (convention.commitTemplate.includes('{ref}') && (!task.externalRef || !message.includes(task.externalRef)))) {
          bad.push(`${hash.slice(0, 10)} ${message}`);
        }
      }
      output = bad.join('\n');
    } catch (error) {
      output = `Không đọc được commit: ${String(error)}`;
    }
    return { name: check.name, ok: !output, exitCode: output ? 1 : 0, durationMs: Date.now() - started, outputTail: tail(output || 'OK') };
  }
  const r = await runInProcessGroup(check.cmd[0], check.cmd.slice(1), { cwd: repo, env: envFromFiles(repo, hubHome, project), timeoutMs: (check.timeoutSec || 600) * 1000 });
  const ok = r.code === 0 && !r.timedOut;
  return { name: check.name, ok, exitCode: r.code, durationMs: Date.now() - started, outputTail: tail(`${r.output}${r.timedOut ? `\nTimeout sau ${check.timeoutSec || 600}s` : ''}`) };
}
import { ensureWorktreeNodeModules } from './cache.js';
import { projectSettings } from './projects/settings.js';

export class CheckRunner {
  constructor(private db: Database.Database) {}
  async run(task: TaskRow, project: ProjectRow, runId: string, options: CheckRunOptions = {}): Promise<{ passed: boolean; failed: string[]; results: CheckResult[] }> {
    const repo = task.worktreePath || project.path; await this.prepare(repo, project.path, project);
    const hubHome = process.env.AGENTHUB_HOME || path.join(process.env.HOME || process.cwd(), '.agenthub');
    const configured = project.checks ? JSON.parse(project.checks) as CheckDefinition[] : detectChecks(repo);
    // Explicit project checks are authoritative. Only auto-detected release
    // checks are excluded because they may run npm ci/package.
    const checks = [...(project.checks ? configured : configured.filter((check) => !isHeavyReleaseCheck(check))), ...mandatoryChecks(repo, task, project)];
    if (!options.reuseSavedResults) {
      this.db.prepare('DELETE FROM check_results WHERE taskId = ? AND runId = ?').run(task.id, runId);
    }
    const head = worktreeHead(repo);
    const existingRows = options.reuseSavedResults
      ? this.db.prepare('SELECT name, ok, exitCode, durationMs, outputTail, head FROM check_results WHERE taskId = ? AND runId = ?')
        .all(task.id, runId) as Array<{ name: string; ok: number; exitCode: number | null; durationMs: number; outputTail: string; head: string | null }>
      : [];
    const existing = new Map(existingRows.filter((row) => row.head === head && head !== null).map((row) => [row.name, row] as const));
    const results: CheckResult[] = [];
    for (const check of checks) {
      const saved = existing.get(check.name) as CheckResult | undefined;
      if (saved) {
        results.push({ ...saved, ok: Boolean(saved.ok) });
        continue;
      }
      const result = await runOne(check, repo, hubHome, project, task);
      results.push(result);
      this.db.prepare('INSERT INTO check_results (taskId, runId, name, ok, exitCode, durationMs, outputTail, head) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(task.id, runId, result.name, result.ok ? 1 : 0, result.exitCode, result.durationMs, result.outputTail, head);
    }
    return { passed: results.every((r) => r.ok), failed: results.filter((r) => !r.ok).map((r) => r.name), results };
  }
  private async prepare(repo: string, projectPath?: string, project?: ProjectRow): Promise<void> {
    if (project && projectSettings(project).worktree.install !== 'auto') {
      return;
    }
    try {
      await ensureWorktreeNodeModules(repo, projectPath);
    } catch {
      /* subsequent check reports failure */
    }
  }
}
export function getCheckResults(db: Database.Database, taskId: string): CheckResult[] {
  const rows = db.prepare(`SELECT c.name, c.ok, c.exitCode, c.durationMs, c.outputTail, c.runId, r.startedAt AS runStartedAt
    FROM check_results c JOIN runs r ON r.id = c.runId
    WHERE c.taskId = ? AND c.runId = (
      SELECT c2.runId FROM check_results c2 JOIN runs r2 ON r2.id = c2.runId
      WHERE c2.taskId = ? GROUP BY c2.runId ORDER BY r2.startedAt DESC, r2.rowid DESC LIMIT 1
    )
    ORDER BY c.rowid`).all(taskId, taskId) as Array<{
    name: string;
    ok: number;
    exitCode: number | null;
    durationMs: number;
    outputTail: string;
    runId: string;
    runStartedAt: string;
  }>;
  return rows.map((r) => ({ ...r, ok: Boolean(r.ok) }));
}
