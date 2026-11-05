import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSplitPlan } from '../src/integrations/openproject/split.js';
import { OpenProjectWritebackService } from '../src/integrations/openproject/writeback.js';
import { OpenProjectIntakeService } from '../src/integrations/openproject/intake.js';
import { buildReviewerPrompt } from '../src/reviewer.js';
import { saveOpenProjectKey } from '../src/integrations/openproject/secrets.js';

describe('OpenProject splitPlan parser', () => {
  it('parses plan with all fields populated', () => {
    const report = `## Tóm tắt
Đã lập kế hoạch chia việc.

## Chia việc
### 1. Phần backend
- project: backend
- level: hard
- phụ thuộc: không
Viết API endpoint cho tính năng mới.

### 2. Phần frontend
- project: web
- level: easy
- phụ thuộc: 1
Giao diện gọi API backend.
`;
    const res = parseSplitPlan(report, 5, 'primary');
    expect(res.errors).toEqual([]);
    expect(res.plan).toBeDefined();
    expect(res.plan?.parts).toHaveLength(2);
    expect(res.plan?.parts[0]).toEqual({
      index: 1,
      title: 'Phần backend',
      project: 'backend',
      level: 'hard',
      dependsOn: [],
      description: 'Viết API endpoint cho tính năng mới.',
    });
    expect(res.plan?.parts[1]).toEqual({
      index: 2,
      title: 'Phần frontend',
      project: 'web',
      level: 'easy',
      dependsOn: [1],
      description: 'Giao diện gọi API backend.',
    });
  });

  it('uses default values when optional fields are omitted', () => {
    const report = `## Chia việc
### 1. Phần thứ nhất
Mô tả công việc phần một.

### 2. Phần thứ hai
Mô tả công việc phần hai.
`;
    const res = parseSplitPlan(report, 5, 'my-default-project');
    expect(res.errors).toEqual([]);
    expect(res.plan?.parts[0].project).toBe('my-default-project');
    expect(res.plan?.parts[0].level).toBe('easy');
    expect(res.plan?.parts[0].dependsOn).toEqual([]);
  });

  it('reports errors for malformed plans without throwing', () => {
    const report = `## Chia việc
### 1.
- project: web
- phụ thuộc: 99
`;
    const res = parseSplitPlan(report, 5, 'primary');
    expect(res.plan).toBeUndefined();
    expect(res.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('thiếu tiêu đề'),
      expect.stringContaining('thiếu mô tả'),
      expect.stringContaining('phụ thuộc vào số không tồn tại'),
    ]));
  });

  it('rejects plan with non-sequential numbering', () => {
    const report = `## Chia việc
### 1. Phần một
Mô tả một.

### 3. Phần ba
Mô tả ba.
`;
    const res = parseSplitPlan(report, 5, 'primary');
    expect(res.plan).toBeUndefined();
    expect(res.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('Số thứ tự việc con phải liên tục'),
    ]));
  });

  it('rejects plan exceeding maxParts (e.g. 7 parts when max is 5)', () => {
    const report = `## Chia việc
### 1. Việc 1
Mô tả 1.
### 2. Việc 2
Mô tả 2.
### 3. Việc 3
Mô tả 3.
### 4. Việc 4
Mô tả 4.
### 5. Việc 5
Mô tả 5.
### 6. Việc 6
Mô tả 6.
### 7. Việc 7
Mô tả 7.
`;
    const res = parseSplitPlan(report, 5, 'primary');
    expect(res.plan).toBeUndefined();
    expect(res.errors).toEqual(['Kế hoạch có 7 phần; hãy gộp lại tối đa 5 phần']);
  });

  it('parses 1-part plan successfully so caller can run as normal task', () => {
    const report = `## Chia việc
### 1. Việc duy nhất vừa sức một task
Mô tả đầy đủ công việc.
`;
    const res = parseSplitPlan(report, 5, 'primary');
    expect(res.errors).toEqual([]);
    expect(res.plan?.parts).toHaveLength(1);
    expect(res.plan?.parts[0].title).toBe('Việc duy nhất vừa sức một task');
  });

  it('reports error when report is empty or missing ## Chia việc', () => {
    expect(parseSplitPlan(null).errors).toEqual(['Thiếu báo cáo để đọc ## Chia việc']);
    expect(parseSplitPlan('## DONE\nKhông có chia việc').errors).toEqual(['Thiếu mục ## Chia việc']);
  });

  it('rejects invalid explicitly supplied fields instead of silently defaulting', () => {
    const res = parseSplitPlan(`## Chia việc
### 1. Phần một
- project: ???
- level: medium
- phụ thuộc: 2, nope
Mô tả phần một.

### 2. Phần hai
Mô tả phần hai.`, 5, 'primary');
    expect(res.plan).toBeUndefined();
    expect(res.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('project không hợp lệ'),
      expect.stringContaining('level không hợp lệ'),
      expect.stringContaining('phụ thuộc không hợp lệ'),
    ]));
  });
});

