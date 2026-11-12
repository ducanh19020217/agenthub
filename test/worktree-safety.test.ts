import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { WorktreeService, isDeletableWorktreePath } from '../src/worktrees/index.js';
import type { AgentHubConfig } from '../src/config.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-wt-safety-'));
  dirs.push(root);
  const hubHome = path.join(root, 'hub');
  const worktreesDir = path.join(hubHome, 'worktrees');
  const project = path.join(root, 'Desktop', 'XFarm');
  fs.mkdirSync(worktreesDir, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: project });
  fs.writeFileSync(path.join(project, 'README.md'), 'keep me');
  execFileSync('git', ['add', '.'], { cwd: project });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: project });
  const service = new WorktreeService({ worktreesDir, hubHome } as AgentHubConfig);
  return { root, hubHome, worktreesDir, project, service };
}

describe('worktree deletion safety (sự cố 16/10: hub xóa nhầm thư mục gốc repo)', () => {
  it('chỉ cho xóa đường dẫn nằm hẳn trong worktreesDir', () => {
    const { worktreesDir, project, hubHome } = setup();
    expect(isDeletableWorktreePath(worktreesDir, path.join(worktreesDir, 'xfarm', 'p1'), [project])).toBe(true);
    expect(isDeletableWorktreePath(worktreesDir, project, [project])).toBe(false);
    expect(isDeletableWorktreePath(worktreesDir, worktreesDir, [project])).toBe(false);
    expect(isDeletableWorktreePath(worktreesDir, hubHome, [project])).toBe(false);
    expect(isDeletableWorktreePath(worktreesDir, path.join(worktreesDir, '..', 'hub.db'), [project])).toBe(false);
    expect(isDeletableWorktreePath(worktreesDir, '/', [project])).toBe(false);
    expect(isDeletableWorktreePath(worktreesDir, null, [project])).toBe(false);
  });

  it('không xóa được thư mục gốc project khi worktreePath trỏ vào nó', () => {
    const { project, service } = setup();
    expect(service.remove(project, project)).toBe(false);
    expect(fs.existsSync(path.join(project, '.git'))).toBe(true);
    expect(fs.readFileSync(path.join(project, 'README.md'), 'utf8')).toBe('keep me');
  });

  it('không xóa thư mục project nằm ngoài worktreesDir dù không có project (projectPath null)', () => {
    const { project, service } = setup();
    expect(service.remove(null, project)).toBe(false);
    expect(fs.existsSync(project)).toBe(true);
  });

  it('chặn symlink trong worktreesDir trỏ ra ngoài', () => {
    const { worktreesDir, project, service } = setup();
    const link = path.join(worktreesDir, 'evil');
    fs.symlinkSync(project, link);
    expect(service.remove(project, link)).toBe(false);
    expect(fs.existsSync(path.join(project, 'README.md'))).toBe(true);
  });

  it('vẫn xóa được worktree hợp lệ', () => {
    const { worktreesDir, project, service } = setup();
    const wt = path.join(worktreesDir, 'xfarm', 'task-a');
    execFileSync('git', ['-C', project, 'worktree', 'add', '-q', '-b', 'task-a', wt]);
    expect(service.remove(project, wt)).toBe(true);
    expect(fs.existsSync(wt)).toBe(false);
    expect(fs.existsSync(path.join(project, 'README.md'))).toBe(true);
  });

  it('removeAsync không chặn event loop khi git chậm', async () => {
    const { root, worktreesDir, project, service } = setup();
    const wt = path.join(worktreesDir, 'xfarm', 'slow-task');
    execFileSync('git', ['-C', project, 'worktree', 'add', '-q', '-b', 'slow-task', wt]);

    const fakeBin = path.join(root, 'fake-bin');
    fs.mkdirSync(fakeBin);
    const fakeGit = path.join(fakeBin, 'git');
    fs.writeFileSync(fakeGit, '#!/bin/sh\nsleep 2\nexec /usr/bin/git "$@"\n', { mode: 0o755 });
    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${originalPath || ''}`;
    try {
      let ticks = 0;
      const timer = setInterval(() => { ticks++; }, 100);
      const removed = await service.removeAsync(project, wt);
      clearInterval(timer);
      expect(removed).toBe(true);
      expect(ticks).toBeGreaterThanOrEqual(10);
      expect(fs.existsSync(wt)).toBe(false);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('createAsync không chặn event loop khi git chậm', async () => {
    const { root, worktreesDir, project, service } = setup();
    const fakeBin = path.join(root, 'fake-bin');
    fs.mkdirSync(fakeBin);
    const fakeGit = path.join(fakeBin, 'git');
    fs.writeFileSync(fakeGit, '#!/bin/sh\nsleep 2\nexec /usr/bin/git "$@"\n', { mode: 0o755 });
    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${originalPath || ''}`;
    try {
      let ticks = 0;
      const timer = setInterval(() => { ticks++; }, 100);
      const created = await service.createAsync({
        projectPath: project,
        projectId: 'xfarm',
        slug: 'slow-create',
        branch: 'slow-create',
        baseRef: 'HEAD',
      });
      clearInterval(timer);
      expect(created).toBe(path.join(worktreesDir, 'xfarm', 'slow-create'));
      expect(ticks).toBeGreaterThanOrEqual(10);
      expect(fs.existsSync(created)).toBe(true);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('hoạt động đúng khi worktreesDir đi qua symlink nhưng target chưa tồn tại (macOS /var -> /private/var)', () => {
    const { root, project } = setup();
    const realDir = path.join(root, 'real-worktrees');
    const symlinkDir = path.join(root, 'symlink-worktrees');
    fs.mkdirSync(realDir, { recursive: true });
    fs.symlinkSync(realDir, symlinkDir);
    expect(isDeletableWorktreePath(symlinkDir, path.join(symlinkDir, 'project', 'uncreated-task'), [project])).toBe(true);
    expect(isDeletableWorktreePath(symlinkDir, path.join(realDir, 'project', 'uncreated-task'), [project])).toBe(true);
  });
});

describe('warm worktree pool', () => {
  it('refills detached worktrees and acquires a clean task branch', async () => {
    const { project, worktreesDir } = setup();
    const events: Array<{ type: string; payload?: unknown }> = [];
    const configured = new WorktreeService({ worktreesDir, hubHome: path.dirname(worktreesDir), cacheDir: path.join(path.dirname(worktreesDir), 'cache'), cacheMaxEntries: 3, cacheMaxGB: 1 } as AgentHubConfig, {
      emit: (type, _taskId, payload) => { events.push({ type, payload }); return true; },
    });
    const settings = JSON.stringify({ worktree: { warmPool: 1, install: 'skip' } });
    await configured.refillPool({ projectPath: project, projectId: 'xfarm', projectSettings: settings, baseRef: 'HEAD' });
    const poolPath = path.join(worktreesDir, 'xfarm', '.pool', '1');
    expect(fs.existsSync(poolPath)).toBe(true);
    expect(execFileSync('git', ['-C', poolPath, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' })).toBe('HEAD\n');
    const exclude = execFileSync('git', ['-C', poolPath, 'rev-parse', '--git-path', 'info/exclude'], { encoding: 'utf8' }).trim();
    expect(fs.readFileSync(path.isAbsolute(exclude) ? exclude : path.join(poolPath, exclude), 'utf8')).toContain('.agenthub/');

    const taskPath = await configured.acquireFromPool({ projectPath: project, projectId: 'xfarm', projectSettings: settings, slug: 'task-a', branch: 'agenthub/task-a', baseRef: 'HEAD', taskId: 'xfarm/task-a' });
    expect(taskPath).toBe(path.join(worktreesDir, 'xfarm', 'task-a'));
    expect(execFileSync('git', ['-C', taskPath!, 'symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8' })).toBe('agenthub/task-a\n');
    expect(execFileSync('git', ['-C', taskPath!, 'status', '--porcelain'], { encoding: 'utf8' })).toBe('');
    expect(events.map((event) => event.type)).toContain('worktree.pool_hit');
  });

  it('removes a broken pool entry and falls back to normal creation', async () => {
    const { project, worktreesDir, service } = setup();
    const settings = JSON.stringify({ worktree: { warmPool: 1 } });
    const broken = path.join(worktreesDir, 'xfarm', '.pool', '1');
    fs.mkdirSync(broken, { recursive: true });
    const result = await service.acquireFromPool({ projectPath: project, projectId: 'xfarm', projectSettings: settings, slug: 'fallback', branch: 'fallback', baseRef: 'HEAD' });
    expect(result).toBeNull();
    expect(fs.existsSync(broken)).toBe(false);
    const created = await service.createAsync({ projectPath: project, projectId: 'xfarm', projectSettings: settings, slug: 'fallback', branch: 'fallback', baseRef: 'HEAD' });
    expect(fs.existsSync(created)).toBe(true);
  });

  it('refreshes an existing pool slot to the latest base ref', async () => {
    const { project, worktreesDir, service } = setup();
    const settings = JSON.stringify({ worktree: { warmPool: 1, install: 'skip' } });
    const baseBranch = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: project, encoding: 'utf8' }).trim();
    await service.refillPool({ projectPath: project, projectId: 'xfarm', projectSettings: settings, baseRef: baseBranch });
    fs.writeFileSync(path.join(project, 'README.md'), 'updated');
    execFileSync('git', ['add', 'README.md'], { cwd: project });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'update'], { cwd: project });
    const expected = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: project, encoding: 'utf8' }).trim();

    await service.refillPool({ projectPath: project, projectId: 'xfarm', projectSettings: settings, baseRef: baseBranch });

    const poolPath = path.join(worktreesDir, 'xfarm', '.pool', '1');
    expect(execFileSync('git', ['-C', poolPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(expected);
    expect(execFileSync('git', ['-C', poolPath, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' })).toBe('HEAD\n');
  });

  it('does not create a pool when disabled or disk is low', async () => {
    const first = setup();
    await first.service.refillPool({ projectPath: first.project, projectId: 'xfarm', projectSettings: JSON.stringify({ worktree: { warmPool: 0 } }), baseRef: 'HEAD' });
    expect(fs.existsSync(path.join(first.worktreesDir, 'xfarm', '.pool'))).toBe(false);
    const second = setup();
    await second.service.refillPool({ projectPath: second.project, projectId: 'xfarm', projectSettings: JSON.stringify({ worktree: { warmPool: 1 } }), baseRef: 'HEAD', diskAvailable: () => false });
    expect(fs.existsSync(path.join(second.worktreesDir, 'xfarm', '.pool'))).toBe(false);
  });
});
