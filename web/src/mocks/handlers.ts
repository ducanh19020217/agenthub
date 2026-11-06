import { http, HttpResponse } from 'msw';
import {
  BrainStatus,
  ChatMessage,
  ChatSession,
  EventItem,
  HubStatus,
  Profile,
  Project,
  SystemConfig,
  TaskDetail,
  TaskBatch,
} from '../types/api';
import { parseApiTime } from '../lib/time';
import { filterTasksForDag, layoutTaskDag } from '../components/dag/dagUtils';

let mockBrain: BrainStatus = {
  activity: 'idle',
  detail: 'Sẵn sàng điều phối',
  taskId: null,
  updatedAt: new Date().toISOString(),
  stale: false,
};

// Realistic mock data
let mockProjects: Project[] = [
  {
    id: 'xfarm',
    name: 'XFarm',
    path: '/home/user/projects/xfarm',
    defaultBranch: 'main',
    envTemplate: JSON.stringify({ PORT: 3001, DB: 'xfarm_test' }, null, 2),
    maxParallel: 3,
    createdAt: '2026-10-01 10:00:00',
  },
  {
    id: 'agenthub',
    name: 'AgentHub',
    path: '/home/user/Desktop/AgentHub',
    defaultBranch: 'main',
    envTemplate: null,
    maxParallel: 3,
    createdAt: '2026-10-01 10:00:00',
  },
];

let mockProfiles: Profile[] = [
  {
    name: 'chinh',
    engine: 'agy',
    kind: 'keyring',
    email: 'chinh@example.com',
    loggedIn: true,
    enabled: 1,
    busy: true,
    isBusy: true,
    duplicateWarning: true,
    duplicateEmailWith: ['g1'],
    quotaMarks: [
      {
        profileName: 'chinh',
        family: 'gemini-3.8-flash',
        until: Math.floor(Date.now() / 1000) + 1800,
        reason: 'RESOURCE_EXHAUSTED: Quota exceeded for model gemini-3.8-flash',
      },
    ],
  },
  {
    name: 'g1',
    engine: 'agy',
    kind: 'isolated',
    email: 'chinh@example.com',
    loggedIn: true,
    enabled: 1,
    busy: false,
    isBusy: false,
    duplicateWarning: true,
    duplicateEmailWith: ['chinh'],
    quotaMarks: [],
  },
  {
    name: 'g2',
    engine: 'agy',
    kind: 'isolated',
    email: 'g2.developer@example.com',
    loggedIn: true,
    enabled: 1,
    busy: false,
    isBusy: false,
    duplicateWarning: false,
    duplicateEmailWith: [],
    quotaMarks: [
      {
        profileName: 'g2',
        family: 'gemini-3.8-flash-high',
        until: Math.floor(Date.now() / 1000) + 3600,
        reason: 'Daily token quota reached',
      },
    ],
  },
  {
    name: 'g3',
    engine: 'agy',
    kind: 'isolated',
    email: null,
    loggedIn: false,
    enabled: 1,
    busy: false,
    isBusy: false,
    duplicateWarning: false,
    duplicateEmailWith: [],
    quotaMarks: [],
  },
  {
    name: 'codex',
    engine: 'codex',
    kind: 'codex',
    email: null,
    loggedIn: true,
    enabled: 1,
    busy: false,
    isBusy: false,
    duplicateWarning: false,
    duplicateEmailWith: [],
    quotaMarks: [],
  },
];

let mockBatches: TaskBatch[] = [
  {
    id: 'batch-1',
    projectId: 'agenthub',
    title: 'Kế hoạch phát triển AgentHub',
    goal: 'Bổ sung tính năng batch planning và DAG visualizer',
    status: 'draft',
    createdBy: 'claude',
    createdAt: '2026-10-20T10:00:00Z',
  },
  {
    id: 'batch-2',
    projectId: 'xfarm',
    title: 'Nâng cấp API farm',
    goal: 'Tối ưu GraphQL và mutation',
    status: 'dispatched',
    createdBy: 'user',
    createdAt: '2026-10-19T14:30:00Z',
  },
];

