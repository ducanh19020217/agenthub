import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/daemon.js';
import { FakeEngine, Engine, AgyEngine } from '../src/engines/index.js';

describe('Worker Progress Tracking & AgyEngine Stream Option', () => {
  let tmpDir: string;
  let config: ReturnType<typeof loadConfig>;
  let ctx: ReturnType<typeof createContext>;
  let fakeEngine: FakeEngine;
  let projectPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-progress-test-'));
    const agyHomesDir = path.join(tmpDir, 'agy-homes');
    fs.mkdirSync(agyHomesDir, { recursive: true });

    process.env.AGENTHUB_HOME = tmpDir;
    process.env.AGENTHUB_AGY_HOMES = agyHomesDir;

    config = loadConfig(tmpDir);
    fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    const engines = new Map<string, Engine>([['agy', fakeEngine]]);

    ctx = createContext(config, engines);
    ctx.scheduler.stop();

    projectPath = path.join(tmpDir, 'repo');
    fs.mkdirSync(projectPath, { recursive: true });
    execFileSync('git', ['init', '--template='], { cwd: projectPath });
    execFileSync('git', ['checkout', '-b', 'main'], { cwd: projectPath });
    fs.writeFileSync(path.join(projectPath, 'README.md'), '# Main Repo');
    execFileSync('git', ['add', '.'], { cwd: projectPath });
    execFileSync('git', ['commit', '-m', 'initial commit', '--allow-empty'], {
      cwd: projectPath,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'test',
        GIT_AUTHOR_EMAIL: 'test@test.com',
        GIT_COMMITTER_NAME: 'test',
        GIT_COMMITTER_EMAIL: 'test@test.com',
      },
    });

    ctx.projectRepo.insert({
      id: 'p-prog',
      name: 'Project Progress',
      path: projectPath,
      defaultBranch: 'main',
      maxParallel: 2,
    });

    ctx.profileRepo.upsert({
      name: 'p1',
      engine: 'agy',
      kind: 'isolated',
      home: path.join(agyHomesDir, 'p1'),
      email: 'p1@example.com',
      enabled: 1,
      autoCreated: 0,
      createdAt: new Date().toISOString(),
    });
  });

  afterEach(() => {
    try {
      ctx.scheduler.stop();
      ctx.db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('1. AgyEngine supports agyStreamOutput config and opts.streamOutput flag', async () => {
    // Check config defaults (agyStreamOutput defaults to true)
    expect(config.workers.agyStreamOutput).toBe(true);

    // Custom config with agyStreamOutput: false
    const customCfgPath = path.join(tmpDir, 'custom-cfg');
    fs.mkdirSync(customCfgPath, { recursive: true });
    fs.writeFileSync(path.join(customCfgPath, 'config.json'), JSON.stringify({ workers: { agyStreamOutput: false } }));
    const customCfg = loadConfig(customCfgPath);
    expect(customCfg.workers.agyStreamOutput).toBe(false);

    // Mock binary to inspect CLI args
    const dumpScript = path.join(tmpDir, 'dump-args.mjs');
    fs.writeFileSync(
      dumpScript,
      `#!/usr/bin/env node
import fs from 'node:fs';
const pIdx = process.argv.indexOf('-p');
const out = pIdx >= 0 ? process.argv[pIdx + 1] : process.argv[2];
fs.writeFileSync(out, JSON.stringify(process.argv));
process.exit(0);
`,
      { mode: 0o755 },
    );

    const profile = ctx.profileRepo.get('p1')!;

    // By default: --output-format stream-json is included
    const defaultEngine = new AgyEngine(dumpScript);
    const outDefault = path.join(tmpDir, 'args-default.json');
    const childDefault = defaultEngine.spawn({
      profile,
      model: 'gemini-3.8-flash-high',
      cwd: tmpDir,
      prompt: outDefault,
      logPath: path.join(tmpDir, 'default.log'),
    });
    await new Promise<void>((resolve) => childDefault.on('exit', () => resolve()));
    const defaultArgs: string[] = JSON.parse(fs.readFileSync(outDefault, 'utf8'));
    expect(defaultArgs).toContain('--output-format');
    expect(defaultArgs[defaultArgs.indexOf('--output-format') + 1]).toBe('stream-json');

    // When streamOutput = false on engine:
    const disabledEngine = new AgyEngine(dumpScript, undefined, false);
    const outDisabled = path.join(tmpDir, 'args-disabled.json');
    const childDisabled = disabledEngine.spawn({
      profile,
      model: 'gemini-3.8-flash-high',
      cwd: tmpDir,
      prompt: outDisabled,
      logPath: path.join(tmpDir, 'disabled.log'),
    });
    await new Promise<void>((resolve) => childDisabled.on('exit', () => resolve()));
    const disabledArgs: string[] = JSON.parse(fs.readFileSync(outDisabled, 'utf8'));
    expect(disabledArgs).not.toContain('--output-format');

    // Per-call override via opts.streamOutput = false
    const outOverride = path.join(tmpDir, 'args-override.json');
    const childOverride = defaultEngine.spawn({
      profile,
      model: 'gemini-3.8-flash-high',
      cwd: tmpDir,
      prompt: outOverride,
      logPath: path.join(tmpDir, 'override.log'),
      streamOutput: false,
    });
    await new Promise<void>((resolve) => childOverride.on('exit', () => resolve()));
    const overrideArgs: string[] = JSON.parse(fs.readFileSync(outOverride, 'utf8'));
    expect(overrideArgs).not.toContain('--output-format');
  });

  it('2. AgyEngine quota and auth error detection works with stream-json log entries', () => {
    const agy = new AgyEngine('/nonexistent');

    const streamJsonQuotaLog = [
      '{"type":"init","session_id":"abc"}',
      '{"type":"tool_use","name":"run_command"}',
      '{"type":"error","error":"RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 2h30m0s."}',
    ].join('\n');
    const quotaResult = agy.detectQuota(streamJsonQuotaLog);
    expect(quotaResult.exhausted).toBe(true);
    expect(quotaResult.resetSeconds).toBe(9060); // 9000s + 60s buffer

    const streamJsonAuthLog = [
      '{"type":"init","session_id":"abc"}',
      '{"type":"error","error_code":401,"message":"UNAUTHENTICATED"}',
    ].join('\n');
    const authResult = agy.detectAuthError(streamJsonAuthLog);
    expect(authResult.expired).toBe(true);
  });

  it('3. API getTask and getStatus return worker progress fields for running agy task', async () => {
    const taskId = 'p-prog/t1';
    ctx.taskRepo.insert({
      id: taskId,
      projectId: 'p-prog',
      slug: 't1',
      title: 'Progress Task',
      level: 'easy',
      status: 'running',
      branch: 'agenthub/t1',
      baseRef: 'main',
      worktreePath: projectPath,
    });

    const branchName = 'agenthub/t1';
    execFileSync('git', ['checkout', '-b', branchName], { cwd: projectPath });
    execFileSync('git', ['checkout', 'main'], { cwd: projectPath });

    const runId = 'run-prog-1';
    ctx.runRepo.insert({
      id: runId,
      taskId,
      engine: 'agy',
      model: 'gemini-3.8-flash-high',
      profileName: 'p1',
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    });

    // Manually register running task in scheduler
    const startTime = Date.now() - 60_000;
    const runningMap = ctx.scheduler.getRunning();
    runningMap.set(taskId, {
      taskId,
      runId,
      profileName: 'p1',
      model: 'gemini-3.8-flash-high',
      engine: fakeEngine,
      startTime,
      timeoutAt: startTime + 3600_000,
      lastOutputAt: startTime,
      lastActivityAt: startTime,
      activitySource: 'log',
      cachedConversationMtime: 0,
      cachedWorktreeMtime: 0,
      pid: 999999,
      pidStart: 1,
    } as unknown as Parameters<typeof runningMap.set>[1]);

    // Initial check: getTask returns basic progress with null commits/files
    const initialTask = await ctx.service.getTask(taskId);
    expect(initialTask.currentRun).toBeDefined();
    expect(initialTask.currentRun?.startedAt).toBe(new Date(startTime).toISOString());
    expect(['log', 'worktree', 'conversation']).toContain(initialTask.currentRun?.activitySource);
    expect(initialTask.currentRun?.newCommitCount).toBeNull();
    expect(initialTask.currentRun?.changedFileCount).toBeNull();

    // Make 1 commit on the task branch
    execFileSync('git', ['checkout', branchName], { cwd: projectPath });
    fs.writeFileSync(path.join(projectPath, 'file1.txt'), 'hello from worker');
    execFileSync('git', ['add', '.'], { cwd: projectPath });
    execFileSync('git', ['commit', '-m', 'feat: initial work'], {
      cwd: projectPath,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'test',
        GIT_AUTHOR_EMAIL: 'test@test.com',
        GIT_COMMITTER_NAME: 'test',
        GIT_COMMITTER_EMAIL: 'test@test.com',
      },
    });

    // Add uncommitted file changes (staged and unstaged)
    fs.writeFileSync(path.join(projectPath, 'file2.txt'), 'unstaged modification');
    fs.writeFileSync(path.join(projectPath, 'file3.txt'), 'staged modification');
    execFileSync('git', ['add', 'file3.txt'], { cwd: projectPath });

    // Trigger commit check and reset activity check throttle to pick up worktree changes
    const runningTask = ctx.scheduler.getRunning().get(taskId);
    if (runningTask) runningTask.activityCheckedAt = 0;
    await ctx.scheduler.checkTaskCommits(taskId, undefined, Date.now(), true);

    // Verify getTask returns updated progress fields
    const updatedTask = await ctx.service.getTask(taskId);
    expect(updatedTask.currentRun?.newCommitCount).toBe(1);
    expect(updatedTask.currentRun?.lastCommitAt).toBeDefined();
    expect(typeof updatedTask.currentRun?.lastCommitAt).toBe('string');
    expect(updatedTask.currentRun?.changedFileCount).toBe(2);
    expect(updatedTask.currentRun?.activitySource).toBe('worktree');

    // Verify getStatus running worker returns the same progress fields
    const status = ctx.service.getStatus();
    const worker = status.running.find((w) => w.taskId === taskId);
    expect(worker).toBeDefined();
    expect(worker?.newCommitCount).toBe(1);
    expect(worker?.lastCommitAt).toBeDefined();
    expect(worker?.changedFileCount).toBe(2);
    expect(worker?.activitySource).toBe('worktree');
  });
});
