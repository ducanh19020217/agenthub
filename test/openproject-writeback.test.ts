import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OpenProjectWritebackService } from '../src/integrations/openproject/writeback.js';
import { saveOpenProjectKey } from '../src/integrations/openproject/secrets.js';

type TestTask = Record<string, unknown> & { id: string; projectId: string; externalRef: string };

function harness(input: { tasks: TestTask[]; autoResolve?: boolean; autoStart?: boolean; triage?: 'off' | 'approve' | 'auto'; pushProjects?: string[]; targetProject?: string; rowWriteback?: string; extraProjects?: string[]; fetchFn?: typeof fetch; git?: (cwd: string, args: string[]) => Promise<{ code: number; output: string }> }) {
  const hubHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-writeback-'));
  saveOpenProjectKey(hubHome, 'op', 'key');
  const tasks = new Map(input.tasks.map((task) => [task.id, task]));
  const row = { source_id: 'op', wp_id: 10, display_id: 'OP-1', status_id: 1, updated_at: '', last_comment_id: null, task_ids: JSON.stringify(input.tasks.map((task) => task.id)), writeback: input.rowWriteback || '{}', created_at: '' } as any;
  let listener: ((type: string, taskId?: string, payload?: unknown) => void) | undefined;
  const events: Array<{ type: string; taskId?: string; payload?: any }> = [];
  const bus = { on: (_event: string, handler: typeof listener) => { listener = handler; }, off: () => undefined, emit: (type: string, taskId?: string, payload?: unknown) => { events.push({ type, taskId, payload }); return true; } };
  const projects = new Map<string, any>();
  for (const projectId of new Set(input.tasks.map((task) => task.projectId).concat(input.targetProject ? [input.targetProject] : []).concat(input.extraProjects || []))) {
    projects.set(projectId, { id: projectId, path: hubHome, settings: JSON.stringify({ openproject: { enabled: true, sourceId: 'op', role: projectId === 'app' ? 'primary' : 'secondary', ...(input.targetProject === projectId ? {} : {}) }, ...(input.pushProjects?.includes(projectId) ? { gitea: { enabled: true, targetBranch: 'main' } } : {}) }) });
  }
  const created: unknown[] = [];
  const service = new OpenProjectWritebackService({
    config: { hubHome, integrations: { openproject: { sources: [{ id: 'op', url: 'https://op.test', project: 'main', triage: input.triage || 'off', autoResolve: input.autoResolve !== false, resolvedStatusId: 5, reviewStatusId: 6, watchStatusIds: [], reopenedStatusIds: [], openStatusIds: [], minTicketNumber: 0, pollIntervalSec: 60, autoStart: input.autoStart !== false, language: 'vi' }] } }, deploy: {} } as never,
    projectRepo: { get: (id: string) => projects.get(id), getAll: () => [...projects.values()] } as never,
    taskRepo: { get: (id: string) => tasks.get(id) } as never,
    trackerRepo: { listAll: () => [row], get: () => row, upsert: (next: any) => { Object.assign(row, next); return row; } } as never,
    taskService: { createTask: (raw: any) => { const createdTask = { id: `${raw.project}/${raw.slug}`, ...raw }; created.push(createdTask); tasks.set(createdTask.id, createdTask); return createdTask; } },
    eventBus: bus,
    fetchFn: input.fetchFn || (async () => new Response(JSON.stringify({ id: 11, lockVersion: 1 }), { status: 200 })) as typeof fetch,
    git: input.git,
    timerMs: 10,
  });
  service.start();
  const emit = async (type: string, taskId?: string, payload?: unknown) => { listener?.(type, taskId, payload); await new Promise((resolve) => setTimeout(resolve, 20)); };
  return { service, row, events, created, hubHome, emit, cleanup: () => { service.stop(); fs.rmSync(hubHome, { recursive: true, force: true }); } };
}

const done = (id: string, projectId: string, comment = `## Comment cho tester\n${id} đã sửa`) => ({ id, projectId, slug: id, title: id, externalRef: 'OP-1', doneReport: comment, blockedReport: null, status: 'done' });