let mockTasks: TaskDetail[] = [
  {
    id: 'agenthub~b1-task-1',
    projectId: 'agenthub',
    slug: 'b1-task-1',
    title: 'Tạo bảng task_batches',
    body: 'Migration 28: thêm bảng task_batches và cột batchId',
    level: 'easy',
    status: 'draft',
    dependsOn: [],
    attempt: 0,
    resume: 0,
    createdAt: '2026-10-20T10:00:00Z',
    updatedAt: '2026-10-20T10:00:00Z',
    batchId: 'batch-1',
    runs: [],
    reviews: [],
  },
  {
    id: 'agenthub~b1-task-2',
    projectId: 'agenthub',
    slug: 'b1-task-2',
    title: 'Xây dựng PlansPage',
    body: 'Trang Kế hoạch với danh sách đợt và TaskDag',
    level: 'hard',
    status: 'draft',
    dependsOn: ['b1-task-1'],
    attempt: 0,
    resume: 0,
    createdAt: '2026-10-20T10:05:00Z',
    updatedAt: '2026-10-20T10:05:00Z',
    batchId: 'batch-1',
    runs: [],
    reviews: [],
  },
  {
    id: 'agenthub~a0-core',
    projectId: 'agenthub',
    slug: 'a0-core',
    title: 'Core AgentHub services',
    body: `# Task a0-core\n\nTriển khai core services cho AgentHub: db, engines, quota, scheduler, worktrees.\n\n## Yêu cầu\n1. SQLite schema\n2. Engine adapters\n3. Scheduler unit tests`,
    level: 'hard',
    status: 'done',
    dependsOn: [],
    attempt: 1,
    resume: 0,
    createdAt: '2026-10-14 07:00:00',
    updatedAt: '2026-10-14 08:45:00',
    doneContent: `# Báo cáo DONE a0-core\n\n- Đã triển khai xong SQLite DB và migrations\n- Engine adapter cho agy và codex\n- Scheduler và quota management\n- **30 tests passed**`,
    commits: [
      '0883e51 feat(core): implement AgentHub core services',
      '6ab9f5a docs(plan): document transient agy errors and retry policy',
    ],
    gitCommits: [
      '0883e51 feat(core): implement AgentHub core services',
      '6ab9f5a docs(plan): document transient agy errors and retry policy',
    ],
    runs: [
      {
        id: 'run-a0-1',
        taskId: 'agenthub~a0-core',
        engine: 'agy',
        model: 'claude-opus-4-6-thinking',
        profileName: 'chinh',
        startedAt: '2026-10-14 08:00:00',
        endedAt: '2026-10-14 08:45:00',
        outcome: 'done',
      },
    ],
    reviews: [],
  },
  {
    id: 'agenthub~a1-api',
    projectId: 'agenthub',
    slug: 'a1-api',
    title: 'HTTP API và MCP server daemon',
    body: `# Task a1-api\n\nTriển khai HTTP daemon và MCP server cho Claude Code kết nối.\n\n## Tiêu chí\n- Endpoint /api/* bảo mật token\n- EventSource SSE\n- MCP tools: hub_status, hub_tasks,...`,
    level: 'hard',
    status: 'running',
    dependsOn: ['agenthub~a0-core'],
    attempt: 1,
    resume: 0,
    createdAt: '2026-10-15 08:30:00',
    updatedAt: '2026-10-15 09:15:00',
    runs: [
      {
        id: 'run-a1-1',
        taskId: 'agenthub~a1-api',
        engine: 'agy',
        model: 'claude-opus-4-6-thinking',
        profileName: 'chinh',
        startedAt: new Date(Date.now() - 35 * 60 * 1000).toISOString(),
        outcome: null,
      },
    ],
    reviews: [],
  },
  {
    id: 'agenthub~a2-web',
    projectId: 'agenthub',
    slug: 'a2-web',
    title: 'Web dashboard AgentHub',
    body: `# Task a2-web\n\nXây dựng SPA React cho web dashboard AgentHub.\n\n- Vite + React 18 + Tailwind 4\n- Kanban board, live log xterm, quản lý profile`,
    level: 'hard',
    status: 'review',
    dependsOn: ['agenthub~a0-core'],
    attempt: 1,
    resume: 0,
    createdAt: '2026-10-15 09:00:00',
    updatedAt: '2026-10-15 11:30:00',
    doneContent: `# Báo cáo DONE a2-web\n\n- Đã hoàn thiện toàn bộ các trang: Tổng quan, Task, Tài khoản, Project, Cài đặt\n- Dark mode, Kanban responsive\n- Tất cả bài test Vitest passed`,
    commits: [
      '21e5b3d docs: a2-web task',
      '002b36c docs(decisions): add DEC-001 for GET/PUT /api/config endpoint',
    ],
    gitCommits: [
      '21e5b3d docs: a2-web task',
      '002b36c docs(decisions): add DEC-001 for GET/PUT /api/config endpoint',
    ],
    runs: [
      {
        id: 'run-a2-1',
        taskId: 'agenthub~a2-web',
        engine: 'agy',
        model: 'gemini-3.8-flash-high',
        profileName: 'g1',
        startedAt: '2026-10-15 09:30:00',
        endedAt: '2026-10-15 11:30:00',
        outcome: 'done',
      },
    ],
    reviews: [],
  },
  {
    id: 'xfarm~seed-data',
    projectId: 'xfarm',
    slug: 'seed-data',
    title: 'Seed dữ liệu mẫu trang trại cây ăn quả',
    body: `Viết script seed dữ liệu mẫu cho hệ thống quản lý tưới tiêu cây ăn quả và sensor nhiệt độ.`,
    level: 'easy',
    status: 'queued',
    dependsOn: [],
    attempt: 0,
    resume: 0,
    createdAt: '2026-10-15 10:00:00',
    updatedAt: '2026-10-15 10:00:00',
    runs: [],
    reviews: [],
  },
  {
    id: 'xfarm~iot-sync',
    projectId: 'xfarm',
    slug: 'iot-sync',
    title: 'Đồng bộ cảm biến IoT qua MQTT',
    body: `Tích hợp MQTT client nhận telemetry từ sensor độ ẩm đất theo chu kỳ 10 giây.`,
    level: 'easy',
    status: 'waiting_quota',
    dependsOn: ['xfarm~seed-data'],
    attempt: 1,
    resume: 0,
    createdAt: '2026-10-15 10:10:00',
    updatedAt: '2026-10-15 10:20:00',
    runs: [
      {
        id: 'run-iot-1',
        taskId: 'xfarm~iot-sync',
        engine: 'agy',
        model: 'gemini-3.8-flash',
        profileName: 'chinh',
        startedAt: '2026-10-15 10:15:00',
        endedAt: '2026-10-15 10:20:00',
        outcome: 'quota',
      },
    ],
    reviews: [],
  },
  {
    id: 'xfarm~billing',
    projectId: 'xfarm',
    slug: 'billing',
    title: 'Tích hợp cổng thanh toán VNPay',
    body: `Xử lý webhook thanh toán và kiểm tra chữ ký số SHA256 checksum từ VNPay gateway.`,
    level: 'hard',
    status: 'blocked',
    dependsOn: [],
    attempt: 1,
    resume: 0,
    createdAt: '2026-10-14 14:00:00',
    updatedAt: '2026-10-14 14:30:00',
    blockedContent: `# BỊ CHẶN: Thiếu thông tin cấu hình VNPay sandbox\n\nCần bổ sung VNP_TMN_CODE và VNP_HASH_SECRET vào file .env hoặc envTemplate.`,
    runs: [
      {
        id: 'run-bill-1',
        taskId: 'xfarm~billing',
        engine: 'codex',
        model: 'codex:gpt-5.6-luna',
        profileName: 'codex',
        startedAt: '2026-10-14 14:05:00',
        endedAt: '2026-10-14 14:30:00',
        outcome: 'blocked',
      },
    ],
    reviews: [],
  },
  {
    id: 'xfarm~auth-sms',
    projectId: 'xfarm',
    slug: 'auth-sms',
    title: 'Xác thực tài khoản bằng OTP qua SMS',
    body: `Tích hợp SMS gateway gửi mã 6 số ngẫu nhiên có hiệu lực trong 5 phút.`,
    level: 'easy',
    status: 'failed',
    dependsOn: [],
    attempt: 2,
    resume: 0,
    createdAt: '2026-10-15 08:00:00',
    updatedAt: '2026-10-15 08:35:00',
    runs: [
      {
        id: 'run-sms-1',
        taskId: 'xfarm~auth-sms',
        engine: 'agy',
        model: 'gemini-3.8-flash',
        profileName: 'g2',
        startedAt: '2026-10-15 08:10:00',
        endedAt: '2026-10-15 08:35:00',
        outcome: 'crashed',
      },
    ],
    reviews: [],
  },
  {
    id: 'agenthub~docs-cleanup',
    projectId: 'agenthub',
    slug: 'docs-cleanup',
    title: 'Rà soát tài liệu kiến trúc và hướng dẫn',
    body: `Kiểm tra lại toàn bộ file trong docs/, cập nhật diagrams và protocol.md.`,
    level: 'easy',
    status: 'draft',
    dependsOn: [],
    attempt: 0,
    resume: 0,
    createdAt: '2026-10-15 11:00:00',
    updatedAt: '2026-10-15 11:00:00',
    runs: [],
    reviews: [],
  },
];