describe('OpenProject intake with split configuration', () => {
  it('creates -plan task for tickets with matching typeId when triage is off', async () => {
    const hubHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-intake-split-'));
    try {
      const tasks = new Map<string, any>();
      const taskRepo = {
        get: (id: string) => tasks.get(id),
        insert: (task: any) => tasks.set(task.id, task),
        update: (id: string, updates: any) => { Object.assign(tasks.get(id), updates); },
      };
      const project = { id: 'primary', path: '/tmp/test', settings: JSON.stringify({ openproject: { enabled: true, sourceId: 'op', role: 'primary' } }) };
      const source = {
        id: 'op',
        url: 'https://op.test',
        project: 'main',
        triage: 'off' as const,
        minTicketNumber: 0,
        autoStart: true,
        split: { typeIds: [5], keyword: '[chia]', workerMayRequest: true, maxParts: 5, createChildTickets: true },
      };
      const intake = new OpenProjectIntakeService({
        config: {
          hubHome,
          integrations: {
            openproject: {
              sources: [source],
            },
          },
        } as any,
        projectRepo: { getAll: () => [project], get: () => project } as any,
        taskRepo: taskRepo as any,
        trackerRepo: { get: () => null, listBySource: () => [], upsert: () => {} } as any,
        taskBatchRepo: {} as any,
        taskService: { createTask: (raw: any) => { const t = { id: `${raw.project}/${raw.slug}`, ...raw }; tasks.set(t.id, t); return t; } } as any,
        eventBus: { on: () => {}, off: () => {}, emit: () => true } as any,
      });

      const wp = {
        id: 10,
        displayId: '10',
        subject: 'Tính năng lớn',
        _links: { type: { href: '/api/v3/types/5' } },
      };

      const seed = {
        source_id: 'op',
        wp_id: wp.id,
        display_id: '10',
        status_id: null,
        updated_at: '',
        last_comment_id: null,
        task_ids: '[]',
        writeback: '{}',
        created_at: '',
      };
      const client = { downloadAttachment: vi.fn() };

      await (intake as any).handleTicket(
        source,
        project,
        client,
        wp,
        [],
        seed,
        'new',
      );

      const created = [...tasks.values()];
      expect(created.some((t) => t.slug.includes('-plan'))).toBe(true);
    } finally {
      fs.rmSync(hubHome, { recursive: true, force: true });
    }
  });

  it('creates -plan task for tickets with [chia] keyword when triage is off', async () => {
    const hubHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-intake-split-'));
    try {
      const tasks = new Map<string, any>();
      const taskRepo = {
        get: (id: string) => tasks.get(id),
        insert: (task: any) => tasks.set(task.id, task),
        update: (id: string, updates: any) => { Object.assign(tasks.get(id), updates); },
      };
      const project = { id: 'primary', path: '/tmp/test', settings: JSON.stringify({ openproject: { enabled: true, sourceId: 'op', role: 'primary' } }) };
      const source = {
        id: 'op',
        url: 'https://op.test',
        project: 'main',
        triage: 'off' as const,
        minTicketNumber: 0,
        autoStart: true,
        split: { typeIds: [], keyword: '[chia]', workerMayRequest: true, maxParts: 5, createChildTickets: true },
      };
      const intake = new OpenProjectIntakeService({
        config: {
          hubHome,
          integrations: {
            openproject: {
              sources: [source],
            },
          },
        } as any,
        projectRepo: { getAll: () => [project], get: () => project } as any,
        taskRepo: taskRepo as any,
        trackerRepo: { get: () => null, listBySource: () => [], upsert: () => {} } as any,
        taskBatchRepo: {} as any,
        taskService: { createTask: (raw: any) => { const t = { id: `${raw.project}/${raw.slug}`, ...raw }; tasks.set(t.id, t); return t; } } as any,
        eventBus: { on: () => {}, off: () => {}, emit: () => true } as any,
      });

      const wp = {
        id: 20,
        displayId: '20',
        subject: '[chia] Refactor hệ thống thanh toán',
        _links: { type: { href: '/api/v3/types/1' } },
      };

      const seed = {
        source_id: 'op',
        wp_id: wp.id,
        display_id: '20',
        status_id: null,
        updated_at: '',
        last_comment_id: null,
        task_ids: '[]',
        writeback: '{}',
        created_at: '',
      };
      const client = { downloadAttachment: vi.fn() };

      await (intake as any).handleTicket(
        source,
        project,
        client,
        wp,
        [],
        seed,
        'new',
      );

      const created = [...tasks.values()];
      expect(created.some((t) => t.slug.includes('-plan'))).toBe(true);
    } finally {
      fs.rmSync(hubHome, { recursive: true, force: true });
    }
  });
});

