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
import { Engine } from '../src/engines/index.js';
import { saveOpenProjectKey } from '../src/integrations/openproject/secrets.js';
import { OpenProjectSourceSchema } from '../src/config.js';
import { DailyReportService } from '../src/integrations/openproject/daily-report.js';

describe('AgentHub MCP Server Tools', () => {
  let tmpDir: string;
  let token: string;
  let port: number;
  let server: FastifyInstance;
  let ctx: DaemonContext;
  let client: Client;
  let clientTransport: InMemoryTransport;
  let serverTransport: InMemoryTransport;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-mcp-test-'));
    const agyHomesDir = path.join(tmpDir, 'agy-homes');
    fs.mkdirSync(agyHomesDir, { recursive: true });

    process.env.AGENTHUB_HOME = tmpDir;
    process.env.AGENTHUB_AGY_HOMES = agyHomesDir;
    process.env.AGENTHUB_DEFAULT_LOG_DIR = path.resolve(__dirname, 'fixtures', 'fake-gemini-log');
    process.env.AGENTHUB_AGY_BIN = path.resolve(__dirname, 'fixtures', 'fake-agy-login.mjs');
    port = 0;
    process.env.AGENTHUB_PORT = String(port);

    const tokenPath = path.join(tmpDir, 'token');
    token = getOrCreateToken(tokenPath);

    const config = loadConfig(tmpDir);
    config.agyHomesDir = agyHomesDir;
    config.defaultLogDir = process.env.AGENTHUB_DEFAULT_LOG_DIR;
    config.integrations.openproject.sources = [OpenProjectSourceSchema.parse({
      id: 'op', url: 'https://op.test', project: 'demo',
      timesheet: { enabled: true, activityId: 7, minEntryHours: 0.5, roundTo: 0.25 },
    })];
    saveOpenProjectKey(tmpDir, 'op', 'test-key');
    ctx = createContext(config);
    // Stop scheduler to prevent it from interfering with static db test fixtures
    ctx.scheduler.stop();

    server = await createServer(ctx.service, config);
    await server['listen']({ port: 0, host: '127.0.0.1' });
    const addr = server.server.address() as net.AddressInfo;
    port = addr.port;
    process.env.AGENTHUB_PORT = String(port);

    // Connect MCP in-memory client
    const mcpServer = createMcpServer({ port, token, baseUrl: `http://127.0.0.1:${port}` });
    [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);

    client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    ctx.scheduler.stop();
    await client.close();
    await server.close();
    ctx.db.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    delete process.env.AGENTHUB_HOME;
    delete process.env.AGENTHUB_PORT;
    delete process.env.AGENTHUB_AGY_HOMES;
    delete process.env.AGENTHUB_DEFAULT_LOG_DIR;
    delete process.env.AGENTHUB_AGY_BIN;
  });

  it('handles daemon down error gracefully when server is unreachable', async () => {
    const offlineMcpServer = createMcpServer({
      port: 59999,
      baseUrl: 'http://127.0.0.1:59999',
      token,
    });
    const [cTrans, sTrans] = InMemoryTransport.createLinkedPair();
    await offlineMcpServer.connect(sTrans);
    const offlineClient = new Client({ name: 'c', version: '1.0' }, { capabilities: {} });
    await offlineClient.connect(cTrans);

    const res = (await offlineClient.callTool({ name: 'hub_status', arguments: {} })) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('AgentHub daemon chưa chạy: `agenthub install-service` hoặc `agenthub daemon`');
    await offlineClient.close();
  });

  it('exposes setup tools with dry-run defaults and no raw integration secret input', async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      'hub_effective_config', 'hub_presets', 'hub_departments', 'hub_preset_apply', 'hub_project_settings',
      'hub_department', 'hub_config_set', 'hub_integration_discover', 'hub_request_secret',
    ]));
    const preset = tools.tools.find((tool) => tool.name === 'hub_preset_apply');
    expect(preset?.inputSchema).toMatchObject({ properties: { dryRun: { default: true } } });
    const discover = tools.tools.find((tool) => tool.name === 'hub_integration_discover');
    expect(discover?.inputSchema.properties).not.toHaveProperty('key');
  });

  it('exposes manual timesheet tools with optional source/date and validated hours', async () => {
    const tools = await client.listTools();
    const get = tools.tools.find((tool) => tool.name === 'hub_timesheet_get');
    const add = tools.tools.find((tool) => tool.name === 'hub_timesheet_add');
    expect(get).toBeDefined(); expect(add).toBeDefined();
    expect(get?.inputSchema.properties).toMatchObject({ sourceId: {}, date: {} });
    expect(add?.inputSchema.properties).toMatchObject({ description: {}, activeHours: { minimum: 0, maximum: 24 }, waitHours: { minimum: 0, maximum: 24 } });
  });

  it('gets the sole timesheet source by default and rejects an empty manual total', async () => {
    const get = (await client.callTool({ name: 'hub_timesheet_get', arguments: {} })) as { content: Array<{ text: string }> };
    expect(get.content[0].text).toContain('"sourceId":"op"');
    const add = (await client.callTool({ name: 'hub_timesheet_add', arguments: {
      ticket: 'OP-1', description: 'Không có giờ', activeHours: 0, waitHours: 0,
    } })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(add.isError).toBe(true);
    expect(add.content[0].text).toMatch(/lớn hơn 0|greater than 0/i);
  });

  it('passes a valid manual entry through the MCP add tool', async () => {
    (ctx.timesheetService as unknown as { fetchFn: typeof fetch }).fetchFn = (async (url: string | URL, _init?: RequestInit) => {
      const value = url.toString();
      if (value.includes('/work_packages?')) return new Response(JSON.stringify({ _embedded: { elements: [{ id: 1, displayId: 'OP-1', subject: 'Ticket 1', lockVersion: 1 }] }, total: 1 }));
      if (value.endsWith('/time_entries')) return new Response(JSON.stringify({ id: 10 }));
      return new Response(JSON.stringify({ _embedded: { elements: [] }, total: 0 }));
    }) as typeof fetch;
    const add = (await client.callTool({ name: 'hub_timesheet_add', arguments: {
      ticket: 'OP-1', description: 'Trao đổi khách', activeHours: 1, waitHours: 0.5, pinned: true,
    } })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(add.isError).not.toBe(true);
    expect(add.content[0].text).toContain('source_id');
  });

  it('hub_status returns overview with task counts, running tasks, and profile quota status', async () => {
    ctx.profileRepo.upsert({
      name: 'chinh',
      engine: 'agy',
      kind: 'isolated',
      enabled: 1,
      email: 'chinh@example.com',
    });
    ctx.quotaMarkRepo.mark('chinh', 'claude', Math.floor(Date.now() / 1000) + 3600);

    const res = (await client.callTool({ name: 'hub_status', arguments: {} })) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(res.content[0].text).toContain('Đang chạy 0 · chờ review 0 · chờ quota 0 · lỗi 0');
    expect(res.content[0].text).toContain('Hồ sơ:');
    expect(res.content[0].text).toContain('chinh(gemini✓ claude✗→');
    expect(res.content[0].text).toContain('Quota: Vẫn chạy bằng');

    const until = Math.floor(Date.now() / 1000) + 3600;
    ctx.quotaMarkRepo.mark('chinh', 'gemini', until);
    ctx.quotaMarkRepo.mark('chinh', 'gpt', until);
    const exhausted = (await client.callTool({ name: 'hub_status', arguments: {} })) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(exhausted.content[0].text).toContain('🚨 Hết sạch quota ở mọi tài khoản và model');
    expect(exhausted.content[0].text).toContain('Hệ thống tạm dừng thực thi task');
  });

  it('hub_status reports actual wait reason when tasks are waiting for disk', async () => {
    ctx.projectRepo.insert({
      id: 'proj-disk',
      name: 'Project Disk',
      path: tmpDir,
      defaultBranch: 'main',
      envTemplate: null,
      maxParallel: 2,
    });
    ctx.taskRepo.insert({
      id: 'proj-disk/task-disk-wait',
      projectId: 'proj-disk',
      slug: 'task-disk-wait',
      title: 'Task waiting for disk',
      status: 'waiting_quota',
      waitReason: 'disk',
    });

    const res = (await client.callTool({ name: 'hub_status', arguments: {} })) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(res.content[0].text).toContain('chờ đĩa 1');
  });

  it('hub_status displays task title on the running worker line', async () => {
    ctx.projectRepo.insert({
      id: 'proj',
      name: 'Project',
      path: tmpDir,
      defaultBranch: 'main',
      envTemplate: null,
      maxParallel: 2,
    });
    ctx.taskRepo.insert({
      id: 'proj/task-1',
      projectId: 'proj',
      slug: 'task-1',
      title: 'Tích hợp thanh toán trực tuyến',
      status: 'running',
    });

    const runningMap = ctx.scheduler.getRunning();
    runningMap.set('proj/task-1', {
      runId: 'run-1',
      taskId: 'proj/task-1',
      pid: 1234,
      pidStart: 1234,
      profileName: 'g2',
      model: 'gemini-3.8-flash-high',
      engine: { id: 'agy' } as unknown as Engine,
      startTime: Date.now() - 60000,
      timeoutMs: 3600000,
      retryCount: 0,
      projectId: 'proj',
    });

    const res = (await client.callTool({ name: 'hub_status', arguments: {} })) as {
      content: Array<{ type: string; text: string }>;
    };

    expect(res.content[0].text).toContain('Đang chạy 1');
    expect(res.content[0].text).toContain(
      '- proj/task-1 (Tích hợp thanh toán trực tuyến) [running] gemini-3.8-flash-high@g2',
    );
  });

  it('hub_projects and hub_register_project manage projects', async () => {
    // Initially empty
    let listRes = (await client.callTool({ name: 'hub_projects', arguments: {} })) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(listRes.content[0].text).toContain('Chưa có project nào được đăng ký.');

    // Register project
    const repoPath = path.join(tmpDir, 'test-repo');
    fs.mkdirSync(repoPath, { recursive: true });
    execFileSync('git', ['init', '--template='], { cwd: repoPath });
    execFileSync('git', ['checkout', '-b', 'main'], { cwd: repoPath });
    fs.writeFileSync(path.join(repoPath, 'README.md'), '# Initial Repo\n');
    execFileSync('git', ['add', '.'], { cwd: repoPath });
    execFileSync('git', ['commit', '-m', 'chore: initial commit', '--allow-empty'], {
      cwd: repoPath,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'test',
        GIT_COMMITTER_NAME: 'test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      },
    });

    const regRes = (await client.callTool({
      name: 'hub_register_project',
      arguments: {
        name: 'proj1',
        path: repoPath,
        defaultBranch: 'main',
        maxParallel: 2,
      },
    })) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(regRes.content[0].text).toContain('✓ Đã đăng ký project "proj1"');

    // List again
    listRes = (await client.callTool({ name: 'hub_projects', arguments: {} })) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(listRes.content[0].text).toContain('Projects (1):');
    expect(listRes.content[0].text).toContain('proj1 (proj1):');
  });

  it('scopes project writes and batch dispatches with AGENTHUB_MCP_PROJECT', async () => {
    for (const id of ['p1', 'p2']) {
      ctx.projectRepo.insert({ id, name: id, path: tmpDir, defaultBranch: 'main', envTemplate: null, maxParallel: 1 });
    }
    ctx.db.prepare("INSERT INTO task_batches (id, projectId, title, status) VALUES ('batch-p2', 'p2', 'P2 batch', 'draft')").run();
    process.env.AGENTHUB_MCP_PROJECT = 'p1';
    const scopedServer = createMcpServer({ port, token, baseUrl: `http://127.0.0.1:${port}` });
    const [scopedClientTransport, scopedServerTransport] = InMemoryTransport.createLinkedPair();
    await scopedServer.connect(scopedServerTransport);
    const scopedClient = new Client({ name: 'scoped-client', version: '1.0' }, { capabilities: {} });
    await scopedClient.connect(scopedClientTransport);
    try {
      const create = (await scopedClient.callTool({
        name: 'hub_create_task',
        arguments: { project: 'p2', slug: 'forbidden', title: 'Nope', body: 'x' },
      })) as { isError?: boolean; content: Array<{ text: string }> };
      expect(create.isError).toBe(true);
      expect(create.content[0].text).toContain('project "p1"');

      const dispatch = (await scopedClient.callTool({ name: 'hub_dispatch_batch', arguments: { id: 'batch-p2' } })) as { isError?: boolean; content: Array<{ text: string }> };
      expect(dispatch.isError).toBe(true);
      expect(dispatch.content[0].text).toContain('project "p1"');

      const projects = (await scopedClient.callTool({ name: 'hub_projects', arguments: {} })) as { content: Array<{ text: string }> };
      expect(projects.content[0].text).toContain('Projects (1):');
      expect(projects.content[0].text).toContain('p1 (p1):');
      expect(projects.content[0].text).not.toContain('p2 (p2):');
    } finally {
      await scopedClient.close();
      delete process.env.AGENTHUB_MCP_PROJECT;
    }
  });

  it('hub_profiles and hub_mark_quota manage profiles and quota marks', async () => {
    ctx.profileRepo.upsert({
      name: 'p1',
      engine: 'agy',
      kind: 'isolated',
      enabled: 1,
      email: 'p1@example.com',
    });

    const markRes = (await client.callTool({
      name: 'hub_mark_quota',
      arguments: {
        profile: 'p1',
        family: 'gemini',
        seconds: 120,
      },
    })) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(markRes.content[0].text).toContain('✓ Đã đánh dấu quota cho profile "p1" họ gemini trong 120s');

    ctx.profileRepo.upsert({
      name: 'p2',
      engine: 'agy',
      kind: 'isolated',
      enabled: 1,
      email: null,
      authState: 'needs_verification',
      authMessage: 'Cần xác minh tài khoản',
      verifyUrl: 'https://accounts.google.com/signin/continue?sarp=1',
    });

    const profRes = (await client.callTool({ name: 'hub_profiles', arguments: {} })) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(profRes.content[0].text).toContain('p1 [agy]');
    expect(profRes.content[0].text).toContain('Quota: gemini đến');
    expect(profRes.content[0].text).toContain('p2 [agy]');
    expect(profRes.content[0].text).toContain('p2(cần xác minh)');
    expect(profRes.content[0].text).toContain('[Cần xác minh: https://accounts.google.com/signin/continue?sarp=1]');
  });

  it('hub_create_task and hub_tasks create and list tasks', async () => {
    ctx.projectRepo.insert({
      id: 'proj',
      name: 'proj',
      path: tmpDir,
      defaultBranch: 'main',
      envTemplate: null,
      maxParallel: 1,
    });

    // Create draft task
    const createDraftRes = (await client.callTool({
      name: 'hub_create_task',
      arguments: {
        project: 'proj',
        slug: 'task-draft',
        title: 'Draft Task',
        body: 'Draft body',
        start: false,
      },
    })) as { content: Array<{ type: string; text: string }> };
    expect(createDraftRes.content[0].text).toContain('✓ Đã tạo task "proj/task-draft" [draft]: Draft Task');

    // Create queued task
    const createQueuedRes = (await client.callTool({
      name: 'hub_create_task',
      arguments: {
        project: 'proj',
        slug: 'task-queued',
        title: 'Queued Task',
        body: 'Queued body',
        start: true,
      },
    })) as { content: Array<{ type: string; text: string }> };
    expect(createQueuedRes.content[0].text).toContain('✓ Đã tạo task "proj/task-queued"');
    expect(createQueuedRes.content[0].text).toMatch(/\[(queued|waiting_quota)\]/);

    // List tasks filtered by status
    const tasksRes = (await client.callTool({
      name: 'hub_tasks',
      arguments: {
        status: 'draft',
      },
    })) as { content: Array<{ type: string; text: string }> };
    expect(tasksRes.content[0].text).toContain('Tasks (1):');
    expect(tasksRes.content[0].text).toContain('[draft] proj/task-draft');
    expect(tasksRes.content[0].text).not.toContain('proj/task-queued');
  });

  it('hub_update_task updates task fields and reports success', async () => {
    ctx.projectRepo.insert({
      id: 'proj-update',
      name: 'proj-update',
      path: tmpDir,
      defaultBranch: 'main',
      envTemplate: null,
      maxParallel: 2,
    });

    ctx.taskRepo.insert({
      id: 'proj-update/t1',
      projectId: 'proj-update',
      slug: 't1',
      title: 'Original Title',
      body: 'Original Body',
      status: 'queued',
      level: 'easy',
    });

    const updateRes = (await client.callTool({
      name: 'hub_update_task',
      arguments: {
        id: 'proj-update/t1',
        title: 'Updated Title',
        level: 'hard',
        modelChain: ['gemini-3.8-flash-high'],
        appendBody: '\nAppended detail',
      },
    })) as { content: Array<{ type: string; text: string }> };

    expect(updateRes.content[0].text).toContain('✓ Đã cập nhật task "proj-update/t1" [queued]: Updated Title');

    const updated = ctx.taskRepo.get('proj-update/t1');
    expect(updated?.title).toBe('Updated Title');
    expect(updated?.level).toBe('hard');
    expect(updated?.modelChain).toBe(JSON.stringify(['gemini-3.8-flash-high']));
    expect(updated?.body).toBe('Original Body\nAppended detail');
  });

  it('hub_task and hub_task_log return details, git diff prompt, and log tail', async () => {
    ctx.projectRepo.insert({
      id: 'proj',
      name: 'proj',
      path: tmpDir,
      defaultBranch: 'main',
      envTemplate: null,
      maxParallel: 1,
    });

    const wtPath = path.join(tmpDir, 'wt1');
    fs.mkdirSync(wtPath, { recursive: true });

    const logPath = path.join(tmpDir, 'task.log');
    fs.writeFileSync(logPath, 'Step 1: start\nStep 2: done\n', 'utf-8');

    ctx.taskRepo.insert({
      id: 'proj/t1',
      projectId: 'proj',
      slug: 't1',
      title: 'Detailed Task',
      body: 'Task body',
      status: 'review',
      worktreePath: wtPath,
      baseRef: 'main',
      branch: 'agenthub/t1',
    });
    ctx.taskRepo.update('proj/t1', { worktreePath: wtPath });

    ctx.runRepo.insert({
      id: 'r1',
      taskId: 'proj/t1',
      engine: 'codex',
      attempt: 1,
      model: 'codex:gpt-5.6-luna',
      profileName: 'default',
      worktreePath: wtPath,
      logPath,
      startedAt: Date.now() - 30000,
      endedAt: Date.now(),
      outcome: 'done',
    });

    // Write DONE marker
    const agenthubDir = path.join(wtPath, '.agenthub');
    fs.mkdirSync(agenthubDir, { recursive: true });
    fs.writeFileSync(path.join(agenthubDir, 'DONE'), 'Task finished successfully\nAll tests pass.', 'utf-8');

    // hub_task
    const taskRes = (await client.callTool({
      name: 'hub_task',
      arguments: { id: 'proj/t1' },
    })) as { content: Array<{ type: string; text: string }> };
    expect(taskRes.content[0].text).toContain('Task: proj/t1 [review]');
    expect(taskRes.content[0].text).toContain('Tiêu đề: Detailed Task');
    expect(taskRes.content[0].text).toContain('--- Báo cáo DONE ---');
    expect(taskRes.content[0].text).toContain('Task finished successfully');
    expect(taskRes.content[0].text).toContain(
      `Review: đọc diff bằng \`git -C ${wtPath} diff main...HEAD\``,
    );

    // hub_task_log
    const logRes = (await client.callTool({
      name: 'hub_task_log',
      arguments: { id: 'proj/t1', tail: 10 },
    })) as { content: Array<{ type: string; text: string }> };
    expect(logRes.content[0].text).toContain('Step 1: start');
    expect(logRes.content[0].text).toContain('Step 2: done');
  });

  it('hub_review and hub_retry handle task reviews and retrying failed tasks', async () => {
    ctx.projectRepo.insert({
      id: 'proj',
      name: 'proj',
      path: tmpDir,
      defaultBranch: 'main',
      envTemplate: null,
      maxParallel: 1,
    });

    ctx.taskRepo.insert({
      id: 'proj/t-review',
      projectId: 'proj',
      slug: 't-review',
      title: 'Review Task',
      status: 'review',
    });

    // Approve
    const approveRes = (await client.callTool({
      name: 'hub_review',
      arguments: {
        id: 'proj/t-review',
        verdict: 'approved',
      },
    })) as { content: Array<{ type: string; text: string }> };
    expect(approveRes.content[0].text).toContain('✓ Đã review task "proj/t-review": approved');
    expect(ctx.taskRepo.get('proj/t-review')?.status).toBe('done');

    // Failed task retry
    ctx.taskRepo.insert({
      id: 'proj/t-fail',
      projectId: 'proj',
      slug: 't-fail',
      title: 'Failed Task',
      status: 'failed',
    });

    const retryRes = (await client.callTool({
      name: 'hub_retry',
      arguments: {
        id: 'proj/t-fail',
        note: 'Retrying after quota replenish',
      },
    })) as { content: Array<{ type: string; text: string }> };
    expect(retryRes.content[0].text).toContain('✓ Đã retry task "proj/t-fail"');
    expect(['queued', 'waiting_quota']).toContain(ctx.taskRepo.get('proj/t-fail')?.status);

    // Done task hub_publish
    ctx.taskRepo.insert({
      id: 'proj/t-pub',
      projectId: 'proj',
      slug: 't-pub',
      title: 'Pub Task',
      status: 'done',
    });

    const pubRes = (await client.callTool({
      name: 'hub_publish',
      arguments: {
        id: 'proj/t-pub',
      },
    })) as { content: Array<{ type: string; text: string }> };
    expect(pubRes.content[0].text).toBeDefined();
  });

  it('hub_review supports source: operational without incrementing reviewerChangesRequested', async () => {
    ctx.projectRepo.insert({
      id: 'proj-op',
      name: 'proj-op',
      path: tmpDir,
      defaultBranch: 'main',
      envTemplate: null,
      maxParallel: 1,
    });
    ctx.taskRepo.insert({
      id: 'proj-op/t-conflict',
      projectId: 'proj-op',
      slug: 't-conflict',
      title: 'Conflict task',
      status: 'review',
    });

    const opRes = (await client.callTool({
      name: 'hub_review',
      arguments: {
        id: 'proj-op/t-conflict',
        verdict: 'changes_requested',
        feedback: 'Gỡ xung đột merge conflict trên nhánh main',
        source: 'operational',
      },
    })) as { content: Array<{ type: string; text: string }> };

    expect(opRes.content[0].text).toContain('changes_requested');
    expect(ctx.taskRepo.get('proj-op/t-conflict')?.reviewerChangesRequested).toBe(0);
    expect(ctx.reviewRepo.getByTask('proj-op/t-conflict')).toHaveLength(1);

    // Default source is content and increments counter
    ctx.taskRepo.update('proj-op/t-conflict', { status: 'review' });
    const contentRes = (await client.callTool({
      name: 'hub_review',
      arguments: {
        id: 'proj-op/t-conflict',
        verdict: 'changes_requested',
        feedback: 'Sửa lỗi logic code',
      },
    })) as { content: Array<{ type: string; text: string }> };

    expect(contentRes.content[0].text).toContain('changes_requested');
    expect(ctx.taskRepo.get('proj-op/t-conflict')?.reviewerChangesRequested).toBe(1);
    expect(ctx.reviewRepo.getByTask('proj-op/t-conflict')).toHaveLength(2);
  });

  it('hub_cancel cancels a task', async () => {
    ctx.projectRepo.insert({
      id: 'proj',
      name: 'proj',
      path: tmpDir,
      defaultBranch: 'main',
      envTemplate: null,
      maxParallel: 1,
    });

    ctx.taskRepo.insert({
      id: 'proj/t-queued',
      projectId: 'proj',
      slug: 't-queued',
      title: 'Queued Task',
      status: 'queued',
    });

    const cancelRes = (await client.callTool({
      name: 'hub_cancel',
      arguments: { id: 'proj/t-queued', reason: 'Trùng với task khác trong batch' },
    })) as { content: Array<{ type: string; text: string }> };
    expect(cancelRes.content[0].text).toContain('✓ Đã hủy task "proj/t-queued"');
    expect(ctx.taskRepo.get('proj/t-queued')?.status).toBe('cancelled');
    expect(ctx.taskRepo.get('proj/t-queued')?.cancelReason).toBe('Trùng với task khác trong batch');
    expect(ctx.taskRepo.get('proj/t-queued')?.cancelledBy).toBe('mcp');

    const noReason = (await client.callTool({ name: 'hub_cancel', arguments: { id: 'proj/t-queued' } })) as { isError?: boolean; content: Array<{ type: string; text: string }> };
    expect(noReason.isError ?? /validation/i.test(noReason.content[0]?.text || '')).toBeTruthy();
  });

  it('hub_wait returns immediately when target task is already terminal or wakes on SSE event', async () => {
    ctx.projectRepo.insert({
      id: 'proj',
      name: 'proj',
      path: tmpDir,
      defaultBranch: 'main',
      envTemplate: null,
      maxParallel: 1,
    });

    // 1. Task already terminal
    ctx.taskRepo.insert({
      id: 'proj/t-done',
      projectId: 'proj',
      slug: 't-done',
      title: 'Done Task',
      status: 'done',
    });

    const immRes = (await client.callTool({
      name: 'hub_wait',
      arguments: { ids: ['proj/t-done'] },
    })) as { content: Array<{ type: string; text: string }> };
    expect(immRes.content[0].text).toContain('Task "proj/t-done" đang ở trạng thái [done]: Done Task');

    // 2. Wait for pending task to reach review_ready via SSE
    ctx.taskRepo.insert({
      id: 'proj/t-wait',
      projectId: 'proj',
      slug: 't-wait',
      title: 'Wait Task',
      status: 'running',
    });

    const waitPromise = client.callTool({
      name: 'hub_wait',
      arguments: { ids: ['proj/t-wait'], timeoutSec: 5 },
    });

    // Periodically emit event until received
    const intervalTimer = setInterval(() => {
      ctx.scheduler.getEventBus().emit('task.review_ready', 'proj/t-wait');
    }, 150);

    const waitRes = (await waitPromise) as { content: Array<{ type: string; text: string }> };
    clearInterval(intervalTimer);
    expect(waitRes.content[0].text).toContain('✓ Task "proj/t-wait" đã chuyển sang trạng thái [review]');
  });

  it('hub_brain updates Claude brain status', async () => {
    const res = (await client.callTool({
      name: 'hub_brain',
      arguments: {
        activity: 'merging',
        detail: 'Đang merge PR vào main',
        taskId: 'proj/t-done',
      },
    })) as { content: Array<{ type: string; text: string }> };

    expect(res.content[0].text).toContain('✓ Đã cập nhật trạng thái Claude: [merging] Đang merge PR vào main (task: proj/t-done)');

    const brain = ctx.brainRepo.get();
    expect(brain).toBeDefined();
    expect(brain?.activity).toBe('merging');
    expect(brain?.detail).toBe('Đang merge PR vào main');
    expect(brain?.taskId).toBe('proj/t-done');
  });

  it('hub_create_task auto-updates brain status to dispatching <slug>', async () => {
    ctx.projectRepo.insert({
      id: 'testproj',
      name: 'Test Project',
      path: tmpDir,
      defaultBranch: 'main',
      envTemplate: null,
      maxParallel: 3,
    });

    const res = (await client.callTool({
      name: 'hub_create_task',
      arguments: {
        project: 'testproj',
        slug: 'slug-abc',
        title: 'Task Slug ABC',
        body: 'Description',
      },
    })) as { content: Array<{ type: string; text: string }> };

    expect(res.content[0].text).toContain('✓ Đã tạo task "testproj/slug-abc"');

    const brain = ctx.brainRepo.get();
    expect(brain).toBeDefined();
    expect(brain?.activity).toBe('dispatching');
    expect(brain?.detail).toBe('dispatching slug-abc');
    expect(brain?.taskId).toBe('testproj/slug-abc');
  });

  it('hub_review auto-updates brain status to reviewing <taskId>', async () => {
    ctx.projectRepo.insert({
      id: 'revproj',
      name: 'Review Project',
      path: tmpDir,
      defaultBranch: 'main',
      envTemplate: null,
      maxParallel: 3,
    });
    ctx.taskRepo.insert({
      id: 'revproj/task-rev',
      projectId: 'revproj',
      slug: 'task-rev',
      title: 'Task to Review',
      status: 'review',
    });

    const res = (await client.callTool({
      name: 'hub_review',
      arguments: {
        id: 'revproj/task-rev',
        verdict: 'approved',
      },
    })) as { content: Array<{ type: string; text: string }> };

    expect(res.content[0].text).toContain('✓ Đã review task "revproj/task-rev": approved');

    const brain = ctx.brainRepo.get();
    expect(brain).toBeDefined();
    expect(brain?.activity).toBe('reviewing');
    expect(brain?.detail).toBe('reviewing revproj/task-rev');
    expect(brain?.taskId).toBe('revproj/task-rev');
  });

  it('hub_git runs safe git subcommands (status, log, diff, show) and rejects forbidden commands/flags', async () => {
    const { execSync } = await import('node:child_process');
    const repoDir = path.join(tmpDir, 'test-git-repo');
    fs.mkdirSync(repoDir, { recursive: true });
    execSync('git init', { cwd: repoDir });
    execSync('git checkout -B main', { cwd: repoDir });
    execSync('git config user.email "test@example.com"', { cwd: repoDir });
    execSync('git config user.name "Tester"', { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, 'hello.txt'), 'Hello world\n');
    execSync('git add hello.txt', { cwd: repoDir });
    execSync('git commit -m "initial commit"', { cwd: repoDir });

    ctx.projectRepo.insert({
      id: 'gitproj',
      name: 'Git Project',
      path: repoDir,
      defaultBranch: 'main',
      envTemplate: null,
      maxParallel: 1,
    });

    // 1. Reject disallowed subcommand (e.g. push, commit, checkout)
    const badSubCmd = (await client.callTool({
      name: 'hub_git',
      arguments: {
        project: 'gitproj',
        args: ['push'],
      },
    })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(badSubCmd.isError).toBe(true);
    expect(badSubCmd.content[0].text).toContain('không được phép');

    // 2. Reject forbidden arguments: --output, --ext-diff, -c, --exec
    for (const forbiddenArg of ['--output=/tmp/evil', '--output', '--ext-diff', '-c foo=bar', '--exec=whoami']) {
      const forbiddenRes = (await client.callTool({
        name: 'hub_git',
        arguments: {
          project: 'gitproj',
          args: ['diff', forbiddenArg],
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(forbiddenRes.isError).toBe(true);
      expect(forbiddenRes.content[0].text).toContain('bị từ chối vì lý do an toàn');
    }

    // 3. Allowed: git status
    const statusRes = (await client.callTool({
      name: 'hub_git',
      arguments: {
        project: 'gitproj',
        args: ['status', '--short'],
      },
    })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(statusRes.isError).toBeUndefined();
    expect(statusRes.content[0].text).toBeDefined();

    // 4. Allowed: git log
    const logRes = (await client.callTool({
      name: 'hub_git',
      arguments: {
        project: 'gitproj',
        args: ['log', '-n', '1', '--oneline'],
      },
    })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(logRes.isError).toBeUndefined();
    expect(logRes.content[0].text).toContain('initial commit');

    // 5. Allowed: git diff
    fs.writeFileSync(path.join(repoDir, 'hello.txt'), 'Hello world modified\n');
    const diffRes = (await client.callTool({
      name: 'hub_git',
      arguments: {
        project: 'gitproj',
        args: ['diff'],
      },
    })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(diffRes.isError).toBeUndefined();
    expect(diffRes.content[0].text).toContain('+Hello world modified');

    // 6. Allowed: git show
    const showRes = (await client.callTool({
      name: 'hub_git',
      arguments: {
        project: 'gitproj',
        args: ['show', 'HEAD'],
      },
    })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(showRes.isError).toBeUndefined();
    expect(showRes.content[0].text).toContain('initial commit');

    // 7. Truncates output at 64KB
    const largeFile = path.join(repoDir, 'large.txt');
    fs.writeFileSync(largeFile, 'a'.repeat(70 * 1024) + '\n');
    execSync('git add large.txt && git commit -m "add large file"', { cwd: repoDir });
    fs.writeFileSync(largeFile, 'b'.repeat(70 * 1024) + '\n');
    const largeDiff = (await client.callTool({
      name: 'hub_git',
      arguments: {
        project: 'gitproj',
        args: ['diff', 'large.txt'],
      },
    })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(largeDiff.isError).toBeUndefined();
    expect(largeDiff.content[0].text).toContain('[output truncated at 64KB]');
  });

  it('hub_daily_report triggers daily report generation via API', async () => {
    const source = OpenProjectSourceSchema.parse({
      id: 'op-demo',
      url: 'https://op.example.test',
      project: 'demo',
      openStatusIds: [],
      dailyReport: {
        enabled: true,
        time: '08:00',
        weekdaysOnly: true,
        maxItems: 10,
        telegram: false,
      },
    });
    ctx.config.integrations.openproject.sources = [source];
    saveOpenProjectKey(ctx.config.hubHome, 'op-demo', 'test-key');

    const fakeFetch = vi.fn(async (url: string | URL) => {
      const urlStr = url.toString();
      if (urlStr.includes('/users/me')) {
        return new Response(JSON.stringify({ id: 1, name: 'Alice' }));
      }
      return new Response(JSON.stringify({ total: 0, _embedded: { elements: [] } }));
    });

    ctx.dailyReportService = new DailyReportService({
      config: ctx.config,
      eventBus: ctx.scheduler.getEventBus(),
      fetchFn: fakeFetch as unknown as typeof fetch,
      now: () => new Date('2026-11-03T12:00:00Z').getTime(),
    });
    ctx.service.dailyReportService = ctx.dailyReportService;

    const res = (await client.callTool({
      name: 'hub_daily_report',
      arguments: {
        sourceId: 'op-demo',
        date: '2026-11-03',
      },
    })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain('✓ Đã tạo báo cáo ngày cho nguồn op-demo');
    expect(res.content[0].text).toContain('Ngày: 03/11/2026');
  });

  it('hub_create_task tool schema and description clearly document createTicket', async () => {
    const tools = await client.listTools();
    const createTool = tools.tools.find((t) => t.name === 'hub_create_task');
    expect(createTool).toBeDefined();
    expect(createTool?.description).toContain('createTicket');
    expect(createTool?.inputSchema.properties?.createTicket).toBeDefined();
  });

  it('hub_ticket_search and hub_ticket_create interact with OpenProject via MCP tools', async () => {
    const source = OpenProjectSourceSchema.parse({
      id: 'op-mcp',
      url: 'https://op.example.test',
      project: 'mcp-demo',
      openStatusIds: [],
    });
    ctx.config.integrations.openproject.sources = [source];
    saveOpenProjectKey(ctx.config.hubHome, 'op-mcp', 'mcp-api-key');

    let createRequested = false;
    let createBody = '';
    const originalFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: string | URL, init?: RequestInit) => {
      const u = url.toString();
      if (u.includes('127.0.0.1') || u.includes('localhost')) {
        return originalFetch(url, init);
      }
      if (u.endsWith('/statuses?pageSize=100')) {
        return new Response(JSON.stringify({ _embedded: { elements: [{ id: 1, name: 'New' }] } }), { status: 200 });
      }
      if (u.endsWith('/users/me')) {
        return new Response(JSON.stringify({ id: 9, name: 'Worker' }), { status: 200 });
      }
      if (u.includes('/projects/mcp-demo/work_packages') && init?.method === 'POST') {
        createRequested = true;
        createBody = String(init?.body || '');
        return new Response(JSON.stringify({ id: 42, displayId: 'DEMO-42' }), { status: 201 });
      }
      if (u.includes('/projects/mcp-demo/work_packages?')) {
        return new Response(JSON.stringify({
          total: 1,
          _embedded: { elements: [{ id: 42, displayId: 'DEMO-42', subject: 'Search target', lockVersion: 1 }] },
        }), { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    });

    // Test hub_ticket_search
    const searchRes = (await client.callTool({
      name: 'hub_ticket_search',
      arguments: {
        sourceId: 'op-mcp',
        query: 'DEMO-42',
      },
    })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

    expect(searchRes.isError).toBeUndefined();
    const searchParsed = JSON.parse(searchRes.content[0].text);
    expect(searchParsed).toEqual([
      expect.objectContaining({ displayId: 'DEMO-42', subject: 'Search target' }),
    ]);

    // Test hub_ticket_create
    const createRes = (await client.callTool({
      name: 'hub_ticket_create',
      arguments: {
        sourceId: 'op-mcp',
        subject: 'Fresh ticket from MCP',
        description: 'Ticket details markdown',
      },
    })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

    expect(createRes.isError).toBeUndefined();
    expect(createRequested).toBe(true);
    expect(createBody).toContain('Fresh ticket from MCP');
    const createdParsed = JSON.parse(createRes.content[0].text);
    expect(createdParsed).toEqual(expect.objectContaining({ id: 42, displayId: 'DEMO-42' }));
  });

  describe('hub_health_sweep tool', () => {
    beforeEach(() => {
      vi.spyOn(ctx.scheduler, 'isStopped').mockReturnValue(false);
      vi.spyOn(ctx.scheduler, 'isDraining').mockReturnValue(false);
    });

    it('returns prompt message when no health sweep has been run', async () => {
      const res = (await client.callTool({
        name: 'hub_health_sweep',
        arguments: {},
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(res.isError).toBeUndefined();
      expect(res.content[0].text).toBe(
        'Chưa có kết quả quét sức khoẻ nào. Gọi lại với { runNow: true } để quét ngay.',
      );
    });

    it('triggers sweep via POST when runNow is true and formats clean result', async () => {
      const res = (await client.callTool({
        name: 'hub_health_sweep',
        arguments: { runNow: true },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(res.isError).toBeUndefined();
      expect(res.content[0].text).toContain('Lượt quét sức khoẻ:');
      expect(res.content[0].text).toContain('Tất cả bình thường, không phát hiện bất thường nào.');
    });

    it('retrieves cached sweep result via GET when runNow is false', async () => {
      // First run a sweep to populate lastResult
      await client.callTool({
        name: 'hub_health_sweep',
        arguments: { runNow: true },
      });

      // Now query via GET (runNow: false)
      const res = (await client.callTool({
        name: 'hub_health_sweep',
        arguments: { runNow: false },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(res.isError).toBeUndefined();
      expect(res.content[0].text).toContain('Lượt quét sức khoẻ:');
      expect(res.content[0].text).toContain('Tất cả bình thường, không phát hiện bất thường nào.');
    });

    it('formats detected issues list correctly', async () => {
      ctx.projectRepo.insert({
        id: 'p-health-mcp',
        name: 'Health MCP Project',
        path: tmpDir,
        defaultBranch: 'main',
        envTemplate: null,
        maxParallel: 1,
      });
      ctx.taskRepo.insert({
        id: 'p-health-mcp/t-churn',
        projectId: 'p-health-mcp',
        slug: 't-churn',
        title: 'Task with churn issue',
        status: 'queued',
      });
      ctx.taskRepo.update('p-health-mcp/t-churn', {
        runCount: 10,
      });

      const res = (await client.callTool({
        name: 'hub_health_sweep',
        arguments: { runNow: true },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(res.isError).toBeUndefined();
      expect(res.content[0].text).toContain('Phát hiện 1 vấn đề:');
      expect(res.content[0].text).toContain('- [churn] p-health-mcp/t-churn (queued,');
      expect(res.content[0].text).toContain('đổi model chain');
    });

    it('handles daemon down error gracefully when server is unreachable', async () => {
      const offlineMcpServer = createMcpServer({
        port: 59999,
        baseUrl: 'http://127.0.0.1:59999',
        token,
      });
      const [cTrans, sTrans] = InMemoryTransport.createLinkedPair();
      await offlineMcpServer.connect(sTrans);
      const offlineClient = new Client({ name: 'c-offline-sweep', version: '1.0' }, { capabilities: {} });
      await offlineClient.connect(cTrans);

      try {
        const res = (await offlineClient.callTool({
          name: 'hub_health_sweep',
          arguments: {},
        })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

        expect(res.isError).toBe(true);
        expect(res.content[0].text).toContain('AgentHub daemon chưa chạy');
      } finally {
        await offlineClient.close();
      }
    });
  });
});

