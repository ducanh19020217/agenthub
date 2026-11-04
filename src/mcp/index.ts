import fs from 'node:fs';
import { hubVersion } from '../version.js';
import { execFile } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getTokenPath, readExistingToken } from '../auth.js';
import { toRouteId, toTaskId } from '../services/index.js';
import { formatRunnableCapacity, QuotaCapacitySnapshot } from '../quota/index.js';

export class DaemonDownError extends Error {
  constructor(message = 'AgentHub daemon chưa chạy: `agenthub install-service` hoặc `agenthub daemon`') {
    super(message);
    this.name = 'DaemonDownError';
  }
}

export function handleError(err: unknown): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  const errorObj = err as { name?: string; message?: string; code?: string; cause?: { code?: string } } | undefined;
  if (
    err instanceof DaemonDownError ||
    errorObj?.code === 'ECONNREFUSED' ||
    errorObj?.cause?.code === 'ECONNREFUSED' ||
    errorObj?.message?.includes('fetch failed') ||
    errorObj?.message?.includes('ECONNREFUSED')
  ) {
    return {
      content: [{
        type: 'text',
        text: 'AgentHub daemon chưa chạy: `agenthub install-service` hoặc `agenthub daemon`',
      }],
      isError: true,
    };
  }
  return {
    content: [{
      type: 'text',
      text: `Lỗi: ${errorObj?.message || String(err)}`,
    }],
    isError: true,
  };
}