let mockConfig: SystemConfig = {
  modelChainHard: ['codex:gpt-5.6-luna', 'gemini-3.8-flash-high'],
  modelChainEasy: ['gemini-3.8-flash-medium', 'codex:gpt-5.6-luna'],
  defaultTimeout: 10800,
  slotsPerAgyProfile: 2,
  slotsPerCodexProfile: 2,
  watchdog: { stallMinutes: 8, waitingMinutes: 5 },
  stall: { noCommitMin: 45, loopThreshold: 6 },
  modelChains: {
    hard: ['codex:gpt-5.6-luna', 'gemini-3.8-flash-high'],
    easy: ['gemini-3.8-flash-medium', 'codex:gpt-5.6-luna'],
  },
  runTimeoutHours: 3,
  chat: {
    allowFullMode: false,
    disableToolSearch: true,
    claudeBin: 'claude',
    maxConcurrent: 2,
    model: 'sonnet',
  },
};

let mockChatSessions: ChatSession[] = [
  {
    id: 'sess-1',
    projectId: 'agenthub',
    title: 'Hỏi về kiến trúc AgentHub',
    mode: 'safe',
    busy: false,
    updatedAt: new Date(Date.now() - 3600000).toISOString(),
    lastMessage: 'Tôi đã kiểm tra cấu trúc thư mục của AgentHub.',
  },
  {
    id: 'sess-2',
    projectId: 'xfarm',
    title: 'Chia task cho dự án XFarm',
    mode: 'safe',
    busy: false,
    updatedAt: new Date(Date.now() - 7200000).toISOString(),
    lastMessage: 'Giai đoạn 1 của XFarm có thể chia thành 3 task nhỏ.',
  },
];

let mockChatMessages: Record<string, ChatMessage[]> = {
  'sess-1': [
    {
      id: 'msg-1',
      role: 'user',
      content: 'Kiến trúc AgentHub hoạt động thế nào?',
      createdAt: new Date(Date.now() - 3600000).toISOString(),
    },
    {
      id: 'msg-2',
      role: 'tool',
      content: '',
      meta: { name: 'Read docs/PLAN.md', summary: 'Đọc kiến trúc hệ thống' },
      createdAt: new Date(Date.now() - 3590000).toISOString(),
    },
    {
      id: 'msg-3',
      role: 'assistant',
      content: 'AgentHub là hệ thống điều phối tác vụ lập trình tự động với Claude Code và Antigravity.',
      meta: { durationMs: 4200, costUsd: 0.02, numTurns: 1 },
      createdAt: new Date(Date.now() - 3580000).toISOString(),
    },
  ],
  'sess-2': [
    {
      id: 'msg-201',
      role: 'user',
      content: 'Chia GĐ 1 của XFarm thành task nhỏ và giao việc',
      createdAt: new Date(Date.now() - 7200000).toISOString(),
    },
    {
      id: 'msg-202',
      role: 'assistant',
      content: 'Giai đoạn 1 của XFarm có thể chia thành 3 task nhỏ:\n1. Seed dữ liệu mẫu\n2. Cảm biến IoT\n3. Thanh toán',
      meta: { durationMs: 3500, costUsd: 0.015, numTurns: 1 },
      createdAt: new Date(Date.now() - 7190000).toISOString(),
    },
  ],
};

let mockEvents: EventItem[] = [
  {
    id: 101,
    ts: '2026-10-15 09:15:00',
    type: 'task.started',
    taskId: 'agenthub~a1-api',
    payload: { worker: 'chinh', model: 'claude-opus-4-6-thinking' },
  },
  {
    id: 102,
    ts: '2026-10-15 10:20:00',
    type: 'quota.marked',
    taskId: 'xfarm~iot-sync',
    payload: { profile: 'chinh', family: 'gemini-3.8-flash', duration: 1800 },
  },
  {
    id: 103,
    ts: '2026-10-15 11:30:00',
    type: 'task.review',
    taskId: 'agenthub~a2-web',
    payload: { status: 'review' },
  },
];

let mockTaskNotes: Array<{
  id: number;
  projectId: string;
  taskId: string;
  kind: 'note' | 'overlap';
  content: string;
  createdAt: string;
}> = [];

function checkAuth(request: Request): boolean {
  const auth = request.headers.get('Authorization');
  return !!auth && auth.startsWith('Bearer ');
}