describe('Review prompt and review flow for -plan tasks', () => {
  it('buildReviewerPrompt includes specialized instructions for plan tasks', () => {
    const normalPrompt = buildReviewerPrompt('Đề bài task', '/tmp/worktree', [], [], '/tmp/worktree', [], false);
    expect(normalPrompt).not.toContain('HƯỚNG DẪN RIÊNG CHO TASK KẾ HOẠCH CHIA VIỆC');

    const planPrompt = buildReviewerPrompt('Đề bài task plan', '/tmp/worktree', [], [], '/tmp/worktree', [], true);
    expect(planPrompt).toContain('HƯỚNG DẪN RIÊNG CHO TASK KẾ HOẠCH CHIA VIỆC (-plan)');
    expect(planPrompt).toContain('Đủ phạm vi');
    expect(planPrompt).toContain('Giới hạn độ vụn');
    expect(planPrompt).toContain('Phụ thuộc');
    expect(planPrompt).toContain('Level');
    expect(planPrompt).toContain('Định dạng');
  });
});

type TestTaskItem = Record<string, unknown> & {
  id: string;
  projectId: string;
  slug: string;
  title: string;
  externalRef: string;
  doneReport?: string | null;
  blockedReport?: string | null;
  status?: string;
  body?: string;
};

function splitHarness(input: {
  tasks: TestTaskItem[];
  triage?: 'off' | 'approve' | 'auto';
  autoStart?: boolean;
  createChildTickets?: boolean;
  workerMayRequest?: boolean;
  maxParts?: number;
  initialRowWriteback?: string;
  fetchFn?: typeof fetch;
  git?: (cwd: string, args: string[]) => Promise<{ code: number; output: string }>;
}) {
  const hubHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-split-'));
  saveOpenProjectKey(hubHome, 'op', 'key');
  const tasks = new Map(input.tasks.map((task) => [task.id, task]));
  const row = {
    source_id: 'op',
    wp_id: 100,
    display_id: '100',
    status_id: 1,
    updated_at: '',
    last_comment_id: null,
    task_ids: JSON.stringify(input.tasks.map((task) => task.id)),
    writeback: input.initialRowWriteback || '{}',
    created_at: '',
  } as any;
  const trackerRows = new Map<string, any>([['op:100', row]]);
  let listener: ((type: string, taskId?: string, payload?: unknown) => void) | undefined;
  const events: Array<{ type: string; taskId?: string; payload?: any }> = [];
  const bus = {
    on: (_event: string, handler: typeof listener) => { listener = handler; },
    off: () => undefined,
    emit: (type: string, taskId?: string, payload?: unknown) => { events.push({ type, taskId, payload }); return true; },
  };
  const projects = new Map<string, any>();
  for (const projectId of ['primary', 'backend', 'web']) {
    projects.set(projectId, {
      id: projectId,
      path: hubHome,
      settings: JSON.stringify({
        openproject: { enabled: true, sourceId: 'op', role: projectId === 'primary' ? 'primary' : 'secondary' },
        gitea: { enabled: true, targetBranch: 'main' },
      }),
    });
  }

  const batches = new Map<string, any>();
  let batchSeq = 1;
  const apiCalls: Array<{ url: string; method?: string; body?: any }> = [];

  const defaultFetch = async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    apiCalls.push({ url: urlStr, method: init?.method, body });
    if (urlStr.includes('/work_packages') && init?.method === 'POST') {
      const newId = 200 + apiCalls.length;
      return new Response(JSON.stringify({
        id: newId,
        lockVersion: 1,
        _links: { self: { href: `/api/v3/work_packages/${newId}` } },
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ id: 100, lockVersion: 1 }), { status: 200 });
  };

  const service = new OpenProjectWritebackService({
    config: {
      hubHome,
      integrations: {
        openproject: {
          sources: [{
            id: 'op',
            url: 'https://op.test',
            project: 'main',
            triage: input.triage ?? 'off',
            feedbackStatusId: 6,
            autoResolve: true,
            resolvedStatusId: 5,
            reviewStatusId: 6,
            watchStatusIds: [],
            reopenedStatusIds: [],
            openStatusIds: [],
            minTicketNumber: 0,
            pollIntervalSec: 60,
            autoStart: input.autoStart ?? false,
            language: 'vi',
            split: {
              typeIds: [5],
              keyword: '[chia]',
              workerMayRequest: input.workerMayRequest ?? true,
              maxParts: input.maxParts ?? 5,
              createChildTickets: input.createChildTickets ?? true,
            },
          }],
        },
      },
      deploy: {},
    } as any,
    projectRepo: { get: (id: string) => projects.get(id), getAll: () => [...projects.values()] } as any,
    taskRepo: {
      get: (id: string) => tasks.get(id),
      update: (id: string, updates: any) => {
        const t = tasks.get(id);
        if (t) Object.assign(t, updates);
      },
    } as any,
    trackerRepo: {
      listAll: () => [...trackerRows.values()],
      get: (sourceId: string, wpId: number) => trackerRows.get(`${sourceId}:${wpId}`),
      upsert: (next: any) => {
        const key = `${next.source_id}:${next.wp_id}`;
        trackerRows.set(key, { ...(trackerRows.get(key) || {}), ...next });
        return trackerRows.get(key);
      },
    } as any,
    taskBatchRepo: {
      get: (id: string) => batches.get(id),
    } as any,
    batchService: {
      createBatch: (raw: any) => {
        const batchId = `batch-${batchSeq++}`;
        const createdTasks = raw.tasks.map((t: any) => {
          const taskObj = { id: `${t.project || raw.project}/${t.slug}`, projectId: t.project || raw.project, ...t, status: 'draft', externalRef: '100' };
          tasks.set(taskObj.id, taskObj);
          return taskObj;
        });
        const batchObj = { id: batchId, ...raw, tasks: createdTasks, status: raw.dispatch ? 'dispatched' : 'draft' };
        batches.set(batchId, batchObj);
        return batchObj;
      },
      dispatchBatch: (batchId: string) => {
        const batch = batches.get(batchId);
        if (batch) batch.status = 'dispatched';
        listener?.('batch.dispatched', undefined, { batchId });
      },
    },
    taskService: {
      createTask: (raw: any) => {
        const created = { id: `${raw.project}/${raw.slug}`, ...raw, status: 'queued' };
        tasks.set(created.id, created);
        return created;
      },
    },
    eventBus: bus,
    fetchFn: (input.fetchFn || defaultFetch) as typeof fetch,
    git: input.git || (async () => ({ code: 0, output: '' })),
    timerMs: 10,
  });

  service.start();
  const emit = async (type: string, taskId?: string, payload?: unknown) => {
    listener?.(type, taskId, payload);
    await new Promise((resolve) => setTimeout(resolve, 30));
  };

  return {
    service,
    row,
    trackerRows,
    tasks,
    batches,
    events,
    apiCalls,
    hubHome,
    emit,
    cleanup: () => {
      service.stop();
      fs.rmSync(hubHome, { recursive: true, force: true });
    },
  };
}