describe('OpenProjectWritebackService', () => {
  it('comments and resolves once after a merged task without push configuration', async () => {
    const h = harness({ tasks: [done('app/fix', 'app')] });
    await h.emit('task.merged', 'app/fix', { mergeCommit: 'abc' });
    await h.emit('task.merged', 'app/fix', { mergeCommit: 'abc' });
    expect(h.events.filter((event) => event.type === 'tracker.resolved')).toHaveLength(1);
    expect(JSON.parse(h.row.writeback).commented).toBe(true);
    h.cleanup();
  });

  it('waits for every task to be merged and pushed', async () => {
    let pushed = false;
    const h = harness({ tasks: [done('app/fe', 'app'), done('app/be', 'app')], pushProjects: ['app'], git: async (_cwd, args) => ({ code: args[0] === 'fetch' || pushed ? 0 : 1, output: '' }) });
    await h.emit('task.merged', 'app/fe', { mergeCommit: 'fe' });
    await h.emit('task.merged', 'app/be', { mergeCommit: 'be' });
    expect(h.events.some((event) => event.type === 'tracker.resolved')).toBe(false);
    pushed = true;
    await h.emit('gitea.sync.succeeded', undefined, { projectId: 'app', merged: true });
    expect(h.events.filter((event) => event.type === 'tracker.resolved')).toHaveLength(1);
    h.cleanup();
  });

  it('does not resolve before push and only comments when autoResolve is disabled', async () => {
    let pushed = false;
    const h = harness({ tasks: [done('app/fix', 'app')], autoResolve: false, pushProjects: ['app'], git: async (_cwd, args) => ({ code: args[0] === 'fetch' || pushed ? 0 : 1, output: '' }) });
    await h.emit('task.merged', 'app/fix', { mergeCommit: 'abc' });
    expect(h.events.some((event) => event.type === 'tracker.resolved')).toBe(false);
    pushed = true;
    await h.emit('deploy.succeeded', undefined, { projectId: 'app' });
    expect(h.events.some((event) => event.type === 'tracker.resolved')).toBe(false);
    expect(JSON.parse(h.row.writeback).commented).toBe(true);
    h.cleanup();
  });

  it('requests review once per blocked task and permits later resolution', async () => {
    const task = { ...done('app/fix', 'app'), blockedReport: '## Cần quyết định\nChọn phương án 1.' };
    const h = harness({ tasks: [task] });
    await h.emit('task.blocked', task.id);
    await h.emit('task.blocked', task.id);
    expect(h.events.filter((event) => event.type === 'tracker.review_requested')).toHaveLength(1);
    await h.emit('task.merged', task.id, { mergeCommit: 'abc' });
    expect(h.events.some((event) => event.type === 'tracker.resolved')).toBe(true);
    h.cleanup();
  });

  it('retries a temporary OpenProject failure', async () => {
    let calls = 0;
    const fetchFn = (async () => { calls++; return new Response('{}', { status: calls === 1 ? 503 : 200 }); }) as typeof fetch;
    const h = harness({ tasks: [done('app/fix', 'app')], fetchFn });
    await h.emit('task.merged', 'app/fix', { mergeCommit: 'abc' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toBeGreaterThanOrEqual(2);
    h.cleanup();
  });

  it('creates only a hub linked task and reports an invalid target project', async () => {
    const task = { ...done('app/fix', 'app'), doneReport: '## Cần sửa ở project web\nNội dung cần sửa.' };
    const h = harness({ tasks: [task], targetProject: 'web' });
    await h.emit('task.done', task.id);
    expect(h.created).toHaveLength(1);
    expect((h.created[0] as any).externalRef).toBe('OP-1');
    expect((h.created[0] as any).dependsOn).toEqual([task.id]);
    h.cleanup();
    const invalid = harness({ tasks: [task] });
    await invalid.emit('task.done', task.id);
    expect(invalid.created).toHaveLength(0);
    const failure = invalid.events.find((event) => event.type === 'tracker.writeback_failed');
    expect(failure?.taskId).toBeUndefined();
    expect(failure?.payload.error).toContain('không hợp lệ');
    invalid.cleanup();
  });

  it('creates the repair task once with the complete analysis, note, and autoStart policy', async () => {
    const analysis = {
      conclusion: 'lỗi', size: 'vừa', repo: ['app'], summary: 'Tóm tắt', evidence: 'Bằng chứng',
      cause: 'Nguyên nhân', proposal: 'Đề xuất', risks: 'Rủi ro', questions: 'Không có',
    };
    const triage = { id: 'app/op-op-1-triage', projectId: 'app', slug: 'op-op-1-triage', title: 'Triage', externalRef: 'OP-1', status: 'done' } as TestTask;
    const h = harness({ tasks: [triage], autoStart: false, rowWriteback: JSON.stringify({ triage: { taskId: triage.id, analysis, readyAt: 'now' } }) });
    const first = await h.service.decide(h.row, 'do', 'Ưu tiên sửa trên bản phát hành này');
    const second = await h.service.decide(h.row, 'do', 'không được dùng lại');
    expect(first.taskIds).toEqual(['app/op-op-1-triage', 'app/op-op-1']);
    expect(second.taskIds).toEqual(first.taskIds);
    expect(h.created).toHaveLength(1);
    expect(h.created[0]).toMatchObject({ start: false, slug: 'op-op-1' });
    expect(String((h.created[0] as any).body)).toContain('Ưu tiên sửa trên bản phát hành này');
    expect(String((h.created[0] as any).body)).toContain('## Phân tích triage');
    h.cleanup();
  });

  it('asks tester, records the decision, and creates a triage revision from user input', async () => {
    const analysis = { conclusion: 'thiếu thông tin', size: 'nhỏ', repo: ['app'], summary: 'Tóm tắt', evidence: 'Bằng chứng', cause: 'Chưa rõ', proposal: 'Hỏi thêm', risks: 'Rủi ro', questions: 'Gửi log' };
    const triage = { id: 'app/op-op-1-triage', projectId: 'app', slug: 'op-op-1-triage', title: 'Triage', externalRef: 'OP-1', status: 'done' } as TestTask;
    const calls: string[] = [];
    const fetchFn = (async (url: string | URL, init?: RequestInit) => { calls.push(`${init?.method || 'GET'} ${url}`); return new Response(JSON.stringify({ id: 11, lockVersion: 1 }), { status: 200 }); }) as typeof fetch;
    const h = harness({ tasks: [triage], rowWriteback: JSON.stringify({ triage: { taskId: triage.id, analysis, readyAt: 'now' } }), fetchFn });
    await h.service.decide(h.row, 'ask', 'Tester kiểm tra thêm');
    expect(calls.some((call) => call.includes('PATCH') || call.includes('POST'))).toBe(true);
    expect(JSON.parse(h.row.writeback).decision).toMatchObject({ action: 'ask', note: 'Tester kiểm tra thêm' });
    const input = await h.service.submitTriageInput(h.row, 'log từ server khách hàng');
    expect(input.taskId).toBe('app/op-op-1-triage-r1');
    expect(fs.readFileSync(path.join(h.hubHome, 'tracker', 'op', '10', 'user-input-1.md'), 'utf8')).toBe('log từ server khách hàng');
    expect(h.created).toHaveLength(1);
    h.cleanup();
  });

  it('skips without creating a task and comments only when a reason is supplied', async () => {
    const analysis = { conclusion: 'không phải lỗi', size: 'nhỏ', repo: ['app'], summary: 'Không lỗi', evidence: 'Đã kiểm tra', cause: 'Hành vi đúng', proposal: 'Không sửa', risks: 'Không có', questions: 'Không có' };
    const triage = { id: 'app/op-op-1-triage', projectId: 'app', slug: 'op-op-1-triage', title: 'Triage', externalRef: 'OP-1', status: 'done' } as TestTask;
    const bodies: string[] = [];
    const fetchFn = (async (_url: string | URL, init?: RequestInit) => { if (init?.body) bodies.push(String(init.body)); return new Response(JSON.stringify({ id: 11, lockVersion: 1 }), { status: 200 }); }) as typeof fetch;
    const h = harness({ tasks: [triage], rowWriteback: JSON.stringify({ triage: { taskId: triage.id, analysis, readyAt: 'now' } }), fetchFn });
    const result = await h.service.decide(h.row, 'skip', 'Đã xác nhận là hành vi đúng');
    expect(result.action).toBe('skip');
    expect(h.created).toHaveLength(0);
    expect(bodies.some((body) => body.includes('**[AgentHub] Không xử lý**: Đã xác nhận là hành vi đúng'))).toBe(true);
    h.cleanup();
  });

  it('marks a manual ticket without creating a repair task', async () => {
    const analysis = { conclusion: 'việc thủ công', size: 'vừa', repo: ['app'], summary: 'Cần thao tác server', evidence: 'Cần kiểm tra máy khách', cause: 'Ngoài phạm vi repo', proposal: 'Người dùng xử lý', risks: 'Có thể gián đoạn dịch vụ', questions: 'Không có' };
    const triage = { id: 'app/op-op-1-triage', projectId: 'app', slug: 'op-op-1-triage', title: 'Triage', externalRef: 'OP-1', status: 'done' } as TestTask;
    const h = harness({ tasks: [triage], rowWriteback: JSON.stringify({ triage: { taskId: triage.id, analysis, readyAt: 'now' } }) });
    const result = await h.service.decide(h.row, 'manual');
    expect(result.action).toBe('manual');
    expect(h.created).toHaveLength(0);
    expect(JSON.parse(h.row.writeback).decision.action).toBe('manual');
    h.cleanup();
  });

  it('auto-dispatches a small bug and leaves a non-bug waiting for a decision', async () => {
    const triage = { id: 'app/op-op-1-triage', projectId: 'app', slug: 'op-op-1-triage', title: 'Triage', externalRef: 'OP-1', status: 'done', doneReport: `Kết luận: lỗi\nĐộ lớn: nhỏ\nRepo: app\n\n### Tóm tắt yêu cầu\nBug\n\n### Bằng chứng\nTest\n\n### Nguyên nhân dự kiến\nCause\n\n### Hướng sửa đề xuất (và phương án nếu có nhiều)\nFix\n\n### Rủi ro / ảnh hưởng\nRisk\n\n### Câu hỏi cho tester (nếu thiếu thông tin)\nNone` } as TestTask;
    const h = harness({ tasks: [triage], triage: 'auto' });
    await h.emit('task.done', triage.id);
    expect(h.created).toHaveLength(1);
    expect(h.created[0]).toMatchObject({ slug: 'op-op-1', start: true });
    h.cleanup();

    const waiting = { ...triage, id: 'app/op-op-2-triage', slug: 'op-op-2-triage', doneReport: triage.doneReport!.replace('Kết luận: lỗi', 'Kết luận: không phải lỗi') };
    const w = harness({ tasks: [waiting], triage: 'auto' });
    await w.emit('task.done', waiting.id);
    expect(w.created).toHaveLength(0);
    expect(w.events.some((event) => event.type === 'tracker.triage_ready' && (event.payload as any)?.autoDispatch === false)).toBe(true);
    w.cleanup();
  });

  it('creates multi-repo repair tasks with an API provider dependency and ignores triage in resolve checks', async () => {
    const analysis = { conclusion: 'lỗi', size: 'lớn', repo: ['app', 'web'], summary: 'Tóm tắt', evidence: 'Bằng chứng', cause: 'Nguyên nhân', proposal: 'Đề xuất', risks: 'Rủi ro', questions: 'Không có', perRepo: 'app cung cấp API contract; web dùng contract đó' };
    const triage = { id: 'app/op-op-1-triage', projectId: 'app', slug: 'op-op-1-triage', title: 'Triage', externalRef: 'OP-1', status: 'done' } as TestTask;
    const h = harness({ tasks: [triage], extraProjects: ['web'], rowWriteback: JSON.stringify({ triage: { taskId: triage.id, analysis, readyAt: 'now' } }) });
    const result = await h.service.decide(h.row, 'do');
    expect(result.taskIds).toEqual(['app/op-op-1-triage', 'app/op-op-1-app', 'web/op-op-1-web']);
    expect(h.created).toHaveLength(2);
    expect((h.created[1] as any).dependsOn).toEqual(['app/op-op-1-app']);
    await h.emit('task.merged', 'app/op-op-1-app', { mergeCommit: 'a' });
    await h.emit('task.merged', 'web/op-op-1-web', { mergeCommit: 'b' });
    expect(h.events.some((event) => event.type === 'tracker.resolved')).toBe(true);
    h.cleanup();
  });
});
