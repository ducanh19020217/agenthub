import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { FastifyInstance } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/api/server.js';
import { createContext, DaemonContext } from '../src/daemon.js';
import { loadConfig } from '../src/config.js';
import { getOrCreateToken } from '../src/auth.js';
import { createMcpServer } from '../src/mcp/index.js';
import { detectCycle } from '../src/services/dag.js';
import { NotificationService } from '../src/notify.js';

describe('Batch Planning & Drafts (c-plan-drafts)', () => {
  let tmpDir: string;
  let token: string;
  let port: number;
  let server: FastifyInstance;
  let ctx: DaemonContext;
  let client: Client;
  let clientTransport: InMemoryTransport;
  let serverTransport: InMemoryTransport;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-batch-test-'));
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
    config.notifications.desktopLevel = 'all';
    config.agyHomesDir = agyHomesDir;
    config.defaultLogDir = process.env.AGENTHUB_DEFAULT_LOG_DIR;
    ctx = createContext(config);
    ctx.scheduler.stop();

    // Register a test project
    const projectDir = path.join(tmpDir, 'test-project');
    fs.mkdirSync(projectDir, { recursive: true });
    ctx.projectRepo.insert({
      id: 'test-proj',
      name: 'Test Project',
      path: projectDir,
      defaultBranch: 'main',
      envTemplate: null,
      maxParallel: 2,
    });

    server = await createServer(ctx.service, config);
    await server['listen']({ port: 0, host: '127.0.0.1' });
    const addr = server.server.address() as net.AddressInfo;
    port = addr.port;
    process.env.AGENTHUB_PORT = String(port);

    const mcpServer = createMcpServer({ port, token, baseUrl: `http://127.0.0.1:${port}` });
    [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);

    client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    try {
      await client.close();
      await server.close();
    } catch {
      // ignore
    }
    ctx.scheduler.stop();
    ctx.db.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    delete process.env.AGENTHUB_HOME;
    delete process.env.AGENTHUB_AGY_HOMES;
    delete process.env.AGENTHUB_DEFAULT_LOG_DIR;
    delete process.env.AGENTHUB_AGY_BIN;
    delete process.env.AGENTHUB_PORT;
  });

  it('detectCycle detects simple and multi-hop dependency cycles', () => {
    // 1. Acyclic
    const acyclic = [
      { id: 'p/a', slug: 'a', projectId: 'p', dependsOn: [] },
      { id: 'p/b', slug: 'b', projectId: 'p', dependsOn: ['p/a'] },
      { id: 'p/c', slug: 'c', projectId: 'p', dependsOn: ['b'] },
    ];
    expect(detectCycle(acyclic)).toBeNull();

    // 2. Direct cycle (a <-> b)
    const directCycle = [
      { id: 'p/a', slug: 'a', projectId: 'p', dependsOn: ['b'] },
      { id: 'p/b', slug: 'b', projectId: 'p', dependsOn: ['a'] },
    ];
    const directResult = detectCycle(directCycle);
    expect(directResult).not.toBeNull();
    expect(directResult).toEqual(expect.arrayContaining(['p/a', 'p/b']));

    // 3. Multi-hop cycle (a -> b -> c -> a)
    const multiCycle = [
      { id: 'p/a', slug: 'a', projectId: 'p', dependsOn: ['p/c'] },
      { id: 'p/b', slug: 'b', projectId: 'p', dependsOn: ['a'] },
      { id: 'p/c', slug: 'c', projectId: 'p', dependsOn: ['b'] },
    ];
    const multiResult = detectCycle(multiCycle);
    expect(multiResult).not.toBeNull();
  });

  it('creates batch and resolves dependencies by slug within the same batch', async () => {
    const result = (await client.callTool({
      name: 'hub_create_batch',
      arguments: {
        project: 'test-proj',
        title: 'Refactor Auth Module',
        goal: 'Tách JWT và OAuth thành các service độc lập',
        tasks: [
          {
            slug: 'auth-db',
            title: 'Tạo bảng auth_tokens',
            body: 'Tạo schema db',
            level: 'easy',
          },
          {
            slug: 'auth-jwt',
            title: 'Viết JWT service',
            body: 'Xử lý sign và verify',
            level: 'hard',
            dependsOn: ['auth-db'],
          },
          {
            slug: 'auth-oauth',
            title: 'Tích hợp OAuth',
            body: 'Hỗ trợ Google & GitHub',
            level: 'hard',
            dependsOn: ['auth-jwt'],
          },
        ],
      },
    })) as { content: Array<{ type: string; text: string }> };

    expect(result.content[0].text).toContain('✓ Đã tạo đợt');
    expect(result.content[0].text).toContain('auth-db');
    expect(result.content[0].text).toContain('auth-jwt');
    expect(result.content[0].text).toContain('auth-oauth');

    // Verify tasks in database
    const tDb = ctx.taskRepo.get('test-proj/auth-db')!;
    const tJwt = ctx.taskRepo.get('test-proj/auth-jwt')!;
    const tOauth = ctx.taskRepo.get('test-proj/auth-oauth')!;

    expect(tDb.status).toBe('draft');
    expect(tJwt.status).toBe('draft');
    expect(tOauth.status).toBe('draft');

    expect(tDb.batchId).toBeDefined();
    expect(tJwt.batchId).toBe(tDb.batchId);
    expect(tOauth.batchId).toBe(tDb.batchId);

    // Verify slug was resolved to test-proj/auth-db
    expect(JSON.parse(tJwt.dependsOn)).toEqual(['test-proj/auth-db']);
    expect(JSON.parse(tOauth.dependsOn)).toEqual(['test-proj/auth-jwt']);

    // Check viewing batch via hub_batch tool
    const batchView = (await client.callTool({
      name: 'hub_batch',
      arguments: { id: tDb.batchId! },
    })) as { content: Array<{ type: string; text: string }> };

    expect(batchView.content[0].text).toContain('Refactor Auth Module');
    expect(batchView.content[0].text).toContain('Tách JWT và OAuth');
    expect(batchView.content[0].text).toContain('test-proj/auth-db [draft]');
  });

  it('detects cycles and blocks dispatch, but dispatches successfully when acyclic', async () => {
    // Create batch with cycle
    const batchRes = ctx.service.createBatch({
      project: 'test-proj',
      title: 'Cyclic Plan',
      tasks: [
        { slug: 'cyc-1', title: 'Task 1', dependsOn: ['cyc-2'] },
        { slug: 'cyc-2', title: 'Task 2', dependsOn: ['cyc-1'] },
      ],
    });

    // Attempting to dispatch must fail with 400 cycle_detected
    expect(() => ctx.service.dispatchBatch(batchRes.id)).toThrowError(/vòng phụ thuộc/);

    // Fix cycle: remove dependency on cyc-1
    ctx.service.updateTask('test-proj/cyc-2', { dependsOn: [] });

    // Now dispatching via hub_dispatch_batch should succeed
    const dispatchRes = (await client.callTool({
      name: 'hub_dispatch_batch',
      arguments: { id: batchRes.id },
    })) as { content: Array<{ type: string; text: string }> };

    expect(dispatchRes.content[0].text).toContain('✓ Đã giao đợt');

    // Verify tasks are now queued (or waiting_quota if scheduler ticked without available profiles)
    const t1 = ctx.taskRepo.get('test-proj/cyc-1')!;
    const t2 = ctx.taskRepo.get('test-proj/cyc-2')!;
    expect(['queued', 'waiting_quota']).toContain(t1.status);
    expect(['queued', 'waiting_quota']).toContain(t2.status);

    const updatedBatch = ctx.service.getBatch(batchRes.id);
    expect(updatedBatch.status).toBe('dispatched');
    expect(ctx.eventRepo.getRecent(100).filter((event) => event.type === 'batch.dispatched')).toHaveLength(1);
  });

  it('supports discarding a draft batch', async () => {
    const batch = ctx.service.createBatch({
      project: 'test-proj',
      title: 'Batch to Discard',
      tasks: [
        { slug: 'disc-1', title: 'Task 1' },
        { slug: 'disc-2', title: 'Task 2' },
      ],
    });

    const res = ctx.service.discardBatch(batch.id);
    expect(res.ok).toBe(true);

    const updatedBatch = ctx.service.getBatch(batch.id);
    expect(updatedBatch.status).toBe('discarded');

    const t1 = ctx.taskRepo.get('test-proj/disc-1')!;
    const t2 = ctx.taskRepo.get('test-proj/disc-2')!;
    expect(t1.status).toBe('cancelled');
    expect(t2.status).toBe('cancelled');
    const events = ctx.eventRepo.getRecent(100);
    expect(events.filter((event) => event.type === 'batch.discarded')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'task.cancelled')).toHaveLength(2);
  });

  it('supports adding, removing, and editing tasks in a draft batch', async () => {
    const batch = ctx.service.createBatch({
      project: 'test-proj',
      title: 'Batch Editing Test',
      tasks: [
        { slug: 'edit-1', title: 'Original Task 1' },
        { slug: 'edit-2', title: 'Original Task 2', dependsOn: ['edit-1'] },
      ],
    });

    // 1. Add task to batch
    const added = ctx.service.addTaskToBatch(batch.id, {
      slug: 'edit-3',
      title: 'Added Task 3',
      dependsOn: ['edit-2'],
    });
    expect(added.id).toBe('test-proj/edit-3');
    expect(added.batchId).toBe(batch.id);
    expect(added.status).toBe('draft');

    // 2. Edit task in batch
    const updated = ctx.service.updateTask('test-proj/edit-1', {
      title: 'Renamed Task 1',
      body: 'Updated markdown body',
      level: 'hard',
    });
    expect(updated.title).toBe('Renamed Task 1');
    expect(updated.level).toBe('hard');

    // 3. Remove task from batch and ensure dependsOn cleans up
    ctx.service.removeTaskFromBatch(batch.id, 'test-proj/edit-1');
    expect(ctx.taskRepo.get('test-proj/edit-1')).toBeUndefined();

    // edit-2 should no longer have edit-1 in dependsOn
    const t2 = ctx.taskRepo.get('test-proj/edit-2')!;
    expect(JSON.parse(t2.dependsOn)).toEqual([]);
  });

  it('planning.requireApproval forces Claude hub_create_task into draft batch', async () => {
    // 1. By default planning.requireApproval is false
    expect(ctx.service.config.planning.requireApproval).toBe(false);

    const normalTask = (await client.callTool({
      name: 'hub_create_task',
      arguments: {
        project: 'test-proj',
        slug: 'normal-task',
        title: 'Normal Direct Task',
        body: 'Đề bài markdown',
        start: true,
      },
    })) as { content: Array<{ type: string; text: string }> };

    expect(normalTask.content[0].text).toMatch(/\[(queued|waiting_quota)\]/);
    expect(['queued', 'waiting_quota']).toContain(ctx.taskRepo.get('test-proj/normal-task')!.status);

    // 2. Enable planning.requireApproval
    ctx.service.config.planning.requireApproval = true;

    const approvalTask = (await client.callTool({
      name: 'hub_create_task',
      arguments: {
        project: 'test-proj',
        slug: 'require-approval-task',
        title: 'Needs Approval Task',
        body: 'Đề bài markdown',
        start: true,
      },
    })) as { content: Array<{ type: string; text: string }> };

    expect(approvalTask.content[0].text).toContain('[draft]');
    const t = ctx.taskRepo.get('test-proj/require-approval-task')!;
    expect(t.status).toBe('draft');
    expect(t.batchId).toBeDefined();

    const batch = ctx.service.getBatch(t.batchId!);
    expect(batch.status).toBe('draft');
    expect(batch.title).toContain('Needs Approval Task');
  });

  it('emits batch.created event and produces notification message', () => {
    let capturedMsg = '';
    const notifier = new NotificationService({
      eventBus: ctx.scheduler.getEventBus(),
      config: ctx.service.config,
      exec: (_bin, args) => {
        capturedMsg = args[args.length - 1] || '';
      },
    });
    notifier.start();

    // Create a batch with 6 tasks
    ctx.service.createBatch({
      project: 'test-proj',
      title: 'Lớn',
      tasks: [
        { slug: 't-1', title: '1' },
        { slug: 't-2', title: '2' },
        { slug: 't-3', title: '3' },
        { slug: 't-4', title: '4' },
        { slug: 't-5', title: '5' },
        { slug: 't-6', title: '6' },
      ],
      createdBy: 'claude',
    });

    notifier.stop();

    // Verify exact notification text from Requirement 5: "Claude đề xuất 6 task, chờ bạn duyệt"
    expect(capturedMsg).toBe('Claude đề xuất 6 task, chờ bạn duyệt');
  });

  it('dispatches a batch in one call and reports progress', () => {
    const batch = ctx.service.createBatch({
      project: 'test-proj',
      title: 'Giao ngay',
      goal: 'Mục tiêu giao ngay',
      dispatch: true,
      tasks: [
        { slug: 'dispatch-a', title: 'A' },
        { slug: 'dispatch-b', title: 'B', dependsOn: ['dispatch-a'] },
      ],
    });

    expect(batch.status).toBe('dispatched');
    expect(batch.tasks.every((task) => task.status !== 'draft')).toBe(true);
    expect(batch.progress).toMatchObject({ total: 2, done: 0 });
  });

  it('groups standalone Claude tasks from the same session into an automatic dispatched batch', () => {
    const first = ctx.service.createTask({
      project: 'test-proj', slug: 'auto-a', title: 'Mục tiêu lớn', body: 'A', start: true,
      fromClaude: true, sessionId: 'session-1', goal: 'Mục tiêu lớn',
    });
    const second = ctx.service.createTask({
      project: 'test-proj', slug: 'auto-b', title: 'Bước hai', body: 'B', start: true,
      fromClaude: true, sessionId: 'session-1', goal: 'Mục tiêu lớn',
    });

    expect(first.batchId).toBeDefined();
    expect(second.batchId).toBe(first.batchId);
    expect(ctx.service.getBatch(first.batchId!).status).toBe('dispatched');
  });
});
