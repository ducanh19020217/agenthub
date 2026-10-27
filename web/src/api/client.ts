import {
  BrainStatus,
  ClaudeQuota,
  CheckProfileResponse,
  CreateProfileInput,
  CreateProjectInput,
  CreateNewProjectInput,
  DeployStatus,
  CreateTaskInput,
  CaptureTaskInput,
  HubStatus,
  LoginSessionResponse,
  Profile,
  Project,
  Run,
  ProjectInspection,
  RetryTaskInput,
  ReviewTaskInput,
  SystemConfig,
  Task,
  TaskDetail,
  TaskNote,
  UpdateProjectInput,
  UpdateTaskInput,
  VersionResponse,
  SavingsReport,
  DailyUsageReport,
  OrphanProcess,
  KnowledgeEntry,
  TaskGraphResponse,
  ModelOptions,
  TaskBatch,
  CreateBatchInput,
  PerfReport,
  Department,
  EventItem,
} from '../types/api';
import { getActiveLocale, translateApiErrorMessage } from '../utils/apiError';

export interface ClaudeSession {
  sessionId: string;
  cwd: string;
  title: string | null;
  model: string | null;
  messages: number;
  effectiveTokens: number;
  lastAt: string | null;
  active: boolean;
  topTasks: Array<{ taskId: string; effectiveTokens: number }>;
  limitResetAt?: number | null;
  autoResumeEnabled?: number;
}

export const getPerf = () => apiFetch<PerfReport>('/api/perf');

export async function getModelOptions(): Promise<ModelOptions> {
  return apiFetch<ModelOptions>('/api/models');
}

export interface SetupStatus {
  node: { version: string; ok: boolean };
  git: { version: string | null; installed: boolean };
  tools: Array<{ id: 'claude' | 'codex' | 'agy'; installed: boolean; version: string | null; path: string | null; manual: boolean; docsUrl?: string; installing: boolean }>;
  profiles: Profile[];
  mcpRegistered: boolean;
  serviceRunning: boolean;
  setupCompletedAt?: string;
  setupSkippedAt?: string;
}

export const getSetupStatus = () => apiFetch<SetupStatus>('/api/setup/status');
export const installSetupTool = (tool: string) => apiFetch<{ jobId: string }>(`/api/setup/install/${encodeURIComponent(tool)}`, { method: 'POST' });
export const completeSetup = (skip = false) => apiFetch(`/api/setup/${skip ? 'skip' : 'complete'}`, { method: 'POST' });
export const installSetupMcp = () => apiFetch('/api/setup/mcp', { method: 'POST' });

const TOKEN_STORAGE_KEY = 'agenthub_token';
export const API_REQUEST_TIMEOUT_MS = 15_000;

let unauthorizedListeners: Array<() => void> = [];

export class AuthError extends Error {
  constructor(message = getActiveLocale() === 'en' ? 'Unauthenticated or invalid token' : 'Chưa xác thực hoặc token không hợp lệ') {
    super(message);
    this.name = 'AuthError';
  }
}

export function subscribeUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.push(listener);
  return () => {
    unauthorizedListeners = unauthorizedListeners.filter((l) => l !== listener);
  };
}

function notifyUnauthorized() {
  for (const listener of unauthorizedListeners) {
    try {
      listener();
    } catch {
      // ignore listener error
    }
  }
}

export function getToken(): string | null {
  return sessionStorage.getItem(TOKEN_STORAGE_KEY);
}

export function setToken(token: string): void {
  sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
}

export function clearToken(): void {
  sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  notifyUnauthorized();
}

/**
 * Reads token from window.location.hash (#token=...)
 * Stores it into sessionStorage and cleans the hash from the URL.
 */
