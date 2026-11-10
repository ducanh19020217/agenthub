import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/daemon.js';
import { createServer } from '../src/api/server.js';
import { getOrCreateToken } from '../src/auth.js';
import { Scheduler } from '../src/scheduler/index.js';
import { openDatabase, ProjectRepo, ProfileRepo, QuotaMarkRepo, TaskRepo, RunRepo, EventRepo } from '../src/db/index.js';
import { FakeEngine, Engine } from '../src/engines/index.js';

import { execFileSync as runFile } from 'node:child_process';

function initRepo(repoPath: string) {
  fs.mkdirSync(repoPath, { recursive: true });
  execFileSync('git', ['init', '--template='], { cwd: repoPath });
  execFileSync('git', ['checkout', '-b', 'main'], { cwd: repoPath });
  fs.writeFileSync(path.join(repoPath, 'README.md'), '# test\n');
  execFileSync('git', ['add', '.'], { cwd: repoPath });
  execFileSync('git', ['commit', '-m', 'init'], {
    cwd: repoPath,
    env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com' },
  });
}

describe('safe restart API', () => {
  let tmpDir: string;
  let ctx: ReturnType<typeof createContext>;
  let server: Awaited<ReturnType<typeof createServer>>;
  let token: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-restart-api-'));
    const homes = path.join(tmpDir, 'agy-homes');
    fs.mkdirSync(homes, { recursive: true });
    process.env.AGENTHUB_HOME = tmpDir;
    process.env.AGENTHUB_AGY_HOMES = homes;
    const config = loadConfig(tmpDir);
    config.port = 7798;
    token = getOrCreateToken(config.tokenPath);
    const fake = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    ctx = createContext(config, new Map<string, Engine>([['agy', fake]]));
    ctx.scheduler.stop();
    server = await createServer(ctx.service, config);
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
    ctx.db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.AGENTHUB_HOME;
    delete process.env.AGENTHUB_AGY_HOMES;
  });

  const headers = () => ({ host: '127.0.0.1:7798', authorization: `Bearer ${token}` });

  it('starts a when-idle drain, exposes it, and DELETE resumes dispatch', async () => {
    const requested = await server.inject({
      method: 'POST', url: '/api/system/restart', headers: headers(), payload: { mode: 'when-idle', timeoutMinutes: 5, reason: 'test' },
    });
    expect(requested.statusCode).toBe(200);
    expect(JSON.parse(requested.body)).toMatchObject({ draining: true, reason: 'test' });

    const current = await server.inject({ method: 'GET', url: '/api/system/restart', headers: headers() });
    expect(JSON.parse(current.body).draining).toBe(true);

    const cancelled = await server.inject({ method: 'DELETE', url: '/api/system/restart', headers: headers() });
    expect(JSON.parse(cancelled.body)).toMatchObject({ draining: false, waitingFor: [] });
    expect(ctx.eventRepo.getRecent(20).some((event) => event.type === 'hub.restart_cancelled')).toBe(true);
  });

  it('rejects invalid mode and accepts explicit now without a real service restart', async () => {
    const bad = await server.inject({ method: 'POST', url: '/api/system/restart', headers: headers(), payload: { mode: 'later' } });
    expect(bad.statusCode).toBe(400);
    const now = await server.inject({ method: 'POST', url: '/api/system/restart', headers: headers(), payload: { mode: 'now' } });
    expect(now.statusCode).toBe(200);
    expect(JSON.parse(now.body).mode).toBe('now');
  });
});