export const handlers = [
  // GET /health
  http.get('/health', () => {
    return HttpResponse.json({ ok: true, version: '0.1.0' });
  }),

  // GET /api/version
  http.get('/api/version', ({ request }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return HttpResponse.json({
      version: '0.1.0',
      webBuildId: 'build-20261015-01',
    });
  }),

  // GET /api/status
  http.get('/api/status', ({ request }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const counts: Record<string, number> = {
      draft: 0,
      queued: 0,
      running: 0,
      checking: 0,
      review: 0,
      done: 0,
      blocked: 0,
      failed: 0,
      cancelled: 0,
      waiting_quota: 0,
    };

    for (const t of mockTasks) {
      if (counts[t.status] !== undefined) {
        counts[t.status]++;
      }
    }

    const running = mockTasks
      .filter((t) => t.status === 'running')
      .map((t) => {
        const lastRun = t.runs[t.runs.length - 1];
        const startedAt = lastRun?.startedAt || t.updatedAt;
        return {
          taskId: t.id,
          runId: lastRun?.id || 'run-1',
          profileName: lastRun?.profileName || 'chinh',
          model: lastRun?.model || 'claude-opus-4-6-thinking',
          engine: lastRun?.engine || 'agy',
          startedAt,
          elapsedMs: Date.now() - parseApiTime(startedAt),
          projectId: t.projectId,
          slug: t.slug,
          title: t.title,
        };
      });

    const status: HubStatus = {
      tasks: counts,
      profiles: mockProfiles,
      running,
      brain: mockBrain,
      tasksByStatus: counts as any,
      runningWorkers: running,
      recentEvents: [...mockEvents].reverse(),
    };

    return HttpResponse.json(status);
  }),

  // GET /api/brain
  http.get('/api/brain', ({ request }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return HttpResponse.json(mockBrain);
  }),

  // PUT /api/brain
  http.put('/api/brain', async ({ request }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const body = (await request.json()) as Partial<BrainStatus>;
    mockBrain = {
      ...mockBrain,
      ...body,
      updatedAt: new Date().toISOString(),
      stale: false,
    };
    return HttpResponse.json(mockBrain);
  }),

  // GET /api/projects
  http.get('/api/projects', ({ request }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return HttpResponse.json(mockProjects);
  }),

  // POST /api/git/inspect
  http.post('/api/git/inspect', async ({ request }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const body = (await request.json()) as any;
    const p = body?.path || '';
    if (!p) {
      return HttpResponse.json({ valid: false, error: 'empty_path', message: 'Đường dẫn không được để trống', branches: [] });
    }
    const parts = p.split(/[/\\]/).filter(Boolean);
    const suggestedName = parts.pop() || 'project';
    return HttpResponse.json({
      valid: true,
      suggestedName,
      defaultBranch: 'main',
      currentBranch: 'main',
      branches: ['main', 'develop', 'feature/test'],
      remoteUrl: `https://github.com/example/${suggestedName}.git`,
    });
  }),

  // POST /api/projects
  http.post('/api/projects', async ({ request }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const body = (await request.json()) as any;
    const newProject: Project = {
      id: body.name.toLowerCase().replace(/[^a-z0-9_-]/g, '-'),
      name: body.name,
      path: body.path,
      defaultBranch: body.defaultBranch || 'main',
      envTemplate: body.envTemplate || null,
      maxParallel: body.maxParallel || 3,
      hooks: body.hooks || null,
      createdAt: new Date().toISOString(),
    };
    mockProjects.push(newProject);
    return HttpResponse.json(newProject, { status: 201 });
  }),

  // PATCH /api/projects/:id
  http.patch('/api/projects/:id', async ({ params, request }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id } = params;
    const body = (await request.json()) as any;
    const project = mockProjects.find((p) => p.id === id);
    if (!project) {
      return HttpResponse.json({ error: 'Project not found' }, { status: 404 });
    }
    Object.assign(project, body);
    return HttpResponse.json(project);
  }),

  // DELETE /api/projects/:id
  http.delete('/api/projects/:id', ({ params, request }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id } = params;
    mockProjects = mockProjects.filter((p) => p.id !== id);
    return HttpResponse.json({ ok: true });
  }),

  // GET /api/projects/:id/notes
  http.get('/api/projects/:id/notes', ({ params, request }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id } = params;
    const url = new URL(request.url);
    const since = url.searchParams.get('since');
    const sinceId = since ? parseInt(since, 10) : undefined;
    let notes = mockTaskNotes.filter((n) => n.projectId === id);
    if (sinceId !== undefined && !isNaN(sinceId)) {
      notes = notes.filter((n) => n.id > sinceId);
    }
    return HttpResponse.json(notes);
  }),

  // POST /api/tasks/:id/notes
  http.post('/api/tasks/:id/notes', async ({ params, request }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id } = params;
    const taskId = String(id).replace(/~/g, '/');
    const body = (await request.json()) as { content: string; kind?: 'note' | 'overlap' };
    const projectId = taskId.split('/')[0] || 'default';
    const note = {
      id: mockTaskNotes.length + 1,
      projectId,
      taskId,
      kind: body.kind || ('note' as const),
      content: body.content,
      createdAt: new Date().toISOString(),
    };
    mockTaskNotes.push(note);
    return HttpResponse.json(note, { status: 201 });
  }),

  // GET /api/profiles
  http.get('/api/profiles', ({ request }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return HttpResponse.json(mockProfiles);
  }),

  // GET /api/usage/daily
  http.get('/api/usage/daily', ({ request }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const dates = [
      '2026-10-20',
      '2026-10-19',
      '2026-10-18',
      '2026-10-17',
      '2026-10-16',
      '2026-10-15',
      '2026-10-14',
      '2026-10-13',
    ];
    return HttpResponse.json({
      days: 7,
      timezone: 'Asia/Ho_Chi_Minh',
      dates,
      profiles: [
        {
          name: 'chinh',
          engine: 'agy',
          enabled: true,
          isIdle: false,
          quota: { gemini5h: 80, geminiWeek: 85, claude5h: 40, claudeWeek: 50 },
          quotaUsage: [],
          today: { runs: 3, durationMs: 180000, tokens: 65000 },
          totals: { runs: 12, durationMs: 720000, tokens: 280000 },
          daily: {
            '2026-10-20': { runs: 3, durationMs: 180000, tokens: 65000 },
            '2026-10-19': { runs: 2, durationMs: 120000, tokens: 45000 },
          },
        },
        {
          name: 'g1',
          engine: 'agy',
          enabled: true,
          isIdle: true,
          idleReason: 'Gemini 95%, Claude 80% · 0 run hôm nay',
          quota: { gemini5h: 95, geminiWeek: 95, claude5h: 80, claudeWeek: 85 },
          quotaUsage: [],
          today: { runs: 0, durationMs: 0, tokens: 0 },
          totals: { runs: 8, durationMs: 480000, tokens: 190000 },
          daily: {
            '2026-10-20': { runs: 0, durationMs: 0, tokens: 0 },
            '2026-10-19': { runs: 4, durationMs: 240000, tokens: 90000 },
          },
        },
        {
          name: 'g2',
          engine: 'agy',
          enabled: true,
          isIdle: true,
          idleReason: 'Gemini 90%, Claude 90% · 0 run hôm nay',
          quota: { gemini5h: 90, geminiWeek: 90, claude5h: 90, claudeWeek: 90 },
          quotaUsage: [],
          today: { runs: 0, durationMs: 0, tokens: 0 },
          totals: { runs: 5, durationMs: 300000, tokens: 120000 },
          daily: {
            '2026-10-20': { runs: 0, durationMs: 0, tokens: 0 },
          },
        },
        {
          name: 'g3',
          engine: 'agy',
          enabled: true,
          isIdle: false,
          idleReason: 'Đang bị khóa quota',
          quota: { gemini5h: 10, geminiWeek: 20, claude5h: 5, claudeWeek: 15 },
          quotaUsage: [],
          today: { runs: 1, durationMs: 60000, tokens: 25000 },
          totals: { runs: 6, durationMs: 360000, tokens: 150000 },
          daily: {
            '2026-10-20': { runs: 1, durationMs: 60000, tokens: 25000 },
          },
        },
        {
          name: 'codex',
          engine: 'codex',
          enabled: true,
          isIdle: true,
          idleReason: 'Codex sẵn sàng, ít việc hôm nay',
          quota: { gemini5h: null, geminiWeek: null, claude5h: null, claudeWeek: null },
          quotaUsage: [],
          today: { runs: 0, durationMs: 0, tokens: 0 },
          totals: { runs: 4, durationMs: 160000, tokens: 150000 },
          daily: {
            '2026-10-20': { runs: 0, durationMs: 0, tokens: 0 },
          },
        },
      ],
      byDay: dates.map((d, i) => ({
        date: d,
        isToday: i === 0,
        totalRuns: i === 0 ? 4 : 8,
        totalDurationMs: i === 0 ? 240000 : 480000,
        totalTokens: i === 0 ? 90000 : 180000,
        claudeTokens: i === 0 ? 35000 : 70000,
        profiles: [],
      })),
    });
  }),

  // POST /api/profiles
  http.post('/api/profiles', async ({ request }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const body = (await request.json()) as any;
    const newProfile: Profile = {
      name: body.name,
      engine: 'agy',
      kind: 'isolated',
      email: null,
      enabled: true,
      isBusy: false,
      duplicateEmailWith: [],
      quotaMarks: [],
    };
    mockProfiles.push(newProfile);
    return HttpResponse.json(newProfile, { status: 201 });
  }),

  // POST /api/profiles/:name/login
  http.post('/api/profiles/:name/login', ({ params, request }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { name } = params;
    const sessionId = `sess_${name}_${Math.random().toString(36).substring(2, 8)}`;
    return HttpResponse.json({ sessionId });
  }),

  // POST /api/profiles/:name/check
  http.post('/api/profiles/:name/check', ({ request }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return HttpResponse.json({ started: true }, { status: 202 });
  }),

  // PATCH /api/profiles/:name
  http.patch('/api/profiles/:name', async ({ params, request }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { name } = params;
    const body = (await request.json()) as any;
    const profile = mockProfiles.find((p) => p.name === name);
    if (!profile) {
      return HttpResponse.json({ error: 'Profile not found' }, { status: 404 });
    }
    if (typeof body.enabled !== 'undefined') {
      profile.enabled = !!body.enabled;
    }
    return HttpResponse.json(profile);
  }),

  // DELETE /api/profiles/:name/quota
  http.delete('/api/profiles/:name/quota', ({ params, request }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { name } = params;
    const profile = mockProfiles.find((p) => p.name === name);
    if (profile) {
      profile.quotaMarks = [];
    }
    return HttpResponse.json({ ok: true });
  }),

  // PATCH /api/claude/sessions/:id/auto-resume
  http.patch('/api/claude/sessions/:id/auto-resume', async ({ params, request }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const body = (await request.json()) as any;
    return HttpResponse.json({ sessionId: params.id, autoResumeEnabled: body?.enabled ? 1 : 0 });
  }),

  // GET /api/tasks
  http.get('/api/tasks', ({ request }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const url = new URL(request.url);
    const project = url.searchParams.get('project');
    const status = url.searchParams.get('status');

    let tasks = [...mockTasks];
    if (project) {
      tasks = tasks.filter((t) => t.projectId === project);
    }
    if (status) {
      tasks = tasks.filter((t) => t.status === status);
    }
    return HttpResponse.json(tasks);
  }),

  // GET /api/tasks/graph
  http.get('/api/tasks/graph', ({ request }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const url = new URL(request.url);
    const project = url.searchParams.get('project');
    const includeDone = url.searchParams.get('includeDone');

    let tasks = [...mockTasks];
    if (project && project !== 'all') {
      tasks = tasks.filter((t) => t.projectId === project);
    }

    const filtered = filterTasksForDag(tasks, {
      project: project || undefined,
      doneFilter: (includeDone as any) || 'active_chains',
    });
    const layout = layoutTaskDag(filtered);

    return HttpResponse.json({
      nodes: layout.nodes.map((n) => ({
        id: n.id,
        projectId: n.task.projectId,
        slug: n.task.slug,
        title: n.task.title,
        status: n.task.status,
        level: n.task.level,
        modelChain: Array.isArray(n.task.modelChain) ? n.task.modelChain : undefined,
        currentRun: n.task.currentRun,
        blockedCount: n.blockedCount,
        isCritical: n.isCritical,
        isMaxBlocker: n.isMaxBlocker,
      })),
      edges: layout.edges.map((e) => ({
        from: e.from,
        to: e.to,
        isCritical: e.isCritical,
      })),
      criticalPath: layout.criticalPath,
      maxBlockingTaskId: layout.maxBlockingTaskId,
      maxBlockedCount: layout.maxBlockedCount,
    });
  }),

  // POST /api/tasks
  http.post('/api/tasks', async ({ request }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const body = (await request.json()) as any;
    const id = `${body.project}~${body.slug}`;
    const newTask: TaskDetail = {
      id,
      projectId: body.project,
      slug: body.slug,
      title: body.title,
      body: body.body || '',
      level: body.level || 'easy',
      status: body.start ? 'queued' : 'draft',
      dependsOn: body.dependsOn || [],
      attempt: 0,
      resume: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      runs: [],
      reviews: [],
    };
    mockTasks.push(newTask);
    return HttpResponse.json(newTask, { status: 201 });
  }),

  // GET /api/tasks/:id
  http.get('/api/tasks/:id', ({ params, request }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id } = params;
    const task = mockTasks.find((t) => t.id === id);
    if (!task) {
      return HttpResponse.json({ error: 'Task not found' }, { status: 404 });
    }
    return HttpResponse.json(task);
  }),

  // PATCH /api/tasks/:id
  http.patch('/api/tasks/:id', async ({ params, request }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id } = params;
    const normalizedId = typeof id === 'string' && id.includes('~') ? id.replace('~', '/') : id;
    const task = mockTasks.find((t) => t.id === id || t.id === normalizedId);
    if (!task) {
      return HttpResponse.json({ error: 'not_found', message: `Task "${id}" không tồn tại` }, { status: 404 });
    }
    if (!['draft', 'queued', 'waiting_quota', 'failed'].includes(task.status)) {
      return HttpResponse.json(
        { error: 'conflict', message: `Chỉ có thể sửa task ở trạng thái draft, queued, waiting_quota hoặc failed (hiện tại: ${task.status})` },
        { status: 409 },
      );
    }
    const body = (await request.json()) as any;
    if (body.title !== undefined) task.title = body.title;
    if (body.level !== undefined) task.level = body.level;
    if (body.modelChain !== undefined) task.modelChain = body.modelChain;
    if (body.dependsOn !== undefined) task.dependsOn = body.dependsOn;
    if (body.body !== undefined) task.body = body.body;
    if (body.appendBody !== undefined) {
      task.body = task.body ? `${task.body}\n${body.appendBody}` : body.appendBody;
    }
    task.updatedAt = new Date().toISOString();
    return HttpResponse.json(task);
  }),

  // POST /api/tasks/:id/start
  http.post('/api/tasks/:id/start', ({ params, request }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id } = params;
    const task = mockTasks.find((t) => t.id === id);
    if (!task) {
      return HttpResponse.json({ error: 'not_found', message: `Task "${id}" không tồn tại` }, { status: 404 });
    }
    task.status = 'queued';
    task.updatedAt = new Date().toISOString();
    return HttpResponse.json(task);
  }),

  // POST /api/tasks/:id/cancel
  http.post('/api/tasks/:id/cancel', ({ params, request }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id } = params;
    const task = mockTasks.find((t) => t.id === id);
    if (!task) {
      return HttpResponse.json({ error: 'not_found', message: `Task "${id}" không tồn tại` }, { status: 404 });
    }
    task.status = 'cancelled';
    task.updatedAt = new Date().toISOString();
    return HttpResponse.json(task);
  }),

  // POST /api/tasks/:id/pause
  http.post('/api/tasks/:id/pause', ({ params, request }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id } = params;
    const task = mockTasks.find((t) => t.id === id);
    if (!task) {
      return HttpResponse.json({ error: 'not_found', message: `Task "${id}" không tồn tại` }, { status: 404 });
    }
    task.paused = true;
    task.pauseReason = 'manual';
    task.updatedAt = new Date().toISOString();
    return HttpResponse.json({ ok: true, paused: true });
  }),

  // POST /api/tasks/:id/resume
  http.post('/api/tasks/:id/resume', ({ params, request }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id } = params;
    const task = mockTasks.find((t) => t.id === id);
    if (!task) {
      return HttpResponse.json({ error: 'not_found', message: `Task "${id}" không tồn tại` }, { status: 404 });
    }
    task.paused = false;
    task.pauseReason = null;
    task.updatedAt = new Date().toISOString();
    return HttpResponse.json({ ok: true, paused: false });
  }),

  // POST /api/tasks/:id/review
  http.post('/api/tasks/:id/review', async ({ params, request }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id } = params;
    const body = (await request.json()) as any;
    const task = mockTasks.find((t) => t.id === id);
    if (!task) {
      return HttpResponse.json({ error: 'not_found', message: `Task "${id}" không tồn tại` }, { status: 404 });
    }
    if (body.verdict === 'approved') {
      task.status = 'done';
    } else if (body.verdict === 'changes_requested') {
      task.status = 'queued';
      task.resume += 1;
    }
    task.reviews.push({
      id: `rev-${Date.now()}`,
      taskId: task.id,
      verdict: body.verdict,
      feedback: body.feedback || null,
      createdAt: new Date().toISOString(),
    });
    task.updatedAt = new Date().toISOString();
    return HttpResponse.json(task);
  }),

  // POST /api/tasks/:id/retry
  http.post('/api/tasks/:id/retry', async ({ params, request }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id } = params;
    const task = mockTasks.find((t) => t.id === id);
    if (!task) {
      return HttpResponse.json({ error: 'not_found', message: `Task "${id}" không tồn tại` }, { status: 404 });
    }
    task.status = 'queued';
    task.attempt += 1;
    task.updatedAt = new Date().toISOString();
    return HttpResponse.json(task);
  }),

  // DELETE /api/tasks/:id/worktree
  http.delete('/api/tasks/:id/worktree', ({ params, request }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id } = params;
    const task = mockTasks.find((t) => t.id === id);
    if (task) {
      task.worktreePath = null;
    }
    return HttpResponse.json({ ok: true });
  }),

  // GET /api/tasks/:id/log
  http.get('/api/tasks/:id/log', ({ params, request }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const taskId = String(params.id || '');
    const sampleLog = `[2026-10-15 11:20:00] [agenthub] Khởi động worker cho task ${taskId}
[2026-10-15 11:20:02] [worker] Engine: agy, Model: claude-opus-4-6-thinking, Profile: chinh
[2026-10-15 11:20:05] [git] Checkout worktree tại ~/.agenthub/worktrees/${taskId}
[2026-10-15 11:20:10] [exec] Đọc hướng dẫn từ docs/tasks/${taskId.split('~')[1] || taskId}.md
[2026-10-15 11:20:25] [worker] Đang phân tích mã nguồn và thiết kế giải pháp...
[2026-10-15 11:21:00] [exec] npm run test -- --run
[2026-10-15 11:21:15] [exec] 10/10 tests passed!
[2026-10-15 11:21:30] [worker] Hoàn tất công việc, tạo báo cáo DONE.
[2026-10-15 11:21:32] [agenthub] Worker kết thúc với mã 0.`;

    return new HttpResponse(sampleLog, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }),

  // GET /api/config
  http.get('/api/config', ({ request }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return HttpResponse.json({
      modelChainHard: mockConfig.modelChainHard,
      modelChainEasy: mockConfig.modelChainEasy,
      defaultTimeout: mockConfig.defaultTimeout,
      // backwards-compatibility
      modelChains: mockConfig.modelChains,
      runTimeoutHours: mockConfig.runTimeoutHours,
      chat: mockConfig.chat,
    });
  }),

  // PUT /api/config
  http.put('/api/config', async ({ request }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const body = (await request.json()) as any;
    const modelChainHard = body.modelChainHard || body.modelChains?.hard || mockConfig.modelChainHard;
    const modelChainEasy = body.modelChainEasy || body.modelChains?.easy || mockConfig.modelChainEasy;
    const defaultTimeout =
      body.defaultTimeout !== undefined
        ? body.defaultTimeout
        : body.runTimeoutHours
        ? body.runTimeoutHours * 3600
        : mockConfig.defaultTimeout;

    const chat = body.chat ? { ...mockConfig.chat, ...body.chat } : mockConfig.chat;

    mockConfig = {
      modelChainHard,
      modelChainEasy,
      defaultTimeout,
      modelChains: {
        hard: modelChainHard,
        easy: modelChainEasy,
      },
      runTimeoutHours: Math.round(defaultTimeout / 3600),
      chat,
    };
    return HttpResponse.json({
      modelChainHard: mockConfig.modelChainHard,
      modelChainEasy: mockConfig.modelChainEasy,
      defaultTimeout: mockConfig.defaultTimeout,
      chat: mockConfig.chat,
    });
  }),

  // GET /api/models
  http.get('/api/models', ({ request }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return HttpResponse.json({
      suggestions: ['codex:gpt-5.6-luna', 'gemini-3.8-flash-high', 'gemini-3.8-flash-medium'],
      configured: [...new Set([...mockConfig.modelChainHard, ...mockConfig.modelChainEasy])],
    });
  }),

  // GET /api/models
  http.get('/api/models', ({ request }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return HttpResponse.json({
      suggestions: ['codex:gpt-5.6-luna', 'gemini-3.8-flash-high', 'gemini-3.8-flash-medium'],
      configured: [...new Set([...mockConfig.modelChainHard, ...mockConfig.modelChainEasy])],
    });
  }),

  // GET /api/chat/sessions
  http.get('/api/chat/sessions', ({ request }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const sorted = [...mockChatSessions].sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
    return HttpResponse.json(sorted);
  }),

  // POST /api/chat/sessions
  http.post('/api/chat/sessions', async ({ request }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const body = (await request.json()) as any;
    if (body.mode === 'full' && !mockConfig.chat?.allowFullMode) {
      return HttpResponse.json(
        { error: 'forbidden', message: 'Chế độ Đầy đủ chưa được bật trên máy chủ' },
        { status: 403 },
      );
    }
    const newSession: ChatSession = {
      id: `sess-${Date.now()}`,
      projectId: body.projectId || null,
      title: body.title?.trim() || 'Cuộc trò chuyện mới',
      mode: body.mode || 'safe',
      busy: false,
      updatedAt: new Date().toISOString(),
      lastMessage: null,
    };
    mockChatSessions.unshift(newSession);
    mockChatMessages[newSession.id] = [];
    return HttpResponse.json(newSession, { status: 201 });
  }),

  // PATCH /api/chat/sessions/:id
  http.patch('/api/chat/sessions/:id', async ({ params, request }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id } = params;
    const body = (await request.json()) as any;
    const session = mockChatSessions.find((s) => s.id === id);
    if (!session) {
      return HttpResponse.json({ error: 'Session not found' }, { status: 404 });
    }
    if (body.title) {
      session.title = body.title.trim();
    }
    session.updatedAt = new Date().toISOString();
    return HttpResponse.json(session);
  }),

  // DELETE /api/chat/sessions/:id
  http.delete('/api/chat/sessions/:id', ({ params, request }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id } = params;
    const session = mockChatSessions.find((s) => s.id === id);
    if (!session) {
      return HttpResponse.json({ error: 'Session not found' }, { status: 404 });
    }
    if (session.busy) {
      return HttpResponse.json(
        { error: 'conflict', message: 'Không thể xóa phiên đang bận' },
        { status: 409 },
      );
    }
    mockChatSessions = mockChatSessions.filter((s) => s.id !== id);
    delete mockChatMessages[id as string];
    return HttpResponse.json({ ok: true });
  }),

  // GET /api/chat/sessions/:id/messages
  http.get('/api/chat/sessions/:id/messages', ({ params, request }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id } = params;
    const messages = mockChatMessages[id as string] || [];
    return HttpResponse.json(messages);
  }),

  // POST /api/chat/sessions/:id/messages
  http.post('/api/chat/sessions/:id/messages', async ({ params, request }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id } = params;
    const session = mockChatSessions.find((s) => s.id === id);
    if (!session) {
      return HttpResponse.json({ error: 'Session not found' }, { status: 404 });
    }
    if (session.busy) {
      return HttpResponse.json(
        { error: 'conflict', message: 'Claude đang trả lời' },
        { status: 409 },
      );
    }
    const body = (await request.json()) as any;
    const text = body.text || '';
    session.busy = true;
    session.lastMessage = text;
    session.updatedAt = new Date().toISOString();

    const userMessageId = `msg-${Date.now()}`;
    const assistantMessageId = `msg-${Date.now() + 1}`;

    const userMsg: ChatMessage = {
      id: userMessageId,
      role: 'user',
      content: text,
      createdAt: new Date().toISOString(),
    };
    if (!mockChatMessages[session.id]) {
      mockChatMessages[session.id] = [];
    }
    mockChatMessages[session.id].push(userMsg);

    return HttpResponse.json(
      { userMessageId, assistantMessageId },
      { status: 202 },
    );
  }),

  // POST /api/chat/sessions/:id/cancel
  http.post('/api/chat/sessions/:id/cancel', ({ params, request }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id } = params;
    const session = mockChatSessions.find((s) => s.id === id);
    if (session) {
      session.busy = false;
      session.updatedAt = new Date().toISOString();
    }
    return HttpResponse.json({ ok: true });
  }),

  // --- Batches API ---
  // GET /api/batches
  http.get('/api/batches', ({ request }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const url = new URL(request.url);
    const project = url.searchParams.get('project');
    const status = url.searchParams.get('status');

    let result = mockBatches.map((b) => ({
      ...b,
      tasks: mockTasks.filter((t) => t.batchId === b.id),
    }));

    if (project) {
      result = result.filter((b) => b.projectId === project);
    }
    if (status) {
      result = result.filter((b) => b.status === status);
    }

    return HttpResponse.json(result);
  }),

  // GET /api/batches/:id
  http.get('/api/batches/:id', ({ params, request }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id } = params;
    const batch = mockBatches.find((b) => b.id === id);
    if (!batch) {
      return HttpResponse.json({ error: 'not_found', message: 'Batch không tồn tại' }, { status: 404 });
    }
    const tasks = mockTasks.filter((t) => t.batchId === batch.id);
    return HttpResponse.json({ ...batch, tasks });
  }),

  // POST /api/batches
  http.post('/api/batches', async ({ request }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const body = (await request.json()) as any;
    const newBatch: TaskBatch = {
      id: `batch-${Date.now()}`,
      projectId: body.project,
      title: body.title,
      goal: body.goal || null,
      status: 'draft',
      createdBy: body.createdBy || 'user',
      createdAt: new Date().toISOString(),
    };
    mockBatches.unshift(newBatch);

    const createdTasks: TaskDetail[] = (body.tasks || []).map((t: any) => {
      const taskDetail: TaskDetail = {
        id: `${body.project}~${t.slug}`,
        projectId: body.project,
        slug: t.slug,
        title: t.title,
        body: t.body || null,
        level: t.level || 'easy',
        status: 'draft',
        modelChain: t.modelChain || null,
        dependsOn: t.dependsOn || [],
        batchId: newBatch.id,
        attempt: 0,
        resume: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        runs: [],
        reviews: [],
      };
      mockTasks.unshift(taskDetail);
      return taskDetail;
    });

    return HttpResponse.json({ ...newBatch, tasks: createdTasks }, { status: 201 });
  }),

  // POST /api/batches/:id/dispatch
  http.post('/api/batches/:id/dispatch', ({ params, request }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id } = params;
    const batch = mockBatches.find((b) => b.id === id);
    if (!batch) {
      return HttpResponse.json({ error: 'not_found', message: 'Batch không tồn tại' }, { status: 404 });
    }
    if (batch.status !== 'draft') {
      return HttpResponse.json(
        { error: 'conflict', message: 'Chỉ có thể giao đợt ở trạng thái draft' },
        { status: 409 },
      );
    }

    const batchTasks = mockTasks.filter((t) => t.batchId === batch.id);
    const slugMap = new Map<string, string[]>();
    for (const t of batchTasks) {
      const deps = Array.isArray(t.dependsOn) ? t.dependsOn : t.dependsOn ? [t.dependsOn] : [];
      slugMap.set(t.slug, deps);
    }
    const visited = new Set<string>();
    const recStack = new Set<string>();
    let hasCycle = false;
    const checkCycle = (node: string): boolean => {
      visited.add(node);
      recStack.add(node);
      for (const dep of slugMap.get(node) || []) {
        if (!visited.has(dep)) {
          if (checkCycle(dep)) return true;
        } else if (recStack.has(dep)) {
          return true;
        }
      }
      recStack.delete(node);
      return false;
    };
    for (const slug of slugMap.keys()) {
      if (!visited.has(slug)) {
        if (checkCycle(slug)) {
          hasCycle = true;
          break;
        }
      }
    }
    if (hasCycle) {
      return HttpResponse.json(
        { error: 'cycle_detected', message: 'Phát hiện vòng phụ thuộc trong đợt' },
        { status: 400 },
      );
    }

    batch.status = 'dispatched';
    let count = 0;
    for (const t of batchTasks) {
      if (t.status === 'draft') {
        t.status = 'queued';
        t.updatedAt = new Date().toISOString();
        count++;
      }
    }
    return HttpResponse.json({ ok: true, dispatchedCount: count });
  }),

  // POST /api/batches/:id/discard
  http.post('/api/batches/:id/discard', ({ params, request }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id } = params;
    const batch = mockBatches.find((b) => b.id === id);
    if (!batch) {
      return HttpResponse.json({ error: 'not_found', message: 'Batch không tồn tại' }, { status: 404 });
    }
    batch.status = 'discarded';
    return HttpResponse.json({ ok: true });
  }),

  // POST /api/batches/:id/tasks
  http.post('/api/batches/:id/tasks', async ({ params, request }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id } = params;
    const batch = mockBatches.find((b) => b.id === id);
    if (!batch) {
      return HttpResponse.json({ error: 'not_found', message: 'Batch không tồn tại' }, { status: 404 });
    }
    const body = (await request.json()) as any;
    const newTask: TaskDetail = {
      id: `${batch.projectId}~${body.slug}`,
      projectId: batch.projectId,
      slug: body.slug,
      title: body.title,
      body: body.body || null,
      level: body.level || 'easy',
      status: 'draft',
      modelChain: body.modelChain || null,
      dependsOn: body.dependsOn || [],
      batchId: batch.id,
      attempt: 0,
      resume: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      runs: [],
      reviews: [],
    };
    mockTasks.unshift(newTask);
    return HttpResponse.json(newTask, { status: 201 });
  }),

  // DELETE /api/batches/:id/tasks/:taskId
  http.delete('/api/batches/:id/tasks/:taskId', ({ params, request }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { taskId } = params;
    const idx = mockTasks.findIndex((t) => t.id === taskId || t.slug === taskId);
    if (idx !== -1) {
      mockTasks.splice(idx, 1);
    }
    return HttpResponse.json({ ok: true });
  }),

  // DELETE /api/tasks/:id
  http.delete('/api/tasks/:id', ({ params, request }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id } = params;
    const idx = mockTasks.findIndex((t) => t.id === id);
    if (idx !== -1) {
      mockTasks.splice(idx, 1);
    }
    return HttpResponse.json({ ok: true });
  }),

  // POST /api/chat/sessions/:id/compact
  http.post('/api/chat/sessions/:id/compact', ({ params, request }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id } = params;
    const session = mockChatSessions.find((s) => s.id === id);
    if (!session) {
      return HttpResponse.json({ error: 'Session not found' }, { status: 404 });
    }
    session.contextTokens = 20000;
    session.updatedAt = new Date().toISOString();
    const systemMsg = {
      id: `msg-${Date.now()}`,
      sessionId: session.id,
      role: 'system',
      content: 'Đã nén ngữ cảnh',
      createdAt: new Date().toISOString(),
    };
    if (!mockChatMessages[session.id]) {
      mockChatMessages[session.id] = [];
    }
    mockChatMessages[session.id].push(systemMsg as any);
    return HttpResponse.json({ ok: true, contextTokens: 20000 });
  }),

  // POST /api/chat/sessions/:id/fork-summary
  http.post('/api/chat/sessions/:id/fork-summary', ({ params, request }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id } = params;
    const session = mockChatSessions.find((s) => s.id === id);
    if (!session) {
      return HttpResponse.json({ error: 'Session not found' }, { status: 404 });
    }
    const newSession = {
      id: `cs-${Date.now()}`,
      title: `${session.title} (tóm tắt)`,
      mode: session.mode,
      busy: false,
      updatedAt: new Date().toISOString(),
      lastMessage: 'Tóm tắt phiên trước...',
    };
    mockChatSessions.unshift(newSession);
    mockChatMessages[newSession.id] = [
      {
        id: `msg-${Date.now()}`,
        sessionId: newSession.id,
        role: 'user',
        content: 'Tóm tắt phiên trước...',
        createdAt: new Date().toISOString(),
      } as any,
    ];
    return HttpResponse.json({ id: newSession.id, sessionId: newSession.id }, { status: 201 });
  }),
  // POST /api/chat/sessions/:id/compact
  http.post('/api/chat/sessions/:id/compact', ({ params, request }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id } = params;
    const session = mockChatSessions.find((s) => s.id === id);
    if (!session) {
      return HttpResponse.json({ error: 'Session not found' }, { status: 404 });
    }
    session.contextTokens = 20000;
    session.updatedAt = new Date().toISOString();
    const systemMsg = {
      id: `msg-${Date.now()}`,
      sessionId: session.id,
      role: 'system',
      content: 'Đã nén ngữ cảnh',
      createdAt: new Date().toISOString(),
    };
    if (!mockChatMessages[session.id]) {
      mockChatMessages[session.id] = [];
    }
    mockChatMessages[session.id].push(systemMsg as any);
    return HttpResponse.json({ ok: true, contextTokens: 20000 });
  }),

  // POST /api/chat/sessions/:id/fork-summary
  http.post('/api/chat/sessions/:id/fork-summary', ({ params, request }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id } = params;
    const session = mockChatSessions.find((s) => s.id === id);
    if (!session) {
      return HttpResponse.json({ error: 'Session not found' }, { status: 404 });
    }
    const newSession = {
      id: `cs-${Date.now()}`,
      title: `${session.title} (tóm tắt)`,
      mode: session.mode,
      busy: false,
      updatedAt: new Date().toISOString(),
      lastMessage: 'Tóm tắt phiên trước...',
    };
    mockChatSessions.unshift(newSession);
    mockChatMessages[newSession.id] = [
      {
        id: `msg-${Date.now()}`,
        sessionId: newSession.id,
        role: 'user',
        content: 'Tóm tắt phiên trước...',
        createdAt: new Date().toISOString(),
      } as any,
    ];
    return HttpResponse.json({ id: newSession.id, sessionId: newSession.id }, { status: 201 });
  }),
];
