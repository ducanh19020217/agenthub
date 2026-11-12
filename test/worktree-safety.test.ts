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