describe('safe restart scheduler termination', () => {
  let tmpDir: string;
  let config: ReturnType<typeof loadConfig>;
  let db: ReturnType<typeof openDatabase>;
  let scheduler: Scheduler;
  let taskRepo: TaskRepo;
  let runRepo: RunRepo;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-restart-scheduler-'));
    process.env.AGENTHUB_HOME = tmpDir;
    process.env.AGENTHUB_AGY_HOMES = path.join(tmpDir, 'agy-homes');
    fs.mkdirSync(process.env.AGENTHUB_AGY_HOMES, { recursive: true });
    config = loadConfig(tmpDir);
    db = openDatabase(config.dbPath);
    const projects = new ProjectRepo(db);
    taskRepo = new TaskRepo(db);
    runRepo = new RunRepo(db);
    const profiles = new ProfileRepo(db);
    const quotas = new QuotaMarkRepo(db);
    const events = new EventRepo(db);
    const repo = path.join(tmpDir, 'repo');
    initRepo(repo);
    projects.insert({ id: 'p', name: 'P', path: repo, defaultBranch: 'main', maxParallel: 1 });
    profiles.upsert({ name: 'p1', engine: 'agy', kind: 'isolated', home: path.join(tmpDir, 'agy-homes', 'p1'), email: 'p1@example.com', enabled: 1 });
    scheduler = new Scheduler(config, taskRepo, runRepo, events, projects, profiles, quotas, new Map<string, Engine>([['agy', new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'))]]), undefined, undefined, undefined, db);
    scheduler.stop();
    process.env.FAKE_MODE = 'sleep-loop';
  });

  afterEach(() => {
    process.env.STOP_SLEEP = '1';
    scheduler.shutdownForUser('hub_restart');
    scheduler.stop();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.AGENTHUB_HOME;
    delete process.env.AGENTHUB_AGY_HOMES;
    delete process.env.FAKE_MODE;
    delete process.env.STOP_SLEEP;
  });

  it('does not dispatch queued work while an active run drains, then calls restart once', async () => {
    taskRepo.insert({ id: 'p/active', projectId: 'p', slug: 'active', title: 'active', status: 'queued', level: 'easy' });
    taskRepo.insert({ id: 'p/waiting', projectId: 'p', slug: 'waiting', title: 'waiting', status: 'queued', level: 'easy' });
    scheduler.tick();
    for (let i = 0; i < 30 && scheduler.getRunning().size === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(scheduler.getRunning().size).toBe(1);
    const onReady = vi.fn();
    scheduler.beginRestartDrain(5, 'test', onReady);
    scheduler.tick();
    expect(scheduler.getRunning().size).toBe(1);
    expect(taskRepo.get('p/waiting')?.waitReason).toBe('restart');
    expect(onReady).not.toHaveBeenCalled();
    // Model the worker's normal exit after the drain has kept it alive. The
    // process was never killed by the drain itself.
    (scheduler as unknown as { running: Map<string, unknown> }).running.clear();
    scheduler.tick();
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('records hub_restart and appends an explanation when now kills a worker', async () => {
    taskRepo.insert({ id: 'p/active', projectId: 'p', slug: 'active', title: 'active', status: 'queued', level: 'easy' });
    scheduler.tick();
    for (let i = 0; i < 30 && scheduler.getRunning().size === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    const run = runRepo.getByTask('p/active')[0];
    expect(run?.logPath).toBeTruthy();
    fs.writeFileSync(run!.logPath!, 'worker output\n');
    scheduler.shutdownForUser('hub_restart');
    const finished = runRepo.get(run!.id);
    expect(finished?.outcome).toBe('crashed');
    expect(finished?.reason).toBe('hub_restart');
    expect(fs.readFileSync(run!.logPath!, 'utf8')).toContain('[agenthub] Run bị dừng vì hub khởi động lại lúc');
  });
});

describe('production restart scripts', () => {
  it('requests when-idle by default and now only with --force', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-restart-script-'));
    const bin = path.join(tmpDir, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const calls = path.join(tmpDir, 'calls');
    const curl = path.join(bin, 'curl');
    fs.writeFileSync(curl, `#!/bin/sh
echo "$*" >> "$RESTART_CALLS"
case "$*" in
  *"-X POST"*) printf '{"draining":true,"waitingFor":[{"taskId":"p/t","kind":"run","startedAt":0}]}' ;;
  *) printf '{"ok":true}' ;;
esac
`);
    fs.chmodSync(curl, 0o755);
    const tokenHome = path.join(tmpDir, 'home');
    fs.mkdirSync(path.join(tokenHome, '.agenthub'), { recursive: true });
    fs.writeFileSync(path.join(tokenHome, '.agenthub', 'token'), 'test-token');
    const env = { ...process.env, HOME: tokenHome, PATH: `${bin}:${process.env.PATH}`, RESTART_CALLS: calls };
    const script = path.join(process.cwd(), 'scripts', 'run-prod.sh');
    const idle = runFile('bash', [script, '--restart'], { cwd: process.cwd(), env, encoding: 'utf8' });
    const force = runFile('bash', [script, '--restart', '--force'], { cwd: process.cwd(), env, encoding: 'utf8' });
    const stop = runFile('bash', [path.join(process.cwd(), 'scripts', 'stop-prod.sh')], { cwd: process.cwd(), env, encoding: 'utf8' });
    const output = fs.readFileSync(calls, 'utf8');
    expect(output).toContain('"mode":"when-idle"');
    expect(output).toContain('"mode":"now"');
    expect(idle).toContain('Sẽ khởi động lại khi 1 task chạy xong');
    expect(force).toContain('worker đang chạy sẽ bị dừng');
    expect(stop).toContain('Sẽ dừng an toàn sau khi 1 task chạy xong');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