export function initTokenFromHash(): string | null {
  if (typeof window === 'undefined') return null;

  const hash = window.location.hash;
  if (hash) {
    const match = hash.match(/(?:^#|&|\?)token=([^&]+)/);
    if (match && match[1]) {
      const token = decodeURIComponent(match[1]);
      setToken(token);
      // Remove hash from URL without reloading
      const cleanUrl = window.location.pathname + window.location.search;
      window.history.replaceState(null, '', cleanUrl);
      return token;
    }
  }
  return getToken();
}

export async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  if (!token) {
    notifyUnauthorized();
    throw new AuthError(getActiveLocale() === 'en' ? 'Missing authentication token' : 'Thiếu token xác thực');
  }

  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `Bearer ${token}`);
  if (!headers.has('Accept-Language')) {
    headers.set('Accept-Language', getActiveLocale());
  }

  if (options.body && typeof options.body === 'string' && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (options.signal?.aborted) {
    controller.abort();
  } else {
    options.signal?.addEventListener('abort', onAbort, { once: true });
  }
  const timeout = setTimeout(() => controller.abort(), API_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(path, {
      ...options,
      headers,
      signal: controller.signal,
    });

    if (response.status === 401) {
      clearToken();
      throw new AuthError(getActiveLocale() === 'en' ? 'Token is invalid or expired' : 'Token không hợp lệ hoặc đã hết hạn');
    }

    if (!response.ok) {
      let errorMsg = getActiveLocale() === 'en' ? `Error ${response.status}: ${response.statusText}` : `Lỗi ${response.status}: ${response.statusText}`;
      let errorCode: string | undefined;
      try {
        const errJson = await response.json();
        if (errJson) {
          if (typeof errJson.error === 'string') {
            errorCode = errJson.error;
          } else if (typeof errJson.code === 'string') {
            errorCode = errJson.code;
          }

          if (errJson.message) {
            errorMsg = errJson.message;
          } else if (errJson.error) {
            errorMsg = errJson.error;
          }
        }
      } catch {
        try {
          const errText = await response.text();
          if (errText) errorMsg = errText;
        } catch {
          // fallback
        }
      }
      const rawMsg = errorMsg;
      errorMsg = translateApiErrorMessage(errorMsg, errorCode, getActiveLocale());
      const err: any = new Error(errorMsg);
      err.status = response.status;
      err.code = errorCode;
      err.rawMessage = rawMsg;
      throw err;
    }

    // Handle empty or text responses
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      return (await response.json()) as T;
    }
    return (await response.text()) as unknown as T;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

// API methods
export async function getVersion(): Promise<VersionResponse | null> {
  try {
    return await apiFetch<VersionResponse>('/api/version');
  } catch (err: any) {
    if (err?.status === 404 || err?.message?.includes('404')) {
      return null;
    }
    throw err;
  }
}
export async function getStatus(): Promise<HubStatus> {
  return apiFetch<HubStatus>('/api/status');
}

export type FocusState = { projectId: string | null; since: string | null; pauseRunning: boolean };
export const getFocus = () => apiFetch<FocusState>('/api/focus');
export const setFocus = (projectId: string | null, pauseRunning?: boolean) => apiFetch<{ focus: FocusState }>('/api/focus', {
  method: 'PUT',
  body: JSON.stringify({ projectId, ...(pauseRunning === undefined ? {} : { pauseRunning }) }),
});

export async function getOrphans(): Promise<OrphanProcess[]> {
  return apiFetch<OrphanProcess[]>('/api/system/orphans');
}

export async function reapOrphans(): Promise<{ ok: boolean; reaped: number[] }> {
  return apiFetch<{ ok: boolean; reaped: number[] }>('/api/system/orphans/reap', {
    method: 'POST',
  });
}

export async function getBrain(): Promise<BrainStatus> {
  return apiFetch<BrainStatus>('/api/brain');
}

export async function getClaudeQuota(): Promise<ClaudeQuota> {
  return apiFetch<ClaudeQuota>('/api/claude/quota');
}

export type ClaudeFailover = {
  active: boolean;
  until: number | null;
  resetAt: number | null;
  reason: string | null;
  activatedAt: number | null;
  step: {
    type: string;
    model?: string;
    profile?: string;
    engine?: string;
    dailyCapUSD?: number;
  } | null;
  stepIndex: number;
  dailyCostUSD: number;
  apiKeyConfigured: boolean;
  evidence?: { file: string; line: number; observedAt: string } | null;
  lastActivityAt?: string | null;
};

export async function getClaudeFailover(): Promise<ClaudeFailover> {
  return apiFetch<ClaudeFailover>('/api/claude/failover');
}

export async function clearClaudeFailover(): Promise<ClaudeFailover> {
  return apiFetch<ClaudeFailover>('/api/claude/failover/clear', { method: 'POST' });
}

export async function getClaudeApiKeyStatus(): Promise<{ configured: boolean }> {
  return apiFetch<{ configured: boolean }>('/api/claude/api-key');
}

export async function setClaudeApiKey(apiKey: string): Promise<{ configured: boolean }> {
  return apiFetch<{ configured: boolean }>('/api/claude/api-key', {
    method: 'PUT',
    body: JSON.stringify({ apiKey }),
  });
}

export async function rescanClaudeSessions(): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>('/api/claude/sessions/rescan', { method: 'POST' });
}

export async function getProjects(): Promise<Project[]> {
  return apiFetch<Project[]>('/api/projects');
}

export const getDepartments = () => apiFetch<Department[]>('/api/departments');
export const createDepartment = (data: Partial<Department> & { name: string }) => apiFetch<Department>('/api/departments', { method: 'POST', body: JSON.stringify(data) });
export const updateDepartment = (id: string, data: Partial<Department>) => apiFetch<Department>(`/api/departments/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(data) });
export const deleteDepartment = (id: string) => apiFetch<{ ok: boolean }>(`/api/departments/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const updateDepartmentProfiles = (id: string, profiles: Array<Pick<Department['profiles'][number], 'profileName' | 'share'>>) => apiFetch<Department>(`/api/departments/${encodeURIComponent(id)}/profiles`, { method: 'PUT', body: JSON.stringify({ profiles }) });

export async function getArchivedProjects(): Promise<Project[]> {
  return apiFetch<Project[]>('/api/projects?archived=true');
}

export const inspectProject = (path: string) => apiFetch<ProjectInspection>('/api/projects/inspect', { method: 'POST', body: JSON.stringify({ path }) });
export const createNewProject = (data: CreateNewProjectInput) => apiFetch<Project>('/api/projects/new', { method: 'POST', body: JSON.stringify(data) });
export const writeProjectGuidance = (projectId: string, content: string) =>
  apiFetch<{ ok: boolean }>(`/api/projects/${encodeURIComponent(projectId)}/guidance`, {
    method: 'POST',
    body: JSON.stringify({ content, confirm: true }),
  });
export const summarizeProjectContext = (projectId: string, data: { sessions: string[]; selections?: Array<{ session: string; text: string }>; notes?: string }) =>
  apiFetch<{ taskId: string; status: string; summary: string | null }>(
    `/api/projects/${encodeURIComponent(projectId)}/summarize-context`,
    { method: 'POST', body: JSON.stringify(data) },
  );
export const getProjectContextSummary = (projectId: string, taskId: string) =>
  apiFetch<{ taskId: string; status: string; summary: string | null }>(
    `/api/projects/${encodeURIComponent(projectId)}/summarize-context/${encodeURIComponent(taskId.replace('/', '~'))}`,
  );

export const rerunProjectDeploy = (id: string) => apiFetch(`/api/projects/${encodeURIComponent(id)}/deploy`, { method: 'POST' });
export const getProjectDeployStatus = (id: string) =>
  apiFetch<DeployStatus | null>(`/api/projects/${encodeURIComponent(id)}/deploy`);

export async function createProject(data: CreateProjectInput): Promise<Project> {
  return apiFetch<Project>('/api/projects', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateProject(id: string, data: UpdateProjectInput): Promise<Project> {
  return apiFetch<Project>(`/api/projects/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export async function deleteProject(id: string, options?: { purge?: boolean; confirm?: string }): Promise<{ ok: boolean; archived?: boolean; counts?: Record<string, number>; warnings?: string[] }> {
  const query = options?.purge ? `?purge=true&confirm=${encodeURIComponent(options.confirm || '')}` : '';
  return apiFetch<{ ok: boolean; archived?: boolean; counts?: Record<string, number>; warnings?: string[] }>(`/api/projects/${encodeURIComponent(id)}${query}`, {
    method: 'DELETE',
  });
}

export async function restoreProject(id: string): Promise<Project> {
  return apiFetch<Project>(`/api/projects/${encodeURIComponent(id)}/restore`, { method: 'POST' });
}

export async function getProjectKnowledge(projectId: string): Promise<KnowledgeEntry[]> {
  return apiFetch<KnowledgeEntry[]>(`/api/projects/${encodeURIComponent(projectId)}/knowledge`);
}

export async function getProjectKnowledgePage(projectId: string, params: { limit: number; offset?: number; cursor?: string }): Promise<PageResponse<KnowledgeEntry>> {
  const query = new URLSearchParams({ limit: String(params.limit) });
  if (params.offset !== undefined) query.set('offset', String(params.offset));
  if (params.cursor) query.set('cursor', params.cursor);
  return apiFetch<PageResponse<KnowledgeEntry>>(`/api/projects/${encodeURIComponent(projectId)}/knowledge?${query.toString()}`);
}

export interface CiRun {
  projectId: string;
  runId: number;
  workflow: string;
  sha: string;
  status: string;
  conclusion: string | null;
  jobs: string;
  completedAt: string | null;
  url?: string | null;
}

export async function getCiRunsPage(projectId: string, params: { limit: number; offset?: number; cursor?: string }): Promise<PageResponse<CiRun>> {
  const query = new URLSearchParams({ limit: String(params.limit) });
  if (params.offset !== undefined) query.set('offset', String(params.offset));
  if (params.cursor) query.set('cursor', params.cursor);
  return apiFetch<PageResponse<CiRun>>(`/api/projects/${encodeURIComponent(projectId)}/ci/runs?${query.toString()}`);
}

export const getReviewChecklistPreview = (projectId: string) =>
  apiFetch<Array<{ path: string; resolvedPath: string; size: number | null; truncated: boolean; content: string | null; warning?: string }>>(`/api/projects/${encodeURIComponent(projectId)}/review-checklist/preview`);

export async function addProjectKnowledge(
  projectId: string,
  data: { content: string; pinned?: boolean },
): Promise<KnowledgeEntry> {
  return apiFetch<KnowledgeEntry>(`/api/projects/${encodeURIComponent(projectId)}/knowledge`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateProjectKnowledge(
  projectId: string,
  id: number,
  data: { content?: string; pinned?: boolean },
): Promise<KnowledgeEntry> {
  return apiFetch<KnowledgeEntry>(
    `/api/projects/${encodeURIComponent(projectId)}/knowledge/${id}`,
    { method: 'PATCH', body: JSON.stringify(data) },
  );
}

export async function deleteProjectKnowledge(
  projectId: string,
  id: number,
): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(
    `/api/projects/${encodeURIComponent(projectId)}/knowledge/${id}`,
    { method: 'DELETE' },
  );
}

export async function getProfiles(): Promise<Profile[]> {
  return apiFetch<Profile[]>('/api/profiles');
}

export async function refreshProfileUsage(name: string): Promise<Profile> {
  return apiFetch<Profile>(`/api/profiles/${encodeURIComponent(name)}/usage/refresh`, {
    method: 'POST',
  });
}

export interface ImportTokensResult {
  success: boolean;
  total: number;
  successCount: number;
  failedCount: number;
  results: Array<{
    name: string;
    email: string;
    action: 'created' | 'updated' | 'skipped';
    status: 'ok' | 'error';
    message?: string;
  }>;
}

export async function importAgyTokens(data: {
  tokens: any;
  accountType?: 'personal' | 'team' | 'api';
}): Promise<ImportTokensResult> {
  return apiFetch<ImportTokensResult>('/api/profiles/import-tokens', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function createProfile(data: CreateProfileInput): Promise<Profile> {
  return apiFetch<Profile>('/api/profiles', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function deleteProfile(name: string, purgeHome = false): Promise<{ ok: boolean }> {
  const query = purgeHome ? '?purgeHome=1' : '';
  return apiFetch<{ ok: boolean }>(`/api/profiles/${encodeURIComponent(name)}${query}`, {
    method: 'DELETE',
  });
}

export async function renameProfile(name: string, newName: string): Promise<Profile> {
  return apiFetch<Profile>(`/api/profiles/${encodeURIComponent(name)}/rename`, {
    method: 'POST',
    body: JSON.stringify({ newName }),
  });
}

export async function loginProfile(name: string): Promise<LoginSessionResponse> {
  return apiFetch<LoginSessionResponse>(`/api/profiles/${encodeURIComponent(name)}/login`, {
    method: 'POST',
  });
}

export async function checkProfile(name: string): Promise<CheckProfileResponse> {
  return apiFetch<CheckProfileResponse>(`/api/profiles/${encodeURIComponent(name)}/check`, {
    method: 'POST',
  });
}

export async function updateProfile(
  name: string,
  data: {
    enabled?: boolean | number;
    label?: string | null;
    notes?: string | null;
    priority?: number;
  },
): Promise<Profile> {
  return apiFetch<Profile>(`/api/profiles/${encodeURIComponent(name)}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export async function markQuota(
  name: string,
  data: { family: string; seconds?: number; reason?: string },
): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`/api/profiles/${encodeURIComponent(name)}/quota`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function deleteQuota(name: string, family: string): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(
    `/api/profiles/${encodeURIComponent(name)}/quota?family=${encodeURIComponent(family)}`,
    {
      method: 'DELETE',
    },
  );
}

export interface TaskQuery {
  project?: string;
  status?: string;
  search?: string;
  limit?: number;
  cursor?: string;
  offset?: number;
  sort?: 'createdAt' | 'updatedAt' | 'title' | 'slug';
  order?: 'asc' | 'desc';
}

export function getTasks(): Promise<Task[]>;
export function getTasks(params: Omit<TaskQuery, 'limit'> & { limit?: undefined }): Promise<Task[]>;
export async function getTasks(params?: Omit<TaskQuery, 'limit'> & { limit?: undefined }): Promise<Task[]> {
  const query = new URLSearchParams();
  if (params?.project) query.set('project', params.project);
  if (params?.status) query.set('status', params.status);
  if (params?.search) query.set('search', params.search);
  if (params?.cursor) query.set('cursor', params.cursor);
  const qStr = query.toString();
  return apiFetch<Task[]>(`/api/tasks${qStr ? `?${qStr}` : ''}`);
}

export interface PageResponse<T> {
  items: T[];
  total: number;
  nextCursor: string | null;
}

export async function getEventHistoryPage(params: { limit: number; cursor?: string; offset?: number; taskId?: string }): Promise<PageResponse<EventItem>> {
  const query = new URLSearchParams({ limit: String(params.limit) });
  if (params.cursor) query.set('cursor', params.cursor);
  if (params.offset !== undefined) query.set('offset', String(params.offset));
  if (params.taskId) query.set('taskId', params.taskId);
  return apiFetch<PageResponse<EventItem>>(`/api/events/history?${query.toString()}`);
}

export async function getTasksPage(params?: TaskQuery): Promise<PageResponse<Task>> {
  const query = new URLSearchParams();
  if (params?.project) query.set('project', params.project);
  if (params?.status) query.set('status', params.status);
  if (params?.search) query.set('search', params.search);
  query.set('limit', String(params?.limit ?? 20));
  if (params?.cursor) query.set('cursor', params.cursor);
  if (params?.offset !== undefined) query.set('offset', String(params.offset));
  if (params?.sort) query.set('sort', params.sort);
  if (params?.order) query.set('order', params.order);
  const response = await apiFetch<PageResponse<Task> | Task[]>(`/api/tasks?${query.toString()}`);
  return Array.isArray(response)
    ? { items: response, total: response.length, nextCursor: null }
    : response;
}

export async function getAllTasksPaged(params?: Omit<TaskQuery, 'limit' | 'cursor' | 'offset'>): Promise<Task[]> {
  const items: Task[] = [];
  let cursor: string | undefined;
  do {
    const page = await getTasksPage({ ...params, limit: 100, cursor });
    items.push(...page.items);
    cursor = page.nextCursor || undefined;
  } while (cursor);
  return items;
}

export async function getTaskGraph(params?: {
  project?: string;
  includeDone?: string | boolean;
}): Promise<TaskGraphResponse> {
  const query = new URLSearchParams();
  if (params?.project) query.set('project', params.project);
  if (params?.includeDone !== undefined) query.set('includeDone', String(params.includeDone));
  const qStr = query.toString();
  return apiFetch<TaskGraphResponse>(`/api/tasks/graph${qStr ? `?${qStr}` : ''}`);
}

export async function getClaudeSessionsPage(params: { limit: number; offset?: number; cursor?: string; activeWithinMin?: number; sort?: 'lastAt' | 'title' | 'messages' | 'effectiveTokens'; order?: 'asc' | 'desc' }): Promise<PageResponse<ClaudeSession>> {
  const query = new URLSearchParams({ limit: String(params.limit), offset: String(params.offset ?? 0) });
  if (params.activeWithinMin !== undefined) query.set('activeWithinMin', String(params.activeWithinMin));
  if (params.cursor) query.set('cursor', params.cursor);
  if (params.sort) query.set('sort', params.sort);
  if (params.order) query.set('order', params.order);
  return apiFetch<PageResponse<ClaudeSession>>(`/api/claude/sessions?${query.toString()}`);
}

export async function createTask(data: CreateTaskInput): Promise<Task> {
  return apiFetch<Task>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function createTaskFromError(data: CaptureTaskInput): Promise<Task> {
  return apiFetch<Task>('/api/tasks/from-error', { method: 'POST', body: JSON.stringify(data) });
}

export async function getTask(id: string): Promise<TaskDetail> {
  return apiFetch<TaskDetail>(`/api/tasks/${encodeURIComponent(id)}`);
}

export async function updateTask(id: string, data: UpdateTaskInput): Promise<Task> {
  return apiFetch<Task>(`/api/tasks/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export async function rerunChecks(id: string): Promise<{ passed: boolean; failed: string[] }> {
  return apiFetch<{ passed: boolean; failed: string[] }>(
    `/api/tasks/${encodeURIComponent(id)}/checks/rerun`,
    { method: 'POST' },
  );
}

export async function startTask(id: string): Promise<Task> {
  return apiFetch<Task>(`/api/tasks/${encodeURIComponent(id)}/start`, {
    method: 'POST',
  });
}

export async function cancelTask(id: string): Promise<Task> {
  return apiFetch<Task>(`/api/tasks/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
  });
}

export async function pauseTask(id: string): Promise<{ ok: boolean; paused: boolean }> {
  return apiFetch<{ ok: boolean; paused: boolean }>(`/api/tasks/${encodeURIComponent(id)}/pause`, {
    method: 'POST',
  });
}

export async function resumeTask(id: string): Promise<{ ok: boolean; paused: boolean }> {
  return apiFetch<{ ok: boolean; paused: boolean }>(`/api/tasks/${encodeURIComponent(id)}/resume`, {
    method: 'POST',
  });
}

export async function deleteTask(id: string): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`/api/tasks/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export interface TaskBatchPage { items: TaskBatch[]; total: number; nextCursor: string | null }

export async function getBatches(params?: { project?: string; status?: string }): Promise<TaskBatch[]> {
  const query = new URLSearchParams();
  if (params?.project && params.project !== 'all') query.set('project', params.project);
  if (params?.status && params.status !== 'all') query.set('status', params.status);
  const qStr = query.toString();
  return apiFetch<TaskBatch[]>(`/api/batches${qStr ? `?${qStr}` : ''}`);
}

export async function getBatchesPage(params: { project?: string; status?: string; limit: number; offset?: number; cursor?: string }): Promise<TaskBatchPage> {
  const query = new URLSearchParams({ limit: String(params.limit) });
  if (params.project && params.project !== 'all') query.set('project', params.project);
  if (params.status && params.status !== 'all') query.set('status', params.status);
  if (params.cursor) query.set('cursor', params.cursor);
  if (params.offset !== undefined) query.set('offset', String(params.offset));
  return apiFetch<TaskBatchPage>(`/api/batches?${query.toString()}`);
}

export async function getBatch(id: string): Promise<TaskBatch & { tasks: Task[] }> {
  return apiFetch<TaskBatch & { tasks: Task[] }>(`/api/batches/${encodeURIComponent(id)}`);
}

export async function createBatch(data: CreateBatchInput): Promise<TaskBatch & { tasks: Task[] }> {
  return apiFetch<TaskBatch & { tasks: Task[] }>('/api/batches', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function dispatchBatch(id: string): Promise<{ ok: boolean; batchId: string; dispatchedCount: number }> {
  return apiFetch<{ ok: boolean; batchId: string; dispatchedCount: number }>(`/api/batches/${encodeURIComponent(id)}/dispatch`, {
    method: 'POST',
  });
}

export async function discardBatch(id: string): Promise<{ ok: boolean; batchId: string }> {
  return apiFetch<{ ok: boolean; batchId: string }>(`/api/batches/${encodeURIComponent(id)}/discard`, {
    method: 'POST',
  });
}

export async function addTaskToBatch(
  batchId: string,
  data: { slug: string; title: string; body?: string; level?: string; modelChain?: string[]; dependsOn?: string[] },
): Promise<Task> {
  return apiFetch<Task>(`/api/batches/${encodeURIComponent(batchId)}/tasks`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function removeTaskFromBatch(batchId: string, taskId: string): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`/api/batches/${encodeURIComponent(batchId)}/tasks/${encodeURIComponent(taskId)}`, {
    method: 'DELETE',
  });
}
export async function reviewTask(
  id: string,
  data: ReviewTaskInput,
): Promise<Task> {
  return apiFetch<Task>(`/api/tasks/${encodeURIComponent(id)}/review`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function retryTask(id: string, data?: RetryTaskInput): Promise<Task> {
  return apiFetch<Task>(`/api/tasks/${encodeURIComponent(id)}/retry`, {
    method: 'POST',
    body: JSON.stringify(data || {}),
  });
}

export async function retryReviewer(id: string): Promise<Task> {
  return apiFetch<Task>(`/api/tasks/${encodeURIComponent(id)}/review/retry-reviewer`, {
    method: 'POST',
  });
}

export async function deleteWorktree(id: string): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`/api/tasks/${encodeURIComponent(id)}/worktree`, {
    method: 'DELETE',
  });
}

export async function getTaskLog(
  id: string,
  params?: { run?: string; tail?: number },
): Promise<string> {
  const query = new URLSearchParams();
  if (params?.run) query.set('run', params.run);
  if (params?.tail) query.set('tail', String(params.tail));
  const qStr = query.toString();
  return apiFetch<string>(`/api/tasks/${encodeURIComponent(id)}/log${qStr ? `?${qStr}` : ''}`);
}

export async function getTaskRunsPage(
  id: string,
  params?: { limit?: number; offset?: number; cursor?: string },
): Promise<PageResponse<Run>> {
  const query = new URLSearchParams({ limit: String(params?.limit ?? 20) });
  if (params?.offset !== undefined) query.set('offset', String(params.offset));
  if (params?.cursor) query.set('cursor', params.cursor);
  return apiFetch<PageResponse<Run>>(`/api/tasks/${encodeURIComponent(id)}/runs?${query.toString()}`);
}

export async function getProjectNotes(
  projectId: string,
  params?: { since?: number; runningOnly?: boolean; taskId?: string },
): Promise<TaskNote[]> {
  const query = new URLSearchParams();
  if (params?.since !== undefined) query.set('since', String(params.since));
  if (params?.runningOnly) query.set('runningOnly', 'true');
  if (params?.taskId) query.set('taskId', params.taskId);
  const qStr = query.toString();
  return apiFetch<TaskNote[]>(
    `/api/projects/${encodeURIComponent(projectId)}/notes${qStr ? `?${qStr}` : ''}`,
  );
}

export async function getTaskNotes(id: string): Promise<TaskNote[]> {
  const normalizedId = id.replace(/\//g, '~');
  return apiFetch<TaskNote[]>(`/api/tasks/${encodeURIComponent(normalizedId)}/notes`);
}

export async function createTaskNote(
  taskId: string,
  data: { content: string; kind?: 'note' | 'overlap' },
): Promise<TaskNote> {
  const normalizedId = taskId.replace(/\//g, '~');
  return apiFetch<TaskNote>(`/api/tasks/${encodeURIComponent(normalizedId)}/notes`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function getConfig(): Promise<SystemConfig> {
  return apiFetch<SystemConfig>('/api/config');
}

export async function updateConfig(data: Partial<SystemConfig>): Promise<SystemConfig> {
  return apiFetch<SystemConfig>('/api/config', {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function shutdownHub(disable = false): Promise<{ ok: boolean; queued: number; reviewers: number }> {
  return apiFetch('/api/hub/shutdown', { method: 'POST', body: JSON.stringify({ disable }) });
}

export async function uploadBrandingLogo(file: File): Promise<{ ok: boolean; logo: string }> {
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error || new Error(getActiveLocale() === 'en' ? 'Failed to read logo file' : 'Không thể đọc logo'));
    reader.readAsDataURL(file);
  });
  return apiFetch('/api/branding/logo', { method: 'PUT', body: JSON.stringify({ mimeType: file.type, data }) });
}

export async function getSavings(params?: {
  project?: string;
  since?: string;
  limit?: number;
  offset?: number;
  cursor?: string;
}): Promise<SavingsReport> {
  const query = new URLSearchParams();
  if (params?.project) query.set('project', params.project);
  if (params?.since) query.set('since', params.since);
  if (params?.limit !== undefined) query.set('limit', String(params.limit));
  if (params?.offset !== undefined) query.set('offset', String(params.offset));
  if (params?.cursor) query.set('cursor', params.cursor);
  const qStr = query.toString();
  return apiFetch<SavingsReport>(`/api/savings${qStr ? `?${qStr}` : ''}`);
}

export async function getDailyUsage(days = 7): Promise<DailyUsageReport> {
  const query = new URLSearchParams();
  if (days != null) query.set('days', String(days));
  const qStr = query.toString();
  return apiFetch<DailyUsageReport>(`/api/usage/daily${qStr ? `?${qStr}` : ''}`);
}

export interface TelegramChat {
  id: number;
  name: string;
  username?: string;
  kind?: 'chat' | 'group' | 'supergroup' | 'channel';
  projectId?: string;
}

export interface TelegramProjectTopic {
  chatId: number;
  threadId: number;
}

export interface TelegramStatus {
  enabled: boolean;
  hasToken: boolean;
  chats: TelegramChat[];
  allowedChatIds: number[];
  topicMode?: 'project' | 'department';
  projectTopics: Record<string, TelegramProjectTopic>;
  departmentTopics?: Record<string, TelegramProjectTopic>;
  notify: {
    reviewReady: boolean;
    failed: boolean;
    blocked: boolean;
    quotaPerModel: boolean;
    quotaAllExhausted: boolean;
    fallback: boolean;
  };
}

export interface TelegramPairingCode {
  code: string;
  expiresInSec: number;
  enabled: boolean;
  allowedChatIds: number[];
  chats: TelegramChat[];
}

export async function getTelegramStatus(): Promise<TelegramStatus> {
  return apiFetch<TelegramStatus>('/api/telegram/status');
}

export async function putTelegramToken(token: string): Promise<{ hasToken: boolean }> {
  return apiFetch<{ hasToken: boolean }>('/api/telegram/token', {
    method: 'PUT',
    body: JSON.stringify({ token }),
  });
}

export async function testTelegram(): Promise<{
  ok: boolean;
  bot: { id: number; name: string; username?: string };
}> {
  return apiFetch('/api/telegram/test', { method: 'POST' });
}

export async function getTelegramPairingCode(refresh = false): Promise<TelegramPairingCode> {
  return apiFetch(`/api/telegram/pairing-code${refresh ? '?refresh=1' : ''}`);
}

export async function createTelegramPairCode(): Promise<TelegramPairingCode> {
  return apiFetch<TelegramPairingCode>('/api/telegram/pair-code', { method: 'POST' });
}

export async function removeTelegramChat(id: number): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`/api/telegram/chats/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export async function createTelegramTopics(): Promise<Record<string, TelegramProjectTopic>> {
  return apiFetch<Record<string, TelegramProjectTopic>>('/api/telegram/topics/setup', { method: 'POST' });
}

export async function createTelegramProjectTopic(projectId: string): Promise<TelegramProjectTopic> {
  return apiFetch<TelegramProjectTopic>(`/api/telegram/projects/${encodeURIComponent(projectId)}/topic`, { method: 'POST' });
}

export async function createTelegramDepartmentTopic(departmentId: string): Promise<TelegramProjectTopic> {
  return apiFetch<TelegramProjectTopic>(`/api/telegram/departments/${encodeURIComponent(departmentId)}/topic`, { method: 'POST' });
}

export async function attachTelegramProjectChat(projectId: string, chatId: number): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`/api/telegram/projects/${encodeURIComponent(projectId)}/chat`, {
    method: 'PUT', body: JSON.stringify({ chatId }),
  });
}

export async function updateTelegramConfig(data: {
  enabled?: boolean;
  topicMode?: 'project' | 'department';
  notify?: Partial<TelegramStatus['notify']>;
}): Promise<SystemConfig> {
  return apiFetch<SystemConfig>('/api/config', {
    method: 'PUT',
    body: JSON.stringify({ telegram: data }),
  });
}
