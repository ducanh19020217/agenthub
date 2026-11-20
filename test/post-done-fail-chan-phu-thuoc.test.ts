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
import { getRequiredCheckNames, checkMandatoryChecks, INTERNAL_MANDATORY_CHECKS } from '../src/checks.js';

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
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // ignore
    }
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
    execFileSync('git', ['add', 'post-done.js'], { cwd: repoDir });
    execFileSync('git', ['commit', '-m', 'fix: post-done script'], { cwd: repoDir });

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

  it('Feedback 1: autoCloseMergedTasks chặn chuyển done khi post-done fail hoặc thiếu check hợp lệ dù branch đã merge', async () => {
    // Tạo branch cho task và merge vào main
    execFileSync('git', ['checkout', '-b', 'agenthub/task-merged-fail', 'main'], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, 'merged-fail.txt'), 'some code');
    execFileSync('git', ['add', '.'], { cwd: repoDir });
    execFileSync('git', ['commit', '-m', 'feat: work for merged fail task'], { cwd: repoDir });
    execFileSync('git', ['checkout', 'main'], { cwd: repoDir });
    execFileSync('git', ['merge', '--no-ff', 'agenthub/task-merged-fail', '-m', 'Merge branch agenthub/task-merged-fail'], { cwd: repoDir });

    // Task bị blocked do post-done fail
    ctx.taskRepo.insert({
      id: 'test-proj/t-merged-fail',
      projectId: 'test-proj',
      slug: 't-merged-fail',
      title: 'Merged task with failing post-done',
      status: 'blocked',
      branch: 'agenthub/task-merged-fail',
      baseRef: 'main',
      worktreePath: repoDir,
    });

    // Run có check result post-done = fail
    ctx.runRepo.insert({
      id: 'run-mf-1',
      taskId: 'test-proj/t-merged-fail',
      engine: 'hub',
      model: 'checks',
      profileName: 'hub',
    });
    ctx.db.prepare(
      "INSERT INTO check_results (taskId, runId, name, ok, exitCode, durationMs, outputTail) VALUES (?, ?, 'post-done', 0, 1, 10, 'NameError: TAU')",
    ).run('test-proj/t-merged-fail', 'run-mf-1');

    // Gọi autoCloseMergedTasks -> KHÔNG được chuyển task sang done vì post-done fail
    const closed1 = await ctx.scheduler.autoCloseMergedTasks();
    expect(closed1).toBe(0);
    expect(ctx.taskRepo.get('test-proj/t-merged-fail')?.status).toBe('blocked');

    // Trường hợp thiếu check post-done (ví dụ chỉ có check khác hoặc không có check result)
    ctx.db.prepare('DELETE FROM check_results WHERE taskId = ?').run('test-proj/t-merged-fail');
    const closed2 = await ctx.scheduler.autoCloseMergedTasks();
    expect(closed2).toBe(0);
    expect(ctx.taskRepo.get('test-proj/t-merged-fail')?.status).toBe('blocked');

    // Sau khi sửa tay và tất cả mandatory checks (kèm post-done) pass
    ctx.runRepo.insert({
      id: 'run-mf-2',
      taskId: 'test-proj/t-merged-fail',
      engine: 'hub',
      model: 'checks',
      profileName: 'hub',
    });
    const headMf = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();
    for (const name of ['post-done', 'zero-byte', 'uncommitted', 'conflict-markers', 'agenthub-files']) {
      ctx.db.prepare(
        "INSERT INTO check_results (taskId, runId, name, ok, exitCode, durationMs, outputTail, head) VALUES (?, ?, ?, 1, 0, 10, 'SUCCESS', ?)",
      ).run('test-proj/t-merged-fail', 'run-mf-2', name, headMf);
    }

    // Bây giờ autoCloseMergedTasks được phép chuyển sang done
    const closed3 = await ctx.scheduler.autoCloseMergedTasks();
    expect(closed3).toBe(1);
    expect(ctx.taskRepo.get('test-proj/t-merged-fail')?.status).toBe('done');
  });

  it('Feedback 2: reviewTask approved bị chặn khi thiếu check post-done hoặc post-done fail', async () => {
    ctx.taskRepo.insert({
      id: 'test-proj/t-review-postdone',
      projectId: 'test-proj',
      slug: 't-review-postdone',
      title: 'Task in review with postDone enabled',
      status: 'review',
      worktreePath: repoDir,
      baseRef: 'main',
      branch: 'main',
    });

    // 1. Khi chưa có check result nào -> service.reviewTask approved bị chặn
    await expect(
      ctx.service.reviewTask('test-proj/t-review-postdone', { verdict: 'approved', by: 'reviewer' }),
    ).rejects.toThrow('chưa pass check bắt buộc');

    // scheduler.reviewTask cũng không chuyển task sang done
    ctx.scheduler.reviewTask('test-proj/t-review-postdone', 'approved', 'looks good', 'reviewer');
    expect(ctx.taskRepo.get('test-proj/t-review-postdone')?.status).toBe('review');

    // 2. Khi có các mandatory checks khác pass nhưng THIẾU post-done -> vẫn bị chặn
    ctx.runRepo.insert({
      id: 'run-r-1',
      taskId: 'test-proj/t-review-postdone',
      engine: 'hub',
      model: 'checks',
      profileName: 'hub',
    });
    const headR1 = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();
    for (const name of ['zero-byte', 'uncommitted', 'conflict-markers', 'agenthub-files']) {
      ctx.db.prepare(
        "INSERT INTO check_results (taskId, runId, name, ok, exitCode, durationMs, outputTail, head) VALUES (?, ?, ?, 1, 0, 5, 'ok', ?)",
      ).run('test-proj/t-review-postdone', 'run-r-1', name, headR1);
    }

    await expect(
      ctx.service.reviewTask('test-proj/t-review-postdone', { verdict: 'approved', by: 'reviewer' }),
    ).rejects.toThrow('chưa pass check bắt buộc "post-done"');

    // 3. Khi post-done fail -> bị từ chối
    ctx.db.prepare(
      "INSERT INTO check_results (taskId, runId, name, ok, exitCode, durationMs, outputTail, head) VALUES (?, ?, 'post-done', 0, 1, 10, 'failed', ?)",
    ).run('test-proj/t-review-postdone', 'run-r-1', headR1);

    await expect(
      ctx.service.reviewTask('test-proj/t-review-postdone', { verdict: 'approved', by: 'reviewer' }),
    ).rejects.toThrow('check thất bại: post-done');

    // 4. Khi tất cả mandatory checks (kèm post-done) pass -> duyệt approved thành công và chuyển done
    ctx.runRepo.insert({
      id: 'run-r-2',
      taskId: 'test-proj/t-review-postdone',
      engine: 'hub',
      model: 'checks',
      profileName: 'hub',
    });
    const headR2 = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();
    for (const name of ['post-done', 'zero-byte', 'uncommitted', 'conflict-markers', 'agenthub-files']) {
      ctx.db.prepare(
        "INSERT INTO check_results (taskId, runId, name, ok, exitCode, durationMs, outputTail, head) VALUES (?, ?, ?, 1, 0, 10, 'ok', ?)",
      ).run('test-proj/t-review-postdone', 'run-r-2', name, headR2);
    }

    await ctx.service.reviewTask('test-proj/t-review-postdone', { verdict: 'approved', by: 'reviewer', feedback: 'all good' });
    expect(ctx.taskRepo.get('test-proj/t-review-postdone')?.status).toBe('done');
  });

  it('Feedback P1.1: checkMandatoryChecks yêu cầu đầy đủ internal mandatory checks', async () => {
    ctx.taskRepo.insert({
      id: 'test-proj/t-missing-internal',
      projectId: 'test-proj',
      slug: 't-missing-internal',
      title: 'Task with only post-done but missing internal mandatory checks',
      status: 'review',
      worktreePath: repoDir,
      baseRef: 'main',
      branch: 'main',
    });

    ctx.runRepo.insert({
      id: 'run-internal-1',
      taskId: 'test-proj/t-missing-internal',
      engine: 'hub',
      model: 'checks',
      profileName: 'hub',
    });

    // Chỉ có post-done pass, thiếu zero-byte, uncommitted, conflict-markers, agenthub-files
    const headInternal1 = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();
    ctx.db.prepare(
      "INSERT INTO check_results (taskId, runId, name, ok, exitCode, durationMs, outputTail, head) VALUES (?, ?, 'post-done', 1, 0, 10, 'ok', ?)",
    ).run('test-proj/t-missing-internal', 'run-internal-1', headInternal1);

    const checkStatus = ctx.scheduler.checkMandatoryChecksForTask(
      ctx.taskRepo.get('test-proj/t-missing-internal')!,
      ctx.projectRepo.get('test-proj'),
    );
    expect(checkStatus.ok).toBe(false);
    expect(checkStatus.reason).toContain('chưa pass check bắt buộc "zero-byte"');

    await expect(
      ctx.service.reviewTask('test-proj/t-missing-internal', { verdict: 'approved', by: 'reviewer' }),
    ).rejects.toThrow('chưa pass check bắt buộc "zero-byte"');

    // Thêm các internal check còn lại
    for (const name of ['zero-byte', 'uncommitted', 'conflict-markers', 'agenthub-files']) {
      ctx.db.prepare(
        "INSERT INTO check_results (taskId, runId, name, ok, exitCode, durationMs, outputTail, head) VALUES (?, ?, ?, 1, 0, 5, 'ok', ?)",
      ).run('test-proj/t-missing-internal', 'run-internal-1', name, headInternal1);
    }

    const checkStatus2 = ctx.scheduler.checkMandatoryChecksForTask(
      ctx.taskRepo.get('test-proj/t-missing-internal')!,
      ctx.projectRepo.get('test-proj'),
    );
    expect(checkStatus2.ok).toBe(true);

    await ctx.service.reviewTask('test-proj/t-missing-internal', { verdict: 'approved', by: 'reviewer' });
    expect(ctx.taskRepo.get('test-proj/t-missing-internal')?.status).toBe('done');
  });

  it('Feedback P1.2: checkMandatoryChecks và rerunChecks từ chối / loại bỏ kết quả check từ HEAD cũ', async () => {
    // Commit 1: ban đầu
    const head1 = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();

    ctx.taskRepo.insert({
      id: 'test-proj/t-stale-head',
      projectId: 'test-proj',
      slug: 't-stale-head',
      title: 'Task with checks from stale HEAD',
      status: 'blocked',
      worktreePath: repoDir,
      baseRef: 'main',
      branch: 'main',
    });

    ctx.runRepo.insert({
      id: 'run-sh-1',
      taskId: 'test-proj/t-stale-head',
      engine: 'hub',
      model: 'checks',
      profileName: 'hub',
    });

    // Tất cả checks pass nhưng gắn với head1
    for (const name of ['post-done', 'zero-byte', 'uncommitted', 'conflict-markers', 'agenthub-files']) {
      ctx.db.prepare(
        'INSERT INTO check_results (taskId, runId, name, ok, exitCode, durationMs, outputTail, head) VALUES (?, ?, ?, 1, 0, 5, ?, ?)',
      ).run('test-proj/t-stale-head', 'run-sh-1', name, 'ok', head1);
    }

    // Commit mới: head2
    fs.writeFileSync(path.join(repoDir, 'new-file.txt'), 'new commit');
    execFileSync('git', ['add', '.'], { cwd: repoDir });
    execFileSync('git', ['commit', '-m', 'feat: new commit on branch'], { cwd: repoDir });
    const head2 = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();
    expect(head1).not.toBe(head2);

    // Khi kiểm tra với head2: checkMandatoryChecks phát hiện stale head và từ chối
    const task = ctx.taskRepo.get('test-proj/t-stale-head')!;
    const proj = ctx.projectRepo.get('test-proj')!;
    const staleStatus = ctx.scheduler.checkMandatoryChecksForTask(task, proj, head2);
    expect(staleStatus.ok).toBe(false);
    expect(staleStatus.reason).toContain('không khớp HEAD hiện tại');

    // Chạy rerunChecks
    fs.writeFileSync(
      path.join(repoDir, 'post-done.js'),
      'console.log("Post done ok");\nprocess.exit(0);\n',
    );
    execFileSync('git', ['add', 'post-done.js'], { cwd: repoDir });
    execFileSync('git', ['commit', '-m', 'fix: post-done on head3'], { cwd: repoDir });

    const rerunRes = await ctx.service.rerunChecks('test-proj/t-stale-head', { onlyNames: ['post-done'] });
    expect(rerunRes.passed).toBe(true);
    expect(rerunRes.allPassed).toBe(true);

    // Task chuyển thành done và kết quả lưu trong DB mang HEAD mới nhất
    expect(ctx.taskRepo.get('test-proj/t-stale-head')?.status).toBe('done');
    const results = ctx.scheduler.getCheckResults('test-proj/t-stale-head');
    const head3 = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();
    for (const r of results) {
      expect(r.head).toBe(head3);
    }
  });

  it('Feedback 3 P1.1: mandatory checks bắt buộc cho mọi project kể cả không có checks/postDone/package.json', async () => {
    const emptyRepo = path.join(tmpDir, 'empty-repo');
    fs.mkdirSync(emptyRepo, { recursive: true });
    execFileSync('git', ['init', '--template='], { cwd: emptyRepo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: emptyRepo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: emptyRepo });
    execFileSync('git', ['checkout', '-b', 'main'], { cwd: emptyRepo });
    fs.writeFileSync(path.join(emptyRepo, 'readme.txt'), 'hello');
    execFileSync('git', ['add', '.'], { cwd: emptyRepo });
    execFileSync('git', ['commit', '-m', 'feat: init empty'], { cwd: emptyRepo });

    ctx.projectRepo.insert({
      id: 'no-cfg-proj',
      name: 'No Config Project',
      path: emptyRepo,
      defaultBranch: 'main',
      envTemplate: null,
      maxParallel: 1,
    });

    const project = ctx.projectRepo.get('no-cfg-proj')!;
    const reqNames = getRequiredCheckNames(project, emptyRepo);
    expect(reqNames).toEqual([...INTERNAL_MANDATORY_CHECKS]);

    const checkRes = checkMandatoryChecks([], project, emptyRepo);
    expect(checkRes.ok).toBe(false);
    expect(checkRes.reason).toContain('chưa pass check bắt buộc "zero-byte"');

    ctx.taskRepo.insert({
      id: 'no-cfg-proj/t-unconfigured',
      projectId: 'no-cfg-proj',
      slug: 't-unconfigured',
      title: 'Task in unconfigured project',
      status: 'review',
      worktreePath: emptyRepo,
      baseRef: 'main',
      branch: 'main',
    });

    await expect(
      ctx.service.reviewTask('no-cfg-proj/t-unconfigured', { verdict: 'approved', by: 'reviewer' }),
    ).rejects.toThrow('chưa pass check bắt buộc "zero-byte"');
  });

  it('Feedback 3 P1.2: check results thiếu HEAD (head = NULL) bị coi là không hợp lệ khi kiểm tra currentHead và bị xóa khi rerun', async () => {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();

    ctx.taskRepo.insert({
      id: 'test-proj/t-null-head',
      projectId: 'test-proj',
      slug: 't-null-head',
      title: 'Task with NULL head checks',
      status: 'blocked',
      worktreePath: repoDir,
      baseRef: 'main',
      branch: 'main',
    });

    ctx.runRepo.insert({
      id: 'run-null-1',
      taskId: 'test-proj/t-null-head',
      engine: 'hub',
      model: 'checks',
      profileName: 'hub',
    });

    // Chèn check results với head = NULL (dữ liệu cũ trước migration)
    for (const name of ['post-done', 'zero-byte', 'uncommitted', 'conflict-markers', 'agenthub-files']) {
      ctx.db.prepare(
        "INSERT INTO check_results (taskId, runId, name, ok, exitCode, durationMs, outputTail, head) VALUES (?, ?, ?, 1, 0, 5, 'ok', NULL)",
      ).run('test-proj/t-null-head', 'run-null-1', name);
    }

    const task = ctx.taskRepo.get('test-proj/t-null-head')!;
    const proj = ctx.projectRepo.get('test-proj')!;
    const checkStatus = ctx.scheduler.checkMandatoryChecksForTask(task, proj, head);
    expect(checkStatus.ok).toBe(false);
    expect(checkStatus.reason).toContain('thiếu thông tin commit HEAD');

    // Chạy rerunChecks: các kết quả head = NULL bị xóa và thay thế bằng kết quả mang head mới
    fs.writeFileSync(
      path.join(repoDir, 'post-done.js'),
      'console.log("Post done ok");\nprocess.exit(0);\n',
    );
    execFileSync('git', ['add', 'post-done.js'], { cwd: repoDir });
    execFileSync('git', ['commit', '-m', 'fix: post done script'], { cwd: repoDir });
    const newHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();

    const rerunRes = await ctx.service.rerunChecks('test-proj/t-null-head');
    expect(rerunRes.allPassed).toBe(true);

    const saved = ctx.scheduler.getCheckResults('test-proj/t-null-head');
    for (const r of saved) {
      expect(r.head).toBe(newHead);
    }
  });

  it('Feedback 3 P1.3: areDependenciesMet, reviewTask và autoMerge từ chối khi checks thuộc HEAD cũ', async () => {
    const head1 = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();

    // 1. Dependency: task parent có status done nhưng checks thuộc HEAD cũ
    ctx.taskRepo.insert({
      id: 'test-proj/t-dep-parent',
      projectId: 'test-proj',
      slug: 't-dep-parent',
      title: 'Parent Task',
      status: 'done',
      worktreePath: repoDir,
      baseRef: 'main',
      branch: 'main',
    });

    ctx.runRepo.insert({
      id: 'run-dep-p1',
      taskId: 'test-proj/t-dep-parent',
      engine: 'hub',
      model: 'checks',
      profileName: 'hub',
    });

    for (const name of ['post-done', 'zero-byte', 'uncommitted', 'conflict-markers', 'agenthub-files']) {
      ctx.db.prepare(
        "INSERT INTO check_results (taskId, runId, name, ok, exitCode, durationMs, outputTail, head) VALUES (?, ?, ?, 1, 0, 5, 'ok', ?)",
      ).run('test-proj/t-dep-parent', 'run-dep-p1', name, head1);
    }

    // Tạo commit mới trên repoDir để HEAD đổi sang head2
    fs.writeFileSync(path.join(repoDir, 'dep-change.txt'), 'new commit for dep');
    execFileSync('git', ['add', '.'], { cwd: repoDir });
    execFileSync('git', ['commit', '-m', 'feat: new commit on branch'], { cwd: repoDir });
    const head2 = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();
    expect(head1).not.toBe(head2);

    ctx.taskRepo.insert({
      id: 'test-proj/t-dep-child',
      projectId: 'test-proj',
      slug: 't-dep-child',
      title: 'Child Task',
      status: 'queued',
      dependsOn: ['test-proj/t-dep-parent'],
    });

    const child = ctx.taskRepo.get('test-proj/t-dep-child')!;
    expect(ctx.scheduler.areDependenciesMet(child)).toBe(false);
    const reason = ctx.scheduler.getDependencyWaitReason(child);
    expect(reason).toContain('không khớp HEAD hiện tại');

    // 2. reviewTask: task trong review nhưng checks thuộc HEAD cũ
    ctx.taskRepo.insert({
      id: 'test-proj/t-review-stale-head',
      projectId: 'test-proj',
      slug: 't-review-stale-head',
      title: 'Task in review with stale checks',
      status: 'review',
      worktreePath: repoDir,
      baseRef: 'main',
      branch: 'main',
    });

    ctx.runRepo.insert({
      id: 'run-rev-s1',
      taskId: 'test-proj/t-review-stale-head',
      engine: 'hub',
      model: 'checks',
      profileName: 'hub',
    });

    for (const name of ['post-done', 'zero-byte', 'uncommitted', 'conflict-markers', 'agenthub-files']) {
      ctx.db.prepare(
        "INSERT INTO check_results (taskId, runId, name, ok, exitCode, durationMs, outputTail, head) VALUES (?, ?, ?, 1, 0, 5, 'ok', ?)",
      ).run('test-proj/t-review-stale-head', 'run-rev-s1', name, head1);
    }

    await expect(
      ctx.service.reviewTask('test-proj/t-review-stale-head', { verdict: 'approved', by: 'reviewer' }),
    ).rejects.toThrow('không khớp HEAD hiện tại');

    ctx.scheduler.reviewTask('test-proj/t-review-stale-head', 'approved', 'looks good', 'reviewer');
    expect(ctx.taskRepo.get('test-proj/t-review-stale-head')?.status).toBe('review');
  });

  it('Feedback 4 P1: đường approved bắt buộc kiểm tra mandatory checks kể cả khi project không cấu hình checks', async () => {
    // Tạo repo riêng không cấu hình checks/postDone/package.json
    const unconfiguredRepo = path.join(tmpDir, 'unconfigured-repo');
    fs.mkdirSync(unconfiguredRepo, { recursive: true });
    execFileSync('git', ['init', '--template='], { cwd: unconfiguredRepo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: unconfiguredRepo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: unconfiguredRepo });
    execFileSync('git', ['checkout', '-b', 'main'], { cwd: unconfiguredRepo });
    fs.writeFileSync(path.join(unconfiguredRepo, 'readme.txt'), 'hello');
    execFileSync('git', ['add', '.'], { cwd: unconfiguredRepo });
    execFileSync('git', ['commit', '-m', 'feat: initial commit'], { cwd: unconfiguredRepo });

    ctx.projectRepo.insert({
      id: 'unconf-proj',
      name: 'Unconfigured Project',
      path: unconfiguredRepo,
      defaultBranch: 'main',
      envTemplate: null,
      maxParallel: 1,
      settings: JSON.stringify({}),
    });

    // 1. Task trong unconf-proj nhưng chưa chạy check nào và không có run
    ctx.taskRepo.insert({
      id: 'unconf-proj/t-no-checks',
      projectId: 'unconf-proj',
      slug: 't-no-checks',
      title: 'Task without checks in unconfigured project',
      status: 'review',
      worktreePath: unconfiguredRepo,
      baseRef: 'main',
      branch: 'main',
    });

    // Gọi Scheduler.reviewTask khi chưa có checks -> không được chuyển sang done
    ctx.scheduler.reviewTask('unconf-proj/t-no-checks', 'approved', 'looks good', 'human-reviewer');
    expect(ctx.taskRepo.get('unconf-proj/t-no-checks')?.status).toBe('review');

    // 2. Task có uncommitted file (vi phạm check uncommitted)
    ctx.taskRepo.insert({
      id: 'unconf-proj/t-dirty',
      projectId: 'unconf-proj',
      slug: 't-dirty',
      title: 'Task with dirty worktree in unconfigured project',
      status: 'review',
      worktreePath: unconfiguredRepo,
      baseRef: 'main',
      branch: 'main',
    });
    ctx.runRepo.insert({
      id: 'run-unconf-dirty',
      taskId: 'unconf-proj/t-dirty',
      engine: 'hub',
      model: 'checks',
      profileName: 'hub',
    });
    fs.writeFileSync(path.join(unconfiguredRepo, 'dirty.txt'), 'dirty worktree content');

    // Gọi service.reviewTask -> tự chạy check runner nhưng check uncommitted fail -> ném 400
    await expect(
      ctx.service.reviewTask('unconf-proj/t-dirty', { verdict: 'approved', by: 'human-reviewer' }),
    ).rejects.toThrow('check thất bại: uncommitted');
    expect(ctx.taskRepo.get('unconf-proj/t-dirty')?.status).toBe('review');

    // Xóa file dirty để worktree sạch
    fs.unlinkSync(path.join(unconfiguredRepo, 'dirty.txt'));

    // 3. Task sạch trong unconf-proj: khi duyệt approved, service tự động chạy CheckRunner và chuyển sang done
    ctx.taskRepo.insert({
      id: 'unconf-proj/t-clean',
      projectId: 'unconf-proj',
      slug: 't-clean',
      title: 'Clean task in unconfigured project',
      status: 'review',
      worktreePath: unconfiguredRepo,
      baseRef: 'main',
      branch: 'main',
    });
    ctx.runRepo.insert({
      id: 'run-unconf-clean',
      taskId: 'unconf-proj/t-clean',
      engine: 'hub',
      model: 'checks',
      profileName: 'hub',
    });

    const reviewed = await ctx.service.reviewTask('unconf-proj/t-clean', { verdict: 'approved', by: 'human-reviewer' });
    expect(reviewed.status).toBe('done');
  });

  it('Feedback 4 P2: rerun riêng post-done trên commit HEAD mới tự động đồng bộ và chạy lại các checks còn lại trên HEAD mới', async () => {
    // Project có cấu hình project.checks và postDone
    const checksConfigRepo = path.join(tmpDir, 'checks-config-repo');
    fs.mkdirSync(checksConfigRepo, { recursive: true });
    execFileSync('git', ['init', '--template='], { cwd: checksConfigRepo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: checksConfigRepo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: checksConfigRepo });
    execFileSync('git', ['checkout', '-b', 'main'], { cwd: checksConfigRepo });

    const postDoneScript = path.join(checksConfigRepo, 'post-done.js');
    fs.writeFileSync(postDoneScript, 'process.exit(1);\n'); // Ban đầu fail
    fs.writeFileSync(path.join(checksConfigRepo, 'file.txt'), 'initial\n');
    execFileSync('git', ['add', '.'], { cwd: checksConfigRepo });
    execFileSync('git', ['commit', '-m', 'feat: initial commit'], { cwd: checksConfigRepo });
    const head1 = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checksConfigRepo, encoding: 'utf8' }).trim();

    ctx.projectRepo.insert({
      id: 'proj-with-checks',
      name: 'Project With Checks',
      path: checksConfigRepo,
      defaultBranch: 'main',
      envTemplate: null,
      maxParallel: 1,
      checks: JSON.stringify([
        { name: 'lint', cmd: ['node', '-e', 'process.exit(0)'] },
      ]),
      settings: JSON.stringify({
        postDone: {
          enabled: true,
          cmd: ['node', 'post-done.js'],
          timeoutSec: 30,
        },
      }),
    });

    ctx.taskRepo.insert({
      id: 'proj-with-checks/t-parent',
      projectId: 'proj-with-checks',
      slug: 't-parent',
      title: 'Parent Task',
      status: 'failed',
      worktreePath: checksConfigRepo,
      baseRef: 'main',
      branch: 'main',
    });

    ctx.taskRepo.insert({
      id: 'proj-with-checks/t-child',
      projectId: 'proj-with-checks',
      slug: 't-child',
      title: 'Child Task',
      status: 'queued',
      dependsOn: ['proj-with-checks/t-parent'],
    });

    ctx.runRepo.insert({
      id: 'run-head1',
      taskId: 'proj-with-checks/t-parent',
      engine: 'hub',
      model: 'checks',
      profileName: 'hub',
    });

    // Giả lập kết quả trên head1: lint pass, mandatory pass, nhưng post-done fail
    for (const name of ['lint', 'zero-byte', 'uncommitted', 'conflict-markers', 'agenthub-files']) {
      ctx.db.prepare(
        "INSERT INTO check_results (taskId, runId, name, ok, exitCode, durationMs, outputTail, head) VALUES (?, ?, ?, 1, 0, 5, 'ok', ?)",
      ).run('proj-with-checks/t-parent', 'run-head1', name, head1);
    }
    ctx.db.prepare(
      "INSERT INTO check_results (taskId, runId, name, ok, exitCode, durationMs, outputTail, head) VALUES (?, ?, ?, 0, 1, 5, 'fail', ?)",
    ).run('proj-with-checks/t-parent', 'run-head1', 'post-done', head1);

    // Người dùng sửa post-done script trên nhánh và tạo commit mới head2
    fs.writeFileSync(postDoneScript, 'process.exit(0);\n');
    execFileSync('git', ['add', '.'], { cwd: checksConfigRepo });
    execFileSync('git', ['commit', '-m', 'fix: resolve post-done error'], { cwd: checksConfigRepo });
    const head2 = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checksConfigRepo, encoding: 'utf8' }).trim();
    expect(head2).not.toBe(head1);

    // Gọi rerunChecks chỉ định riêng post-done
    const rerunResult = await ctx.service.rerunChecks('proj-with-checks/t-parent', {
      onlyNames: ['post-done'],
    });

    // rerunChecks phải tự động bảo đảm cả post-done và các check còn lại đều pass trên head2
    expect(rerunResult.passed).toBe(true);
    expect(rerunResult.allPassed).toBe(true);
    expect(ctx.taskRepo.get('proj-with-checks/t-parent')?.status).toBe('done');

    // Kiểm tra tất cả check_results đều thuộc head2
    const results = ctx.scheduler.getCheckResults('proj-with-checks/t-parent');
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.head).toBe(head2);
      expect(r.ok).toBe(true);
    }

    // Task phụ thuộc được unblock
    const child = ctx.taskRepo.get('proj-with-checks/t-child')!;
    expect(ctx.scheduler.areDependenciesMet(child)).toBe(true);
  });
});
