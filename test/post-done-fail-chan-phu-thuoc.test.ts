import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { FastifyInstance } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/api/server.js';
import { createContext, DaemonContext } from '../src/daemon.js';
import { loadConfig } from '../src/config.js';
import { getOrCreateToken } from '../src/auth.js';
import { createMcpServer } from '../src/mcp/index.js';
import { FakeEngine, Engine } from '../src/engines/index.js';

describe('postDone failure and dependency unblocking (4 điểm yêu cầu)', () => {
  let tmpDir: string;
  let repoDir: string;
  let ctx: DaemonContext;
  let server: FastifyInstance;
  let client: Client;
  let clientTransport: InMemoryTransport;
  let serverTransport: InMemoryTransport;
  let port: number;

  beforeEach(async () => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'post-done-fail-test-')));
    repoDir = path.join(tmpDir, 'repo');
    fs.mkdirSync(repoDir, { recursive: true });

    // Init git repo
    execFileSync('git', ['init', '--template='], { cwd: repoDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
    execFileSync('git', ['checkout', '-b', 'main'], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, 'file.txt'), 'hello\n');
    execFileSync('git', ['add', '.'], { cwd: repoDir });
    execFileSync('git', ['commit', '-m', 'feat: init'], { cwd: repoDir });

    const agyHomesDir = path.join(tmpDir, 'agy-homes');
    fs.mkdirSync(agyHomesDir, { recursive: true });

    process.env.AGENTHUB_HOME = tmpDir;
    process.env.AGENTHUB_AGY_HOMES = agyHomesDir;
    process.env.AGENTHUB_DEFAULT_LOG_DIR = path.resolve(__dirname, 'fixtures', 'fake-gemini-log');
    process.env.AGENTHUB_AGY_BIN = path.resolve(__dirname, 'fixtures', 'fake-agy-login.mjs');
    process.env.AGENTHUB_PORT = '0';

    const tokenPath = path.join(tmpDir, 'token');
    getOrCreateToken(tokenPath);

    const config = loadConfig(tmpDir);
    config.agyHomesDir = agyHomesDir;
    config.defaultLogDir = process.env.AGENTHUB_DEFAULT_LOG_DIR;
    config.autoFixOnFail = true;

    // Use fake engine
    const fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    const engines = new Map<string, Engine>([
      ['agy', fakeEngine],
      ['codex', fakeEngine],
    ]);

    ctx = createContext(config, engines);

    // Register project with postDone enabled
    ctx.projectRepo.insert({
      id: 'test-proj',
      name: 'Test Project',
      path: repoDir,
      defaultBranch: 'main',
      envTemplate: null,
      maxParallel: 2,
      settings: JSON.stringify({
        postDone: {
          enabled: true,
          cmd: ['node', 'post-done.js'],
          timeoutSec: 30,
          artifactsDir: '.agenthub/post-done',
        },
      }),
    });

    // Register worker profile
    ctx.profileRepo.upsert({
      name: 'p1',
      engine: 'agy',
      kind: 'isolated',
      home: path.join(tmpDir, 'p1'),
      email: 'p1@example.com',
      enabled: 1,
    });

    server = await createServer(ctx.service, config);
    await server.listen({ port: 0, host: '127.0.0.1' });
    const addr = server.server.address() as net.AddressInfo;
    port = addr.port;
    process.env.AGENTHUB_PORT = String(port);

    // Setup MCP client
    const mcpServer = createMcpServer();
    [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    client = new Client({ name: 'test-mcp-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    ctx.scheduler.stop();
    await server.close();
    await client.close();
    delete process.env.AGENTHUB_HOME;
    delete process.env.AGENTHUB_AGY_HOMES;
    delete process.env.AGENTHUB_DEFAULT_LOG_DIR;
    delete process.env.AGENTHUB_AGY_BIN;
    delete process.env.AGENTHUB_PORT;
    delete process.env.AGENTHUB_TOKEN;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('Điểm 1: post-done fail ở lượt cuối (checkFixAttempts >= 2) chuyển task sang blocked, không thành done hay review', async () => {
    // Failing script
    fs.writeFileSync(
      path.join(repoDir, 'post-done.js'),
      'console.error("Traceback (most recent call last):\\n  File render.py, line 42\\nNameError: TAU");\nprocess.exit(1);\n',
    );
    execFileSync('git', ['add', 'post-done.js'], { cwd: repoDir });
    execFileSync('git', ['commit', '-m', 'feat: add failing post-done'], { cwd: repoDir });

    ctx.taskRepo.insert({
      id: 'test-proj/t-final-fail',
      projectId: 'test-proj',
      slug: 't-final-fail',
      title: 'Task final fail',
      status: 'checking',
      worktreePath: repoDir,
      baseRef: 'main',
      branch: 'main',
    });
    ctx.taskRepo.update('test-proj/t-final-fail', { checkFixAttempts: 2 });

    ctx.runRepo.insert({
      id: 'run-final-1',
      taskId: 'test-proj/t-final-fail',
      engine: 'agy',
      model: 'gemini-3.8-flash-high',
      profileName: 'p1',
    });
    ctx.runRepo.finish('run-final-1', 'done');

    await ctx.scheduler.runChecksForTask('test-proj/t-final-fail', 'run-final-1');

    const task = ctx.taskRepo.get('test-proj/t-final-fail')!;
    expect(task.status).toBe('blocked');
    expect(task.status).not.toBe('done');
    expect(task.status).not.toBe('review');
    expect(task.blockedReport).toContain('post-done fail, hết vòng tự sửa');
    expect(task.blockedReport).toContain('NameError: TAU');

    const blockedEvents = ctx.eventRepo.getByTask('test-proj/t-final-fail').filter((e) => e.type === 'task.blocked');
    expect(blockedEvents.length).toBeGreaterThan(0);

    // Defense-in-depth: nếu ai cố gọi reviewTask approved thì bị chặn
    await expect(
      ctx.service.reviewTask('test-proj/t-final-fail', { verdict: 'approved', by: 'claude' }),
    ).rejects.toThrow();
  });

  it('Điểm 3: khi check post-done fail mà task còn vòng (< 2), tự chạy lại worker và đưa outputTail của post-done vào feedback', async () => {
    // Failing script
    fs.writeFileSync(
      path.join(repoDir, 'post-done.js'),
      'console.error("Traceback (most recent call last):\\n  File render.py, line 42\\nNameError: TAU");\nprocess.exit(1);\n',
    );
    execFileSync('git', ['add', 'post-done.js'], { cwd: repoDir });
    execFileSync('git', ['commit', '-m', 'feat: failing post-done for round 1'], { cwd: repoDir });

    ctx.taskRepo.insert({
      id: 'test-proj/t-round-1',
      projectId: 'test-proj',
      slug: 't-round-1',
      title: 'Task round 1 fail',
      body: 'Nội dung ban đầu',
      status: 'checking',
      worktreePath: repoDir,
      baseRef: 'main',
      branch: 'main',
      checkFixAttempts: 0, // Còn vòng tự sửa
    });

    ctx.runRepo.insert({
      id: 'run-round-1',
      taskId: 'test-proj/t-round-1',
      engine: 'agy',
      model: 'gemini-3.8-flash-high',
      profileName: 'p1',
    });
    ctx.runRepo.finish('run-round-1', 'done');

    await ctx.scheduler.runChecksForTask('test-proj/t-round-1', 'run-round-1');

    const task = ctx.taskRepo.get('test-proj/t-round-1')!;
    // Task tự động được chạy lại (hoặc queued/running) với checkFixAttempts tăng lên 1
    expect(task.checkFixAttempts).toBe(1);
    expect(['queued', 'running']).toContain(task.status);
    expect(task.body).toContain('## Feedback tự sửa lần 1');
    expect(task.body).toContain('### post-done');
    expect(task.body).toContain('NameError: TAU');

    // Kiểm tra sự kiện checks_failed_autofix đã được emit
    const queuedEvents = ctx.eventRepo.getByTask('test-proj/t-round-1').filter((e) => e.type === 'task.queued');
    expect(queuedEvents.some((e) => e.payload?.includes('checks_failed_autofix'))).toBe(true);

    // Kiểm tra file task.md trong worktree
    const taskMdPath = path.join(repoDir, '.agenthub', 'task.md');
    expect(fs.existsSync(taskMdPath)).toBe(true);
    const taskMd = fs.readFileSync(taskMdPath, 'utf-8');
    expect(taskMd).toContain('NameError: TAU');
    expect(taskMd).toContain('post-done');
  });

  it('Điểm 2: task phụ thuộc bị chặn khi task gốc failed/blocked hoặc chưa pass checks; hiển thị rõ lý do chờ', async () => {
    // Task gốc bị blocked do post-done fail
    ctx.taskRepo.insert({
      id: 'test-proj/root-task',
      projectId: 'test-proj',
      slug: 'root-task',
      title: 'Khung Dung Canh Chung',
      status: 'blocked',
      blockedReport: '## post-done fail, hết vòng tự sửa\n\nNameError: TAU',
      worktreePath: repoDir,
    });

    // Run và check fail cho task gốc
    ctx.runRepo.insert({
      id: 'run-root',
      taskId: 'test-proj/root-task',
      engine: 'agy',
      model: 'gemini-3.8-flash-high',
      profileName: 'p1',
    });
    ctx.runRepo.finish('run-root', 'done');
    ctx.scheduler.getDatabase()!.prepare(
      'INSERT INTO check_results (taskId, runId, name, ok, exitCode, durationMs, outputTail) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('test-proj/root-task', 'run-root', 'post-done', 0, 1, 100, 'NameError: TAU');

    // Ba task phụ thuộc
    ctx.taskRepo.insert({
      id: 'test-proj/dep-1',
      projectId: 'test-proj',
      slug: 'dep-1',
      title: 'Dung canh t6 02',
      status: 'queued',
      dependsOn: ['test-proj/root-task'],
    });

    // Scheduler tick
    await ctx.scheduler.tick();

    // dep-1 không được chạy, chuyển waitReason = dependency
    const dep1 = ctx.taskRepo.get('test-proj/dep-1')!;
    expect(dep1.status).toBe('queued');
    expect(dep1.waitReason).toBe('dependency');

    // Kiểm tra lý do chờ chi tiết qua getDependencyWaitReason
    const waitReasonDetail = ctx.scheduler.getDependencyWaitReason(dep1);
    expect(waitReasonDetail).toContain('test-proj/root-task');
    expect(waitReasonDetail).toContain('blocked');
    expect(waitReasonDetail).toContain('post-done fail, hết vòng tự sửa');

    // Kiểm tra API trả về dependencyWaitReason
    const apiDetail = await ctx.service.getTask('test-proj/dep-1');
    expect(apiDetail.waitReason).toBe('dependency');
    expect(apiDetail.dependencyWaitReason).toBe(waitReasonDetail);

    // Kể cả nếu task gốc có status 'done' nhưng checks thất bại thì task phụ thuộc vẫn bị chặn
    ctx.taskRepo.updateStatus('test-proj/root-task', 'done');
    expect(ctx.scheduler.areDependenciesMet(dep1)).toBe(false);
    expect(ctx.scheduler.getDependencyWaitReason(dep1)).toContain('check thất bại: post-done');
  });

  it('Điểm 4: rerunChecks sau khi người sửa tay trên nhánh -> pass thì task done và mở khoá task phụ thuộc', async () => {
    // Task gốc ban đầu bị blocked do post-done lỗi
    ctx.taskRepo.insert({
      id: 'test-proj/khung-chung',
      projectId: 'test-proj',
      slug: 'khung-chung',
      title: 'Khung Dung Canh Chung',
      status: 'blocked',
      blockedReport: '## post-done fail, hết vòng tự sửa\n\nNameError: TAU',
      worktreePath: repoDir,
      baseRef: 'main',
      branch: 'main',
    });

    ctx.runRepo.insert({
      id: 'run-root-4',
      taskId: 'test-proj/khung-chung',
      engine: 'agy',
      model: 'gemini-3.8-flash-high',
      profileName: 'p1',
    });
    ctx.runRepo.finish('run-root-4', 'done');

    // Task phụ thuộc chờ task gốc
    ctx.taskRepo.insert({
      id: 'test-proj/dung-canh-t6',
      projectId: 'test-proj',
      slug: 'dung-canh-t6',
      title: 'Dung canh t6',
      status: 'queued',
      dependsOn: ['test-proj/khung-chung'],
    });

    // Chạy tick để task phụ thuộc nhận waitReason dependency
    await ctx.scheduler.tick();
    expect(ctx.taskRepo.get('test-proj/dung-canh-t6')?.waitReason).toBe('dependency');

    // Người dùng sửa tay code trong repo / worktree: sửa post-done.js thành công
    fs.writeFileSync(
      path.join(repoDir, 'post-done.js'),
      'console.log("TAU = 6.283185307179586; Render video frame 1... SUCCESS");\nprocess.exit(0);\n',
    );
    execFileSync('git', ['add', 'post-done.js'], { cwd: repoDir });
    execFileSync('git', ['commit', '-m', 'fix: define TAU constant'], { cwd: repoDir });

    // Gọi rerunChecks riêng cho post-done
    const rerun = await ctx.service.rerunChecks('test-proj/khung-chung', { onlyNames: ['post-done'] });
    expect(rerun.passed).toBe(true);
    expect(rerun.allPassed).toBe(true);

    // Task gốc đã chuyển sang done
    const rootAfter = ctx.taskRepo.get('test-proj/khung-chung')!;
    expect(rootAfter.status).toBe('done');
    expect(rootAfter.blockedReport).toBeNull();

    // Scheduler tick -> task phụ thuộc được mở khoá và chạy
    await ctx.scheduler.tick();
    const depAfter = ctx.taskRepo.get('test-proj/dung-canh-t6')!;
    expect(depAfter.waitReason).toBeNull();
    expect(depAfter.status).toBe('running');
  });

  it('Điểm 4 (MCP): hub_rerun_checks và hub_retry với checksOnly thực thi và hiển thị kết quả đúng', async () => {
    ctx.taskRepo.insert({
      id: 'test-proj/t-mcp-rerun',
      projectId: 'test-proj',
      slug: 't-mcp-rerun',
      title: 'Task for MCP Rerun',
      status: 'blocked',
      blockedReport: '## post-done fail, hết vòng tự sửa',
      worktreePath: repoDir,
      baseRef: 'main',
      branch: 'main',
    });

    ctx.runRepo.insert({
      id: 'run-mcp',
      taskId: 'test-proj/t-mcp-rerun',
      engine: 'agy',
      model: 'gemini-3.8-flash-high',
      profileName: 'p1',
    });
    ctx.runRepo.finish('run-mcp', 'done');

    // Sửa tay post-done thành công
    fs.writeFileSync(
      path.join(repoDir, 'post-done.js'),
      'console.log("Render frame done");\nprocess.exit(0);\n',
    );

    // Gọi tool hub_rerun_checks qua MCP client
    const res = await client.callTool({
      name: 'hub_rerun_checks',
      arguments: {
        id: 'test-proj/t-mcp-rerun',
        onlyNames: ['post-done'],
      },
    });

    const text = (res.content as Array<{ text: string }>)[0]?.text || '';
    expect(text).toContain('✓ TẤT CẢ PASS');
    expect(text).toContain('Trạng thái task: [done]');
    expect(text).toContain('Task đã chuyển trạng thái [done] và mở khoá các task phụ thuộc.');

    // Kiểm tra DB task đã done
    expect(ctx.taskRepo.get('test-proj/t-mcp-rerun')?.status).toBe('done');

    // Kiểm tra hub_retry với checksOnly: true
    ctx.taskRepo.updateStatus('test-proj/t-mcp-rerun', 'blocked');
    const retryRes = await client.callTool({
      name: 'hub_retry',
      arguments: {
        id: 'test-proj/t-mcp-rerun',
        checksOnly: true,
        onlyNames: ['post-done'],
      },
    });
    const retryText = (retryRes.content as Array<{ text: string }>)[0]?.text || '';
    expect(retryText).toContain('✓ Đã retry task');
    expect(retryText).toContain('trạng thái: [done]');
  });
});
