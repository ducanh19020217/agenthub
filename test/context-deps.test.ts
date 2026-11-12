import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { WorktreeService } from '../src/worktrees/index.js';
import {
  openDatabase,
  ProjectRepo,
  ProfileRepo,
  QuotaMarkRepo,
  TaskRepo,
  RunRepo,
  EventRepo,
  ReviewRepo,
} from '../src/db/index.js';
import { Scheduler } from '../src/scheduler/index.js';
import { FakeEngine, Engine } from '../src/engines/index.js';
import { loadConfig } from '../src/config.js';
import { ClaudeFailoverState } from '../src/chat/failover.js';

describe('dependency context in worker files', () => {
  it('writes dependency context and prepends the read instruction', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-context-'));
    try {
      const service = new WorktreeService({
        worktreesDir: path.join(root, 'worktrees'),
        hubHome: root,
      } as never);
      const worktree = path.join(root, 'worktree');
      fs.mkdirSync(worktree, { recursive: true });

      service.writeTaskFile(worktree, 'Do the task.', false, undefined, [{
        id: 'project/dep',
        title: 'Dependency task',
        doneContent: 'Implemented the dependency.',
        review: 'approved — Looks good.',
        diffStat: '  src/a.ts | 2 +-',
      }], 16000);

      expect(fs.readFileSync(path.join(worktree, '.agenthub', 'task.md'), 'utf8'))
        .toBe('Đọc `.agenthub/context/deps.md` trước khi bắt đầu.\n\nDo the task.');
      const context = fs.readFileSync(path.join(worktree, '.agenthub', 'context', 'deps.md'), 'utf8');
      expect(context).toContain('## Dependency task (project/dep)');
      expect(context).toContain('Implemented the dependency.');
      expect(context).toContain('approved — Looks good.');
      expect(context).toContain('src/a.ts | 2 +-');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('limits each DONE, diff lines, and total context size', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-context-'));
    try {
      const service = new WorktreeService({
        worktreesDir: path.join(root, 'worktrees'),
        hubHome: root,
      } as never);
      const worktree = path.join(root, 'worktree');
      fs.mkdirSync(worktree, { recursive: true });
      const diff = Array.from({ length: 80 }, (_, index) => `line-${index}`).join('\n');

      service.writeTaskFile(worktree, 'Task', false, undefined, [{
        id: 'project/dep',
        title: 'Dependency',
        doneContent: 'D'.repeat(5000),
        diffStat: diff,
      }], 600);

      const context = fs.readFileSync(path.join(worktree, '.agenthub', 'context', 'deps.md'), 'utf8');
      expect(context.length).toBeLessThanOrEqual(600);
      expect(context).toContain('[Đã cắt bớt context dependency');
      expect(context).not.toContain('line-60');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not leave dependency context for a task without dependencies', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-context-'));
    try {
      const service = new WorktreeService({
        worktreesDir: path.join(root, 'worktrees'),
        hubHome: root,
      } as never);
      const worktree = path.join(root, 'worktree');
      fs.mkdirSync(path.join(worktree, '.agenthub', 'context'), { recursive: true });
      fs.writeFileSync(path.join(worktree, '.agenthub', 'context', 'deps.md'), 'stale');

      service.writeTaskFile(worktree, 'Task', false);

      expect(fs.existsSync(path.join(worktree, '.agenthub', 'context', 'deps.md'))).toBe(false);
      expect(fs.readFileSync(path.join(worktree, '.agenthub', 'task.md'), 'utf8')).toBe('Task');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('includes 2 dependencies completely when within limit and truncates with notice when exceeding', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-context-'));
    try {
      const service = new WorktreeService({
        worktreesDir: path.join(root, 'worktrees'),
        hubHome: root,
      } as never);
      const worktree = path.join(root, 'worktree');
      fs.mkdirSync(worktree, { recursive: true });

      const twoDeps = [
        {
          id: 'project/dep-1',
          title: 'First Dependency',
          doneContent: 'Done first dependency report.',
          review: 'approved — Clean implementation.',
          diffStat: ' src/first.ts | 4 ++++\n 1 file changed, 4 insertions(+)',
        },
        {
          id: 'project/dep-2',
          title: 'Second Dependency',
          doneContent: 'Done second dependency report.',
          review: 'approved — Tests passing.',
          diffStat: ' src/second.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)',
        },
      ];

      // Within limit: contains both in full
      service.writeTaskFile(worktree, 'Main task', false, undefined, twoDeps, 16000);
      const fullContext = fs.readFileSync(path.join(worktree, '.agenthub', 'context', 'deps.md'), 'utf8');
      expect(fullContext).toContain('## First Dependency (project/dep-1)');
      expect(fullContext).toContain('Done first dependency report.');
      expect(fullContext).toContain('approved — Clean implementation.');
      expect(fullContext).toContain('src/first.ts | 4 ++++');
      expect(fullContext).toContain('## Second Dependency (project/dep-2)');
      expect(fullContext).toContain('Done second dependency report.');
      expect(fullContext).toContain('approved — Tests passing.');
      expect(fullContext).toContain('src/second.ts | 2 +-');
      expect(fullContext).not.toContain('[Đã cắt bớt');

      // Exceeding limit: cuts within limit and appends notice
      service.writeTaskFile(worktree, 'Main task', false, undefined, twoDeps, 250);
      const truncatedContext = fs.readFileSync(path.join(worktree, '.agenthub', 'context', 'deps.md'), 'utf8');
      expect(truncatedContext.length).toBeLessThanOrEqual(250);
      expect(truncatedContext).toContain('[Đã cắt bớt context dependency vì vượt giới hạn cấu hình.]');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('regenerates dependency context and avoids duplicated instruction on retry / changes_requested', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-context-'));
    try {
      const service = new WorktreeService({
        worktreesDir: path.join(root, 'worktrees'),
        hubHome: root,
      } as never);
      const worktree = path.join(root, 'worktree');
      fs.mkdirSync(worktree, { recursive: true });

      const initialDep = [{
        id: 'project/dep',
        title: 'Initial Dep',
        doneContent: 'Initial report.',
        review: 'approved',
        diffStat: ' a.ts | 1 +',
      }];

      service.writeTaskFile(worktree, 'Original task body', false, undefined, initialDep, 16000);
      const taskMdInitial = fs.readFileSync(path.join(worktree, '.agenthub', 'task.md'), 'utf8');
      expect(taskMdInitial).toBe('Đọc `.agenthub/context/deps.md` trước khi bắt đầu.\n\nOriginal task body');

      // Retry / feedback with updated dependency context
      const updatedDep = [{
        id: 'project/dep',
        title: 'Initial Dep',
        doneContent: 'Updated report after review.',
        review: 'approved — Verified',
        diffStat: ' a.ts | 2 ++',
      }];
      service.writeTaskFile(worktree, 'Original task body', true, 'Please fix edge cases.', updatedDep, 16000);

      const depsMdUpdated = fs.readFileSync(path.join(worktree, '.agenthub', 'context', 'deps.md'), 'utf8');
      expect(depsMdUpdated).toContain('Updated report after review.');
      expect(depsMdUpdated).toContain('approved — Verified');

      const taskMdUpdated = fs.readFileSync(path.join(worktree, '.agenthub', 'task.md'), 'utf8');
      expect(taskMdUpdated).toContain('Đọc `.agenthub/context/deps.md` trước khi bắt đầu.\n\nOriginal task body');
      expect(taskMdUpdated).toContain('## Feedback review\n\nPlease fix edge cases.');
      // Ensure the instruction is only present once
      const matches = taskMdUpdated.match(/Đọc `\.agenthub\/context\/deps\.md` trước khi bắt đầu\./g);
      expect(matches?.length).toBe(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('retains diff stat and done report from database even after dependency branch is merged into baseRef and worktree removed', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-sched-deps-'));
    try {
      const projectPath = path.join(root, 'repo');
      fs.mkdirSync(projectPath, { recursive: true });
      execFileSync('git', ['init', '--template='], { cwd: projectPath });
      execFileSync('git', ['checkout', '-b', 'main'], { cwd: projectPath });
      execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: projectPath });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: projectPath });
      fs.writeFileSync(path.join(projectPath, 'README.md'), '# Test\n');
      execFileSync('git', ['add', '.'], { cwd: projectPath });
      execFileSync('git', ['commit', '-m', 'Initial commit', '--allow-empty'], {
        cwd: projectPath,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'test',
          GIT_AUTHOR_EMAIL: 'test@test.com',
          GIT_COMMITTER_NAME: 'test',
          GIT_COMMITTER_EMAIL: 'test@test.com',
        },
      });

      // Create branch for dep task
      execFileSync('git', ['checkout', '-b', 'agenthub/dep'], { cwd: projectPath });
      fs.writeFileSync(path.join(projectPath, 'dep.txt'), 'dependency feature\n');
      execFileSync('git', ['add', '.'], { cwd: projectPath });
      execFileSync('git', ['commit', '-m', 'feat: dep'], { cwd: projectPath });
      execFileSync('git', ['checkout', 'main'], { cwd: projectPath });

      // Merge branch into main — git diff --stat between main and branch is now empty!
      execFileSync('git', ['merge', 'agenthub/dep'], { cwd: projectPath });
      const currentDiff = execFileSync('git', ['diff', '--stat', 'main...agenthub/dep'], { cwd: projectPath, encoding: 'utf8' });
      expect(currentDiff.trim()).toBe('');

      const config = loadConfig(root);
      config.hubHome = root;
      config.worktreesDir = path.join(root, 'worktrees');
      const db = openDatabase(config.dbPath);
      const projectRepo = new ProjectRepo(db);
      const profileRepo = new ProfileRepo(db);
      const taskRepo = new TaskRepo(db);
      const runRepo = new RunRepo(db);
      const eventRepo = new EventRepo(db);
      const quotaMarkRepo = new QuotaMarkRepo(db);
      const reviewRepo = new ReviewRepo(db);

      projectRepo.insert({
        id: 'p1',
        name: 'Project 1',
        path: projectPath,
        defaultBranch: 'main',
        maxParallel: 2,
      });

      profileRepo.upsert({
        name: 'test-p',
        engine: 'agy',
        kind: 'isolated',
        home: path.join(root, 'p-home'),
        email: null,
        enabled: 1,
      });

      // Insert dep task: marked done, worktreePath is null (cleaned up),
      // doneReport and diffStat persisted in DB before merge.
      taskRepo.insert({
        id: 'p1/dep',
        projectId: 'p1',
        slug: 'dep',
        title: 'Dep Task',
        status: 'done',
        baseRef: 'main',
        branch: 'agenthub/dep',
        worktreePath: null,
        doneReport: 'Dep task completed successfully.',
        diffStat: ' dep.txt | 1 +\n 1 file changed, 1 insertion(+)',
      });

      reviewRepo.insert({
        id: 'rev-1',
        taskId: 'p1/dep',
        verdict: 'approved',
        feedback: 'Clean changes',
      });

      // Insert dependent task
      taskRepo.insert({
        id: 'p1/consumer',
        projectId: 'p1',
        slug: 'consumer',
        title: 'Consumer Task',
        body: 'Implement consumer.',
        dependsOn: ['p1/dep'],
        status: 'queued',
      });

      const fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
      const scheduler = new Scheduler(
        config,
        taskRepo,
        runRepo,
        eventRepo,
        projectRepo,
        profileRepo,
        quotaMarkRepo,
        new Map<string, Engine>([['agy', fakeEngine]]),
        { diskSpace: () => ({ freeGB: 10, totalGB: 100 }) },
      );
      scheduler.configureReviewer(reviewRepo, new ClaudeFailoverState());

      await scheduler.tick();

      await vi.waitFor(() => expect(taskRepo.get('p1/consumer')?.status).toBe('running'));
      const consumer = taskRepo.get('p1/consumer')!;
      expect(consumer.worktreePath).toBeDefined();

      const taskMd = fs.readFileSync(path.join(consumer.worktreePath!, '.agenthub', 'task.md'), 'utf8');
      expect(taskMd).toBe('Đọc `.agenthub/context/deps.md` trước khi bắt đầu.\n\nImplement consumer.');

      const depsMd = fs.readFileSync(path.join(consumer.worktreePath!, '.agenthub', 'context', 'deps.md'), 'utf8');
      expect(depsMd).toContain('## Dep Task (p1/dep)');
      expect(depsMd).toContain('Dep task completed successfully.');
      expect(depsMd).toContain('approved — Clean changes');
      expect(depsMd).toContain('dep.txt | 1 +');

      scheduler.stop();
      db.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
