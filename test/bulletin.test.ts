import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { createContext, closeContext } from '../src/daemon.js';
import { createServer } from '../src/api/server.js';
import { getOrCreateToken } from '../src/auth.js';
import { FakeEngine } from '../src/engines/index.js';
import { NotificationService } from '../src/notify.js';
import { BulletinService, getChangedFilesForWorktree, parseDiffOutput, parsePorcelainOutput } from '../src/bulletin.js';
import { cmdNote, cmdNotes } from '../src/cli.js';

describe('Context Bulletin & Overlap Coordination', () => {
  let tmpDir: string;
  let repoDir: string;
  let worktree1Dir: string;
  let worktree2Dir: string;
  let config: ReturnType<typeof loadConfig>;
  let ctx: ReturnType<typeof createContext>;
  let server: ReturnType<typeof createServer>;
  let token: string;
  let notifierExecCalls: Array<{ file: string; args: string[] }>;
  let notifier: NotificationService;

  function initGitRepo(targetDir: string) {
    fs.mkdirSync(targetDir, { recursive: true });
    execFileSync('git', ['init', '--template='], { cwd: targetDir });
    execFileSync('git', ['checkout', '-b', 'main'], { cwd: targetDir });
    fs.writeFileSync(path.join(targetDir, 'shared.ts'), 'export const version = 1;\n');
    fs.writeFileSync(path.join(targetDir, 'other.ts'), 'export const other = true;\n');
    execFileSync('git', ['add', '.'], { cwd: targetDir });
    execFileSync('git', ['commit', '-m', 'initial commit'], {
      cwd: targetDir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      },
    });
  }

  function authHeaders() {
    return {
      host: '127.0.0.1:7700',
      authorization: `Bearer ${token}`,
    };
  }

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-bulletin-test-'));
    process.env.AGENTHUB_HOME = tmpDir;
    config = loadConfig(tmpDir);

    token = getOrCreateToken(config.tokenPath);

    repoDir = path.join(tmpDir, 'repo');
    initGitRepo(repoDir);

    worktree1Dir = path.join(tmpDir, 'worktrees', 'proj', 'task-1');
    worktree2Dir = path.join(tmpDir, 'worktrees', 'proj', 'task-2');
    fs.mkdirSync(path.dirname(worktree1Dir), { recursive: true });

    execFileSync('git', ['worktree', 'add', worktree1Dir, '-b', 'task-1-branch', 'main'], { cwd: repoDir });
    execFileSync('git', ['worktree', 'add', worktree2Dir, '-b', 'task-2-branch', 'main'], { cwd: repoDir });

    const fakeScript = path.resolve(__dirname, 'fixtures', 'fake-agent.mjs');
    const engines = new Map();
    engines.set('agy', new FakeEngine(fakeScript));
    engines.set('codex', new FakeEngine(fakeScript));

    ctx = createContext(config, engines);
    server = await createServer(ctx.service, config);

    notifierExecCalls = [];
    notifier = new NotificationService({
      eventBus: ctx.scheduler.getEventBus(),
      config,
      taskRepo: ctx.taskRepo,
      quotaMarkRepo: ctx.quotaMarkRepo,
      exec: (file, args) => {
        notifierExecCalls.push({ file, args });
      },
    });
    notifier.start();

    ctx.projectRepo.insert({
      id: 'proj',
      name: 'Project Test',
      path: repoDir,
      defaultBranch: 'main',
      envTemplate: null,
      maxParallel: 3,
    });
  });

  afterEach(async () => {
    notifier.stop();
    await server.close();
    closeContext(ctx);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    delete process.env.AGENTHUB_HOME;
    delete process.env.AGENTHUB_TASK_ID;
  });

  describe('Git diff & porcelain parsing', () => {
    it('parses porcelain output with normal, untracked, and quoted paths', () => {
      const output = ` M src/file1.ts\n?? src/untracked.ts\nR  old.ts -> new.ts\n?? ".agenthub/context/bulletin.md"\n`;
      const files = parsePorcelainOutput(output);
      expect(files).toEqual(['src/file1.ts', 'src/untracked.ts', 'new.ts']);
    });

    it('parses diff output ignoring .agenthub and .git files', () => {
      const output = `src/main.ts\n.agenthub/task.md\n"src/components/Button.tsx"\n`;
      const files = parseDiffOutput(output);
      expect(files).toEqual(['src/main.ts', 'src/components/Button.tsx']);
    });

    it('collects changed and untracked files from a worktree', () => {
      fs.writeFileSync(path.join(worktree1Dir, 'shared.ts'), 'export const version = 2;\n');
      fs.writeFileSync(path.join(worktree1Dir, 'newfile.ts'), 'export const isNew = true;\n');

      const files = getChangedFilesForWorktree(worktree1Dir, 'main');
      expect(files.has('shared.ts')).toBe(true);
      expect(files.has('newfile.ts')).toBe(true);
      expect(files.has('other.ts')).toBe(false);
    });
  });

  describe('API endpoints: /api/projects/:id/notes and /api/tasks/:id/notes', () => {
    it('creates note via POST /api/tasks/:id/notes and retrieves via GET', async () => {
      ctx.taskRepo.insert({
        id: 'proj/task-1',
        projectId: 'proj',
        slug: 'task-1',
        title: 'Task 1',
        status: 'running',
        worktreePath: worktree1Dir,
      });

      // 1. POST note
      const postRes = await server.inject({
        method: 'POST',
        url: '/api/tasks/proj~task-1/notes',
        headers: authHeaders(),
        payload: {
          content: 'Đổi schema bảng task_notes',
          kind: 'note',
        },
      });

      expect(postRes.statusCode).toBe(201);
      const note = JSON.parse(postRes.body);
      expect(note.id).toBeGreaterThan(0);
      expect(note.projectId).toBe('proj');
      expect(note.taskId).toBe('proj/task-1');
      expect(note.content).toBe('Đổi schema bảng task_notes');
      expect(note.kind).toBe('note');

      // 2. GET /api/projects/proj/notes
      const getProjRes = await server.inject({
        method: 'GET',
        url: '/api/projects/proj/notes',
        headers: authHeaders(),
      });
      expect(getProjRes.statusCode).toBe(200);
      const projNotes = JSON.parse(getProjRes.body);
      expect(projNotes).toHaveLength(1);
      expect(projNotes[0].content).toBe('Đổi schema bảng task_notes');

      // 3. GET /api/tasks/proj~task-1/notes
      const getTaskRes = await server.inject({
        method: 'GET',
        url: '/api/tasks/proj~task-1/notes',
        headers: authHeaders(),
      });
      expect(getTaskRes.statusCode).toBe(200);
      const taskNotes = JSON.parse(getTaskRes.body);
      expect(taskNotes).toHaveLength(1);
      expect(taskNotes[0].id).toBe(note.id);
    });

    it('filters notes with query params: since, taskId, and runningOnly', async () => {
      ctx.taskRepo.insert({
        id: 'proj/task-1',
        projectId: 'proj',
        slug: 'task-1',
        title: 'Task 1',
        status: 'running',
      });
      ctx.taskRepo.insert({
        id: 'proj/task-2',
        projectId: 'proj',
        slug: 'task-2',
        title: 'Task 2',
        status: 'done',
      });

      const note1 = ctx.taskNoteRepo.insert({
        projectId: 'proj',
        taskId: 'proj/task-1',
        kind: 'note',
        content: 'Note 1 from running task',
      });
      const note2 = ctx.taskNoteRepo.insert({
        projectId: 'proj',
        taskId: 'proj/task-2',
        kind: 'note',
        content: 'Note 2 from done task',
      });

      // Filter by since
      const sinceRes = await server.inject({
        method: 'GET',
        url: `/api/projects/proj/notes?since=${note1.id}`,
        headers: authHeaders(),
      });
      expect(sinceRes.statusCode).toBe(200);
      const sinceNotes = JSON.parse(sinceRes.body);
      expect(sinceNotes).toHaveLength(1);
      expect(sinceNotes[0].id).toBe(note2.id);

      // Filter by runningOnly
      const runningRes = await server.inject({
        method: 'GET',
        url: '/api/projects/proj/notes?runningOnly=true',
        headers: authHeaders(),
      });
      expect(runningRes.statusCode).toBe(200);
      const runningNotes = JSON.parse(runningRes.body);
      expect(runningNotes).toHaveLength(1);
      expect(runningNotes[0].taskId).toBe('proj/task-1');

      // Filter by taskId
      const filterTaskRes = await server.inject({
        method: 'GET',
        url: '/api/projects/proj/notes?taskId=proj~task-2',
        headers: authHeaders(),
      });
      expect(filterTaskRes.statusCode).toBe(200);
      const task2Notes = JSON.parse(filterTaskRes.body);
      expect(task2Notes).toHaveLength(1);
      expect(task2Notes[0].taskId).toBe('proj/task-2');
    });

    it('returns 404 when project or task not found', async () => {
      const resProj = await server.inject({
        method: 'GET',
        url: '/api/projects/nonexistent/notes',
        headers: authHeaders(),
      });
      expect(resProj.statusCode).toBe(404);

      const resTask = await server.inject({
        method: 'POST',
        url: '/api/tasks/nonexistent~slug/notes',
        headers: authHeaders(),
        payload: { content: 'test note' },
      });
      expect(resTask.statusCode).toBe(404);
    });
  });

  describe('CLI commands: agenthub note and agenthub notes', () => {
    it('agenthub note posts a note for current task', async () => {
      ctx.taskRepo.insert({
        id: 'proj/task-1',
        projectId: 'proj',
        slug: 'task-1',
        title: 'Task 1',
        status: 'running',
        worktreePath: worktree1Dir,
      });

      // Start fastify listener on port
      const testPort = 18991;
      const testConfig = { ...config, port: testPort };
      await server.listen({ port: testPort, host: '127.0.0.1' });

      process.env.AGENTHUB_TASK_ID = 'proj/task-1';
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await cmdNote(testConfig, ['Thêm route mới /api/v2/notes']);

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('✓ Đã thêm ghi chú cho task proj/task-1'),
      );
      consoleLogSpy.mockRestore();

      const notes = ctx.taskNoteRepo.getByTask('proj/task-1');
      expect(notes).toHaveLength(1);
      expect(notes[0].content).toBe('Thêm route mới /api/v2/notes');
    });

    it('agenthub notes lists notes of running tasks in the project', async () => {
      ctx.taskRepo.insert({
        id: 'proj/task-1',
        projectId: 'proj',
        slug: 'task-1',
        title: 'Task 1',
        status: 'running',
        worktreePath: worktree1Dir,
      });
      ctx.taskRepo.insert({
        id: 'proj/task-2',
        projectId: 'proj',
        slug: 'task-2',
        title: 'Task 2',
        status: 'running',
        worktreePath: worktree2Dir,
      });

      ctx.taskNoteRepo.insert({
        projectId: 'proj',
        taskId: 'proj/task-2',
        kind: 'note',
        content: 'Task 2 đã hoàn tất migrations',
      });
      ctx.taskNoteRepo.insert({
        projectId: 'proj',
        taskId: 'proj/task-1',
        kind: 'overlap',
        content: 'Trùng sửa file shared.ts với task proj/task-2',
      });

      const testPort = 18992;
      const testConfig = { ...config, port: testPort };
      await server.listen({ port: testPort, host: '127.0.0.1' });

      process.env.AGENTHUB_TASK_ID = 'proj/task-1';
      const logs: string[] = [];
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
        logs.push(String(msg));
      });

      await cmdNotes(testConfig, []);

      expect(logs.some((l) => l.includes('Task 2 đã hoàn tất migrations'))).toBe(true);
      expect(logs.some((l) => l.includes('[TRÙNG FILE]') && l.includes('shared.ts'))).toBe(true);
      consoleLogSpy.mockRestore();
    });
  });

  describe('Overlap detection with 2 fake worktrees & no duplicate notifications', () => {
    it('detects overlap on shared file, creates notes, emits event, writes bulletin, and does not report duplicate', async () => {
      ctx.taskRepo.insert({
        id: 'proj/task-1',
        projectId: 'proj',
        slug: 'task-1',
        title: 'Task 1 - Feature A',
        status: 'running',
        baseRef: 'main',
        worktreePath: worktree1Dir,
      });

      ctx.taskRepo.insert({
        id: 'proj/task-2',
        projectId: 'proj',
        slug: 'task-2',
        title: 'Task 2 - Feature B',
        status: 'running',
        baseRef: 'main',
        worktreePath: worktree2Dir,
      });

      // Both worktrees modify the same file: shared.ts
      fs.writeFileSync(path.join(worktree1Dir, 'shared.ts'), 'export const version = 100;\n');
      fs.writeFileSync(path.join(worktree2Dir, 'shared.ts'), 'export const version = 200;\n');

      const bulletinService = new BulletinService({
        config,
        taskRepo: ctx.taskRepo,
        projectRepo: ctx.projectRepo,
        taskNoteRepo: ctx.taskNoteRepo,
        eventBus: ctx.scheduler.getEventBus(),
      });

      // Track task.overlap events
      const overlapEvents: Array<{ taskId: string; payload: unknown }> = [];
      ctx.scheduler.getEventBus().on('task.overlap', (taskId, payload) => {
        overlapEvents.push({ taskId: taskId || '', payload });
      });

      // 1. First overlap check
      const result1 = await bulletinService.checkOverlaps();
      expect(result1.overlapsFound).toHaveLength(1);
      expect(result1.overlapsFound[0]).toEqual({
        taskId: 'proj/task-1',
        otherTaskId: 'proj/task-2',
        file: 'shared.ts',
      });

      // Verify event was emitted
      expect(overlapEvents).toHaveLength(1);
      expect(overlapEvents[0].taskId).toBe('proj/task-1');
      expect((overlapEvents[0].payload as { file?: string }).file).toBe('shared.ts');

      // Overlap stays in the bulletin/dashboard and is not a desktop notification.
      const overlapNotification = notifierExecCalls.find((c) =>
        c.args.some((a) => a.includes('shared.ts') && a.includes('Trùng file')),
      );
      expect(overlapNotification).toBeUndefined();

      // Verify notes in database
      const notes = ctx.taskNoteRepo.getByProject('proj');
      const overlapNotes = notes.filter((n) => n.kind === 'overlap');
      expect(overlapNotes).toHaveLength(2);
      expect(overlapNotes.some((n) => n.taskId === 'proj/task-1' && n.content.includes('shared.ts'))).toBe(true);
      expect(overlapNotes.some((n) => n.taskId === 'proj/task-2' && n.content.includes('shared.ts'))).toBe(true);

      // Verify bulletin.md written in both worktrees
      const bulletin1Path = path.join(worktree1Dir, '.agenthub', 'context', 'bulletin.md');
      const bulletin2Path = path.join(worktree2Dir, '.agenthub', 'context', 'bulletin.md');
      expect(fs.existsSync(bulletin1Path)).toBe(true);
      expect(fs.existsSync(bulletin2Path)).toBe(true);

      const bulletin1Content = fs.readFileSync(bulletin1Path, 'utf-8');
      expect(bulletin1Content).toContain('Cảnh báo trùng file liên quan');
      expect(bulletin1Content).toContain('shared.ts');

      // 2. Second overlap check (both tasks still running, both still modifying shared.ts)
      // Must NOT report duplicate ("không báo trùng lặp")
      const result2 = await bulletinService.checkOverlaps();
      expect(result2.overlapsFound).toHaveLength(0);

      // No new events emitted
      expect(overlapEvents).toHaveLength(1);

      // Notes count in DB unchanged
      const notesAfter = ctx.taskNoteRepo.getByProject('proj');
      expect(notesAfter.filter((n) => n.kind === 'overlap')).toHaveLength(2);
    });

    it('generates bulletin with notes from other tasks and related overlaps', () => {
      ctx.taskRepo.insert({
        id: 'proj/task-1',
        projectId: 'proj',
        slug: 'task-1',
        title: 'Task 1',
        status: 'running',
        worktreePath: worktree1Dir,
      });
      ctx.taskRepo.insert({
        id: 'proj/task-2',
        projectId: 'proj',
        slug: 'task-2',
        title: 'Task 2',
        status: 'running',
        worktreePath: worktree2Dir,
      });

      // Add a note from task 2
      ctx.taskNoteRepo.insert({
        projectId: 'proj',
        taskId: 'proj/task-2',
        kind: 'note',
        content: 'Đã đổi interface AuthToken',
      });

      // Add an overlap note for task 1
      ctx.taskNoteRepo.insert({
        projectId: 'proj',
        taskId: 'proj/task-1',
        kind: 'overlap',
        content: 'Trùng sửa file shared.ts với task proj/task-2',
      });

      const bulletinService = new BulletinService({
        config,
        taskRepo: ctx.taskRepo,
        projectRepo: ctx.projectRepo,
        taskNoteRepo: ctx.taskNoteRepo,
        eventBus: ctx.scheduler.getEventBus(),
      });

      bulletinService.updateBulletinForTask(ctx.taskRepo.get('proj/task-1')!);

      const bulletin1Path = path.join(worktree1Dir, '.agenthub', 'context', 'bulletin.md');
      expect(fs.existsSync(bulletin1Path)).toBe(true);

      const content = fs.readFileSync(bulletin1Path, 'utf-8');
      expect(content).toContain('Đã đổi interface AuthToken');
      expect(content).toContain('Trùng sửa file shared.ts với task proj/task-2');
    });
  });

  describe('Worker protocol instructions', () => {
    it('protocol.md instructs workers to read bulletin.md and use agenthub note', () => {
      const protocolPath = path.resolve(__dirname, '..', 'src', 'protocol.md');
      expect(fs.existsSync(protocolPath)).toBe(true);
      const content = fs.readFileSync(protocolPath, 'utf-8');

      expect(content).toContain('.agenthub/context/bulletin.md');
      expect(content).toContain('agenthub note');
    });
  });
});
