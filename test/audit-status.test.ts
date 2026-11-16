import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/daemon.js';
import { createServer } from '../src/api/server.js';
import { getOrCreateToken } from '../src/auth.js';
import { FakeEngine } from '../src/engines/index.js';
import { computeTaskAudit, getDerivedAuditStatus } from '../src/services/audit-status.js';
import type { TaskRow, ProjectRow, EventRow, ReviewRow } from '../src/db/index.js';

let tmpDir: string;
let config: ReturnType<typeof loadConfig>;
let ctx: ReturnType<typeof createContext>;
let server: ReturnType<typeof createServer>;
let token: string;
let fakeEngine: FakeEngine;

function authHeaders() {
  return {
    host: '127.0.0.1:7791',
    authorization: `Bearer ${token}`,
  };
}

describe('Audit Status Service & API (DEC-035)', () => {
  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-audit-test-'));
    const agyHomesDir = path.join(tmpDir, 'agy-homes');
    fs.mkdirSync(agyHomesDir, { recursive: true });

    process.env.AGENTHUB_HOME = tmpDir;
    process.env.AGENTHUB_AGY_HOMES = agyHomesDir;

    config = loadConfig(tmpDir);
    config.agyHomesDir = agyHomesDir;
    config.port = 7791;
    token = getOrCreateToken(config.tokenPath);

    fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    const engines = new Map([['agy', fakeEngine]]);

    ctx = createContext(config, engines as any);
    ctx.scheduler.stop();
    server = await createServer(ctx.service, config);
    await server.ready();
  });

  afterEach(async () => {
    if (server) await server.close();
    if (ctx?.db) ctx.db.close();
    try {
      if (tmpDir && fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
    delete process.env.AGENTHUB_HOME;
    delete process.env.AGENTHUB_AGY_HOMES;
  });

  describe('computeTaskAudit & getDerivedAuditStatus unit tests', () => {
    const baseProject: ProjectRow = {
      id: 'p1',
      name: 'Project 1',
      path: '/path/p1',
      defaultBranch: 'main',
      maxParallel: 2,
      createdAt: '2026-11-01T00:00:00Z',
      updatedAt: '2026-11-01T00:00:00Z',
    };

    const makeTask = (status = 'done', pushResult?: Record<string, unknown>): TaskRow => ({
      id: 'p1/t1',
      projectId: 'p1',
      slug: 't1',
      title: 'Task 1',
      level: 'easy',
      status: status as any,
      dependsOn: '[]',
      attempt: 1,
      resume: 0,
      createdAt: '2026-11-01T00:00:00Z',
      updatedAt: '2026-11-01T00:00:00Z',
      pushResult: pushResult ? JSON.stringify(pushResult) : null,
    });

    it('1. Đang audit: pushResult state = auditing', () => {
      const task = makeTask('done', {
        state: 'auditing',
        startedAt: '2026-11-16T10:00:00.000Z',
      });
      const audit = computeTaskAudit(task, [], baseProject);
      expect(audit).not.toBeNull();
      expect(audit?.state).toBe('auditing');
      expect(audit?.startedAt).toBe('2026-11-16T10:00:00.000Z');
      expect(getDerivedAuditStatus(task, [], baseProject)).toBe('auditing');
    });

    it('2. Đang audit: event task.audit_started', () => {
      const task = makeTask('done');
      const events: EventRow[] = [
        {
          id: 1,
          taskId: 'p1/t1',
          type: 'task.audit_started',
          payload: JSON.stringify({ taskId: 'p1/t1', projectId: 'p1' }),
          ts: '2026-11-16T10:00:00.000Z',
        },
      ];
      const audit = computeTaskAudit(task, events, baseProject);
      expect(audit?.state).toBe('auditing');
      expect(getDerivedAuditStatus(task, events, baseProject)).toBe('auditing');
    });

    it('3. Đạt: audit_passed event & pushResult', () => {
      const task = makeTask('done', {
        auditPassed: true,
        summary: 'Tất cả 3 file đã kiểm tra, không phát hiện lỗi logic.',
        findings: [],
        model: 'gpt-5.6-luna',
        engine: 'codex',
        finishedAt: '2026-11-16T10:05:00.000Z',
      });
      const events: EventRow[] = [
        {
          id: 1,
          taskId: 'p1/t1',
          type: 'task.audit_started',
          payload: JSON.stringify({}),
          ts: '2026-11-16T10:00:00.000Z',
        },
        {
          id: 2,
          taskId: 'p1/t1',
          type: 'task.audit_passed',
          payload: JSON.stringify({
            summary: 'Tất cả 3 file đã kiểm tra, không phát hiện lỗi logic.',
            findings: [],
            model: 'gpt-5.6-luna',
            engine: 'codex',
          }),
          ts: '2026-11-16T10:05:00.000Z',
        },
      ];
      const audit = computeTaskAudit(task, events, baseProject);
      expect(audit?.state).toBe('audit_passed');
      expect(audit?.summary).toContain('không phát hiện lỗi logic');
      expect(audit?.model).toBe('gpt-5.6-luna');
      expect(audit?.engine).toBe('codex');
      expect(getDerivedAuditStatus(task, events, baseProject)).toBe('audit_passed');
    });

    it('4. Không đạt còn vòng: trả worker sửa (substate: returned_to_worker)', () => {
      const task = makeTask('queued', {
        auditFailed: true,
        auditFixRounds: 1,
        maxFixRounds: 2,
        summary: 'Phát hiện lỗi null pointer ở hàm parseUser',
        findings: [
          { severity: 'P1', kind: 'logic_error', file: 'src/user.ts', line: 42, detail: 'parseUser throws when input is empty' },
        ],
        failedAt: '2026-11-16T10:02:00.000Z',
      });
      const events: EventRow[] = [
        {
          id: 1,
          taskId: 'p1/t1',
          type: 'task.audit_failed',
          payload: JSON.stringify({
            exceededMaxRounds: false,
            auditFixRounds: 1,
            summary: 'Phát hiện lỗi null pointer ở hàm parseUser',
            findings: [{ severity: 'P1', kind: 'logic_error', file: 'src/user.ts', line: 42, detail: 'parseUser throws when input is empty' }],
          }),
          ts: '2026-11-16T10:02:00.000Z',
        },
      ];
      const audit = computeTaskAudit(task, events, baseProject);
      expect(audit?.state).toBe('audit_failed');
      expect(audit?.substate).toBe('returned_to_worker');
      expect(audit?.rounds).toBe(1);
      expect(audit?.maxRounds).toBe(2);
      expect(audit?.findings).toHaveLength(1);
      expect(audit?.findings[0].severity).toBe('P1');
      expect(getDerivedAuditStatus(task, events, baseProject)).toBe('audit_failed');
    });

    it('5. Quá vòng: bị chặn (substate: blocked do exceededMaxRounds)', () => {
      const task = makeTask('done', {
        auditFailed: true,
        exceededMaxRounds: true,
        auditFixRounds: 2,
        maxFixRounds: 2,
        summary: 'Vẫn còn lỗi logic sau 2 vòng sửa',
        findings: [
          { severity: 'P1', kind: 'regression', file: 'src/calc.ts', line: 10, detail: 'Wrong return calculation' },
        ],
        failedAt: '2026-11-16T10:10:00.000Z',
      });
      const events: EventRow[] = [
        {
          id: 1,
          taskId: 'p1/t1',
          type: 'task.audit_failed',
          payload: JSON.stringify({
            exceededMaxRounds: true,
            maxFixRounds: 2,
            auditFixRounds: 2,
            summary: 'Vẫn còn lỗi logic sau 2 vòng sửa',
            findings: [{ severity: 'P1', kind: 'regression', file: 'src/calc.ts', line: 10, detail: 'Wrong return calculation' }],
          }),
          ts: '2026-11-16T10:10:00.000Z',
        },
      ];
      const audit = computeTaskAudit(task, events, baseProject);
      expect(audit?.state).toBe('audit_failed');
      expect(audit?.substate).toBe('blocked');
      expect(audit?.rounds).toBe(2);
      expect(audit?.maxRounds).toBe(2);
      expect(getDerivedAuditStatus(task, events, baseProject)).toBe('audit_failed');
    });

    it('6. Bị task khác chặn (substate: blocked do blockedByTaskId)', () => {
      const task = makeTask('done', {
        blockedByTask: 't-other',
        blockedByTaskId: 'p1/t-other',
        error: 'Chặn publish do task t-other vượt quá số vòng sửa audit (2)',
        failedAt: '2026-11-16T10:10:00.000Z',
      });
      const audit = computeTaskAudit(task, [], baseProject);
      expect(audit?.state).toBe('audit_failed');
      expect(audit?.substate).toBe('blocked');
      expect(audit?.blockedByTaskId).toBe('p1/t-other');
      expect(getDerivedAuditStatus(task, [], baseProject)).toBe('audit_failed');
    });

    it('7. Bỏ qua audit: audit_skipped', () => {
      const task = makeTask('done', {
        auditSkipped: true,
      });
      const events: EventRow[] = [
        {
          id: 1,
          taskId: 'p1/t1',
          type: 'task.audit_skipped',
          payload: JSON.stringify({ manual: true }),
          ts: '2026-11-16T10:00:00.000Z',
        },
      ];
      const audit = computeTaskAudit(task, events, baseProject);
      expect(audit?.state).toBe('audit_skipped');
      expect(getDerivedAuditStatus(task, events, baseProject)).toBe('audit_skipped');
    });

    it('7b. Bỏ qua audit vẫn giữ trạng thái sau khi push thành công', () => {
      const task = {
        ...makeTask('done', { auditSkipped: true }),
        pushedAt: '2026-11-16T10:01:00.000Z',
      };
      const events: EventRow[] = [
        {
          id: 1,
          taskId: 'p1/t1',
          type: 'task.audit_skipped',
          payload: JSON.stringify({ manual: true }),
          ts: '2026-11-16T10:00:00.000Z',
        },
        {
          id: 2,
          taskId: 'p1/t1',
          type: 'task.pushed',
          payload: JSON.stringify({}),
          ts: '2026-11-16T10:01:00.000Z',
        },
      ];

      expect(computeTaskAudit(task, events, baseProject)?.state).toBe('audit_skipped');
      expect(getDerivedAuditStatus(task, events, baseProject)).toBe('audit_skipped');
    });

    it('8. Project tắt audit (publish.audit.enabled = false): returns null, không đếm', () => {
      const projectDisabled: ProjectRow = {
        ...baseProject,
        settings: JSON.stringify({ publish: { audit: { enabled: false } } }),
      };
      const task = makeTask('done', {
        state: 'auditing',
      });
      const audit = computeTaskAudit(task, [], projectDisabled);
      expect(audit).toBeNull();
      expect(getDerivedAuditStatus(task, [], projectDisabled)).toBeNull();
    });

    it('9. Tái dựng lịch sử multi-round từ events & reviews', () => {
      const task = makeTask('done', {
        auditPassed: true,
        summary: 'Audit vòng 2 đạt',
      });
      const events: EventRow[] = [
        {
          id: 1,
          taskId: 'p1/t1',
          type: 'task.audit_started',
          payload: JSON.stringify({}),
          ts: '2026-11-16T09:00:00.000Z',
        },
        {
          id: 2,
          taskId: 'p1/t1',
          type: 'task.audit_failed',
          payload: JSON.stringify({
            round: 1,
            auditFixRounds: 1,
            exceededMaxRounds: false,
            summary: 'Lỗi vòng 1',
            findings: [{ severity: 'P2', kind: 'edge_case', file: 'a.ts', line: 1, detail: 'missing check' }],
            engine: 'codex',
            model: 'gpt-5.6-luna',
          }),
          ts: '2026-11-16T09:05:00.000Z',
        },
        {
          id: 3,
          taskId: 'p1/t1',
          type: 'task.audit_started',
          payload: JSON.stringify({}),
          ts: '2026-11-16T10:00:00.000Z',
        },
        {
          id: 4,
          taskId: 'p1/t1',
          type: 'task.audit_passed',
          payload: JSON.stringify({
            summary: 'Đã sửa xong lỗi logic, pass vòng 2',
            findings: [],
            engine: 'codex',
            model: 'gpt-5.6-luna',
          }),
          ts: '2026-11-16T10:04:00.000Z',
        },
      ];
      const reviews: ReviewRow[] = [
        {
          id: 'rev-1',
          taskId: 'p1/t1',
          verdict: 'changes_requested',
          feedback: 'Audit feedback round 1',
          createdAt: '2026-11-16T09:05:00.000Z',
          actor: 'audit-prepublish',
          engine: 'codex',
          profileName: 'prof-codex',
        },
      ];

      const audit = computeTaskAudit(task, events, baseProject, reviews);
      expect(audit?.state).toBe('audit_passed');
      expect(audit?.history).toHaveLength(2);
      expect(audit?.history?.[0].round).toBe(1);
      expect(audit?.history?.[0].state).toBe('audit_failed');
      expect(audit?.history?.[0].substate).toBe('returned_to_worker');
      expect(audit?.history?.[1].round).toBe(2);
      expect(audit?.history?.[1].state).toBe('audit_passed');
    });
  });

  describe('API endpoints: GET /api/tasks, GET /api/status, and GET /api/tasks/:id', () => {
    it('returns audit object in GET /api/tasks/:id with findings and history', async () => {
      ctx.projectRepo.insert({
        id: 'proj-audit',
        name: 'Project Audit',
        path: path.join(tmpDir, 'repo'),
        defaultBranch: 'main',
        maxParallel: 1,
      });

      const taskId = 'task-audit-1';
      ctx.taskRepo.insert({
        id: taskId,
        projectId: 'proj-audit',
        slug: 't-audit-1',
        title: 'Task with audit findings',
        status: 'done',
      });

      ctx.taskRepo.update(taskId, {
        pushResult: JSON.stringify({
          auditFailed: true,
          auditFixRounds: 1,
          maxFixRounds: 2,
          summary: 'Phát hiện lỗ hổng logic validation',
          findings: [
            { severity: 'P1', kind: 'security', file: 'src/auth.ts', line: 55, detail: 'Missing check on token validity' },
            { severity: 'P2', kind: 'edge_case', file: 'src/auth.ts', line: 70, detail: 'Unhandled undefined user' },
          ],
          failedAt: '2026-11-16T11:00:00.000Z',
          startedAt: '2026-11-16T10:55:00.000Z',
          model: 'gpt-5.6-luna',
          engine: 'codex',
        }),
      });

      ctx.eventRepo.insert('task.audit_started', taskId, {
        taskId,
        projectId: 'proj-audit',
        startedAt: '2026-11-16T10:55:00.000Z',
      });
      ctx.eventRepo.insert('task.audit_failed', taskId, {
        taskId,
        projectId: 'proj-audit',
        exceededMaxRounds: false,
        auditFixRounds: 1,
        summary: 'Phát hiện lỗ hổng logic validation',
        findings: [
          { severity: 'P1', kind: 'security', file: 'src/auth.ts', line: 55, detail: 'Missing check on token validity' },
          { severity: 'P2', kind: 'edge_case', file: 'src/auth.ts', line: 70, detail: 'Unhandled undefined user' },
        ],
        model: 'gpt-5.6-luna',
        engine: 'codex',
      });

      // GET /api/tasks/:id
      const res = await server.inject({
        method: 'GET',
        url: `/api/tasks/${taskId}`,
        headers: authHeaders(),
      });
      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.audit).toBeDefined();
      expect(data.audit.state).toBe('audit_failed');
      expect(data.audit.substate).toBe('returned_to_worker');
      expect(data.audit.rounds).toBe(1);
      expect(data.audit.maxRounds).toBe(2);
      expect(data.audit.summary).toBe('Phát hiện lỗ hổng logic validation');
      expect(data.audit.findings).toHaveLength(2);
      expect(data.audit.findings[0]).toEqual({
        severity: 'P1',
        kind: 'security',
        file: 'src/auth.ts',
        line: 55,
        detail: 'Missing check on token validity',
      });
      expect(data.audit.model).toBe('gpt-5.6-luna');
      expect(data.audit.engine).toBe('codex');
      expect(data.audit.history).toHaveLength(1);

      // GET /api/tasks/:id/timeline
      const resTimeline = await server.inject({
        method: 'GET',
        url: `/api/tasks/${taskId}/timeline`,
        headers: authHeaders(),
      });
      expect(resTimeline.statusCode).toBe(200);
      const timeline = resTimeline.json();
      expect(timeline.some((item: { status: string }) => item.status === 'auditing')).toBe(true);
      const failedStep = timeline.find((item: { status: string }) => item.status === 'audit_failed');
      expect(failedStep).toBeDefined();
      expect(failedStep.round).toBe(1);
    });

    it('deduplicates duplicate audit start events from API and publish worker', async () => {
      const taskId = 'task-audit-duplicate-start';
      ctx.projectRepo.insert({
        id: 'proj-audit-duplicate',
        name: 'Project Audit Duplicate',
        path: path.join(tmpDir, 'repo-duplicate'),
        defaultBranch: 'main',
        maxParallel: 1,
      });
      ctx.taskRepo.insert({
        id: taskId,
        projectId: 'proj-audit-duplicate',
        slug: 'duplicate-start',
        title: 'Duplicate audit start',
        status: 'done',
      });

      ctx.eventRepo.insert('task.auditing', taskId, {});
      ctx.eventRepo.insert('task.publishing', taskId, {});
      ctx.eventRepo.insert('task.audit_started', taskId, {});
      ctx.eventRepo.insert('task.audit_passed', taskId, {});

      const res = await server.inject({
        method: 'GET',
        url: `/api/tasks/${taskId}/timeline`,
        headers: authHeaders(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().filter((item: { status: string }) => item.status === 'auditing')).toHaveLength(1);
    });

    it('filters tasks via GET /api/tasks?derived=auditing and GET /api/tasks?derived=audit_failed and counts in GET /api/status', async () => {
      ctx.projectRepo.insert({
        id: 'proj-filter',
        name: 'Project Filter',
        path: path.join(tmpDir, 'repo2'),
        defaultBranch: 'main',
        maxParallel: 2,
      });

      // Task 1: auditing
      ctx.taskRepo.insert({
        id: 't-auditing',
        projectId: 'proj-filter',
        slug: 't-auditing',
        title: 'Task Auditing',
        status: 'done',
      });
      ctx.taskRepo.update('t-auditing', {
        pushResult: JSON.stringify({ state: 'auditing', startedAt: '2026-11-16T12:00:00Z' }),
      });

      // Task 2: audit_failed
      ctx.taskRepo.insert({
        id: 't-audit-failed',
        projectId: 'proj-filter',
        slug: 't-audit-failed',
        title: 'Task Audit Failed',
        status: 'done',
      });
      ctx.taskRepo.update('t-audit-failed', {
        pushResult: JSON.stringify({ auditFailed: true, exceededMaxRounds: true, summary: 'Max rounds exceeded' }),
      });

      // Task 3: done normal
      ctx.taskRepo.insert({
        id: 't-normal-done',
        projectId: 'proj-filter',
        slug: 't-normal-done',
        title: 'Task Normal Done',
        status: 'done',
      });

      // 1. GET /api/tasks?derived=auditing
      const resAuditing = await server.inject({
        method: 'GET',
        url: '/api/tasks?derived=auditing',
        headers: authHeaders(),
      });
      expect(resAuditing.statusCode).toBe(200);
      const auditingList = resAuditing.json();
      expect(auditingList).toHaveLength(1);
      expect(auditingList[0].id).toBe('t-auditing');

      // 2. GET /api/tasks?derived=audit_failed
      const resFailed = await server.inject({
        method: 'GET',
        url: '/api/tasks?derived=audit_failed',
        headers: authHeaders(),
      });
      expect(resFailed.statusCode).toBe(200);
      const failedList = resFailed.json();
      expect(failedList).toHaveLength(1);
      expect(failedList[0].id).toBe('t-audit-failed');

      // 3. Paginated query: GET /api/tasks?limit=10&derived=audit_failed
      const resPage = await server.inject({
        method: 'GET',
        url: '/api/tasks?limit=10&derived=audit_failed',
        headers: authHeaders(),
      });
      expect(resPage.statusCode).toBe(200);
      const page = resPage.json();
      expect(page.total).toBe(1);
      expect(page.items).toHaveLength(1);
      expect(page.items[0].id).toBe('t-audit-failed');

      // 4. GET /api/status has auditing and audit_failed counts
      const resStatus = await server.inject({
        method: 'GET',
        url: '/api/status',
        headers: authHeaders(),
      });
      expect(resStatus.statusCode).toBe(200);
      const statusData = resStatus.json();
      expect(statusData.tasks.auditing).toBe(1);
      expect(statusData.tasks.audit_failed).toBe(1);
    });
  });
});
