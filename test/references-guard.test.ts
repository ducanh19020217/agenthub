import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  takeReferenceSnapshot,
  detectReferenceModifications,
  takeReferenceSnapshotAsync,
  takeReferenceSnapshotsAsync,
  detectReferenceModificationsAsync,
} from '../src/references.js';
import { loadConfig } from '../src/config.js';
import {
  openDatabase,
  ProjectRepo,
  ProfileRepo,
  QuotaMarkRepo,
  TaskRepo,
  RunRepo,
  EventRepo,
  RunMetricsRepo,
} from '../src/db/index.js';
import { Scheduler } from '../src/scheduler/index.js';
import { FakeEngine, type Engine } from '../src/engines/index.js';

describe('Reference snapshotting and modification detection unit tests', () => {
  it('detects modifications in a git repository reference', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-git-ref-'));
    try {
      const repoDir = path.join(root, 'shared-repo');
      fs.mkdirSync(repoDir);
      execFileSync('git', ['init', '--template='], { cwd: repoDir });
      execFileSync('git', ['checkout', '-b', 'main'], { cwd: repoDir });

      fs.writeFileSync(path.join(repoDir, 'initial.txt'), 'version 1');
      execFileSync('git', ['add', '.'], { cwd: repoDir });
      execFileSync('git', ['commit', '-m', 'initial commit'], {
        cwd: repoDir,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'test',
          GIT_AUTHOR_EMAIL: 'test@example.com',
          GIT_COMMITTER_NAME: 'test',
          GIT_COMMITTER_EMAIL: 'test@example.com',
        },
      });

      // 1. Snapshot taken before worker run
      const snapshot = takeReferenceSnapshot({ name: 'shared_repo', path: repoDir });
      expect(snapshot.kind).toBe('git');

      // Untouched: no modifications
      expect(detectReferenceModifications([snapshot])).toEqual([]);

      // 2. Worker modifies a file in the repo
      fs.writeFileSync(path.join(repoDir, 'initial.txt'), 'version 2 (modified by worker)');
      const mods1 = detectReferenceModifications([snapshot]);
      expect(mods1.length).toBe(1);
      expect(mods1[0].name).toBe('shared_repo');
      expect(mods1[0].modifiedFiles).toContain('initial.txt');

      // 3. Worker adds a new file
      execFileSync('git', ['checkout', '--', '.'], { cwd: repoDir });
      fs.writeFileSync(path.join(repoDir, 'untracked.txt'), 'new file');
      const mods2 = detectReferenceModifications([snapshot]);
      expect(mods2.length).toBe(1);
      expect(mods2[0].modifiedFiles).toContain('untracked.txt');

      // 4. Worker commits a change
      execFileSync('git', ['add', '.'], { cwd: repoDir });
      execFileSync('git', ['commit', '-m', 'worker commit'], {
        cwd: repoDir,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'worker',
          GIT_AUTHOR_EMAIL: 'worker@example.com',
          GIT_COMMITTER_NAME: 'worker',
          GIT_COMMITTER_EMAIL: 'worker@example.com',
        },
      });
      const mods3 = detectReferenceModifications([snapshot]);
      expect(mods3.length).toBe(1);
      expect(mods3[0].modifiedFiles).toContain('untracked.txt');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('detects modifications in a regular directory reference', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-dir-ref-'));
    try {
      const dir = path.join(root, 'docs');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'doc1.md'), 'hello');
      fs.writeFileSync(path.join(dir, 'doc2.md'), 'world');

      const snapshot = takeReferenceSnapshot({ name: 'docs', path: dir });
      expect(snapshot.kind).toBe('dir');

      // Untouched: no modifications
      expect(detectReferenceModifications([snapshot])).toEqual([]);

      // 1. File modified
      fs.writeFileSync(path.join(dir, 'doc1.md'), 'hello modified content');
      const mods1 = detectReferenceModifications([snapshot]);
      expect(mods1.length).toBe(1);
      expect(mods1[0].name).toBe('docs');
      expect(mods1[0].modifiedFiles).toContain('doc1.md');

      // Restore
      fs.writeFileSync(path.join(dir, 'doc1.md'), 'hello');

      // 2. File added
      fs.writeFileSync(path.join(dir, 'new-doc.md'), 'new');
      const mods2 = detectReferenceModifications([snapshot]);
      expect(mods2.length).toBe(1);
      expect(mods2[0].modifiedFiles).toContain('new-doc.md');

      // 3. File deleted
      fs.unlinkSync(path.join(dir, 'new-doc.md'));
      fs.unlinkSync(path.join(dir, 'doc2.md'));
      const mods3 = detectReferenceModifications([snapshot]);
      expect(mods3.length).toBe(1);
      expect(mods3[0].modifiedFiles).toContain('doc2.md');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('detects modifications in a single file reference', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-file-ref-'));
    try {
      const file = path.join(root, 'glossary.json');
      fs.writeFileSync(file, '{"term": "original"}');

      const snapshot = takeReferenceSnapshot({ name: 'glossary', path: file });
      expect(snapshot.kind).toBe('file');

      // Untouched
      expect(detectReferenceModifications([snapshot])).toEqual([]);

      // Modified
      fs.writeFileSync(file, '{"term": "tampered"}');
      const mods1 = detectReferenceModifications([snapshot]);
      expect(mods1.length).toBe(1);
      expect(mods1[0].name).toBe('glossary');
      expect(mods1[0].modifiedFiles).toContain('glossary.json');

      // Deleted
      fs.unlinkSync(file);
      const mods2 = detectReferenceModifications([snapshot]);
      expect(mods2.length).toBe(1);
      expect(mods2[0].modifiedFiles).toContain('glossary.json');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('handles missing reference path properly without false positives unless created', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-missing-ref-'));
    try {
      const missingPath = path.join(root, 'nonexistent.txt');
      const snapshot = takeReferenceSnapshot({ name: 'absent', path: missingPath });
      expect(snapshot.kind).toBe('missing');

      // Still missing: no modification
      expect(detectReferenceModifications([snapshot])).toEqual([]);

      // If created during run: detected
      fs.writeFileSync(missingPath, 'unexpectedly created');
      const mods = detectReferenceModifications([snapshot]);
      expect(mods.length).toBe(1);
      expect(mods[0].name).toBe('absent');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('Async reference snapshotting and modification detection', () => {
  it('takes async snapshots and detects modifications across git, dir, and file references', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-async-ref-'));
    try {
      // 1. File ref
      const fileRef = path.join(root, 'config.json');
      fs.writeFileSync(fileRef, '{"version": 1}');

      // 2. Dir ref
      const dirRef = path.join(root, 'docs');
      fs.mkdirSync(dirRef);
      fs.writeFileSync(path.join(dirRef, 'guide.md'), '# Guide');

      // 3. Git ref
      const gitRef = path.join(root, 'repo');
      fs.mkdirSync(gitRef);
      execFileSync('git', ['init', '--template='], { cwd: gitRef });
      execFileSync('git', ['checkout', '-b', 'main'], { cwd: gitRef });
      fs.writeFileSync(path.join(gitRef, 'readme.txt'), 'hello');
      execFileSync('git', ['add', '.'], { cwd: gitRef });
      execFileSync('git', ['commit', '-m', 'init'], {
        cwd: gitRef,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'test',
          GIT_AUTHOR_EMAIL: 'test@example.com',
          GIT_COMMITTER_NAME: 'test',
          GIT_COMMITTER_EMAIL: 'test@example.com',
        },
      });

      // 4. Missing ref
      const missingRef = path.join(root, 'missing.txt');

      const refs = [
        { name: 'cfg', path: fileRef },
        { name: 'docs', path: dirRef },
        { name: 'code', path: gitRef },
        { name: 'missing', path: missingRef },
      ];

      // Take snapshots concurrently
      const snapshots = await takeReferenceSnapshotsAsync(refs);
      expect(snapshots.length).toBe(4);
      expect(snapshots[0].kind).toBe('file');
      expect(snapshots[1].kind).toBe('dir');
      expect(snapshots[2].kind).toBe('git');
      expect(snapshots[3].kind).toBe('missing');

      // No modifications initially
      const initialMods = await detectReferenceModificationsAsync(snapshots);
      expect(initialMods).toEqual([]);

      // Modify all references
      fs.writeFileSync(fileRef, '{"version": 2}');
      fs.writeFileSync(path.join(dirRef, 'new.md'), '# New doc');
      fs.writeFileSync(path.join(gitRef, 'readme.txt'), 'modified hello');
      fs.writeFileSync(missingRef, 'now exists');

      const detectedMods = await detectReferenceModificationsAsync(snapshots);
      expect(detectedMods.length).toBe(4);
      expect(detectedMods.some((m) => m.name === 'cfg')).toBe(true);
      expect(detectedMods.some((m) => m.name === 'docs')).toBe(true);
      expect(detectedMods.some((m) => m.name === 'code')).toBe(true);
      expect(detectedMods.some((m) => m.name === 'missing')).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('Scheduler reference guard integration', () => {
  it('blocks task and emits reference.modified when reference is modified by worker', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-ref-sched-'));
    const prevHome = process.env.AGENTHUB_HOME;
    const prevAgyHomes = process.env.AGENTHUB_AGY_HOMES;
    try {
      const hubHome = path.join(root, 'hub');
      const agyHomesDir = path.join(root, 'agy-homes');
      fs.mkdirSync(hubHome, { recursive: true });
      fs.mkdirSync(agyHomesDir, { recursive: true });

      process.env.AGENTHUB_HOME = hubHome;
      process.env.AGENTHUB_AGY_HOMES = agyHomesDir;

      // Shared reference dir
      const refDir = path.join(root, 'shared-data');
      fs.mkdirSync(refDir);
      const refFile = path.join(refDir, 'readonly.txt');
      fs.writeFileSync(refFile, 'initial content');

      // Project repo
      const projectRepoDir = path.join(root, 'project');
      fs.mkdirSync(projectRepoDir);
      execFileSync('git', ['init', '--template='], { cwd: projectRepoDir });
      execFileSync('git', ['checkout', '-b', 'main'], { cwd: projectRepoDir });
      fs.writeFileSync(path.join(projectRepoDir, 'main.txt'), 'main');
      execFileSync('git', ['add', '.'], { cwd: projectRepoDir });
      execFileSync('git', ['commit', '-m', 'init'], {
        cwd: projectRepoDir,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'test',
          GIT_AUTHOR_EMAIL: 'test@example.com',
          GIT_COMMITTER_NAME: 'test',
          GIT_COMMITTER_EMAIL: 'test@example.com',
        },
      });

      // Fake worker script that modifies the reference and creates DONE marker
      const fakeAgent = path.join(root, 'bad-worker.mjs');
      fs.writeFileSync(
        fakeAgent,
        `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

// Worker maliciously/accidentally modifies the reference file via env
const refPath = process.env.AGENTHUB_REF_SHARED_DATA;
if (refPath) {
  fs.writeFileSync(path.join(refPath, 'readonly.txt'), 'tampered by worker');
}

// Worker creates DONE marker
const agentHubDir = path.join(process.cwd(), '.agenthub');
fs.mkdirSync(agentHubDir, { recursive: true });
fs.writeFileSync(path.join(agentHubDir, 'DONE'), 'All done!');
process.exit(0);
`,
        { mode: 0o755 },
      );

      const config = loadConfig(hubHome);
      config.hubHome = hubHome;
      config.agyHomesDir = agyHomesDir;
      config.port = 0;

      const db = openDatabase(config.dbPath);
      const projectRepo = new ProjectRepo(db);
      const profileRepo = new ProfileRepo(db);
      const quotaMarkRepo = new QuotaMarkRepo(db);
      const taskRepo = new TaskRepo(db);
      const runRepo = new RunRepo(db);
      const eventRepo = new EventRepo(db);
      const runMetricsRepo = new RunMetricsRepo(db);

      const fakeEngine = new FakeEngine(fakeAgent);
      const engines = new Map<string, Engine>([['agy', fakeEngine]]);

      const scheduler = new Scheduler(
        config,
        taskRepo,
        runRepo,
        eventRepo,
        projectRepo,
        profileRepo,
        quotaMarkRepo,
        engines,
        undefined,
        undefined,
        undefined,
        runMetricsRepo,
      );

      // Track reference.modified event
      const refModifiedEvents: Array<{ taskId: string; payload: unknown }> = [];
      scheduler.getEventBus().on('reference.modified', (taskId, payload) => {
        refModifiedEvents.push({ taskId, payload });
      });

      const taskBlockedEvents: Array<{ taskId: string; payload: unknown }> = [];
      scheduler.getEventBus().on('task.blocked', (taskId, payload) => {
        taskBlockedEvents.push({ taskId, payload });
      });

      // Create project with references
      projectRepo.insert({
        id: 'test-proj',
        name: 'test-proj',
        path: projectRepoDir,
        defaultBranch: 'main',
        maxParallel: 2,
        settings: JSON.stringify({
          references: [
            { name: 'shared_data', path: refDir, inject: false },
          ],
        }),
      });

      // Create profile
      profileRepo.upsert({
        name: 'default',
        engine: 'agy',
        kind: 'isolated',
        home: path.join(root, 'agy-home'),
        email: null,
        enabled: 1,
      });

      // Create task
      taskRepo.insert({
        id: 'test-proj/bad-task',
        projectId: 'test-proj',
        title: 'Task that touches references',
        slug: 'bad-task',
        status: 'queued',
        level: 'easy',
      });
      const task = taskRepo.get('test-proj/bad-task')!;

      // Step 1: Start the task
      await scheduler.startTask(task, 'gemini-3.8-flash-high', 'default');

      // Wait for the fake worker process to complete
      for (let i = 0; i < 50; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        scheduler.tick();
        const current = taskRepo.get(task.id);
        if (current && current.status !== 'running') break;
      }

      // Check task status
      const updatedTask = taskRepo.get(task.id);
      expect(updatedTask).toBeDefined();
      expect(updatedTask?.status).toBe('blocked');
      expect(runMetricsRepo.getByTask(task.id)).toHaveLength(1);

      // Check events
      expect(refModifiedEvents.length).toBeGreaterThanOrEqual(1);
      expect(refModifiedEvents[0].taskId).toBe(task.id);
      const eventPayload = refModifiedEvents[0].payload as { reference: string; modifiedFiles: string[] };
      expect(eventPayload.reference).toBe('shared_data');
      expect(eventPayload.modifiedFiles).toContain('readonly.txt');

      expect(taskBlockedEvents.length).toBeGreaterThanOrEqual(1);

      // Check that .agenthub/DONE was removed and .agenthub/BLOCKED was created
      expect(fs.existsSync(path.join(updatedTask!.worktreePath!, '.agenthub', 'DONE'))).toBe(false);
      const blockedPath = path.join(updatedTask!.worktreePath!, '.agenthub', 'BLOCKED');
      expect(fs.existsSync(blockedPath)).toBe(true);
      const blockedContent = fs.readFileSync(blockedPath, 'utf-8');
      expect(blockedContent).toContain('shared_data');
      expect(blockedContent).toContain('readonly.txt');

      scheduler.stop();
      db.close();
    } finally {
      if (prevHome !== undefined) process.env.AGENTHUB_HOME = prevHome; else delete process.env.AGENTHUB_HOME;
      if (prevAgyHomes !== undefined) process.env.AGENTHUB_AGY_HOMES = prevAgyHomes; else delete process.env.AGENTHUB_AGY_HOMES;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('completes task normally when references are untouched', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-ref-clean-'));
    const prevHome = process.env.AGENTHUB_HOME;
    const prevAgyHomes = process.env.AGENTHUB_AGY_HOMES;
    try {
      const hubHome = path.join(root, 'hub');
      const agyHomesDir = path.join(root, 'agy-homes');
      fs.mkdirSync(hubHome, { recursive: true });
      fs.mkdirSync(agyHomesDir, { recursive: true });

      process.env.AGENTHUB_HOME = hubHome;
      process.env.AGENTHUB_AGY_HOMES = agyHomesDir;

      const refDir = path.join(root, 'clean-ref');
      fs.mkdirSync(refDir);
      fs.writeFileSync(path.join(refDir, 'clean.txt'), 'clean content');

      const projectRepoDir = path.join(root, 'project-clean');
      fs.mkdirSync(projectRepoDir);
      execFileSync('git', ['init', '--template='], { cwd: projectRepoDir });
      execFileSync('git', ['checkout', '-b', 'main'], { cwd: projectRepoDir });
      fs.writeFileSync(path.join(projectRepoDir, 'main.txt'), 'main');
      execFileSync('git', ['add', '.'], { cwd: projectRepoDir });
      execFileSync('git', ['commit', '-m', 'init'], {
        cwd: projectRepoDir,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'test',
          GIT_AUTHOR_EMAIL: 'test@example.com',
          GIT_COMMITTER_NAME: 'test',
          GIT_COMMITTER_EMAIL: 'test@example.com',
        },
      });

      // Fake worker that respects references and creates DONE marker
      const fakeAgent = path.join(root, 'good-worker.mjs');
      fs.writeFileSync(
        fakeAgent,
        `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

// Worker creates DONE marker without touching references
const agentHubDir = path.join(process.cwd(), '.agenthub');
fs.mkdirSync(agentHubDir, { recursive: true });
fs.writeFileSync(path.join(agentHubDir, 'DONE'), 'Finished cleanly!');
process.exit(0);
`,
        { mode: 0o755 },
      );

      const config = loadConfig(hubHome);
      config.hubHome = hubHome;
      config.agyHomesDir = agyHomesDir;
      config.port = 0;

      const db = openDatabase(config.dbPath);
      const projectRepo = new ProjectRepo(db);
      const profileRepo = new ProfileRepo(db);
      const quotaMarkRepo = new QuotaMarkRepo(db);
      const taskRepo = new TaskRepo(db);
      const runRepo = new RunRepo(db);
      const eventRepo = new EventRepo(db);

      const fakeEngine = new FakeEngine(fakeAgent);
      const engines = new Map<string, Engine>([['agy', fakeEngine]]);

      const scheduler = new Scheduler(
        config,
        taskRepo,
        runRepo,
        eventRepo,
        projectRepo,
        profileRepo,
        quotaMarkRepo,
        engines,
      );

      const refModifiedEvents: Array<{ taskId: string }> = [];
      scheduler.getEventBus().on('reference.modified', (taskId) => {
        refModifiedEvents.push({ taskId });
      });

      projectRepo.insert({
        id: 'clean-proj',
        name: 'clean-proj',
        path: projectRepoDir,
        defaultBranch: 'main',
        maxParallel: 2,
        settings: JSON.stringify({
          references: [{ name: 'clean_data', path: refDir, inject: false }],
        }),
      });

      profileRepo.upsert({
        name: 'default',
        engine: 'agy',
        kind: 'isolated',
        home: path.join(root, 'agy-home'),
        email: null,
        enabled: 1,
      });

      taskRepo.insert({
        id: 'clean-proj/good-task',
        projectId: 'clean-proj',
        title: 'Task that respects references',
        slug: 'good-task',
        status: 'queued',
        level: 'easy',
      });
      const task = taskRepo.get('clean-proj/good-task')!;

      await scheduler.startTask(task, 'gemini-3.8-flash-high', 'default');
      for (let i = 0; i < 50; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        scheduler.tick();
        const current = taskRepo.get(task.id);
        if (current && current.status !== 'running') break;
      }

      const updatedTask = taskRepo.get(task.id);
      expect(updatedTask).toBeDefined();
      // Should NOT be blocked; should advance to checking / review
      expect(updatedTask?.status).not.toBe('blocked');
      expect(refModifiedEvents.length).toBe(0);

      scheduler.stop();
      db.close();
    } finally {
      if (prevHome !== undefined) process.env.AGENTHUB_HOME = prevHome; else delete process.env.AGENTHUB_HOME;
      if (prevAgyHomes !== undefined) process.env.AGENTHUB_AGY_HOMES = prevAgyHomes; else delete process.env.AGENTHUB_AGY_HOMES;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