export function formatElapsed(ms: number): string {
  if (ms < 60000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hours}h${remMins}m`;
}

export function formatUntil(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function formatProfileSummary(p: {
  name: string;
  engine: string;
  enabled: boolean | number;
  duplicateWarning?: boolean;
  quotaMarks?: Array<{ family: string; until: number }>;
  usage?: Array<{ grp: string; window: string; remainingPct: number; resetAt: number }>;
  slotsUsed?: number;
  slotsTotal?: number;
  authState?: string | null;
  authMessage?: string | null;
  verifyUrl?: string | null;
}): string {
  if (!p.enabled) return `${p.name}(tắt)`;
  if (p.authState === 'needs_verification') {
    return `${p.name}(cần xác minh)`;
  }
  if (p.authState === 'not_logged_in') {
    return `${p.name}(chưa đăng nhập)`;
  }
  if (p.authState === 'error') {
    return `${p.name}(lỗi xác thực)`;
  }
  const marks = p.quotaMarks || [];
  if (p.engine === 'codex') {
    const mark = marks.find((m) => m.family === 'codex');
    return `${p.name}(codex${mark ? `✗→${formatUntil(mark.until)}` : '✓'})`;
  }
  // agy
  const gMark = marks.find((m) => m.family === 'gemini');
  const cMark = marks.find((m) => m.family === 'claude');
  const gStr = gMark ? `gemini✗→${formatUntil(gMark.until)}` : 'gemini✓';
  const cStr = cMark ? `claude✗→${formatUntil(cMark.until)}` : 'claude✓';
  const otherMarks = marks.filter((m) => m.family !== 'gemini' && m.family !== 'claude');
  const otherStr = otherMarks.map((m) => ` ${m.family}✗→${formatUntil(m.until)}`).join('');
  const usage = p.usage || [];
  const usageStr = usage.length
    ? ` ${usage.map((u) => `${u.grp.startsWith('Gemini') ? 'gemini' : 'claude'} ${u.window} còn ${u.remainingPct}% (reset ${formatUntil(u.resetAt)})`).join(' · ')}`
    : ' chưa có số liệu';
  const slots = p.slotsTotal ? ` · slots ${p.slotsUsed || 0}/${p.slotsTotal}` : '';
  let res = `${p.name}(${gStr} ${cStr}${otherStr}${usageStr}${slots})`;
  if (p.duplicateWarning) {
    res += '⚠️trùng';
  }
  return res;
}

function formatBestQuotaLine(
  profiles: Array<{ name: string; usage?: Array<{ grp: string; window: string; remainingPct: number }> }>,
  family: 'gemini' | 'claude',
): string {
  const groupPrefix = family === 'gemini' ? 'Gemini' : 'Claude';
  const values = profiles.flatMap((p) => (p.usage || [])
    .filter((u) => u.window === '5h' && (family === 'gemini' ? u.grp.startsWith('Gemini') : !u.grp.startsWith('Gemini')))
    .map((u) => ({ name: p.name, remainingPct: u.remainingPct })));
  if (!values.length) return `Nhiều quota ${groupPrefix} 5h nhất: chưa có số liệu`;
  const best = Math.max(...values.map((v) => v.remainingPct));
  const names = values.filter((v) => v.remainingPct === best).map((v) => v.name);
  return `Nhiều quota ${groupPrefix} 5h nhất: ${names.join(', ')} (còn ${best}%)`;
}

export interface McpServerOptions {
  port?: number;
  token?: string;
  baseUrl?: string;
  tokenPath?: string;
  chatSessionId?: string;
  projectId?: string;
}

export function createMcpServer(options?: McpServerOptions): McpServer {
  const server = new McpServer({
    name: 'agenthub',
    version: hubVersion(),
  });

  const getPort = (): number => {
    if (options?.port) return options.port;
    return parseInt(process.env.AGENTHUB_PORT || '7700', 10);
  };

  const getBaseUrl = (): string => {
    if (options?.baseUrl) return options.baseUrl;
    return `http://127.0.0.1:${getPort()}`;
  };

  const getToken = (): string => {
    if (options?.token) return options.token;
    const token = readExistingToken(options?.tokenPath || getTokenPath());
    if (!token) {
      throw new DaemonDownError();
    }
    return token;
  };

  const scopedProject = (): string | undefined => options?.projectId || process.env.AGENTHUB_MCP_PROJECT || undefined;
  const assistantSession = (): boolean => (process.env.AGENTHUB_CHAT_KIND || '') === 'assistant';
  const assertAssistantAllowed = (toolName: string): void => {
    if (assistantSession() && ['hub_review', 'hub_dispatch_batch', 'hub_request_secret'].includes(toolName)) {
      throw new Error(`Trợ lý không được gọi ${toolName}; việc này thuộc về bộ não`);
    }
  };
  const assertSetupWriteAllowed = (toolName: string, dryRun: boolean | undefined): void => {
    if (assistantSession() && dryRun === false) throw new Error(`Trợ lý guarded chỉ được dryRun với ${toolName}`);
  };
  const assertProject = (projectId: string | undefined, action: string): void => {
    const scope = scopedProject();
    if (scope && projectId !== scope) throw new Error(`${action} chỉ được phép trong project "${scope}"`);
  };
  const assertTaskId = (id: string, action: string): void => {
    const scope = scopedProject();
    if (!scope) return;
    const taskId = id.replace('~', '/');
    if (!taskId.startsWith(`${scope}/`)) throw new Error(`${action} chỉ được phép trong project "${scope}"`);
  };

  async function callApi<T>(method: string, apiPath: string, body?: unknown, timeoutMs?: number): Promise<T> {
    const token = getToken();
    const port = getPort();
    const url = `${getBaseUrl()}${apiPath}`;

    let res: Response;
    try {
      const signal = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined;
      res = await fetch(url, {
        method,
        headers: {
          Host: `127.0.0.1:${port}`,
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal,
      });
    } catch (err: unknown) {
      const errorObj = err as { code?: string; cause?: { code?: string }; message?: string } | undefined;
      if (
        errorObj?.code === 'ECONNREFUSED' ||
        errorObj?.cause?.code === 'ECONNREFUSED' ||
        errorObj?.message?.includes('fetch failed')
      ) {
        throw new DaemonDownError();
      }
      throw err;
    }

    if (!res.ok) {
      let errBody: { error?: string; message?: string } = {};
      try {
        errBody = (await res.json()) as { error?: string; message?: string };
      } catch {
        // ignore non-json
      }
      throw new Error(errBody.message || res.statusText);
    }

    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  server.tool(
    'permission_prompt',
    'Yêu cầu người dùng duyệt một lần chạy công cụ trong chat safe mode',
    {
      tool_name: z.string(),
      input: z.record(z.unknown()),
    },
    async (args) => {
      try {
        const sessionId = options?.chatSessionId || process.env.AGENTHUB_CHAT_SESSION_ID;
        if (!sessionId) return { content: [{ type: 'text', text: JSON.stringify({ behavior: 'deny', message: 'Thiếu phiên chat' }) }] };
        const result = await callApi<{ behavior: 'allow' | 'deny'; updatedInput?: Record<string, unknown>; message?: string }>(
          'POST', '/api/chat/permissions', { sessionId, tool_name: args.tool_name, input: args.input },
          (Number(process.env.AGENTHUB_PERMISSION_TIMEOUT_SEC) || 600) * 1000 + 30_000,
        );
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err: unknown) {
        return { content: [{ type: 'text', text: JSON.stringify({ behavior: 'deny', message: err instanceof Error ? err.message : String(err) }) }] };
      }
    },
  );

  // 1. hub_status
  server.tool(
    'hub_status',
    'Xem tổng quan hệ thống AgentHub: số lượng task theo trạng thái, các task đang chạy, và trạng thái hồ sơ',
    {},
    async () => {
      try {
        const data = await callApi<{
          tasks: Record<string, number>;
          waitingReasons?: Record<string, number>;
          running: Array<{
            taskId: string;
            runId: string;
            profileName: string;
            model: string;
            engine: string;
            elapsedMs: number;
            title?: string;
            projectId?: string;
            slug?: string;
            worktreePath?: string | null;
          }>;
          profiles: Array<{
            name: string;
            engine: string;
            enabled: boolean | number;
            duplicateWarning?: boolean;
            quotaMarks?: Array<{ family: string; until: number }>;
            usage?: Array<{ grp: string; window: string; remainingPct: number; resetAt: number }>;
            slotsUsed?: number;
            slotsTotal?: number;
          }>;
          quotaCapacity?: QuotaCapacitySnapshot;
        }>('GET', '/api/status');

        const lines: string[] = [];
        const tasks = data.tasks || {};
        const waitingCount = tasks.waiting_quota || 0;
        let waitingSummary = `chờ quota ${waitingCount}`;
        if (waitingCount > 0 && data.waitingReasons) {
          const reasonLabels: Record<string, string> = {
            disk: 'đĩa',
            quota: 'quota',
            slot: 'slot',
            parallel: 'slot',
            department_parallel: 'slot phòng ban',
            load: 'tải máy',
            dependency: 'phụ thuộc',
            profile_busy: 'tài khoản bận',
            no_department_profile: 'thiếu tài khoản phòng ban',
            no_matching_profile: 'thiếu tài khoản phù hợp',
            project_unavailable: 'dự án không truy cập được',
            focus: 'tập trung dự án khác',
          };
          const entries = Object.entries(data.waitingReasons).filter(([, count]) => count > 0);
          if (entries.length === 1) {
            const [reason, count] = entries[0];
            const label = reasonLabels[reason] || reason;
            waitingSummary = `chờ ${label} ${count}`;
          } else if (entries.length > 1) {
            const parts = entries.map(([reason, count]) => `${count} ${reasonLabels[reason] || reason}`);
            waitingSummary = `đang chờ ${waitingCount} (${parts.join(', ')})`;
          }
        }
        lines.push(
          `Đang chạy ${tasks.running || 0}${tasks.checking ? ` · đang kiểm tra ${tasks.checking}` : ''} · chờ review ${tasks.review || 0} · ${waitingSummary} · lỗi ${tasks.failed || 0}`,
        );

        if (data.quotaCapacity) {
          if (data.quotaCapacity.runnable.length === 0) {
            const next = data.quotaCapacity.nextReset;
            const resetStr = next ? ` (sớm nhất: ${next.profileName}/${next.model})` : '';
            lines.push(`🚨 Hết sạch quota ở mọi tài khoản và model — Hệ thống tạm dừng thực thi task${resetStr}`);
          } else {
            const hasMarks = (data.profiles || []).some((p) => (p.quotaMarks || []).length > 0);
            if (hasMarks) {
              lines.push(`Quota: Vẫn chạy bằng ${formatRunnableCapacity(data.quotaCapacity)}`);
            }
          }
        }

        lines.unshift(formatBestQuotaLine(data.profiles || [], 'claude'));
        lines.unshift(formatBestQuotaLine(data.profiles || [], 'gemini'));

        if (data.running && data.running.length > 0) {
          for (const r of data.running) {
            const titlePart = r.title ? ` (${r.title})` : '';
            lines.push(`- ${r.taskId}${titlePart} [running] ${r.model}@${r.profileName} ${formatElapsed(r.elapsedMs)}`);
          }
        }

        if (data.profiles && data.profiles.length > 0) {
          const pSummaries = data.profiles.map((p) => formatProfileSummary(p));
          lines.push(`Hồ sơ: ${pSummaries.join(' ')}`);
        }

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
        };
      } catch (err: unknown) {
        return handleError(err);
      }
    },
  );

  // hub_brain
  server.tool(
    'hub_brain',
    'Cập nhật trạng thái của Claude (bộ não điều phối)',
    {
      activity: z
        .enum([
          'planning',
          'dispatching',
          'reviewing',
          'merging',
          'deploying',
          'waiting',
          'idle',
          'talking',
        ])
        .describe(
          'Hoạt động hiện tại của Claude (planning, dispatching, reviewing, merging, deploying, waiting, idle, talking)',
        ),
      detail: z.string().max(300).describe('Chi tiết hoạt động (tối đa 300 ký tự)'),
      taskId: z.string().optional().describe('ID của task liên quan nếu có'),
    },
    async (args) => {
      try {
        const res = await callApi<{
          activity: string;
          detail: string;
          taskId?: string | null;
          updatedAt: string;
          stale: boolean;
        }>('PUT', '/api/brain', {
          activity: args.activity,
          detail: args.detail,
          taskId: args.taskId || null,
        });

        return {
          content: [
            {
              type: 'text',
              text: `✓ Đã cập nhật trạng thái Claude: [${res.activity}] ${res.detail}${res.taskId ? ` (task: ${res.taskId})` : ''}`,
            },
          ],
        };
      } catch (err: unknown) {
        return handleError(err);
      }
    },
  );

  // 2. hub_projects
  server.tool(
    'hub_notify',
    'Bộ não nhắn thông báo cho người dùng qua Telegram và dashboard',
    {
      text: z.string().min(1).max(4000),
      level: z.enum(['info', 'decision', 'incident']).default('info'),
    },
    async (args) => {
      try {
        const res = await callApi<{ text: string; level: string }>('POST', '/api/brain/notify', args);
        return { content: [{ type: 'text', text: `✓ Đã gửi thông báo (${res.level})` }] };
      } catch (err: unknown) {
        return handleError(err);
      }
    },
  );

  // 2. hub_projects
  server.tool(
    'hub_projects',
    'Xem danh sách các project đã đăng ký trong AgentHub',
    {},
    async () => {
      try {
        const projects = await callApi<
          Array<{
            id: string;
            name: string;
            path: string;
            defaultBranch?: string;
            maxParallel: number;
          }>
        >('GET', '/api/projects');

        const visibleProjects = scopedProject() ? projects.filter((project) => project.id === scopedProject()) : projects;
        if (visibleProjects.length === 0) {
          return { content: [{ type: 'text', text: 'Chưa có project nào được đăng ký.' }] };
        }
        const lines = [`Projects (${visibleProjects.length}):`];
        for (const p of visibleProjects) {
          lines.push(
            `- ${p.id} (${p.name}): ${p.path} (defaultBranch: ${p.defaultBranch || 'main'}, maxParallel: ${p.maxParallel})`,
          );
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (err: unknown) {
        return handleError(err);
      }
    },
  );

  // 3. hub_register_project
  server.tool(
    'hub_register_project',
    'Đăng ký project mới vào AgentHub',
    {
      name: z.string().describe('Tên project'),
      path: z.string().describe('Đường dẫn git repository của project'),
      defaultBranch: z.string().optional().describe('Nhánh mặc định (mặc định: main)'),
      envTemplate: z.string().optional().describe('JSON template biến môi trường theo task nếu có'),
      maxParallel: z.number().int().positive().optional().describe('Số task chạy đồng thời tối đa (mặc định: 3)'),
    },
    async (args) => {
      try {
        if (scopedProject()) throw new Error(`hub_register_project không được phép từ brain của project "${scopedProject()}"`);
        let envTemplateObj: unknown = undefined;
        if (args.envTemplate) {
          try {
            envTemplateObj = JSON.parse(args.envTemplate);
          } catch {
            envTemplateObj = args.envTemplate;
          }
        }
        const res = await callApi<{ id: string; name: string; path: string }>('POST', '/api/projects', {
          name: args.name,
          path: args.path,
          defaultBranch: args.defaultBranch,
          envTemplate: envTemplateObj,
          maxParallel: args.maxParallel,
        });
        return {
          content: [
            { type: 'text', text: `✓ Đã đăng ký project "${res.name}" (id: ${res.id}) tại ${res.path}` },
          ],
        };
      } catch (err: unknown) {
        return handleError(err);
      }
    },
  );

  server.tool(
    'hub_knowledge',
    'Quản lý sổ kiến thức của project (list/add/update/delete)',
    {
      action: z.enum(['list', 'add', 'update', 'delete']),
      project: z.string().min(1),
      id: z.number().int().positive().optional(),
      content: z.string().min(1).optional(),
      taskId: z.string().optional(),
      pinned: z.boolean().optional(),
    },
    async (args) => {
      try {
        const base = `/api/projects/${encodeURIComponent(args.project)}/knowledge`;
        if (args.action === 'list') {
          const entries = await callApi<Array<{ id: number; taskId: string; content: string; pinned: number }>>('GET', base);
          return { content: [{ type: 'text', text: entries.length ? entries.map((e) => `- [${e.pinned ? 'ghim' : 'mới'}] #${e.id} (${e.taskId}): ${e.content}`).join('\n') : 'Sổ kiến thức đang trống.' }] };
        }
        if (!args.id && args.action !== 'add') throw new Error('id là bắt buộc');
        if (args.action === 'add') {
          const entry = await callApi<{ id: number }>('POST', base, { content: args.content, taskId: args.taskId, pinned: args.pinned });
          return { content: [{ type: 'text', text: `✓ Đã thêm mục kiến thức #${entry.id}.` }] };
        }
        if (args.action === 'update') {
          await callApi('PATCH', `${base}/${args.id}`, { content: args.content, pinned: args.pinned });
          return { content: [{ type: 'text', text: `✓ Đã cập nhật mục kiến thức #${args.id}.` }] };
        }
        await callApi('DELETE', `${base}/${args.id}`);
        return { content: [{ type: 'text', text: `✓ Đã xoá mục kiến thức #${args.id}.` }] };
      } catch (err: unknown) {
        return handleError(err);
      }
    },
  );

  // 4. hub_profiles
  server.tool(
    'hub_profiles',
    'Xem danh sách tài khoản hồ sơ, quota marks, và cảnh báo trùng email',
    {},
    async () => {
      try {
        const profiles = await callApi<
          Array<{
            name: string;
            engine: string;
            enabled: boolean | number;
            email?: string | null;
            busy?: boolean;
            duplicateWarning?: boolean;
            quotaMarks?: Array<{ family: string; until: number }>;
            usage?: Array<{ grp: string; window: string; remainingPct: number; resetAt: number }>;
            authState?: string | null;
            authMessage?: string | null;
            verifyUrl?: string | null;
          }>
        >('GET', '/api/profiles');

        if (profiles.length === 0) {
          return { content: [{ type: 'text', text: 'Chưa có hồ sơ nào.' }] };
        }
        const lines = [
          formatBestQuotaLine(profiles, 'gemini'),
          formatBestQuotaLine(profiles, 'claude'),
          `Hồ sơ (${profiles.length}):`,
        ];
        for (const p of profiles) {
          const dupeStr = p.duplicateWarning ? ' ⚠️ (trùng email)' : '';
          const marks = (p.quotaMarks || []).map((m) => `${m.family} đến ${formatUntil(m.until)}`);
          const marksStr = marks.length ? ` [Quota: ${marks.join(', ')}]` : '';
          let authStr = '';
          if (p.authState === 'needs_verification') {
            authStr = ` [Cần xác minh${p.verifyUrl ? `: ${p.verifyUrl}` : ''}]`;
          } else if (p.authState === 'not_logged_in') {
            authStr = ' [Chưa đăng nhập]';
          } else if (p.authState === 'error') {
            authStr = ` [Lỗi xác thực${p.authMessage ? `: ${p.authMessage}` : ''}]`;
          }
          lines.push(`- ${p.name} [${p.engine}]: ${formatProfileSummary(p)}${authStr}${marksStr}${dupeStr}`);
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (err: unknown) {
        return handleError(err);
      }
    },
  );

  // 5. hub_create_task
  server.tool(
    'hub_tracker_sync',
    'Chạy ngay một lượt đồng bộ ticket OpenProject cho một nguồn',
    { sourceId: z.string().min(1) },
    async (args) => {
      try {
        const result = await callApi<{ imported: number; comments: number }>('POST', `/api/integrations/openproject/sources/${encodeURIComponent(args.sourceId)}/sync`);
        return { content: [{ type: 'text', text: `✓ Đã đồng bộ nguồn ${args.sourceId}: ${result.imported} task mới, ${result.comments} comment.` }] };
      } catch (err: unknown) {
        return handleError(err);
      }
    },
  );

  server.tool(
    'hub_daily_report',
    'Tạo ngay báo cáo ngày OpenProject cho một nguồn',
    {
      sourceId: z.string().min(1).describe('ID của nguồn OpenProject'),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Ngày báo cáo dạng YYYY-MM-DD (mặc định hôm nay)'),
    },
    async (args) => {
      try {
        const query = args.date ? `?date=${encodeURIComponent(args.date)}` : '';
        const result = await callApi<{ ok: boolean; path: string; content: string }>(
          'POST',
          `/api/integrations/openproject/sources/${encodeURIComponent(args.sourceId)}/daily-report${query}`,
        );
        return {
          content: [
            {
              type: 'text',
              text: `✓ Đã tạo báo cáo ngày cho nguồn ${args.sourceId} (${result.path}):\n\n${result.content}`,
            },
          ],
        };
      } catch (err: unknown) {
        return handleError(err);
      }
    },
  );

  server.tool(
    'hub_create_task',
    'Tạo task mới trong AgentHub. Nếu start=true thì đưa thẳng vào hàng đợi (queued)',
    {
      project: z.string().describe('ID của project'),
      slug: z.string().describe('Slug định danh task'),
      title: z.string().describe('Tiêu đề task'),
      body: z.string().describe('Đề bài task dạng markdown'),
      level: z.enum(['easy', 'hard']).optional().describe('Độ khó của task (easy hoặc hard)'),
      dependsOn: z.array(z.string()).optional().describe('Danh sách ID các task phụ thuộc'),
      baseRef: z.string().optional().describe('Git base ref'),
      branch: z.string().optional().describe('Git branch cho task'),
      modelChain: z.array(z.string()).optional().describe('Chuỗi model chỉ định'),
      start: z.boolean().optional().describe('Đưa thẳng vào hàng đợi để chạy ngay'),
      goal: z.string().optional().describe('Mục tiêu người dùng của nhóm task'),
    },
    async (args) => {
      try {
        assertProject(args.project, 'Tạo task');
        const res = await callApi<{ id: string; status: string; title: string }>('POST', '/api/tasks', {
          ...args,
          fromClaude: true,
          sessionId: options?.chatSessionId || process.env.AGENTHUB_CHAT_SESSION_ID,
        });
        try {
          await callApi('PUT', '/api/brain', {
            activity: 'dispatching',
            detail: `dispatching ${args.slug}`,
            taskId: res.id,
          });
        } catch {
          // ignore brain update failure
        }
        return {
          content: [{ type: 'text', text: `✓ Đã tạo task "${res.id}" [${res.status}]: ${res.title}` }],
        };
      } catch (err: unknown) {
        return handleError(err);
      }
    },
  );

  // hub_update_task
  server.tool(
    'hub_update_task',
    'Cập nhật modelChain, dependsOn, level, title, body hoặc appendBody của task chưa chạy (draft, queued, waiting_quota, failed)',
    {
      id: z.string().describe('ID của task cần sửa (dạng project/slug hoặc project~slug)'),
      title: z.string().optional().describe('Tiêu đề mới của task'),
      body: z.string().optional().describe('Nội dung đề bài mới dạng markdown'),
      appendBody: z.string().optional().describe('Nội dung bổ sung nối vào cuối body'),
      level: z.enum(['easy', 'hard']).optional().describe('Độ khó của task (easy hoặc hard)'),
      dependsOn: z.array(z.string()).optional().describe('Danh sách ID các task phụ thuộc'),
      modelChain: z.array(z.string()).optional().describe('Chuỗi model chỉ định'),
    },
    async (args) => {
      try {
        if (assistantSession()) {
          const current = await callApi<{ status: string }>('GET', `/api/tasks/${toRouteId(args.id)}`);
          if (current.status !== 'draft' && current.status !== 'queued') throw new Error('Trợ lý chỉ được cập nhật task ở trạng thái draft hoặc queued');
        }
        assertTaskId(args.id, 'Cập nhật task');
        const { id, ...payload } = args;
        const routeId = toRouteId(id);
        const res = await callApi<{ id: string; status: string; title: string }>('PATCH', `/api/tasks/${routeId}`, payload);
        return {
          content: [{ type: 'text', text: `✓ Đã cập nhật task "${res.id}" [${res.status}]: ${res.title}` }],
        };
      } catch (err: unknown) {
        return handleError(err);
      }
    },
  );

  // hub_create_batch
  server.tool(
    'hub_create_batch',
    'Tạo đợt task mới (batch). Dùng cho mọi kế hoạch có từ 2 task liên quan; có thể giao ngay bằng dispatch=true khi không cần duyệt.',
    {
      project: z.string().describe('ID của project'),
      title: z.string().describe('Tiêu đề của đợt lên kế hoạch'),
      goal: z.string().optional().describe('Mục tiêu tổng quát của đợt'),
      dispatch: z.boolean().optional().describe('Giao ngay sau khi tạo, vẫn kiểm tra vòng phụ thuộc'),
      tasks: z
        .array(
          z.object({
            slug: z.string().describe('Slug định danh task'),
            title: z.string().describe('Tiêu đề task'),
            body: z.string().optional().describe('Đề bài task dạng markdown'),
            level: z.enum(['easy', 'hard']).optional().describe('Độ khó của task (easy hoặc hard)'),
            modelChain: z.array(z.string()).optional().describe('Chuỗi model chỉ định'),
            dependsOn: z.array(z.string()).optional().describe('Danh sách ID hoặc slug task phụ thuộc trong cùng đợt'),
          }),
        )
        .min(1)
        .describe('Danh sách task trong đợt'),
    },
    async (args) => {
      try {
        assertAssistantAllowed('hub_create_batch');
        assertProject(args.project, 'Tạo batch');
        const res = await callApi<{
          id: string;
          projectId: string;
          title: string;
          goal?: string;
          status: string;
          tasks: Array<{ id: string; slug: string; title: string; status: string; dependsOn: string | string[] }>;
        }>('POST', '/api/batches', {
          ...args,
          dispatch: assistantSession() ? false : args.dispatch,
          createdBy: assistantSession() ? 'assistant' : 'claude',
          sessionId: options?.chatSessionId || process.env.AGENTHUB_CHAT_SESSION_ID,
        });

        const taskLines = res.tasks
          .map((t) => `  - ${t.id} [${t.status}]: ${t.title}`)
          .join('\n');
        return {
          content: [
            {
              type: 'text',
              text: `✓ Đã tạo đợt "${res.id}" [${res.status}]: "${res.title}" gồm ${res.tasks.length} task${res.status === 'draft' ? ' (chờ duyệt)' : ' (đã giao)'}:\n${taskLines}`,
            },
          ],
        };
      } catch (err: unknown) {
        return handleError(err);
      }
    },
  );

  // hub_batch
  server.tool(
    'hub_batch',
    'Xem thông tin chi tiết và danh sách task của một đợt (batch)',
    {
      id: z.string().describe('ID của đợt (batchId)'),
    },
    async (args) => {
      try {
        const res = await callApi<{
          id: string;
          projectId: string;
          title: string;
          goal?: string | null;
          status: string;
          createdBy?: string | null;
          createdAt: string;
          tasks: Array<{ id: string; slug: string; title: string; status: string; level: string; dependsOn: string | string[] }>;
        }>('GET', `/api/batches/${encodeURIComponent(args.id)}`);

        const goalStr = res.goal ? `\nMục tiêu: ${res.goal}` : '';
        const taskLines = res.tasks.length
          ? res.tasks
              .map((t) => {
                const deps = Array.isArray(t.dependsOn)
                  ? t.dependsOn.join(', ')
                  : typeof t.dependsOn === 'string'
                  ? t.dependsOn
                  : '';
                return `  - ${t.id} [${t.status}] (${t.level})${deps ? ` phụ thuộc: [${deps}]` : ''}: ${t.title}`;
              })
              .join('\n')
          : '  (chưa có task)';

        return {
          content: [
            {
              type: 'text',
              text: `Đợt: ${res.title} (${res.id}) [${res.status}] · Project: ${res.projectId}${goalStr}\nDanh sách task (${res.tasks.length}):\n${taskLines}`,
            },
          ],
        };
      } catch (err: unknown) {
        return handleError(err);
      }
    },
  );

  // hub_dispatch_batch
  server.tool(
    'hub_dispatch_batch',
    'Giao cả đợt task (chuyển mọi draft sang queued sau khi kiểm tra không có vòng phụ thuộc)',
    {
      id: z.string().describe('ID của đợt (batchId)'),
    },
    async (args) => {
      try {
        assertAssistantAllowed('hub_dispatch_batch');
        const scope = scopedProject();
        const batch = await callApi<{ projectId: string }>('GET', `/api/batches/${encodeURIComponent(args.id)}`);
        if (scope && batch.projectId !== scope) throw new Error(`Giao batch chỉ được phép trong project "${scope}"`);
        const res = await callApi<{
          ok: boolean;
          batchId: string;
          dispatchedCount: number;
        }>('POST', `/api/batches/${encodeURIComponent(args.id)}/dispatch`);

        return {
          content: [
            {
              type: 'text',
              text: `✓ Đã giao đợt "${res.batchId}": ${res.dispatchedCount} task đã được chuyển sang hàng đợi (queued)`,
            },
          ],
        };
      } catch (err: unknown) {
        return handleError(err);
      }
    },
  );

  // 6. hub_tasks
  server.tool(
    'hub_tasks',
    'Xem danh sách tasks, có thể lọc theo project hoặc status',
    {
      project: z.string().optional().describe('Lọc theo project ID'),
      status: z.string().optional().describe('Lọc theo trạng thái task'),
    },
    async (args) => {
      try {
        const params = new URLSearchParams();
        if (args.project) params.set('project', args.project);
        else if (scopedProject()) params.set('project', scopedProject()!);
        if (args.status) params.set('status', args.status);
        const query = params.toString() ? `?${params.toString()}` : '';
        const tasks = await callApi<
          Array<{
            id: string;
            title: string;
            status: string;
            level: string;
            attempt: number;
            reviewerEscalated?: number;
            reviewRound?: number;
            reviewMaxRounds?: number;
          }>
        >('GET', `/api/tasks${query}`);

        tasks.sort((a, b) => Number(Boolean(b.reviewerEscalated)) - Number(Boolean(a.reviewerEscalated)));

        if (tasks.length === 0) {
          return { content: [{ type: 'text', text: 'Không có task nào phù hợp.' }] };
        }
        const lines = [`Tasks (${tasks.length}):`];
        for (const t of tasks) {
          const round = t.reviewRound && t.reviewMaxRounds ? `, Vòng duyệt ${t.reviewRound}/${t.reviewMaxRounds}` : '';
          lines.push(`- [${t.status}] ${t.id} - ${t.title} (level: ${t.level}, attempt: ${t.attempt}${round})`);
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (err: unknown) {
        return handleError(err);
      }
    },
  );

  // 7. hub_task
  server.tool(
    'hub_task',
    'Xem chi tiết task: trạng thái, các run, báo cáo DONE, danh sách commit, và worktreePath để review',
    {
      id: z.string().describe('ID của task (dạng project/slug hoặc project~slug)'),
    },
    async (args) => {
      try {
        assertTaskId(args.id, 'Xem task');
        const routeId = toRouteId(args.id);
        const data = await callApi<{
          task: {
            id: string;
            title: string;
            status: string;
            level: string;
            attempt: number;
            branch?: string | null;
            worktreePath?: string | null;
            baseRef?: string | null;
            dependsOn?: string[];
            reviewRound?: number;
            reviewMaxRounds?: number;
          };
          runs: Array<{
            id: string;
            attempt: number;
            outcome?: string | null;
            reason?: string | null;
            model: string;
            profileName: string;
            durationMs?: number | null;
          }>;
          commits: string[];
          doneReport?: string | null;
          blockedReason?: string | null;
          checks?: Array<{ name: string; ok: boolean; exitCode: number | null }>;
        }>('GET', `/api/tasks/${routeId}`);

        const obj = data as Record<string, unknown>;
        const t = (obj.task || obj) as Record<string, unknown>;
        const runs = (obj.runs || []) as Array<Record<string, unknown>>;
        const commits = (obj.commits || []) as string[];
        const doneReport = (obj.doneReport || obj.doneContent) as string | undefined;
        const blockedReason = (obj.blockedReason || obj.blockedContent) as string | undefined;
        const checks = (obj.checks || []) as Array<{ name: string; ok: boolean; exitCode: number | null }>;

        const depsStr = Array.isArray(t.dependsOn)
          ? (t.dependsOn.length > 0 ? t.dependsOn.join(', ') : '(không có)')
          : (t.dependsOn && t.dependsOn !== '[]' ? String(t.dependsOn) : '(không có)');

        const lines: string[] = [
          `Task: ${t.id} [${t.status}]`,
          `Tiêu đề: ${t.title}`,
          `Level: ${t.level} | Lượt chạy: ${t.attempt}`,
          ...(typeof t.reviewRound === 'number' && typeof t.reviewMaxRounds === 'number' ? [`Vòng duyệt: ${t.reviewRound}/${t.reviewMaxRounds}`] : []),
          `Branch: ${t.branch || '(chưa tạo)'}`,
          `Worktree: ${t.worktreePath || '(chưa tạo)'}`,
          `Base ref: ${t.baseRef || '(mặc định)'}`,
          `Phụ thuộc: ${depsStr}`,
          '',
          `Các lượt chạy (${runs.length}):`,
        ];

        if (runs.length === 0) {
          lines.push('  (chưa có)');
        } else {
          for (const r of runs) {
            const dur = typeof r.durationMs === 'number' ? `${Math.round(r.durationMs / 1000)}s` : 'đang chạy';
            const outcome = r.reason === 'stalled' ? 'kẹt (stalled)' : (r.outcome || 'running');
            lines.push(`  - Run #${r.attempt || 1} [${outcome}]: model=${r.model} profile=${r.profileName} (${dur})`);
          }
        }

        lines.push('', `Danh sách commit (${commits.length}):`);
        if (commits.length === 0) {
          lines.push('  (chưa có commit)');
        } else {
          for (const c of commits) {
            lines.push(`  - ${c}`);
          }
        }

        if (doneReport) {
          lines.push('', '--- Báo cáo DONE ---', doneReport);
        }
        if (blockedReason) {
          lines.push('', '--- Lý do BLOCKED ---', blockedReason);
        }

        if (checks.length > 0) {
          lines.push('', `Checks: ${checks.map((check) => `${check.ok ? '✓' : '✗'}${check.name}${!check.ok && check.exitCode != null ? `(${check.exitCode})` : ''}`).join(' ')}`);
        }

        lines.push(
          '',
          `Review: đọc diff bằng \`git -C ${t.worktreePath || '<worktree>'} diff ${t.baseRef || 'main'}...HEAD\``,
        );

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (err: unknown) {
        return handleError(err);
      }
    },
  );

  // 8. hub_task_log
  server.tool(
    'hub_task_log',
    'Xem log của task (mặc định lấy run mới nhất, tail KB)',
    {
      id: z.string().describe('ID của task'),
      tail: z.number().int().positive().optional().describe('Số KB cuối (tối đa 512, mặc định 100)'),
      run: z.number().int().positive().optional().describe('Số thứ tự run (attempt) cụ thể'),
    },
    async (args) => {
      try {
        assertTaskId(args.id, 'Đọc log task');
        const routeId = toRouteId(args.id);
        const params = new URLSearchParams();
        if (args.tail) params.set('tail', String(args.tail));
        if (args.run) params.set('run', String(args.run));
        const query = params.toString() ? `?${params.toString()}` : '';
        const text = await callApi<string>('GET', `/api/tasks/${routeId}/log${query}`);
        return {
          content: [{ type: 'text', text: text || '(log trống)' }],
        };
      } catch (err: unknown) {
        return handleError(err);
      }
    },
  );

  // 9. hub_review
  server.tool(
    'hub_review',
    'Gửi kết quả review cho task: approved để hoàn tất, hoặc changes_requested để yêu cầu sửa tiếp',
    {
      id: z.string().describe('ID của task'),
      verdict: z.enum(['approved', 'changes_requested']).describe('Kết quả review'),
      feedback: z.string().optional().describe('Góp ý hoặc yêu cầu sửa (bắt buộc khi verdict là changes_requested)'),
      merge: z.boolean().optional().describe('Khi approved, merge vào worktree tích hợp đã cấu hình'),
      source: z
        .enum(['content', 'operational'])
        .optional()
        .describe('Phân loại review: "content" (mặc định) cho đánh giá chất lượng mã nguồn; "operational" cho yêu cầu gỡ xung đột merge conflict hoặc các vấn đề vận hành/hạ tầng (không tính vào giới hạn vòng review)'),
    },
    async (args) => {
      try {
        assertAssistantAllowed('hub_review');
        assertTaskId(args.id, 'Duyệt task');
        const routeId = toRouteId(args.id);
        await callApi('POST', `/api/tasks/${routeId}/review`, {
          verdict: args.verdict,
          feedback: args.feedback,
          merge: args.merge,
          source: args.source,
          by: 'claude-review',
        });
        try {
          await callApi('PUT', '/api/brain', {
            activity: 'reviewing',
            detail: `reviewing ${args.id}`,
            taskId: args.id,
          });
        } catch {
          // ignore brain update failure
        }
        return {
          content: [{
            type: 'text',
            text: `✓ Đã review task "${args.id}": ${args.verdict}${args.feedback ? `\nFeedback: ${args.feedback}` : ''}`,
          }],
        };
      } catch (err: unknown) {
        return handleError(err);
      }
    },
  );

  // 10. hub_retry
  server.tool(
    'hub_retry',
    'Chạy lại task bị failed hoặc blocked',
    {
      id: z.string().describe('ID của task'),
      note: z.string().optional().describe('Ghi chú cho lượt chạy lại'),
    },
    async (args) => {
      try {
        assertTaskId(args.id, 'Retry task');
        const routeId = toRouteId(args.id);
        await callApi('POST', `/api/tasks/${routeId}/retry`, { note: args.note });
        return {
          content: [{ type: 'text', text: `✓ Đã retry task "${args.id}"` }],
        };
      } catch (err: unknown) {
        return handleError(err);
      }
    },
  );

  // 11. hub_cancel
  server.tool(
    'hub_cancel',
    'Hủy một task đang chạy hoặc trong hàng đợi',
    {
      id: z.string().describe('ID của task'),
    },
    async (args) => {
      try {
        assertTaskId(args.id, 'Huỷ task');
        const routeId = toRouteId(args.id);
        await callApi('POST', `/api/tasks/${routeId}/cancel`);
        return {
          content: [{ type: 'text', text: `✓ Đã hủy task "${args.id}"` }],
        };
      } catch (err: unknown) {
        return handleError(err);
      }
    },
  );

  // 12. hub_mark_quota
  server.tool(
    'hub_mark_quota',
    'Đánh dấu quota cho một hồ sơ',
    {
      profile: z.string().describe('Tên hồ sơ'),
      family: z.string().describe('Họ model (gemini, claude, codex)'),
      seconds: z.number().int().positive().optional().describe('Thời gian hiệu lực tính bằng giây'),
      reason: z.string().optional().describe('Lý do đánh dấu quota'),
    },
    async (args) => {
      try {
        await callApi('POST', `/api/profiles/${args.profile}/quota`, {
          family: args.family,
          seconds: args.seconds,
          reason: args.reason,
        });
        return {
          content: [{
            type: 'text',
            text: `✓ Đã đánh dấu quota cho profile "${args.profile}" họ ${args.family}${args.seconds ? ` trong ${args.seconds}s` : ''}`,
          }],
        };
      } catch (err: unknown) {
        return handleError(err);
      }
    },
  );

  // 13. hub_wait
  server.tool(
    'hub_wait',
    'Chờ đến khi một task được theo dõi chuyển sang review, blocked, failed, waiting_quota hoặc done',
    {
      ids: z.array(z.string()).optional().describe('Danh sách task ID cần chờ (nếu để trống, chờ task bất kỳ)'),
      timeoutSec: z.number().int().positive().optional().describe('Thời gian chờ tối đa bằng giây (mặc định 600, tối đa 1800)'),
    },
    async (args) => {
      try {
        const timeoutSec = Math.min(Math.max(1, args.timeoutSec ?? 600), 1800);
        const targetIds = args.ids && args.ids.length > 0 ? args.ids.map(toTaskId) : undefined;

        // 1. Check if any target task is ALREADY in an actionable/terminal status
        const terminalStatuses = new Set(['review', 'blocked', 'failed', 'waiting_quota', 'done']);
        const isWaitable = (task: Record<string, unknown>): boolean => {
          if (String(task.status) !== 'review') return terminalStatuses.has(String(task.status));
          const chain = Array.isArray(task.reviewChain) ? task.reviewChain as Array<{ mode?: string }> : [];
          if (chain.length === 0) return true;
          const step = Number(task.reviewStep ?? 0);
          return step >= chain.length || chain[step]?.mode === 'final';
        };
        if (targetIds && targetIds.length > 0) {
          for (const id of targetIds) {
            try {
              const data = await callApi<Record<string, unknown>>('GET', `/api/tasks/${toRouteId(id)}`);
              const t = (data.task || data) as Record<string, unknown>;
              if (t && isWaitable(t)) {
                return {
                  content: [{
                    type: 'text',
                    text: `Task "${t.id}" đang ở trạng thái [${t.status}]: ${t.title}`,
                  }],
                };
              }
            } catch {
              // Task might not exist yet or error, proceed to wait
            }
          }
        }

        // 2. Connect to SSE
        return await new Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>((resolve) => {
          let token: string;
          try {
            token = getToken();
          } catch (e) {
            resolve(handleError(e));
            return;
          }

          const port = getPort();
          const abortController = new AbortController();
          const timer = setTimeout(() => {
            abortController.abort();
            resolve({
              content: [{
                type: 'text',
                text: `Hết thời gian chờ (${timeoutSec}s). Chưa có task nào chuyển trạng thái.`,
              }],
            });
          }, timeoutSec * 1000);

          const targetEventTypes: Record<string, string> = {
            'task.review_ready': 'review',
            'task.blocked': 'blocked',
            'task.failed': 'failed',
            'task.waiting_quota': 'waiting_quota',
            'task.done': 'done',
          };

          const url = `${getBaseUrl()}/api/events?token=${token}`;

          fetch(url, {
            headers: { Host: `127.0.0.1:${port}` },
            signal: abortController.signal,
          })
            .then(async (res) => {
              if (!res.ok || !res.body) {
                clearTimeout(timer);
                resolve({
                  content: [{ type: 'text', text: `Lỗi kết nối SSE: ${res.status}` }],
                  isError: true,
                });
                return;
              }

              const reader = res.body.getReader();
              const decoder = new TextDecoder();
              let buffer = '';

              try {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  buffer += decoder.decode(value, { stream: true });
                  const parts = buffer.split('\n\n');
                  buffer = parts.pop() || '';

                  for (const part of parts) {
                    const lines = part.split('\n');
                    let eventType = '';
                    let dataStr = '';
                    for (const line of lines) {
                      if (line.startsWith('event: ')) {
                        eventType = line.slice(7).trim();
                      } else if (line.startsWith('data: ')) {
                        dataStr = line.slice(6).trim();
                      }
                    }

                    if (eventType in targetEventTypes) {
                      let data: { taskId?: string; payload?: { taskId?: string } } = {};
                      try {
                        data = JSON.parse(dataStr) as { taskId?: string; payload?: { taskId?: string } };
                      } catch {
                        // ignore
                      }
                      const taskId = data.taskId || data.payload?.taskId || '';
                      if (!targetIds || targetIds.includes(taskId)) {
                        clearTimeout(timer);
                        abortController.abort();
                        const status = targetEventTypes[eventType];
                        resolve({
                          content: [{
                            type: 'text',
                            text: `✓ Task "${taskId}" đã chuyển sang trạng thái [${status}]`,
                          }],
                        });
                        return;
                      }
                    }
                  }
                }
              } catch (err: unknown) {
                const errObj = err as { name?: string };
                if (errObj?.name !== 'AbortError') {
                  clearTimeout(timer);
                  resolve(handleError(err));
                }
              }
            })
            .catch((err: unknown) => {
              clearTimeout(timer);
              resolve(handleError(err));
            });
        });
      } catch (err: unknown) {
        return handleError(err);
      }
    },
  );

  // 14. hub_git
  server.tool(
    'hub_git',
    'Chạy lệnh git an toàn (status, log, diff, show) trong thư mục project',
    {
      project: z.string().describe('ID hoặc đường dẫn của project'),
      args: z.array(z.string()).describe('Các tham số git (args[0] phải thuộc status|log|diff|show)'),
    },
    async (toolArgs) => {
      try {
        if (!toolArgs.args || toolArgs.args.length === 0) {
          throw new Error('args không được để trống');
        }

        const subCmd = toolArgs.args[0];
        if (!['status', 'log', 'diff', 'show'].includes(subCmd)) {
          throw new Error(`Lệnh git "${subCmd}" không được phép. Chỉ chấp nhận: status, log, diff, show`);
        }

        for (const arg of toolArgs.args) {
          const trimmed = arg.trim();
          if (
            trimmed.startsWith('--output') ||
            trimmed.startsWith('--ext-diff') ||
            trimmed.startsWith('-c') ||
            trimmed.startsWith('--exec')
          ) {
            throw new Error(`Tham số "${arg}" bị từ chối vì lý do an toàn`);
          }
        }

        let projectPath: string | null = null;
        try {
          const p = await callApi<{ id: string; path: string }>('GET', `/api/projects/${encodeURIComponent(toolArgs.project)}`);
          if (p && p.path) {
            projectPath = p.path;
          }
        } catch {
          // ignore error and search list
        }

        if (!projectPath) {
          try {
            const projects = await callApi<Array<{ id: string; name?: string; path?: string }>>('GET', '/api/projects');
            const found = projects.find(
              (p) => p.id === toolArgs.project || p.name === toolArgs.project || p.path === toolArgs.project,
            );
            if (found && found.path) {
              projectPath = found.path;
            }
          } catch {
            // ignore
          }
        }

        if (!projectPath && fs.existsSync(toolArgs.project)) {
          projectPath = toolArgs.project;
        }

        if (!projectPath) {
          throw new Error(`Không tìm thấy project "${toolArgs.project}"`);
        }

        const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
          execFile(
            'git',
            ['-C', projectPath, ...toolArgs.args],
            { timeout: 30000, maxBuffer: 10 * 1024 * 1024, encoding: 'utf-8' },
            (err, so, se) => {
              if (err) {
                const combined = [se, so, err.message].filter(Boolean).join('\n');
                reject(new Error(combined || String(err)));
              } else {
                resolve({ stdout: so || '', stderr: se || '' });
              }
            },
          );
        });

        let output = stdout || '';
        if (stderr) {
          output = output ? `${output}\n${stderr}` : stderr;
        }

        const MAX_BYTES = 64 * 1024;
        const buf = Buffer.from(output, 'utf-8');
        if (buf.byteLength > MAX_BYTES) {
          output = buf.subarray(0, MAX_BYTES).toString('utf-8') + '\n... [output truncated at 64KB]';
        }

        return {
          content: [{
            type: 'text',
            text: output || '(không có output)',
          }],
        };
      } catch (err: unknown) {
        return handleError(err);
      }
    },
  );

  server.tool(
    'hub_claude_usage',
    'Xem chi phí Claude đo được theo task hoặc tổng trong hôm nay',
    { taskId: z.string().optional() },
    async ({ taskId }) => {
      try {
        const path = taskId ? `/api/tasks/${encodeURIComponent(taskId)}` : '/api/claude/usage/today';
        const data = await callApi<Record<string, unknown>>('GET', path);
        if (taskId) {
          const cost = data.claudeCost as { effectiveTokens?: number; sessions?: number } | undefined;
          return { content: [{ type: 'text', text: `${taskId}: ${cost?.effectiveTokens || 0} effective tokens trong ${cost?.sessions || 0} phiên` }] };
        }
        return { content: [{ type: 'text', text: `Claude hôm nay: ${Number(data.effectiveTokens || 0).toLocaleString()} effective tokens qua ${Number(data.sessions || 0)} phiên` }] };
      } catch (err: unknown) { return handleError(err); }
    },
  );

  // hub_savings
  server.tool(
    'hub_savings',
    'Xem báo cáo hiệu quả ủy quyền worker (token đã tiết kiệm, số dòng code, tỷ lệ tiết kiệm)',
    {
      project: z.string().optional().describe('Lọc theo project ID'),
      since: z.string().optional().describe('Lọc từ ngày hoặc timestamp'),
    },
    async ({ project, since }) => {
      try {
        const queryParams = new URLSearchParams();
        if (project) queryParams.set('project', project);
        if (since) queryParams.set('since', since);
        const qStr = queryParams.toString() ? `?${queryParams.toString()}` : '';

        const data = await callApi<{
          summary: {
            totalWorkerTokens: number;
            claudeSavedTokens: number;
            claudeCostTokens: number;
            savingsRatio: number;
            totalLinesAdded: number;
            totalLinesDeleted: number;
            totalLinesChanged: number;
            tasksApprovedCount: number;
            avgReviewRounds: number;
          };
          tasks: Array<{
            taskId: string;
            model: string;
            linesAdded: number;
            linesDeleted: number;
            tokens: number;
            estimated: boolean;
            reviewRounds: number;
          }>;
        }>('GET', `/api/savings${qStr}`);

        const s = data.summary;
        const pct = (s.savingsRatio * 100).toFixed(1);
        const lines: string[] = [
          `Hiệu quả ủy quyền: Claude tiết kiệm ~${s.claudeSavedTokens.toLocaleString()} tokens (${pct}%), chi phí ~${s.claudeCostTokens.toLocaleString()} tokens`,
          `Code worker: +${s.totalLinesAdded.toLocaleString()} / -${s.totalLinesDeleted.toLocaleString()} dòng (${s.totalLinesChanged.toLocaleString()} dòng thay đổi)`,
          `Task đã duyệt: ${s.tasksApprovedCount} · Trung bình vòng review: ${s.avgReviewRounds.toFixed(1)}`,
        ];

        if (data.tasks && data.tasks.length > 0) {
          lines.push('\nChi tiết theo task:');
          for (const t of data.tasks.slice(0, 15)) {
            const est = t.estimated ? '≈' : '';
            lines.push(
              `- ${t.taskId}: ${t.model} · +${t.linesAdded}/-${t.linesDeleted} dòng · ${est}${t.tokens.toLocaleString()} tokens · ${t.reviewRounds} vòng review`,
            );
          }
          if (data.tasks.length > 15) {
            lines.push(`... và ${data.tasks.length - 15} task khác`);
          }
        }

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
        };
      } catch (err: unknown) {
        return handleError(err);
      }
    },
  );

  server.tool(
    'hub_brain_directive',
    'Thêm, liệt kê hoặc xoá chỉ thị bắt buộc cho bộ não',
    {
      action: z.enum(['add', 'list', 'remove']),
      id: z.string().optional(),
      projectId: z.string().nullable().optional(),
      text: z.string().optional(),
    },
    async (args) => {
      try {
        const targetProject = args.projectId ?? scopedProject();
        assertProject(targetProject, 'Chỉ thị');
        if (args.action === 'list') {
          const query = targetProject ? `?projectId=${encodeURIComponent(targetProject)}` : '';
          const rows = await callApi<Array<{ id: string; projectId: string | null; text: string }>>('GET', `/api/brain/directives${query}`);
          return { content: [{ type: 'text', text: rows.length ? rows.map((row) => `- ${row.id}: ${row.text}`).join('\n') : '(không có chỉ thị)' }] };
        }
        if (args.action === 'remove') {
          if (!args.id) throw new Error('id là bắt buộc khi xoá chỉ thị');
          // The API also verifies ownership of the directive's project.
          const query = targetProject ? `?projectId=${encodeURIComponent(targetProject)}` : '';
          await callApi('DELETE', `/api/brain/directives/${encodeURIComponent(args.id)}${query}`);
          return { content: [{ type: 'text', text: `✓ Đã xoá chỉ thị ${args.id}` }] };
        }
        if (!args.text?.trim()) throw new Error('text là bắt buộc khi thêm chỉ thị');
        const row = await callApi<{ id: string }>('POST', '/api/brain/directives', { projectId: targetProject || null, text: args.text, createdBy: 'assistant' });
        return { content: [{ type: 'text', text: `✓ Đã thêm chỉ thị ${row.id}` }] };
      } catch (err: unknown) { return handleError(err); }
    },
  );

  server.tool(
    'hub_ask_brain',
    'Gửi một câu hỏi cần quyết định cho bộ não',
    { question: z.string().min(1), projectId: z.string().nullable().optional() },
    async (args) => {
      try {
        const projectId = args.projectId ?? scopedProject();
        assertProject(projectId, 'Hỏi bộ não');
        const result = await callApi<{ queued?: boolean }>('POST', '/api/brain/ask', {
          ...args,
          projectId,
          sourceSessionId: options?.chatSessionId || process.env.AGENTHUB_CHAT_SESSION_ID,
        });
        return { content: [{ type: 'text', text: result.queued ? '✓ Đã xếp câu hỏi cho bộ não; câu trả lời sẽ được gửi lại.' : '✓ Đã gửi câu hỏi cho bộ não.' }] };
      } catch (err: unknown) { return handleError(err); }
    },
  );

  server.tool(
    'hub_pause',
    'Tạm dừng một task',
    {
      id: z.string().describe('ID của task cần tạm dừng'),
      reason: z.enum(['manual', 'load', 'brain_load']).optional().describe('Lý do tạm dừng: load (khi máy quá tải để tự tiếp tục khi hạ tải) hoặc manual (tạm dừng thủ công)'),
    },
    async ({ id, reason }) => {
      try {
        assertTaskId(id, 'Tạm dừng task');
        await callApi('POST', `/api/tasks/${toRouteId(id)}/pause`, { reason });
        return { content: [{ type: 'text', text: `✓ Đã tạm dừng ${id}` }] };
      }
      catch (err: unknown) { return handleError(err); }
    },
  );

  server.tool(
    'hub_resume',
    'Tiếp tục một task đã tạm dừng',
    { id: z.string() },
    async ({ id }) => {
      try { assertTaskId(id, 'Tiếp tục task'); await callApi('POST', `/api/tasks/${toRouteId(id)}/resume`); return { content: [{ type: 'text', text: `✓ Đã tiếp tục ${id}` }] }; }
      catch (err: unknown) { return handleError(err); }
    },
  );

  server.tool(
    'hub_gitea_sync',
    'Đồng bộ mã nguồn với Gitea theo cấu hình project (tạo PR, merge)',
    { projectId: z.string().optional() },
    async (args) => {
      try {
        const targetProject = args.projectId ?? scopedProject();
        if (!targetProject) throw new Error('projectId là bắt buộc');
        assertProject(targetProject, 'Đồng bộ Gitea');
        const result = await callApi<Record<string, unknown>>('POST', `/api/projects/${encodeURIComponent(targetProject)}/gitea/sync`);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err: unknown) { return handleError(err); }
    },
  );

  server.tool(
    'hub_remote_deploy',
    'Kích hoạt remote deploy cho một project',
    { projectId: z.string().describe('ID của project') },
    async ({ projectId }) => {
      try {
        const targetProject = projectId || scopedProject();
        if (!targetProject) throw new Error('Cần cung cấp projectId');
        const result = await callApi('POST', `/api/projects/${encodeURIComponent(targetProject)}/remote-deploy`);
        return { content: [{ type: 'text', text: `✓ Đã kích hoạt remote deploy cho project "${targetProject}": ${JSON.stringify(result)}` }] };
      } catch (err: unknown) {
        return handleError(err);
      }
    },
  );

  server.tool('hub_effective_config', 'Đọc cấu hình hiệu lực của project', { project: z.string() }, async ({ project }) => {
    try { assertProject(project, 'Đọc cấu hình'); return { content: [{ type: 'text', text: JSON.stringify(await callApi('GET', `/api/setup/effective-config/${encodeURIComponent(project)}`)) }] }; }
    catch (err: unknown) { return handleError(err); }
  });
  server.tool('hub_presets', 'Liệt kê các preset cấu hình', {}, async () => {
    try { return { content: [{ type: 'text', text: JSON.stringify(await callApi('GET', '/api/setup/presets')) }] }; }
    catch (err: unknown) { return handleError(err); }
  });
  server.tool('hub_departments', 'Liệt kê phòng ban', {}, async () => {
    try { return { content: [{ type: 'text', text: JSON.stringify(await callApi('GET', '/api/setup/departments')) }] }; }
    catch (err: unknown) { return handleError(err); }
  });
  server.tool('hub_preset_apply', 'Xem hoặc áp dụng preset cấu hình', { scope: z.string(), preset: z.string(), dryRun: z.boolean().default(true) }, async (args) => {
    try { assertSetupWriteAllowed('hub_preset_apply', args.dryRun); return { content: [{ type: 'text', text: JSON.stringify(await callApi('POST', '/api/setup/preset-apply', args)) }] }; }
    catch (err: unknown) { return handleError(err); }
  });
  server.tool('hub_project_settings', 'Xem hoặc cập nhật settings project', { project: z.string(), patch: z.record(z.unknown()), dryRun: z.boolean().default(true) }, async (args) => {
    try { assertProject(args.project, 'Cấu hình project'); assertSetupWriteAllowed('hub_project_settings', args.dryRun); return { content: [{ type: 'text', text: JSON.stringify(await callApi('POST', `/api/setup/project-settings/${encodeURIComponent(args.project)}`, args)) }] }; }
    catch (err: unknown) { return handleError(err); }
  });
  server.tool('hub_department', 'Xem hoặc cập nhật phòng ban và gán project', { id: z.string().optional(), patch: z.record(z.unknown()), assignProjects: z.array(z.string()).optional(), dryRun: z.boolean().default(true) }, async (args) => {
    try { assertSetupWriteAllowed('hub_department', args.dryRun); return { content: [{ type: 'text', text: JSON.stringify(await callApi('POST', '/api/setup/department', args)) }] }; }
    catch (err: unknown) { return handleError(err); }
  });
  server.tool('hub_config_set', 'Xem hoặc cập nhật một key config an toàn', { path: z.string(), value: z.unknown(), dryRun: z.boolean().default(true) }, async (args) => {
    try { assertSetupWriteAllowed('hub_config_set', args.dryRun); return { content: [{ type: 'text', text: JSON.stringify(await callApi('POST', '/api/setup/config-set', args)) }] }; }
    catch (err: unknown) { return handleError(err); }
  });
  server.tool('hub_integration_discover', 'Dò thông tin tích hợp chỉ đọc', { kind: z.enum(['openproject', 'gitea', 'checks']), sourceId: z.string().optional(), url: z.string().optional(), project: z.string().optional() }, async (args) => {
    try { if (args.project) assertProject(args.project, 'Dò tích hợp'); return { content: [{ type: 'text', text: JSON.stringify(await callApi('POST', '/api/setup/integration-discover', args)) }] }; }
    catch (err: unknown) { return handleError(err); }
  });
  server.tool('hub_request_secret', 'Yêu cầu người dùng nhập bí mật qua giao diện an toàn', { kind: z.enum(['openproject-key', 'gitea-token', 'deploy-env', 'telegram-token']), target: z.string(), label: z.string() }, async (args) => {
    try { const result = await callApi<{ configured: boolean; reason?: string; url?: string }>('POST', '/api/secrets/requests', args, 10 * 60 * 1000 + 30_000); return { content: [{ type: 'text', text: JSON.stringify(result) }] }; }
    catch (err: unknown) { return handleError(err); }
  });

  return server;
}

export async function runMcpServer(options?: McpServerOptions): Promise<void> {
  const server = createMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