describe('OpenProject split writeback handling', () => {
  it('creates batch when -plan task completes even if triage is enabled', async () => {
    const planReport = `## Chia việc
### 1. Phần backend
- project: backend
Mô tả backend.

### 2. Phần frontend
- project: web
- phụ thuộc: 1
Mô tả frontend.
`;
    const planTask = {
      id: 'primary/op-100-plan',
      projectId: 'primary',
      slug: 'op-100-plan',
      title: 'Lập kế hoạch chia việc',
      externalRef: '100',
      doneReport: planReport,
      blockedReport: null,
      status: 'done',
    };
    const h = splitHarness({ tasks: [planTask], triage: 'approve' });
    await h.emit('task.done', planTask.id);

    const plannedEvent = h.events.find((e) => e.type === 'tracker.split_planned');
    expect(plannedEvent).toBeDefined();
    expect(h.batches.size).toBe(1);
    const batch = [...h.batches.values()][0];
    expect(batch.tasks).toHaveLength(2);
    expect(batch.tasks[0].slug).toBe('op-100-1');
    expect(batch.tasks[0].projectId).toBe('backend');
    expect(batch.tasks[1].slug).toBe('op-100-2');
    expect(batch.tasks[1].projectId).toBe('web');
    h.cleanup();
  });

  it('creates batch when worker self-requests split via ## Chia việc in DONE', async () => {
    const regularTask = {
      id: 'primary/op-100',
      projectId: 'primary',
      slug: 'op-100',
      title: 'Task thường',
      externalRef: '100',
      doneReport: `## Chia việc
### 1. Việc 1
Mô tả 1.

### 2. Việc 2
Mô tả 2.
`,
      blockedReport: null,
      status: 'done',
    };
    const h = splitHarness({ tasks: [regularTask], workerMayRequest: true });
    await h.emit('task.done', regularTask.id);

    expect(h.events.some((e) => e.type === 'tracker.split_planned')).toBe(true);
    expect(h.batches.size).toBe(1);
    h.cleanup();
  });

  it('rejects self-request split if workerMayRequest is false', async () => {
    const regularTask = {
      id: 'primary/op-100',
      projectId: 'primary',
      slug: 'op-100',
      title: 'Task thường',
      externalRef: '100',
      doneReport: `## Chia việc
### 1. Việc 1
Mô tả 1.

### 2. Việc 2
Mô tả 2.
`,
      blockedReport: null,
      status: 'done',
    };
    const h = splitHarness({ tasks: [regularTask], workerMayRequest: false });
    await h.emit('task.done', regularTask.id);

    expect(h.events.some((e) => e.type === 'tracker.split_planned')).toBe(false);
    expect(h.batches.size).toBe(0);
    h.cleanup();
  });

  it('returns invalid plan (e.g. 7 parts) to worker with feedback review and re-queues', async () => {
    const badReport = `## Chia việc
### 1. V1\nMô tả 1.
### 2. V2\nMô tả 2.
### 3. V3\nMô tả 3.
### 4. V4\nMô tả 4.
### 5. V5\nMô tả 5.
### 6. V6\nMô tả 6.
### 7. V7\nMô tả 7.
`;
    const planTask = {
      id: 'primary/op-100-plan',
      projectId: 'primary',
      slug: 'op-100-plan',
      title: 'Lập kế hoạch chia việc',
      externalRef: '100',
      body: 'Đề bài ban đầu',
      doneReport: badReport,
      blockedReport: null,
      status: 'done',
    };
    const h = splitHarness({ tasks: [planTask] });
    await h.emit('task.done', planTask.id);

    expect(h.events.some((e) => e.type === 'tracker.split_invalid')).toBe(true);
    expect(planTask.status).toBe('queued');
    expect((planTask as any).resume).toBe(1);
    expect(planTask.body).toContain('## Feedback review');
    expect(planTask.body).toContain('gộp lại tối đa 5 phần');
    h.cleanup();
  });

  it('runs 1-part plan as a normal task without creating batch', async () => {
    const singlePlanReport = `## Chia việc
### 1. Chỉ có 1 phần vừa sức
Sửa hàm xử lý validation trong form.
`;
    const planTask = {
      id: 'primary/op-100-plan',
      projectId: 'primary',
      slug: 'op-100-plan',
      title: 'Lập kế hoạch chia việc',
      externalRef: '100',
      body: 'Đề bài ban đầu',
      doneReport: singlePlanReport,
      blockedReport: null,
      status: 'done',
    };
    const h = splitHarness({ tasks: [planTask] });
    await h.emit('task.done', planTask.id);

    expect(h.events.some((e) => e.type === 'tracker.split_single_task')).toBe(true);
    expect(h.batches.size).toBe(0);
    expect(planTask.status).toBe('queued');
    expect((planTask as any).resume).toBe(1);
    expect(planTask.body).toContain('thực hiện như task thường');
    expect(planTask.body).toContain('Sửa hàm xử lý validation');
    h.cleanup();
  });

  it('dispatches batch: creates child tickets on OpenProject, tracks items and comments plan', async () => {
    const plan = {
      parts: [
        { index: 1, title: 'Phần 1', project: 'primary', level: 'easy', dependsOn: [], description: 'Mô tả 1' },
        { index: 2, title: 'Phần 2', project: 'primary', level: 'easy', dependsOn: [1], description: 'Mô tả 2' },
      ],
      source: 'done' as const,
    };
    const child1 = { id: 'primary/op-100-1', projectId: 'primary', slug: 'op-100-1', title: '[100] Phần 1', externalRef: '100', status: 'queued' };
    const child2 = { id: 'primary/op-100-2', projectId: 'primary', slug: 'op-100-2', title: '[100] Phần 2', externalRef: '100', status: 'queued' };
    const h = splitHarness({ tasks: [child1, child2], autoStart: false });

    // Set up existing batch
    const batchId = 'batch-test-1';
    h.batches.set(batchId, {
      id: batchId,
      goal: JSON.stringify({ kind: 'openproject-split', sourceId: 'op', wpId: 100, displayId: '100', plan }),
    });

    await h.emit('batch.dispatched', undefined, { batchId });

    // Verify OpenProject createWorkPackage was called for each part with parentId = 100
    const wpCalls = h.apiCalls.filter((c) => c.url.includes('/work_packages') && c.method === 'POST');
    expect(wpCalls.length).toBeGreaterThanOrEqual(2);
    expect(wpCalls[0].body._links?.parent?.href).toBe('/api/v3/work_packages/100');
    expect(wpCalls[0].body._links?.assignee).toBeDefined();
    expect(wpCalls[1].body._links?.parent?.href).toBe('/api/v3/work_packages/100');

    // Verify plan comment was sent to ticket cha
    const commentCall = h.apiCalls.find((c) => c.url.includes('/100/activities') && c.method === 'POST');
    expect(commentCall).toBeDefined();
    expect(commentCall?.body.comment.raw).toContain('**[AgentHub] Kế hoạch**');
    expect(commentCall?.body.comment.raw).toContain('Ticket con:');

    // Verify child tracker items were created
    expect(h.trackerRows.size).toBe(3); // 1 parent + 2 children
    expect(child1.externalRef).not.toBe('100'); // updated to child ticket displayId
    expect(child2.externalRef).not.toBe('100');

    h.cleanup();
  });

  it('saves parent split state before auto-dispatch creates child tickets', async () => {
    const planTask = {
      id: 'primary/op-100-plan',
      projectId: 'primary',
      slug: 'op-100-plan',
      title: 'Lập kế hoạch chia việc',
      externalRef: '100',
      doneReport: `## Chia việc
### 1. Phần 1
Mô tả 1.

### 2. Phần 2
Mô tả 2.`,
      blockedReport: null,
      status: 'done',
    };
    const h = splitHarness({ tasks: [planTask], autoStart: true });
    await h.emit('task.done', planTask.id);

    const childCreates = h.apiCalls.filter((call) => call.url.includes('/work_packages') && call.method === 'POST');
    expect(childCreates.length).toBeGreaterThanOrEqual(2);
    expect(JSON.parse(h.trackerRows.get('op:100').writeback).split.children).toHaveLength(2);
    h.cleanup();
  });

  it('does not create OpenProject child tickets when createChildTickets is false', async () => {
    const plan = {
      parts: [
        { index: 1, title: 'Phần 1', project: 'primary', level: 'easy', dependsOn: [], description: 'Mô tả 1' },
      ],
      source: 'done' as const,
    };
    const child1 = { id: 'primary/op-100-1', projectId: 'primary', slug: 'op-100-1', title: '[100] Phần 1', externalRef: '100', status: 'queued' };
    const h = splitHarness({ tasks: [child1], createChildTickets: false });

    const batchId = 'batch-no-children';
    h.batches.set(batchId, {
      id: batchId,
      goal: JSON.stringify({ kind: 'openproject-split', sourceId: 'op', wpId: 100, displayId: '100', plan }),
    });

    await h.emit('batch.dispatched', undefined, { batchId });

    const wpCalls = h.apiCalls.filter((c) => c.url.endsWith('/work_packages') && c.method === 'POST');
    expect(wpCalls).toHaveLength(0); // No child tickets created

    // Plan comment is sent once
    const commentCalls = h.apiCalls.filter((c) => c.url.includes('/100/activities') && c.method === 'POST');
    expect(commentCalls).toHaveLength(1);

    // Emitting dispatch again does not send duplicate comment
    await h.emit('batch.dispatched', undefined, { batchId });
    const commentCallsAgain = h.apiCalls.filter((c) => c.url.includes('/100/activities') && c.method === 'POST');
    expect(commentCallsAgain).toHaveLength(1);

    h.cleanup();
  });

  it('comments cancellation on discard if plan was commented previously', async () => {
    const plan = {
      parts: [{ index: 1, title: 'Phần 1', project: 'primary', level: 'easy', dependsOn: [], description: 'Mô tả 1' }],
      source: 'done' as const,
    };
    const h = splitHarness({
      tasks: [],
      initialRowWriteback: JSON.stringify({ split: { planCommented: true, plan } }),
    });

    const batchId = 'batch-discard-me';
    h.batches.set(batchId, {
      id: batchId,
      goal: JSON.stringify({ kind: 'openproject-split', sourceId: 'op', wpId: 100, displayId: '100' }),
    });

    await h.emit('batch.discarded', undefined, { batchId });

    const cancelCall = h.apiCalls.find((c) => c.url.includes('/100/activities') && c.body?.comment?.raw?.includes('Huỷ kế hoạch'));
    expect(cancelCall).toBeDefined();
    expect(h.events.some((e) => e.type === 'tracker.split_discarded')).toBe(true);
    h.cleanup();
  });

  it('routes review request ([Cần duyệt]) to child ticket when child task is blocked', async () => {
    const childTaskId = 'primary/op-100-1';
    const childTask = {
      id: childTaskId,
      projectId: 'primary',
      slug: 'op-100-1',
      title: '[100] Phần 1',
      externalRef: '201',
      blockedReport: '## Cần quyết định\nPhương án A hay B?',
      status: 'blocked',
    };
    const h = splitHarness({
      tasks: [childTask],
      initialRowWriteback: JSON.stringify({ split: { children: [childTaskId], childTickets: { [childTaskId]: { id: 201, displayId: '201', url: 'https://op.test/201' } } } }),
    });

    // Add child row to tracker
    h.trackerRows.set('op:201', {
      source_id: 'op',
      wp_id: 201,
      display_id: '201',
      task_ids: JSON.stringify([childTaskId]),
      writeback: '{}',
    });

    await h.emit('task.blocked', childTaskId);

    // Comment [Cần duyệt] must go to ticket 201 (the child), NOT 100 (the parent)
    const childComments = h.apiCalls.filter((c) => c.url.includes('/201/activities'));
    expect(childComments).toHaveLength(1);
    expect(childComments[0].body.comment.raw).toContain('**[Cần duyệt]**');
    expect(childComments[0].body.comment.raw).toContain('Phương án A hay B?');

    const parentComments = h.apiCalls.filter((c) => c.url.includes('/100/activities'));
    expect(parentComments).toHaveLength(0);

    h.cleanup();
  });

  it('parent ticket is only resolved when all child tasks are merged and pushed', async () => {
    const child1Id = 'primary/op-100-1';
    const child2Id = 'primary/op-100-2';
    const childTask1 = {
      id: child1Id,
      projectId: 'primary',
      slug: 'op-100-1',
      title: '[100] Phần 1',
      externalRef: '201',
      doneReport: '## Comment cho tester\nĐã xong phần 1',
      status: 'done',
    };
    const childTask2 = {
      id: child2Id,
      projectId: 'primary',
      slug: 'op-100-2',
      title: '[100] Phần 2',
      externalRef: '202',
      doneReport: '## Comment cho tester\nĐã xong phần 2',
      status: 'done',
    };
    const h = splitHarness({
      tasks: [childTask1, childTask2],
      initialRowWriteback: JSON.stringify({
        split: {
          children: [child1Id, child2Id],
          childTickets: {
            [child1Id]: { id: 201, displayId: '201', url: 'https://op.test/201' },
            [child2Id]: { id: 202, displayId: '202', url: 'https://op.test/202' },
          },
        },
      }),
    });

    // Add child rows
    h.trackerRows.set('op:201', { source_id: 'op', wp_id: 201, display_id: '201', task_ids: JSON.stringify([child1Id]), writeback: '{}' });
    h.trackerRows.set('op:202', { source_id: 'op', wp_id: 202, display_id: '202', task_ids: JSON.stringify([child2Id]), writeback: '{}' });

    // Merge only child 1
    await h.emit('task.merged', child1Id, { mergeCommit: 'c1' });
    // Parent should NOT be resolved yet
    expect(h.events.some((e) => e.type === 'tracker.resolved' && (e.payload as any)?.displayId === '100')).toBe(false);

    // Merge child 2
    await h.emit('task.merged', child2Id, { mergeCommit: 'c2' });

    // Now parent should be resolved!
    expect(h.events.some((e) => e.type === 'tracker.resolved' && (e.payload as any)?.displayId === '100')).toBe(true);

    // Parent should receive aggregated comments from both children
    const parentComment = h.apiCalls.find((c) => c.url.includes('/100/activities'));
    expect(parentComment?.body.comment.raw).toContain('**[AgentHub] Đã sửa**');
    expect(parentComment?.body.comment.raw).toContain('Đã xong phần 1');
    expect(parentComment?.body.comment.raw).toContain('Đã xong phần 2');

    h.cleanup();
  });
});

