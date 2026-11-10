import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AgentHubConfig, TelegramChat, TelegramProjectTopic, saveConfig, updateConfigInMemory } from './config.js';
import { EventBus } from './scheduler/index.js';
import { BrainDirectiveRepo, TaskRepo, ProjectRepo, DepartmentRepo, DepartmentRow, TaskRow, ProjectRow, QuotaMarkRepo, TaskBatchRow, ProfileRepo, EventRepo, CiRepo } from './db/index.js';
import { AppService, toTaskId, toRouteId } from './services/index.js';
import type { ChatService } from './chat/service.js';
import { planningRule } from './chat/claude.js';
import {
  DecisionTracker,
  DigestData,
  generateDigest,
  isQuietHours,
  isSystemIncident,
  forwardDecisionToBrain,
  getMinutesSinceTime,
} from './brain/digest.js';
import { effectiveBrainMode } from './brain/mode.js';
import { projectSettings, mergeProjectSettings } from './projects/settings.js';
import { canAlwaysAllowCommand, commandPermissionLabel } from './chat/permissions.js';
import { formatReset } from './time-format.js';
import { NotificationDeduper } from './notification-dedupe.js';
import { reviewerSettingsFromLegacy } from './reviewer-config.js';
import { QuotaService, QuotaCapacitySnapshot } from './quota/index.js';
import { autoMergeReasonLabel, firstCheckError } from './auto-merge-notify.js';
import { formatYYYYMMDD } from './integrations/openproject/daily-report.js';

export interface TelegramTimesheetCommand { ticket: string | 'new'; activeHours: number; waitHours: number; pinned: boolean; description: string; }
export function parseTimesheetCommand(text: string): TelegramTimesheetCommand {
  const match = text.trim().match(/^(new|[A-Za-z0-9_-]+)\s+(\d+(?:\.\d+)?)h(?:\s+cho\s+(\d+(?:\.\d+)?)h)?(?:\s+(co-dinh))?\s+(.+)$/i);
  if (!match) throw new Error('Cú pháp: /gio <mã ticket|new> <giờ>h [cho <giờ>h] [co-dinh] <mô tả>');
  const activeHours = Number(match[2]); const waitHours = Number(match[3] || 0);
  if (activeHours < 0 || waitHours < 0 || activeHours + waitHours <= 0 || activeHours + waitHours > 24) throw new Error('Tổng giờ phải lớn hơn 0 và không quá 24 giờ');
  return { ticket: match[1].toLowerCase() === 'new' ? 'new' : match[1], activeHours, waitHours, pinned: Boolean(match[4]), description: match[5].trim() };
}


const WAITING_QUOTA_BATCH_DELAY_MS = 100;

const execFileAsync = promisify(execFile);

export type GitDiffFn = (
  cmd: string,
  args: string[],
  options: { cwd: string; timeout: number },
) => Promise<{ stdout: string }>;

export function isProjectMergeEnabled(project?: ProjectRow | null): boolean {
  if (!project?.merge) return false;
  try {
    const parsed = typeof project.merge === 'string' ? JSON.parse(project.merge) : project.merge;
    return Boolean(parsed && typeof parsed === 'object' && (parsed as { enabled?: boolean }).enabled);
  } catch {
    return false;
  }
}

export function slugify(title: string): string {
  const withoutDiacritics = title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');

  const kebab = withoutDiacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/, '');

  return kebab || 'task';
}

export function generateTaskSlug(title: string, projectId: string, taskRepo: TaskRepo): string {
  const baseSlug = slugify(title);
  let slug = baseSlug;
  let counter = 2;
  while (taskRepo.get(`${projectId}/${slug}`)) {
    slug = `${baseSlug}-${counter}`;
    counter += 1;
  }
  return slug;
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: {
      id: number;
      is_bot?: boolean;
      first_name?: string;
      username?: string;
    };
    chat: {
      id: number;
      type: string;
      title?: string;
      username?: string;
      first_name?: string;
    };
    message_thread_id?: number;
    date: number;
    text?: string;
    reply_to_message?: { message_id: number; text?: string };
  };
  callback_query?: {
    id: string;
    from: {
      id: number;
      first_name?: string;
      username?: string;
    };
    message?: {
      message_id: number;
      message_thread_id?: number;
      chat: {
        id: number;
      };
      text?: string;
    };
    data?: string;
  };
}

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface TelegramServiceOptions {
  config: AgentHubConfig;
  service: AppService;
  eventBus: EventBus;
  taskRepo: TaskRepo;
  projectRepo: ProjectRepo;
  departmentRepo?: DepartmentRepo;
  profileRepo?: ProfileRepo;
  quotaMarkRepo?: QuotaMarkRepo;
  quotaService?: QuotaService;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  sleepFn?: (ms: number) => Promise<void>;
  execFile?: GitDiffFn;
  tokenOverride?: string;
  chatService?: ChatService;
  brainSession?: boolean;
  directiveRepo?: BrainDirectiveRepo;
  ciRepo?: CiRepo;
}

export type PendingChatState =
  | { action: 'reject_feedback'; taskId: string }
  | { action: 'triage_note'; sourceId: string; wpId: number; decision: 'ask' | 'skip' }
  | { action: 'newtask_description'; projectId?: string }
  | { action: 'newtask_project_description'; description: string; externalRef?: string }
  | { action: 'newtask_project' }
  | { action: 'newtask_title'; projectId: string }
  | { action: 'newtask_body'; projectId: string; title: string; bodyLines: string[] }
  | { action: 'newtask_level'; projectId: string; title: string; body: string }
  | {
      action: 'newtask_model';
      projectId: string;
      title: string;
      body: string;
      level: 'easy' | 'hard';
      defaultModel: string;
    }
  | {
      action: 'newtask_confirm';
      projectId: string;
      title: string;
      body: string;
      level: 'easy' | 'hard';
      slug: string;
      modelChain?: string[];
      modelDisplay: string;
    };

interface SendQueueItem {
  chatId: number;
  threadId?: number | null;
  text: string;
  replyMarkup?: { inline_keyboard: InlineKeyboardButton[][] };
  resolve: (res: unknown) => void;
  reject: (err: unknown) => void;
}

interface ChatReplyState {
  chatId: number;
  messageId: number;
  threadId?: number;
  text: string;
  lastEditAt: number;
  editTimer?: NodeJS.Timeout;
  editing: boolean;
}

export function redactTelegramToken(value: unknown, token: string | null): string {
  const text = value instanceof Error ? value.message : String(value);
  return token ? text.split(token).join('<redacted>') : text;
}

export function readTelegramToken(tokenPath: string): string | null {
  if (!fs.existsSync(tokenPath)) {
    return null;
  }
  try {
    try {
      const stat = fs.statSync(tokenPath);
      if ((stat.mode & 0o777) !== 0o600) {
        fs.chmodSync(tokenPath, 0o600);
      }
    } catch {
      // ignore
    }
    const content = fs.readFileSync(tokenPath, 'utf-8').trim();
    return content.length > 0 ? content : null;
  } catch {
    return null;
  }
}


/** Shown by Telegram when the user types "/" (registered with setMyCommands on start). */
export const TELEGRAM_BOT_COMMANDS: Array<{ command: string; description: string }> = [
  { command: 'gio', description: 'Thêm/xem bảng giờ: /gio <ticket|new> <giờ>h [cho <giờ>h] [co-dinh] <mô tả>' },
  { command: 'use', description: 'Chọn dự án: /use <dự án> · xem dự án đang chọn: /use' },
  { command: 'projects', description: 'Danh sách dự án, bấm để chọn nhanh' },
  { command: 'ask', description: 'Hỏi/trao đổi với bộ não: /ask <câu hỏi>' },
  { command: 'brain', description: 'Bộ não: /brain · /brain trust [dự án] standard|trusted|full|inherit' },
  { command: 'digest', description: 'Tóm tắt tình hình hệ thống và quota' },
  { command: 'plans', description: '5 kế hoạch gần nhất và tiến độ' },
  { command: 'ci', description: 'Trạng thái CI gần nhất và job lỗi: /ci [dự án]' },
  { command: 'knowledge', description: 'Kiến thức ghim và checklist của dự án đang chọn' },
  { command: 'directives', description: 'Chỉ thị cho bộ não: /directives · add <nội dung> · del <id>' },
  { command: 'status', description: 'Tình hình hub: task, worker, quota' },
  { command: 'focus', description: 'Tập trung tài nguyên cho một dự án: /focus <dự án>|off' },
  { command: 'shutdown', description: 'Tắt AgentHub (bật lại từ máy bằng agenthub start)' },
  { command: 'restart', description: 'Khởi động lại khi rảnh; /restart now để xác nhận khởi động lại ngay' },
  { command: 'tasks', description: 'Danh sách task (lọc: /tasks running)' },
  { command: 'task', description: 'Chi tiết một task: /task <id>' },
  { command: 'newtask', description: 'Tạo task từ một đoạn mô tả chung' },
  { command: 'newtask_detail', description: 'Tạo task chi tiết theo từng bước' },
  { command: 'plan', description: 'Lên kế hoạch: /plan <project> <mục tiêu>' },
  { command: 'drafts', description: 'Task/đợt nháp chờ giao' },
  { command: 'approve', description: 'Duyệt & merge: /approve <id>' },
  { command: 'deploy', description: 'Chạy deploy gần nhất: /deploy <project> [push]' },
  { command: 'reject', description: 'Trả về: /reject <id> <nhận xét>' },
  { command: 'review', description: 'Xem và đổi thứ tự reviewer: /review order' },
  { command: 'retry', description: 'Chạy lại task: /retry <id>' },
  { command: 'log', description: 'Xem log cuối của task: /log <id>' },
  { command: 'cancel', description: 'Huỷ task: /cancel <id>' },
  { command: 'pause', description: 'Tạm dừng giao task mới' },
  { command: 'resume', description: 'Tiếp tục giao task' },
  { command: 'new', description: 'Mở phiên chat mới với Claude' },
  { command: 'stop', description: 'Dừng câu trả lời đang chạy' },
  { command: 'compact', description: 'Nén ngữ cảnh phiên chat' },
  { command: 'help', description: 'Hướng dẫn sử dụng' },
  { command: 'rules', description: 'Quy tắc quyền đã cấp: /rules · /rules del <số>' },
  { command: 'topics', description: 'Tạo topic cho các dự án: /topics setup' },
];


/** Identical notification texts are sent at most once per window. */
const NOTIFY_REPEAT_WINDOW_MS = 30 * 60 * 1000;
export class TelegramBotService {
  private config: AgentHubConfig;
  private service: AppService;
  private eventBus: EventBus;
  private taskRepo: TaskRepo;
  private projectRepo: ProjectRepo;
  private profileRepo?: ProfileRepo;
  private quotaMarkRepo?: QuotaMarkRepo;
  private quotaService?: QuotaService;
  private ciRepo?: CiRepo;
  private lastSentCi = new Map<string, number>();
  private lastSentDisk = new Map<'low' | 'ok', number>();
  private diskBlockedNotified = false;
  private lastSentDiskBlocked = 0;
  private lastSentDiskBlockedByPath = new Map<string, number>();
  private lastSentLoadSummary = 0;
  private lastBroadcast = new Map<string, number>();
  private fetchFn: typeof fetch;
  private now: () => number;
  private get appName(): string { return this.config.branding?.name || 'AgentHub'; }
  private sleepFn: (ms: number) => Promise<void>;
  private execFileFn: GitDiffFn;
  private chatService?: ChatService;
  private brainSession: boolean;
  private directiveRepo?: BrainDirectiveRepo;
  private decisionTracker = new DecisionTracker();
  private quietHoursQueue: Array<{ text: string; timestamp: number }> = [];
  private lastDigestDate = '';
  private lastMorningSummaryDate = '';
  private timerInterval?: NodeJS.Timeout;

  private token: string | null = null;
  private running = false;
  private pollAbortController: AbortController | null = null;
  private pollPromise: Promise<void> | null = null;

  // Pairing state (6 digits, expires in 10 minutes)
  private pairingCode: string | null = null;
  private pairingExpiresAt = 0;
  private pairingInvalidAttempts = 0;
  private pairingAttemptsByChat = new Map<number, number[]>();

  // Pending user input state per chat (e.g. entering feedback for reject)
  private chatStates = new Map<number, PendingChatState>();
  private triageReplies = new Map<string, { sourceId: string; wpId: number }>();

  // Anti-flood: message queue per chat and last send timestamp
  private chatQueues = new Map<number, SendQueueItem[]>();
  private chatProcessing = new Map<number, boolean>();
  private chatLastSent = new Map<number, number>();

  // Deduplication for event notifications
  private lastNotificationTime = new Map<string, number>();
  private allQuotaNotified = new Set<string>();
  private quotaIncidentActive = false;
  private waitingQuotaNotified = false;
  private waitingQuotaCheckTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly eventDeduper: NotificationDeduper;
  private brainWaitingNotified = new Set<string>();
  private focusDigest = new Map<string, number>();
  private reviewFallbackNotified = new Set<string>();
  private mergeConflictNotified = new Set<string>();

  // Bound handler for EventBus
  private boundEventHandler: ((type: string, taskId?: string, payload?: unknown) => void) | null = null;
  private chatReplies = new Map<string, ChatReplyState>();
  /** Telegram messages waiting for a busy session; each gets the reply of its queued turn. */
  private queuedChatTurns = new Map<string, Array<{ chatId: number; messageId: number; threadId?: number }>>();
  private brainQuestions = new Map<string, Map<string, {
    chatId: number;
    userMessageId?: string;
    assistantMessageId?: string;
  }>>();
  private chatSessions = new Map<number, string>();
  private pendingAutoTasks = new Map<string, { chatId: number; projectId: string; description: string; externalRef?: string }>();
  /** Project đã được báo "hết task"; xoá khi project lại có task đang chạy. */
  private projectIdleNotified = new Set<string>();
  /** Per-chat selected project (persisted in config.telegram.chats). */
  private selectedProject = new Map<number, string>();
  private selectedDepartment = new Map<number, string>();
  private activeThreadByChat = new Map<number, number | undefined>();
  public departmentRepo?: DepartmentRepo;
  private notificationProjectId: string | null = null;
  /** Keeps same-text system events from different projects independently deduplicated. */
  private notificationDedupProjectId: string | null = null;
  /** Maps bot reply message ID to brain session ID for continuing conversation on reply (max 200 items). */
  private askReplySessions = new Map<number, string>();

  constructor(opts: TelegramServiceOptions) {
    this.config = opts.config;
    this.service = opts.service;
    this.eventBus = opts.eventBus;
    this.taskRepo = opts.taskRepo;
    this.projectRepo = opts.projectRepo;
    this.departmentRepo = opts.departmentRepo || (opts.service as unknown as { departmentRepo?: DepartmentRepo })?.departmentRepo;
    this.profileRepo = opts.profileRepo || (opts.service as unknown as { profileRepo?: ProfileRepo })?.profileRepo;
    this.quotaMarkRepo = opts.quotaMarkRepo;
    this.quotaService = opts.quotaService || (this.profileRepo && opts.quotaMarkRepo ? new QuotaService(opts.quotaMarkRepo, this.profileRepo) : undefined);
    this.ciRepo = opts.ciRepo;
    this.fetchFn = opts.fetch || globalThis.fetch;
    this.now = opts.now || (() => Date.now());
    this.eventDeduper = new NotificationDeduper({ now: this.now });
    this.sleepFn = opts.sleep || opts.sleepFn || ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.execFileFn = (opts.execFile || execFileAsync) as GitDiffFn;
    this.chatService = opts.chatService;
    this.brainSession = opts.brainSession === true;
    this.directiveRepo = opts.directiveRepo;

    if (opts.tokenOverride) {
      this.token = opts.tokenOverride;
    } else {
      this.refreshToken();
    }

    // Restore per-chat project selection from config
    for (const chat of this.config.telegram?.chats || []) {
      if (chat.projectId) {
        this.selectedProject.set(chat.id, chat.projectId);
      }
    }
  }

  refreshToken(): void {
    const tokenFile =
      this.config.telegram?.botTokenFile ||
      path.join(this.config.hubHome, 'secrets', 'telegram.token');
    this.token = readTelegramToken(tokenFile);
  }

  private quotaCapacity(): QuotaCapacitySnapshot | null {
    if (!this.quotaService || !this.profileRepo || this.profileRepo.getAll().length === 0) return null;
    return this.quotaService.capacitySnapshot(undefined, Math.floor(this.now() / 1000));
  }

  private isAllQuotaExhausted(payload?: Record<string, unknown>, now = this.now()): boolean {
    const snapshot = this.quotaCapacity();
    const hasProfiles = Boolean(this.profileRepo && this.profileRepo.getAll().length > 0);
    return snapshot
      ? snapshot.runnable.length === 0
      : (hasProfiles && this.quotaMarkRepo
          ? new QuotaService(this.quotaMarkRepo, this.profileRepo!).runnableCapacity(undefined, Math.floor(now / 1000)).length === 0
          : Boolean(payload?.allExhausted === true));
  }

  private quotaIncidentMessage(snapshot: QuotaCapacitySnapshot | null): string {
    const next = snapshot?.nextReset;
    const reset = next ? ` Sớm nhất có lại: ${this.escapeHtml(next.profileName)}/${this.escapeHtml(next.model)} lúc ${this.escapeHtml(formatReset(next.at, this.now()))}.` : '';
    return `🚨 <b>Hết sạch quota ở mọi tài khoản và model</b> — các task đang chờ quota.${reset}\nHệ thống tạm dừng thực thi task.`;
  }

  setToken(token: string | null): void {
    this.token = token;
  }

  async testConnection(): Promise<{ id: number; name: string; username?: string }> {
    if (!this.token) throw new Error('Chưa cấu hình Telegram bot token');
    const url = `https://api.telegram.org/bot${this.token}/getMe`;
    let response: Response;
    try {
      response = await this.fetchFn(url, { method: 'POST' });
    } catch (error) {
      throw new Error(`Telegram getMe request failed: ${redactTelegramToken(error, this.token)}`);
    }
    const data = (await response.json()) as {
      ok: boolean;
      description?: string;
      result?: { id: number; first_name?: string; last_name?: string; username?: string };
    };
    if (!response.ok || !data.ok || !data.result) {
      throw new Error(data.description || `Telegram getMe failed with status ${response.status}`);
    }
    return {
      id: data.result.id,
      name: [data.result.first_name, data.result.last_name].filter(Boolean).join(' ') || data.result.username || 'Telegram bot',
      ...(data.result.username ? { username: data.result.username } : {}),
    };
  }

  hasValidToken(): boolean {
    return Boolean(this.token && this.token.length > 0);
  }

  /**
   * Generates or retrieves the 6-digit pairing code (valid for 10 minutes).
   */
  getPairingCode(forceNew = false): { code: string; expiresInSec: number } {
    const now = this.now();
    if (!forceNew && this.pairingCode && this.pairingExpiresAt > now) {
      return {
        code: this.pairingCode,
        expiresInSec: Math.max(0, Math.round((this.pairingExpiresAt - now) / 1000)),
      };
    }

    // Generate new 6-digit code
    this.pairingCode = crypto.randomInt(100000, 1000000).toString();
    this.pairingExpiresAt = now + 10 * 60 * 1000;
    this.pairingInvalidAttempts = 0;
    this.pairingAttemptsByChat.clear();

    return {
      code: this.pairingCode,
      expiresInSec: 600,
    };
  }

  /**
   * Add a chat ID to allowedChatIds and persist to config.json.
   * If the chat was previously configured with a selected project via /use (or kind),
   * preserve existing projectId and kind unless explicitly overridden.
   */
  addAllowedChatId(chatId: number, chat?: TelegramChat): void {
    const existing = (this.config.telegram.chats || []).find((item) => item.id === chatId);
    const resolvedChat: TelegramChat | undefined = chat
      ? {
          ...chat,
          ...(existing?.kind !== undefined && chat.kind === undefined ? { kind: existing.kind } : {}),
          ...(existing?.projectId !== undefined && chat.projectId === undefined ? { projectId: existing.projectId } : {}),
        }
      : undefined;

    if (!this.config.telegram.allowedChatIds.includes(chatId)) {
      this.config.telegram.allowedChatIds.push(chatId);
    }

    if (resolvedChat) {
      this.config.telegram.chats = (this.config.telegram.chats || []).filter((item) => item.id !== chatId);
      this.config.telegram.chats.push(resolvedChat);
      if (resolvedChat.projectId) {
        this.selectedProject.set(chatId, resolvedChat.projectId);
      }
    }

    updateConfigInMemory(this.config, { telegram: this.config.telegram });
    saveConfig(this.config.hubHome, { telegram: this.config.telegram });
  }

  getProjectTopics(): Record<string, TelegramProjectTopic> {
    return { ...(this.config.telegram.projectTopics || {}) };
  }

  async createProjectTopic(projectId: string): Promise<TelegramProjectTopic> {
    const project = this.projectRepo.get(projectId);
    if (!project) throw new Error(`Không tìm thấy dự án "${projectId}"`);
    const existing = this.config.telegram.projectTopics?.[projectId];
    if (existing) return existing;
    const chatId = this.config.telegram.allowedChatIds.find((id) => {
      const chat = this.config.telegram.chats.find((item) => item.id === id);
      return !chat?.projectId;
    }) ?? this.config.telegram.allowedChatIds[0];
    if (chatId === undefined) throw new Error('Chưa có chat Telegram được cho phép');
    if (!this.token) throw new Error('Chưa cấu hình Telegram bot token');
    const response = await this.fetchFn(`https://api.telegram.org/bot${this.token}/createForumTopic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, name: project.name }),
    });
    const data = await response.json() as { ok: boolean; description?: string; result?: { message_thread_id?: number } };
    if (!response.ok || !data.ok || typeof data.result?.message_thread_id !== 'number') {
      throw new Error(data.description || `Telegram createForumTopic failed with status ${response.status}`);
    }
    const topic = { chatId, threadId: data.result.message_thread_id };
    this.config.telegram.projectTopics = { ...(this.config.telegram.projectTopics || {}), [projectId]: topic };
    updateConfigInMemory(this.config, { telegram: this.config.telegram });
    saveConfig(this.config.hubHome, { telegram: this.config.telegram });
    return topic;
  }

  async setupProjectTopics(): Promise<Record<string, TelegramProjectTopic>> {
    for (const project of this.projectRepo.getAll()) {
      if (!this.config.telegram.projectTopics?.[project.id]) {
        try { await this.createProjectTopic(project.id); } catch (error) {
          console.error(`[telegram] topic setup failed for ${project.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    return this.getProjectTopics();
  }

  async ensureProjectTopic(projectId: string): Promise<void> {
    if (!this.config.telegram.enabled || this.config.telegram.projectTopics?.[projectId]) return;
    try { await this.createProjectTopic(projectId); } catch { /* topic setup is best effort */ }
  }

  getDepartmentTopics(): Record<string, TelegramProjectTopic> {
    const fromConfig = { ...(this.config.telegram.departmentTopics || {}) };
    const defaultChatId = this.config.telegram.allowedChatIds.find((id) => id < 0) ?? this.config.telegram.allowedChatIds[0];
    if (defaultChatId !== undefined && this.departmentRepo) {
      for (const dept of this.departmentRepo.getAll()) {
        if (dept.telegramTopicId && !fromConfig[dept.id]) {
          fromConfig[dept.id] = { chatId: defaultChatId, threadId: dept.telegramTopicId };
        }
      }
    }
    return fromConfig;
  }

  getDepartmentTopic(departmentId: string): TelegramProjectTopic | undefined {
    return this.getDepartmentTopics()[departmentId];
  }

  findDepartmentByTopic(chatId: number, threadId: number): DepartmentRow | undefined {
    for (const [deptId, topic] of Object.entries(this.getDepartmentTopics())) {
      if (topic.chatId === chatId && topic.threadId === threadId) {
        return this.departmentRepo?.get(deptId);
      }
    }
    return undefined;
  }

  async createDepartmentTopic(departmentId: string, targetChatId?: number): Promise<TelegramProjectTopic> {
    const dept = this.departmentRepo?.get(departmentId);
    if (!dept) throw new Error(`Không tìm thấy phòng ban "${departmentId}"`);
    const existing = this.config.telegram.departmentTopics?.[departmentId];
    if (existing) return existing;
    const chatId = targetChatId ?? this.config.telegram.allowedChatIds.find((id) => {
      const chat = this.config.telegram.chats?.find((item) => item.id === id);
      return !chat?.projectId && (chat?.kind === 'supergroup' || chat?.kind === 'group' || id < 0);
    }) ?? this.config.telegram.allowedChatIds.find((id) => id < 0) ?? this.config.telegram.allowedChatIds.find((id) => {
      const chat = this.config.telegram.chats?.find((item) => item.id === id);
      return !chat?.projectId;
    }) ?? this.config.telegram.allowedChatIds[0];
    if (chatId === undefined) throw new Error('Chưa có chat Telegram được cho phép');
    if (!this.token) throw new Error('Chưa cấu hình Telegram bot token');
    const response = await this.fetchFn(`https://api.telegram.org/bot${this.token}/createForumTopic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, name: dept.name }),
    });
    const data = await response.json() as { ok: boolean; description?: string; result?: { message_thread_id?: number } };
    if (!response.ok || !data.ok || typeof data.result?.message_thread_id !== 'number') {
      throw new Error(data.description || `Telegram createForumTopic failed with status ${response.status}`);
    }
    const topic = { chatId, threadId: data.result.message_thread_id };
    this.config.telegram.departmentTopics = { ...(this.config.telegram.departmentTopics || {}), [departmentId]: topic };
    this.departmentRepo?.update(departmentId, { telegramTopicId: topic.threadId });
    updateConfigInMemory(this.config, { telegram: this.config.telegram });
    saveConfig(this.config.hubHome, { telegram: this.config.telegram });
    return topic;
  }

  async setupDepartmentTopics(): Promise<Record<string, TelegramProjectTopic>> {
    for (const dept of this.departmentRepo?.getAll() || []) {
      if (!this.config.telegram.departmentTopics?.[dept.id] && !dept.telegramTopicId) {
        try { await this.createDepartmentTopic(dept.id); } catch (error) {
          console.error(`[telegram] topic setup failed for department ${dept.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    return this.getDepartmentTopics();
  }

  async setupTopics(mode?: 'project' | 'department'): Promise<Record<string, TelegramProjectTopic>> {
    const targetMode = mode || this.config.telegram.topicMode || 'project';
    if (mode && this.config.telegram.topicMode !== mode) {
      this.config.telegram.topicMode = mode;
      updateConfigInMemory(this.config, { telegram: this.config.telegram });
      saveConfig(this.config.hubHome, { telegram: this.config.telegram });
    }
    if (targetMode === 'department') {
      return this.setupDepartmentTopics();
    }
    return this.setupProjectTopics();
  }

  getSelectedDepartment(chatId: number): string | undefined {
    return this.selectedDepartment.get(chatId);
  }

  setDepartmentTopic(departmentId: string, topic: TelegramProjectTopic): void {
    this.config.telegram.departmentTopics = {
      ...(this.config.telegram.departmentTopics || {}),
      [departmentId]: topic,
    };
    this.departmentRepo?.update(departmentId, { telegramTopicId: topic.threadId });
    updateConfigInMemory(this.config, { telegram: this.config.telegram });
    saveConfig(this.config.hubHome, { telegram: this.config.telegram });
  }

  setProjectChat(projectId: string, chatId: number): void {
    if (!this.config.telegram.allowedChatIds.includes(chatId)) throw new Error('Chat chưa được cho phép');
    const chats = this.config.telegram.chats.filter((chat) => chat.id !== chatId);
    const existing = this.config.telegram.chats.find((chat) => chat.id === chatId);
    chats.push({ id: chatId, name: existing?.name || `Chat ${chatId}`, ...(existing?.username ? { username: existing.username } : {}), kind: 'chat', projectId });
    this.config.telegram.chats = chats;
    this.selectedProject.set(chatId, projectId);
    updateConfigInMemory(this.config, { telegram: this.config.telegram });
    saveConfig(this.config.hubHome, { telegram: this.config.telegram });
  }

  /**
   * Start the Telegram bot service: subscribes to EventBus and begins long polling.
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    // Refresh token in case it was created/updated on disk
    if (!this.token) {
      this.refreshToken();
    }

    // Subscribe to EventBus notifications
    if (!this.boundEventHandler) {
      this.boundEventHandler = (type: string, taskId?: string, payload?: unknown) => {
        this.handleEvent(type, taskId, payload);
        this.handleChatEvent(type, taskId, payload);
      };
      this.eventBus.on('*', this.boundEventHandler);
    }

    // Begin long polling loop in the background
    this.pollPromise = this.startPollingLoop();

    // Periodic check for digest & decision reminders
    if (!this.timerInterval) {
      this.timerInterval = setInterval(() => {
        void this.periodicCheck();
      }, 60_000);
    }
    void this.registerCommands();
  }

  /** Register the "/" command menu with Telegram; best effort, never blocks or throws. */
  private async registerCommands(): Promise<void> {
    // Network to Telegram can be flaky right after boot: retry a few times.
    for (let attempt = 1; attempt <= 5 && this.running && this.token; attempt += 1) {
      try {
        const res = await this.fetchFn(`https://api.telegram.org/bot${this.token}/setMyCommands`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ commands: TELEGRAM_BOT_COMMANDS }),
        });
        if (res.ok) return;
        console.error(`[telegram] setMyCommands failed with status ${res.status}`);
      } catch (error) {
        console.error(`[telegram] setMyCommands failed: ${redactTelegramToken(error, this.token)}`);
      }
      await this.sleepFn(30_000 * attempt);
    }
  }

  /**
   * Stop the Telegram bot service gracefully.
   */
  async stop(): Promise<void> {
    this.running = false;

    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = undefined;
    }
    if (this.waitingQuotaCheckTimer) {
      clearTimeout(this.waitingQuotaCheckTimer);
      this.waitingQuotaCheckTimer = undefined;
    }

    if (this.pollAbortController) {
      this.pollAbortController.abort();
      this.pollAbortController = null;
    }

    if (this.boundEventHandler) {
      this.eventBus.off('*', this.boundEventHandler);
      this.boundEventHandler = null;
    }
    for (const reply of this.chatReplies.values()) {
      if (reply.editTimer) clearTimeout(reply.editTimer);
    }
    this.chatReplies.clear();
    this.askReplySessions.clear();

    if (this.pollPromise) {
      try {
        await this.pollPromise;
      } catch {
        // ignore
      }
      this.pollPromise = null;
    }
  }

  getDashboardUrl(subPath = ''): string {
    const base = `http://127.0.0.1:${this.config.port}/`;
    return subPath ? `${base}#${subPath}` : base;
  }

  getDecisionTracker(): DecisionTracker {
    return this.decisionTracker;
  }

  getQuietHoursQueue(): Array<{ text: string; timestamp: number }> {
    return [...this.quietHoursQueue];
  }

  flushQuietHoursQueue(): Array<{ text: string; timestamp: number }> {
    const queue = [...this.quietHoursQueue];
    this.quietHoursQueue = [];
    return queue;
  }

  buildCurrentDigest(): DigestData {
    const digest = generateDigest({
      taskRepo: this.taskRepo,
      projectRepo: this.projectRepo,
      profileRepo: this.profileRepo,
      quotaMarkRepo: this.quotaMarkRepo,
      eventRepo: (this.service as unknown as { eventRepo?: EventRepo })?.eventRepo,
      decisionTracker: this.decisionTracker,
      ciRepo: this.ciRepo,
      now: () => this.now(),
      accumulatedQuietHoursMessages: this.quietHoursQueue.map((q) => q.text),
      port: this.config.port,
    });
    const plans = this.buildPlansSummary();
    if (plans) digest.text += `\n\n${plans}`;
    return digest;
  }

  private buildPlansSummary(): string {
    const batches = this.service.listBatches().filter((batch) => batch.status !== 'discarded');
    const active = batches.filter((batch) => batch.progress.total > 0 && batch.progress.done < batch.progress.total && batch.progress.failed === 0).slice(0, 5);
    if (active.length === 0) return '';
    const lines = active.map((batch) => `• ${this.escapeHtml(batch.title)} — ${batch.progress.done}/${batch.progress.total} xong`);
    return `📦 <b>Kế hoạch đang làm</b>\n${lines.join('\n')}`;
  }

  private async handlePlansCommand(chatId: number): Promise<void> {
    const batches = this.service.listBatches().filter((batch) => batch.status !== 'discarded').slice(0, 5);
    if (batches.length === 0) {
      await this.sendMessage(chatId, '📦 Chưa có kế hoạch nào. Khi Claude chia một việc thành nhiều task, kế hoạch sẽ hiện ở đây.');
      return;
    }
    const lines = batches.map((batch) => {
      const state = batch.status === 'draft'
        ? 'Nháp chờ duyệt'
        : batch.progress.failed > 0
          ? 'Có lỗi'
          : batch.progress.total > 0 && batch.progress.done === batch.progress.total
            ? 'Hoàn thành'
            : 'Đang làm';
      return `• <b>${this.escapeHtml(batch.title)}</b> — ${state} (${batch.progress.done}/${batch.progress.total} xong)`;
    });
    await this.sendMessage(chatId, `📦 <b>5 kế hoạch gần nhất</b>\n${lines.join('\n')}`, {
      inline_keyboard: [[{ text: '🌐 Xem trên dashboard', url: this.getDashboardUrl('#/plans') }]],
    });
  }

  async checkDecisionReminders(): Promise<void> {
    if (isQuietHours(this.config.notifications?.quietHours, new Date(this.now()))) {
      return;
    }
    const due = this.decisionTracker.getRemindersDue(this.now(), 2 * 60 * 60 * 1000, 2);
    for (const { decision, reminderIndex } of due) {
      const keyboard: InlineKeyboardButton[][] = [
        [
          { text: '✅ Đồng ý', callback_data: `decision:agree:${decision.id}` },
          { text: '❌ Không', callback_data: `decision:reject:${decision.id}` },
        ],
        [{ text: '🌐 Xem dashboard', url: this.getDashboardUrl() }],
      ];
      const text = `⏰ <b>Nhắc lại quyết định (lần ${reminderIndex}/2):</b>\n${this.escapeHtml(decision.text)}`;
      this.broadcastMessage(text, { inline_keyboard: keyboard });
      this.decisionTracker.markReminderSent(decision.id, this.now());
    }
  }

  buildMorningSummary(): { text: string; keyboard: InlineKeyboardButton[][] } {
    const nowMs = this.now();
    const d = new Date(nowMs);
    const timeStr = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const dateStr = `${timeStr} ${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;

    const queueItems = [...this.quietHoursQueue];
    const pendingDecisions = this.decisionTracker.getPending();

    let text = `🌅 <b>TÓM TẮT BUỔI SÁNG ${this.escapeHtml(this.appName).toUpperCase()}</b>\n<i>${dateStr} (Hết giờ yên tĩnh)</i>\n\n`;

    if (queueItems.length === 0) {
      text += `🔕 <i>Không có thông báo mới trong đêm.</i>\n\n`;
    } else {
      text += `📬 <b>Thông báo trong đêm (${queueItems.length}):</b>\n`;
      const shown = queueItems.slice(0, 10);
      text += shown.map((q) => `• ${this.escapeHtml(q.text)}`).join('\n');
      if (queueItems.length > 10) {
        text += `\n• <i>... và ${queueItems.length - 10} thông báo khác</i>`;
      }
      text += `\n\n`;
    }

    const keyboard: InlineKeyboardButton[][] = [];

    if (pendingDecisions.length > 0) {
      text += `📌 <b>Việc cần quyết định (${pendingDecisions.length}):</b>\n`;
      text += pendingDecisions.map((dec) => {
        const projId = this.extractProjectId(dec.taskId);
        if (this.isMinimalProject(projId)) {
          return `• ${this.projectPrefix(projId)}1 việc cần quyết định — xem dashboard`;
        }
        return `• ${this.projectPrefix(projId)}${this.escapeHtml(dec.text)}`;
      }).join('\n');

      if (pendingDecisions.length === 1) {
        const dec = pendingDecisions[0];
        keyboard.push([
          { text: '✅ Đồng ý', callback_data: `decision:agree:${dec.id}` },
          { text: '❌ Không', callback_data: `decision:reject:${dec.id}` },
        ]);
      } else {
        for (const dec of pendingDecisions.slice(0, 5)) {
          const projId = this.extractProjectId(dec.taskId);
          const short = this.isMinimalProject(projId)
            ? 'Quyết định'
            : (dec.text.length > 20 ? dec.text.slice(0, 17) + '...' : dec.text);
          keyboard.push([
            { text: `✅ ${short}`, callback_data: `decision:agree:${dec.id}` },
            { text: `❌ ${short}`, callback_data: `decision:reject:${dec.id}` },
          ]);
        }
      }
    }

    keyboard.push([{ text: '🌐 Xem dashboard', url: this.getDashboardUrl() }]);

    return { text, keyboard };
  }

  async checkMorningSummary(): Promise<boolean> {
    const qh = this.config.notifications?.quietHours;
    if (!qh || !qh.enabled) return false;

    const nowMs = this.now();
    const d = new Date(nowMs);
    const inQuiet = isQuietHours(qh, d);
    if (inQuiet) return false;

    // Only send if there are queued quiet hours notifications or pending decisions
    const hasContent = this.quietHoursQueue.length > 0 || this.decisionTracker.getPending().length > 0;
    if (!hasContent) return false;

    // Only send within ~2 hours window after quietHours.end
    const minsSinceEnd = getMinutesSinceTime(qh.end || '07:00', d);
    if (minsSinceEnd < 0 || minsSinceEnd > 120) {
      return false;
    }

    const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (this.lastMorningSummaryDate === dateKey) return false;

    this.lastMorningSummaryDate = dateKey;

    const summary = this.buildMorningSummary();
    this.broadcastMessage(summary.text, { inline_keyboard: summary.keyboard });
    this.eventBus.emit('brain.morning_summary', undefined, summary);

    // Reset quiet hours queue after morning summary
    this.quietHoursQueue = [];
    return true;
  }

  async checkScheduledDigest(): Promise<boolean> {
    if (this.config.brain?.digest?.enabled === false) return false;
    const digestTime = this.config.brain?.digest?.time || '18:00';
    const nowMs = this.now();
    const d = new Date(nowMs);
    const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    if (this.lastDigestDate === dateKey) return false;

    // Only send within ~60 minutes window after digestTime
    const minsSinceDigest = getMinutesSinceTime(digestTime, d);
    if (minsSinceDigest < 0 || minsSinceDigest > 60) {
      return false;
    }

    this.lastDigestDate = dateKey;
    const digest = this.buildCurrentDigest();
    const keyboard: InlineKeyboardButton[][] = [
      [{ text: '🌐 Xem dashboard', url: this.getDashboardUrl() }],
    ];
    this.broadcastMessage(digest.text, { inline_keyboard: keyboard }, undefined, 'chung');
    this.eventBus.emit('brain.digest', undefined, digest);

    // Reset quiet hours queue after digest
    this.quietHoursQueue = [];
    return true;
  }

  async periodicCheck(): Promise<void> {
    try {
      this.flushFocusDigest();
      await this.checkDecisionReminders();
      await this.checkMorningSummary();
      await this.checkScheduledDigest();
    } catch {
      // ignore
    }
  }

  private isFocusDeferredEvent(type: string): boolean {
    return type.startsWith('task.') || type.startsWith('assistant.') || type.startsWith('brain.');
  }

  private flushFocusDigest(): void {
    const focusProjectId = this.config.focus?.projectId;
    if (!focusProjectId || this.focusDigest.size === 0) return;
    const parts = [...this.focusDigest.entries()].map(([project, count]) => `${this.escapeHtml(project)}: ${count}`);
    this.focusDigest.clear();
    this.broadcastMessage(`🎯 <b>Tóm tắt khi đang tập trung ${this.escapeHtml(focusProjectId)}</b>\n${parts.join('\n')} thông báo từ project khác`);
  }

  // --- Long Polling ---

  private async startPollingLoop(): Promise<void> {
    let offset = 0;
    let backoffMs = 1000;
    const MAX_BACKOFF = 30000;

    while (this.running) {
      if (!this.token) {
        // Wait and check again if token was added
        await this.sleepFn(3000);
        this.refreshToken();
        continue;
      }

      this.pollAbortController = new AbortController();
      try {
        const updates = await this.fetchUpdates(offset, 25, this.pollAbortController.signal);
        backoffMs = 1000; // Reset backoff on success

        if (updates && updates.length > 0) {
          for (const update of updates) {
            offset = Math.max(offset, update.update_id + 1);
            await this.handleUpdate(update);
          }
        }
      } catch (err) {
        if (!this.running || (err instanceof Error && err.name === 'AbortError')) {
          break;
        }
        // Network error or fetch failed -> exponential backoff
        await this.sleepFn(backoffMs);
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF);
      } finally {
        this.pollAbortController = null;
      }
    }
  }

  private async fetchUpdates(offset: number, timeoutSec = 25, signal?: AbortSignal): Promise<TelegramUpdate[]> {
    if (!this.token) return [];

    const url = `https://api.telegram.org/bot${this.token}/getUpdates`;
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          offset,
          timeout: timeoutSec,
          allowed_updates: ['message', 'callback_query'],
        }),
        signal,
      });
    } catch (err) {
      throw new Error(`Telegram getUpdates request failed: ${redactTelegramToken(err, this.token)}`);
    }

    if (!res.ok) {
      throw new Error(`Telegram getUpdates failed with status ${res.status}`);
    }

    const data = (await res.json()) as { ok: boolean; result?: TelegramUpdate[] };
    return data.ok && Array.isArray(data.result) ? data.result : [];
  }

  /**
   * Process a list of updates directly (useful for tests and manual dispatch).
   */
  async processUpdates(updates: TelegramUpdate[]): Promise<void> {
    for (const update of updates) {
      await this.handleUpdate(update);
    }
  }

  /**
   * Dispatch a single Telegram update (message or callback query).
   */
  async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.message) {
      await this.handleMessage(update.message);
    } else if (update.callback_query) {
      await this.handleCallbackQuery(update.callback_query);
    }
  }

  // --- Message Handling ---

  private async handleMessage(msg: NonNullable<TelegramUpdate['message']>): Promise<void> {
    const chatId = msg.chat.id;
    const threadId = msg.message_thread_id;
    this.activeThreadByChat.set(chatId, threadId);
    if (threadId !== undefined) {
      const topicDept = this.findDepartmentByTopic(chatId, threadId);
      if (topicDept) {
        this.selectedDepartment.set(chatId, topicDept.id);
        this.selectedProject.delete(chatId);
      } else {
        const topicProject = Object.entries(this.config.telegram.projectTopics || {}).find(([, topic]) => topic.chatId === chatId && topic.threadId === threadId)?.[0];
        if (topicProject) {
          this.selectedProject.set(chatId, topicProject);
          this.selectedDepartment.delete(chatId);
        }
      }
    }
    const rawText = (msg.text || '').trim();
    const isAllowed = this.config.telegram?.allowedChatIds?.includes(chatId);

    // 1. Unrecognized / non-allowed chats
    if (!isAllowed) {
      // Check for /start or /pair <mã> pairing command
      const match = rawText.match(/^\/(?:start|pair)(?:\s+(\d{6}))?$/i);
      const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
      const senderId = msg.from?.id;

      // In groups, pairing requires that the sender is an already allowed chat
      if (isGroup && (!senderId || !this.config.telegram?.allowedChatIds?.includes(senderId))) {
        return;
      }

      if (match && match[1] && (msg.chat.type === 'private' || isGroup)) {
        const code = match[1];
        const now = this.now();
        if (this.pairingCode && this.pairingCode === code && this.pairingExpiresAt > now) {
          // Success pairing!
          this.addAllowedChatId(chatId, {
            id: chatId,
            name: msg.chat.title || (msg.chat.first_name ? `${msg.chat.first_name}${msg.chat.username ? ` (@${msg.chat.username})` : ''}` : `Chat ${chatId}`),
            ...(msg.chat.username ? { username: msg.chat.username } : {}),
            kind: isGroup ? (msg.chat.type === 'group' ? 'group' : 'supergroup') : 'chat',
          });
          this.pairingCode = null;
          this.pairingExpiresAt = 0;
          this.pairingInvalidAttempts = 0;
          this.pairingAttemptsByChat.delete(chatId);
          await this.sendDirectMessage(
            chatId,
            isGroup
              ? `✅ Ghép đôi nhóm thành công! Nhóm đã được cấp quyền điều khiển ${this.escapeHtml(this.appName)}.\nGõ /help để xem danh sách các lệnh.`
              : `✅ Ghép đôi thành công! Bạn đã được cấp quyền điều khiển ${this.escapeHtml(this.appName)} từ xa.\nGõ /help để xem danh sách các lệnh.`,
            undefined,
            threadId,
          );
          return;
        }

        if (this.pairingCode && this.pairingExpiresAt > now) {
          const attempts = (this.pairingAttemptsByChat.get(chatId) || []).filter(
            (timestamp) => now - timestamp < 10 * 60 * 1000,
          );
          if (attempts.length < 3) {
            attempts.push(now);
            this.pairingAttemptsByChat.set(chatId, attempts);
            this.pairingInvalidAttempts += 1;
            if (this.pairingInvalidAttempts >= 5) {
              this.pairingCode = null;
              this.pairingExpiresAt = 0;
              this.pairingInvalidAttempts = 0;
              this.pairingAttemptsByChat.clear();
              this.eventBus.emit('telegram.pairing_failed', undefined, {
                reason: 'too_many_invalid_attempts',
                message: 'Mã ghép đôi đã bị huỷ do nhập sai quá nhiều lần.',
              });
            }
          }
        }
      }
      // REQUIREMENT 2: "Chat lạ khác bị bỏ qua (không trả lời)."
      return;
    }

    // 2. Allowed chat - check if user has a pending state (e.g. entering feedback for reject)
    if (msg.reply_to_message?.text && rawText) {
      const displayId = msg.reply_to_message.text.match(/\[([^\]]+)\]/)?.[1];
      const target = displayId ? this.triageReplies.get(displayId) : undefined;
      if (target) {
        try {
          const result = await this.service.submitOpenProjectTriageInput(target.sourceId, target.wpId, rawText);
          await this.sendMessage(chatId, `✅ Đã tạo lượt triage bổ sung: <code>${this.escapeHtml(result.taskId)}</code>`);
        } catch (error) {
          await this.sendMessage(chatId, `❌ Không thể gửi thêm thông tin: ${this.escapeHtml(error instanceof Error ? error.message : String(error))}`);
        }
        return;
      }
    }
    const pendingState = this.chatStates.get(chatId);
    if (pendingState) {
      if (rawText.toLowerCase() === '/cancel') {
        this.chatStates.delete(chatId);
        await this.sendMessage(chatId, 'Đã hủy thao tác.');
        return;
      }

      if (pendingState.action === 'reject_feedback') {
        const taskId = pendingState.taskId;
        this.chatStates.delete(chatId);
        try {
          await this.service.reviewTask(taskId, {
            verdict: 'changes_requested',
            feedback: rawText,
            by: 'telegram',
          });
          await this.sendMessage(chatId, `↩️ Đã trả về task ${taskId} với nhận xét:\n${rawText}`);
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          await this.sendMessage(chatId, `❌ Lỗi khi trả về task ${taskId}: ${errMsg}`);
        }
        return;
      }

      if (pendingState.action === 'triage_note') {
        this.chatStates.delete(chatId);
        if (!rawText) {
          await this.sendMessage(chatId, 'Vui lòng nhập lý do hoặc /cancel.');
          return;
        }
        try {
          const result = await this.service.decideOpenProjectTicket(pendingState.sourceId, pendingState.wpId, pendingState.decision, rawText);
          await this.sendMessage(chatId, `✅ Đã chọn <b>${pendingState.decision}</b>${result.taskIds.length ? `\nTask: <code>${this.escapeHtml(result.taskIds.join(', '))}</code>` : ''}`);
        } catch (error) {
          await this.sendMessage(chatId, `❌ Không thể quyết định triage: ${this.escapeHtml(error instanceof Error ? error.message : String(error))}`);
        }
        return;
      }

      if (pendingState.action === 'newtask_description') {
        this.chatStates.delete(chatId);
        if (pendingState.projectId) {
          const parsed = this.parseLeadingExternalRef(rawText);
          await this.sendAutoTaskToClaude(chatId, pendingState.projectId, parsed.text, parsed.externalRef);
        } else {
          const parsed = this.parseLeadingExternalRef(rawText);
          await this.handleNewTaskDescription(chatId, parsed.text, parsed.externalRef);
        }
        return;
      }

      if (pendingState.action === 'newtask_project_description') {
        await this.sendMessage(chatId, 'Vui lòng chọn project bằng nút bên trên, hoặc gửi /cancel để huỷ.');
        return;
      }

      if (pendingState.action === 'newtask_title') {
        const title = rawText.trim();
        if (!title) {
          await this.sendMessage(chatId, 'Tiêu đề không được để trống. Vui lòng nhập tiêu đề:');
          return;
        }
        this.chatStates.set(chatId, {
          action: 'newtask_body',
          projectId: pendingState.projectId,
          title,
          bodyLines: [],
        });
        await this.sendMessage(
          chatId,
          `📝 Tiêu đề: <b>${this.escapeHtml(title)}</b>\n\nNhập <b>đề bài</b> cho task (có thể gửi nhiều tin nhắn, gõ <code>/done</code> để kết thúc, hoặc <code>/cancel</code> để huỷ):`,
        );
        return;
      }

      if (pendingState.action === 'newtask_body') {
        if (rawText.toLowerCase() === '/done') {
          const body = pendingState.bodyLines.join('\n\n').trim();
          this.chatStates.set(chatId, {
            action: 'newtask_level',
            projectId: pendingState.projectId,
            title: pendingState.title,
            body,
          });
          const keyboard: InlineKeyboardButton[][] = [
            [
              { text: '🟢 Dễ (easy)', callback_data: 'newtask:level:easy' },
              { text: '🔴 Khó (hard)', callback_data: 'newtask:level:hard' },
            ],
            [{ text: '❌ Huỷ', callback_data: 'newtask:cancel' }],
          ];
          await this.sendMessage(chatId, '⚙️ Chọn <b>độ khó</b> cho task:', { inline_keyboard: keyboard });
          return;
        }

        pendingState.bodyLines.push(rawText);
        await this.sendMessage(chatId, '✓ Đã nhận. Gửi tiếp nội dung hoặc gõ <code>/done</code> để tiếp tục.');
        return;
      }

      if (
        pendingState.action === 'newtask_project' ||
        pendingState.action === 'newtask_level' ||
        pendingState.action === 'newtask_model' ||
        pendingState.action === 'newtask_confirm'
      ) {
        await this.sendMessage(chatId, 'Vui lòng chọn tùy chọn bằng các nút bấm bên trên, hoặc gửi /cancel để huỷ.');
        return;
      }
    }

    // 3. Command processing
    if (!rawText.startsWith('/')) {
      const remember = rawText.match(/^ghi nhớ\s*:\s*(.+)$/is);
      if (remember) {
        const projectId = this.selectedProject.get(chatId);
        if (!projectId) {
          await this.sendMessage(chatId, 'Hãy chọn project trước bằng /use <dự án>.');
        } else {
          await this.service.addKnowledge(projectId, { content: remember[1].trim(), pinned: true });
          await this.sendMessage(chatId, '📌 Đã ghim kiến thức cho project đang chọn.');
        }
        return;
      }
      const replyMsgId = msg.reply_to_message?.message_id;
      const askSessionId = replyMsgId ? this.askReplySessions.get(replyMsgId) : undefined;
      if (askSessionId) {
        if (!this.chatService) {
          await this.sendMessage(chatId, 'ℹ️ Chat Claude chưa được bật.');
          return;
        }
        try {
          await this.startChatTurn(chatId, '🧠 Bộ não đang suy nghĩ…', rawText, askSessionId);
        } catch (err: unknown) {
          await this.sendMessage(chatId, `❌ ${this.escapeHtml(err instanceof Error ? err.message : String(err))}`);
        }
        return;
      }
      await this.handleChatMessage(chatId, rawText);
      return;
    }

    const [cmdToken, ...args] = rawText.split(/\s+/);
    // Strip optional @botname suffix
    const cmd = cmdToken.split('@')[0].toLowerCase();
    const argStr = args.join(' ').trim();

    switch (cmd) {
      case '/start':
        await this.sendMessage(
          chatId,
          `👋 Chào bạn! Bạn đã kết nối với ${this.escapeHtml(this.appName)}.\nGõ /help để xem danh sách các lệnh.`,
        );
        break;

      case '/new':
        if (!this.chatService) {
          await this.sendMessage(chatId, 'Chat Claude chưa được bật.');
          break;
        }
        {
          const sessionId = this.brainSession && this.config.assistant.enabled
            ? `assistant:${this.selectedProject.get(chatId) || 'global'}`
            : `telegram:${chatId}:${crypto.randomUUID()}`;
          this.chatSessions.set(chatId, sessionId);
          this.chatService.getOrCreateSession(sessionId, { title: 'Cuộc trò chuyện Telegram' });
        }
        await this.sendMessage(chatId, '🆕 Đã mở phiên chat mới.');
        break;

      case '/topics': {
        const sub = args[0]?.toLowerCase();
        if (sub !== 'setup') {
          await this.sendMessage(chatId, 'Cú pháp: /topics setup [project|department]');
          break;
        }
        const requestedMode = args[1]?.toLowerCase();
        const mode = requestedMode === 'department' || requestedMode === 'project'
          ? requestedMode
          : (this.config.telegram.topicMode || 'project');
        if (mode === 'department') {
          await this.sendMessage(chatId, '⏳ Đang tạo topic cho các phòng ban…');
          const topics = await this.setupTopics(mode);
          await this.sendMessage(chatId, `✅ Đã đồng bộ ${Object.keys(topics).length} topic phòng ban.`);
        } else {
          await this.sendMessage(chatId, '⏳ Đang tạo topic cho các dự án…');
          const topics = await this.setupTopics(mode);
          await this.sendMessage(chatId, `✅ Đã đồng bộ ${Object.keys(topics).length} topic dự án.`);
        }
        break;
      }

      case '/stop':
        await this.stopChat(chatId);
        break;

      case '/shutdown': {
        const status = this.service.getStatus();
        const running = status.tasks.running + status.tasks.checking;
        await this.sendMessage(chatId,
          `⚠️ <b>Tắt AgentHub?</b> ${running} task đang chạy sẽ được đưa về hàng chờ và tiếp tục khi bật lại. Sau đó chỉ có thể bật lại từ máy bằng lệnh <code>agenthub start</code>.`,
          { inline_keyboard: [[
            { text: '✅ Xác nhận tắt', callback_data: 'hubshutdown:confirm' },
            { text: '❌ Hủy', callback_data: 'hubshutdown:cancel' },
          ]] },
        );
        break;
      }

      case '/restart': {
        if (args[0]?.toLowerCase() === 'now') {
          const status = this.service.getStatus();
          const running = status.tasks.running + status.tasks.checking;
          await this.sendMessage(chatId, `⚠️ <b>Khởi động lại ngay?</b> ${running} worker/check đang chạy sẽ bị dừng.`, { inline_keyboard: [[
            { text: '✅ Xác nhận', callback_data: 'hubrestart:confirm' },
            { text: '❌ Hủy', callback_data: 'hubrestart:cancel' },
          ]] });
        } else {
          const state = this.service.beginRestartDrain(120, `telegram:${chatId}`, () => this.service.triggerRestart());
          await this.sendMessage(chatId, `⏳ Sẽ khởi động lại khi ${state.waitingFor.length} việc đang chạy hoàn tất.`);
        }
        break;
      }

      case '/compact':
        await this.sendMessage(chatId, 'ℹ️ Tính năng nén ngữ cảnh chưa được bật.');
        break;

      case '/help':
        await this.sendMessage(chatId, this.renderHelp());
        break;

      case '/rules':
        await this.handlePermissionRules(chatId, args);
        break;

      case '/use':
        await this.handleUseCommand(chatId, argStr);
        break;

      case '/projects':
        await this.handleProjectsCommand(chatId);
        break;

      case '/status':
        await this.handleStatusCommand(chatId);
        break;

      case '/gio': {
        const timesheet = this.service.timesheetService;
        const sourceId = this.config.integrations.openproject.sources.length === 1 ? this.config.integrations.openproject.sources[0].id : undefined;
        if (!timesheet || !sourceId) { await this.sendMessage(chatId, '❌ Cần bật timesheet và cấu hình đúng một nguồn OpenProject.'); break; }
        if (!argStr) {
          const preview = await timesheet.preview(sourceId);
          await this.sendMessage(chatId, `🕒 Hôm nay: ${formatHours(preview.hours)}h\n${preview.entries.map((entry) => `[${entry.displayId}] ${formatHours(entry.hours)}h`).join('\n') || 'Chưa có việc.'}`);
          break;
        }
        try {
          const parsed = parseTimesheetCommand(argStr);
          const date = formatYYYYMMDD(new Date());
          const result = await timesheet.addManual({ sourceId, date, ...(parsed.ticket === 'new' ? { createTicket: { subject: parsed.description } } : { ticket: parsed.ticket }), description: parsed.description, activeHours: parsed.activeHours, waitHours: parsed.waitHours, pinned: parsed.pinned }) as { display_id?: string };
          const preview = await timesheet.preview(sourceId, date);
          await this.sendMessage(chatId, `✅ Đã thêm ${this.escapeHtml(String(result.display_id || parsed.ticket))}: ${this.escapeHtml(parsed.description)} (${formatHours(parsed.activeHours + parsed.waitHours)}h)\nTổng hiện tại: ${formatHours(preview.entries.reduce((sum, entry) => sum + entry.hours, 0))}h/${formatHours(preview.hours)}h${preview.fixedOverHours ? '\n⚠️ Giờ cố định đã vượt tổng ngày.' : ''}`);
        } catch (error) { await this.sendMessage(chatId, `❌ ${this.escapeHtml(error instanceof Error ? error.message : String(error))}`); }
        break;
      }

      case '/focus':
        await this.handleFocusCommand(chatId, argStr);
        break;

      case '/digest':
        await this.handleDigestCommand(chatId);
        break;

      case '/plans':
        await this.handlePlansCommand(chatId);
        break;

      case '/ci':
        await this.handleCiCommand(chatId, argStr);
        break;

      case '/brain':
        await this.handleBrainCommand(chatId, argStr);
        break;

      case '/ask':
        await this.handleAskCommand(chatId, argStr);
        break;

      case '/review':
        await this.handleReviewCommand(chatId, args);
        break;

      case '/knowledge':
        await this.handleKnowledgeCommand(chatId);
        break;

      case '/directives':
        await this.handleDirectivesCommand(chatId, argStr);
        break;

      case '/tasks':
        await this.handleTasksCommand(chatId, argStr);
        break;

      case '/task':
        await this.handleTaskDetailCommand(chatId, argStr);
        break;

      case '/newtask':
        await this.handleNewTaskCommand(chatId, argStr);
        break;

      case '/newtask_detail':
        await this.startNewTaskWizard(chatId);
        break;

      case '/plan':
        await this.handlePlanCommand(chatId, args);
        break;

      case '/drafts':
        await this.handleDraftsCommand(chatId);
        break;

      case '/log':
        await this.handleLogCommand(chatId, argStr);
        break;

      case '/retry':
        await this.handleRetryCommand(chatId, argStr);
        break;

      case '/cancel':
        await this.handleCancelCommand(chatId, argStr);
        break;

      case '/approve':
        await this.handleApproveCommand(chatId, argStr);
        break;

      case '/deploy':
        await this.handleDeployCommand(chatId, argStr);
        break;

      case '/reject':
        await this.handleRejectCommand(chatId, args);
        break;

      case '/pause': {
        const trimmed = argStr.trim();
        if (trimmed) {
          const resolved = this.resolveTask(trimmed);
          if ('error' in resolved) {
            await this.sendMessage(chatId, `❌ ${resolved.error}`);
            break;
          }
          try {
            this.service.pauseTask(resolved.id, 'manual');
            await this.sendMessage(chatId, `⏸ Đã tạm dừng task <b>${this.escapeHtml(resolved.id)}</b>.`);
          } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            await this.sendMessage(chatId, `❌ Lỗi khi tạm dừng task: ${errMsg}`);
          }
          break;
        }
        this.service.pauseScheduler();
        await this.sendMessage(chatId, '⏸ Đã tạm dừng giao task mới. Các task đang chạy vẫn tiếp tục.');
        break;
      }

      case '/resume': {
        const trimmed = argStr.trim();
        if (trimmed) {
          const resolved = this.resolveTask(trimmed);
          if ('error' in resolved) {
            await this.sendMessage(chatId, `❌ ${resolved.error}`);
            break;
          }
          try {
            this.service.resumeTask(resolved.id);
            await this.sendMessage(chatId, `▶️ Đã tiếp tục task <b>${this.escapeHtml(resolved.id)}</b>.`);
          } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            await this.sendMessage(chatId, `❌ Lỗi khi tiếp tục task: ${errMsg}`);
          }
          break;
        }
        this.service.resumeScheduler();
        await this.sendMessage(chatId, '▶️ Đã tiếp tục giao task mới.');
        break;
      }

      default:
        await this.sendMessage(chatId, `Lệnh không hợp lệ: ${cmd}. Gõ /help để xem hướng dẫn.`);
        break;
    }
  }

  private async handleFocusCommand(chatId: number, argStr: string): Promise<void> {
    const target = argStr.trim();
    const current = this.service.getFocus();
    if (!target) {
      await this.sendMessage(chatId, current.projectId
        ? `🎯 Đang tập trung cho <b>${this.escapeHtml(current.projectId)}</b>\nTask khác đang chờ: ${this.taskRepo.getByStatus('queued').filter((task) => task.waitReason === 'focus').length}`
        : '🎯 Chưa bật chế độ tập trung.');
      return;
    }
    try {
      const result = this.service.setFocus({ projectId: target.toLowerCase() === 'off' ? null : target });
      if (!result.focus.projectId) {
        await this.sendMessage(chatId, `▶️ Đã tắt tập trung. ${result.resumed} task được chạy lại.`);
      } else {
        await this.sendMessage(chatId, `🎯 Đã tập trung cho <b>${this.escapeHtml(result.focus.projectId)}</b>. ${result.paused} task bị tạm dừng, ${result.waiting} task khác đang chờ.`);
      }
    } catch (error) {
      await this.sendMessage(chatId, `❌ ${this.escapeHtml(error instanceof Error ? error.message : String(error))}`);
    }
  }

  private async handleKnowledgeCommand(chatId: number): Promise<void> {
    const projectId = this.selectedProject.get(chatId);
    if (!projectId) {
      await this.sendMessage(chatId, 'Hãy chọn project trước bằng /use <dự án>.');
      return;
    }
    const project = this.projectRepo.get(projectId);
    const entries = this.service.listKnowledge(projectId).filter((entry) => entry.pinned === 1);
    const checklist = project ? projectSettings(project).reviewChecklist : [];
    const text = [
      `🧠 <b>Kiến thức · ${this.escapeHtml(project?.name || projectId)}</b>`,
      '',
      '<b>Kiến thức ghim:</b>',
      entries.length ? entries.map((entry) => `• ${this.escapeHtml(entry.content)}`).join('\n') : '• Không có',
      '',
      '<b>Checklist khi duyệt:</b>',
      checklist.length ? checklist.map((item) => `• ${this.escapeHtml(item)}`).join('\n') : '• Không có',
    ].join('\n');
    await this.sendMessage(chatId, text);
  }

  private async handleReviewCommand(chatId: number, args: string[]): Promise<void> {
    if (args[0] !== 'order') {
      await this.sendMessage(chatId, 'Dùng /review order để xem, hoặc /review order claude,codex để đổi thứ tự.');
      return;
    }
    const current = reviewerSettingsFromLegacy(this.config.reviewer as unknown as Record<string, unknown>);
    if (!args[1]) {
      await this.sendMessage(chatId, `🔎 Thứ tự reviewer: ${current.order.map((item) => item.engine).join(' → ')}\nFallback khi không khả dụng: ${current.fallback.onUnavailable ? 'bật' : 'tắt'}, bận sau ${current.fallback.onBusyAfterMin} phút.`);
      return;
    }
    const names = args[1].split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
    if (names.length === 0 || names.some((name) => name !== 'claude' && name !== 'codex') || new Set(names).size !== names.length) {
      await this.sendMessage(chatId, 'Thứ tự phải là danh sách claude,codex (mỗi reviewer tối đa một lần).');
      return;
    }
    const order = names.map((name) => current.order.find((item) => item.engine === name) || {
      engine: name as 'claude' | 'codex',
      model: name === 'claude' ? 'sonnet' : 'gpt-5.6-luna',
      profiles: [],
    });
    updateConfigInMemory(this.config, { reviewer: { order } });
    saveConfig(this.config.hubHome, { reviewer: { order } });
    await this.sendMessage(chatId, `✅ Đã đổi thứ tự reviewer chung: ${names.join(' → ')}`);
  }

  private async handleDeployCommand(chatId: number, argStr: string): Promise<void> {
    const trimmed = argStr.trim();
    if (!trimmed) {
      const statuses = this.service.getDeployStatuses();
      await this.sendMessage(chatId, statuses.length
        ? statuses.map((status) => {
            const pushInfo = status.pushStatus ? ` (${status.pushStatus})` : '';
            return `${this.escapeHtml(status.projectId)}: ${this.escapeHtml(status.status)}${this.escapeHtml(pushInfo)}${status.error ? ` — ${this.escapeHtml(status.error)}` : ''}`;
          }).join('\n')
        : 'Chưa có lượt deploy nào. Dùng: /deploy <project> [push]');
      return;
    }
    const parts = trimmed.split(/\s+/);
    const isPush = parts.length > 1 && parts[parts.length - 1].toLowerCase() === 'push';
    const projectId = isPush ? parts.slice(0, -1).join(' ') : trimmed;

    try {
      if (isPush) {
        const status = await this.service.pushDeployNow(projectId);
        await this.sendMessage(chatId, status.status === 'succeeded'
          ? `✅ Đã đẩy ${this.escapeHtml(projectId)} lên remote (${this.escapeHtml(status.pushStatus || 'thành công')}).`
          : `❌ Đẩy ${this.escapeHtml(projectId)} thất bại: ${this.escapeHtml(status.error || status.status)}`);
        return;
      }
      const status = await this.service.rerunDeploy(projectId);
      await this.sendMessage(chatId, status.status === 'queued' || status.status === 'running'
        ? `⏳ Deploy ${this.escapeHtml(projectId)} đã vào hàng đợi.`
        : status.status === 'succeeded' || status.status === 'restarting'
          ? `✅ Deploy ${this.escapeHtml(projectId)} ${status.status === 'restarting' ? 'đang khởi động lại hub' : 'thành công'}.`
          : `❌ Deploy ${this.escapeHtml(projectId)} thất bại: ${this.escapeHtml(status.error || status.status)}`);
    } catch (error) {
      await this.sendMessage(chatId, `❌ ${this.escapeHtml(error instanceof Error ? error.message : String(error))}`);
    }
  }

  private async handleBrainCommand(chatId: number, argStr: string): Promise<void> {
    const current = this.config.brain;
    const parts = argStr.split(/\s+/).filter(Boolean);
    if (parts[0] === 'engine') {
      const engine = parts[1];
      if (engine !== 'claude' && engine !== 'codex') {
        await this.sendMessage(chatId, 'Cú pháp: /brain engine codex|claude');
        return;
      }
      this.config.brain.engine = engine;
      saveConfig(this.config.hubHome, { brain: { engine } });
      this.eventBus.emit('config.updated', undefined, { brain: { engine }, source: 'telegram' });
      await this.sendMessage(chatId, `🧠 Đã chuyển engine bộ não sang <b>${engine}</b>.`);
      return;
    }
    if (parts[0] === 'trust') {
      const projectId = parts[1];
      const permission = parts[2];
      if (!projectId) {
        await this.sendMessage(chatId, `🧠 Quyền mặc định: <b>${this.config.brain.permissions}</b>\nDùng /brain trust &lt;dự án&gt; standard|trusted|full|inherit`);
        return;
      }
      if (!permission || !['standard', 'trusted', 'full', 'inherit'].includes(permission)) {
        await this.sendMessage(chatId, 'Cú pháp: /brain trust <dự án> standard|trusted|full|inherit');
        return;
      }
      const project = this.projectRepo.get(projectId);
      if (!project) { await this.sendMessage(chatId, `❌ Không tìm thấy dự án "${this.escapeHtml(projectId)}".`); return; }
      if (permission === 'full' && parts[3] !== 'confirm') {
        const keyboard = [[{ text: '⚠️ Xác nhận Toàn quyền', callback_data: `braintrust:full:${projectId}` }]];
        await this.sendMessage(chatId, `⚠️ Toàn quyền cho <b>${this.escapeHtml(projectId)}</b> cho phép Claude chạy mọi lệnh. Gửi lại: <code>/brain trust ${this.escapeHtml(projectId)} full confirm</code> để xác nhận.`, { inline_keyboard: keyboard });
        return;
      }
      const updated = mergeProjectSettings(projectSettings(project), { brain: { permissions: permission as 'standard' | 'trusted' | 'full' | 'inherit' } });
      this.projectRepo.update(project.id, { settings: JSON.stringify(updated) });
      this.eventBus.emit('brain.trust_changed', undefined, { projectId, permissions: permission, source: 'telegram' });
      await this.sendMessage(chatId, `🧠 Đã đổi quyền bộ não dự án <b>${this.escapeHtml(projectId)}</b> sang <b>${permission}</b>.`);
      return;
    }
    if (parts[0] !== 'mode') {
      // /brain with no args: show overview listing per-project brains
      const brain = this.service.getStatus().brain;
      const detailed = brain as (typeof brain & {
        source?: string;
        sessions?: Array<{ link: string; title: string; state?: string; stale?: boolean; lastUserRequest?: string; lastTool?: { name: string; summary?: string } }>;
      });
      let text = '';
      if (detailed?.sessions && detailed.sessions.length > 0) {
        text = `🧠 <b>Claude · Điều phối</b>\n• Trạng thái: <b>${this.brainLabel(detailed)}</b>\n• Nguồn: ${this.escapeHtml(detailed.source || 'hub')}\n`;
        for (const session of detailed.sessions) {
          text += `\n• <a href="${this.escapeHtml(session.link)}">${this.escapeHtml(session.title)}</a> · ${this.brainLabel(session)}\n`;
          if (session.lastUserRequest) text += `  Yêu cầu: ${this.escapeHtml(session.lastUserRequest)}\n`;
          if (session.lastTool) text += `  Tool: ${this.escapeHtml(session.lastTool.name)}${session.lastTool.summary ? ` — ${this.escapeHtml(session.lastTool.summary)}` : ''}\n`;
        }
      } else {
        text = `🧠 Bộ não toàn cục: <b>${current.mode}</b> · model <b>${current.model}</b> · tối đa ${current.maxTurnsPerHour} lượt/giờ`;
        const activity = brain ? ` · trạng thái <b>${this.brainLabel(brain)}</b>` : '';
        text += activity;
      }

      // Per-project listing (chế độ, trạng thái)
      const projects = this.projectRepo.getAll();
      if (projects.length > 0) {
        text += '\n\n<b>Bộ não từng dự án:</b>';
        for (const proj of projects) {
          const ps = projectSettings(proj);
          const mode = ps.brain.mode === 'inherit' ? `${current.mode} (inherit)` : ps.brain.mode;
          const session = this.chatService?.chatSessionRepo.get(`brain:${proj.id}`);
          const effMode = effectiveBrainMode(proj.id, proj, this.config.brain);
          const stateLabel = session?.busy || session?.state === 'running'
            ? 'đang làm'
            : session?.state === 'waiting_permission' || session?.state === 'waiting_limit'
              ? 'chờ bạn trả lời'
              : effMode === 'off'
                ? 'tắt'
                : 'sẵn sàng';
          text += `\n• <code>${this.escapeHtml(proj.id)}</code>: chế độ <b>${mode}</b> · trạng thái <b>${stateLabel}</b>`;
        }
      }
      await this.sendMessage(chatId, text);
      return;
    }
    // /brain mode [<project>] <mode>
    const remaining = parts.slice(1);
    if (remaining.length === 1) {
      // Global mode: /brain mode <mode>
      const mode = remaining[0];
      if (mode !== 'off' && mode !== 'suggest' && mode !== 'auto') {
        await this.sendMessage(chatId, 'Cú pháp: /brain mode off|suggest|auto\nTheo dự án: /brain mode <dự án> off|suggest|auto|external|inherit');
        return;
      }
      this.config.brain.mode = mode;
      saveConfig(this.config.hubHome, { brain: { mode } });
      await this.sendMessage(chatId, `🧠 Đã chuyển bộ não toàn cục sang chế độ <b>${mode}</b>.`);
      return;
    }
    if (remaining.length === 2) {
      // Per-project mode: /brain mode <project> <mode>
      const projectId = remaining[0];
      const mode = remaining[1];
      const validModes = ['off', 'suggest', 'auto', 'external', 'inherit'];
      if (!validModes.includes(mode)) {
        await this.sendMessage(chatId, `Chế độ không hợp lệ: ${mode}. Sử dụng: off, suggest, auto, external, inherit`);
        return;
      }
      const project = this.projectRepo.get(projectId);
      if (!project) {
        await this.sendMessage(chatId, `❌ Không tìm thấy dự án "${this.escapeHtml(projectId)}".`);
        return;
      }
      const current = projectSettings(project);
      const updated = mergeProjectSettings(current, { brain: { mode: mode as 'off' | 'suggest' | 'auto' | 'external' | 'inherit' } });
      this.projectRepo.update(project.id, { settings: JSON.stringify(updated) });
      await this.sendMessage(chatId, `🧠 Đã chuyển bộ não dự án <b>${this.escapeHtml(projectId)}</b> sang chế độ <b>${mode}</b>.`);
      return;
    }
    await this.sendMessage(chatId, 'Cú pháp: /brain mode off|suggest|auto\nTheo dự án: /brain mode <dự án> off|suggest|auto|external|inherit');
  }

  private async handleDirectivesCommand(chatId: number, argStr: string): Promise<void> {
    if (!this.directiveRepo) { await this.sendMessage(chatId, 'Chỉ thị chưa khả dụng.'); return; }
    const projectId = this.selectedProject.get(chatId) || null;
    const parts = argStr.trim().split(/\s+/).filter(Boolean);
    if (parts[0] === 'del' || parts[0] === 'remove') {
      const id = parts[1];
      if (!id || !this.directiveRepo.remove(id)) { await this.sendMessage(chatId, 'Không tìm thấy chỉ thị.'); return; }
      await this.sendMessage(chatId, '✓ Đã xoá chỉ thị.');
      return;
    }
    if (parts[0] === 'add') {
      const text = argStr.slice(3).trim();
      if (!text) { await this.sendMessage(chatId, 'Cú pháp: /directives add <nội dung>'); return; }
      this.directiveRepo.add({ id: crypto.randomUUID(), projectId, text, createdBy: 'telegram' });
      this.eventBus.emit('brain.directive_added', projectId || undefined, { projectId, text });
      await this.sendMessage(chatId, '✓ Đã thêm chỉ thị cho bộ não.');
      return;
    }
    const rows = this.directiveRepo.list(projectId);
    await this.sendMessage(chatId, rows.length ? rows.map((row) => `• <code>${this.escapeHtml(row.id)}</code>: ${this.escapeHtml(row.text)}`).join('\n') : 'Chưa có chỉ thị. Dùng /directives add <nội dung>.');
  }

  private buildProjectsListText(chatId: number): string {
    const projects = this.projectRepo.getAll().filter((p) => !p.archivedAt);
    if (projects.length === 0) {
      return `ℹ️ Chưa có dự án nào. Vui lòng đăng ký trên dashboard: ${this.getDashboardUrl()}`;
    }
    const current = this.selectedProject.get(chatId);
    const currentSelected = current && projects.some((p) => p.id === current) ? current : undefined;
    const lines: string[] = ['📁 <b>Danh sách dự án:</b>\n'];
    for (const p of projects) {
      const isSelected = currentSelected === p.id;
      const prefix = isSelected ? '✅ ' : '• ';
      const nameStr = p.name ? `<b>${this.escapeHtml(p.name)}</b> (<code>${this.escapeHtml(p.id)}</code>)` : `<b>${this.escapeHtml(p.id)}</b>`;
      const branchStr = `<code>${this.escapeHtml(p.defaultBranch || 'main')}</code>`;
      const tasks = this.taskRepo?.getByProject ? this.taskRepo.getByProject(p.id) : [];
      const runningCount = tasks.filter((t) => t.status === 'running' || t.status === 'checking').length;
      const queuedCount = tasks.filter((t) => t.status === 'queued').length;
      const reviewCount = tasks.filter((t) => t.status === 'review').length;
      const taskStr = `${runningCount} đang chạy, ${queuedCount} chờ, ${reviewCount} chờ duyệt`;
      lines.push(`${prefix}${nameStr} · ${branchStr} — ${taskStr}`);
    }
    return lines.join('\n');
  }

  private buildProjectPicker(chatId: number): InlineKeyboardButton[][] {
    const projects = this.projectRepo.getAll().filter((p) => !p.archivedAt);
    if (projects.length === 0) return [];
    const current = this.selectedProject.get(chatId);
    const currentSelected = current && projects.some((p) => p.id === current) ? current : undefined;
    const buttons: InlineKeyboardButton[] = projects.map((p) => {
      const isSelected = currentSelected === p.id;
      const label = p.name || p.id;
      return {
        text: isSelected ? `✅ 📁 ${label}` : `📁 ${label}`,
        callback_data: `use:select:${p.id}`,
      };
    });

    const keyboard: InlineKeyboardButton[][] = [];
    if (buttons.length >= 6) {
      for (let i = 0; i < buttons.length; i += 2) {
        keyboard.push(buttons.slice(i, i + 2));
      }
    } else {
      for (const btn of buttons) {
        keyboard.push([btn]);
      }
    }
    if (currentSelected) {
      keyboard.push([{ text: '🚫 Bỏ chọn', callback_data: 'use:clear:' }]);
    }
    return keyboard;
  }

  private async handleProjectsCommand(chatId: number): Promise<void> {
    const projects = this.projectRepo.getAll().filter((p) => !p.archivedAt);
    if (projects.length === 0) {
      await this.sendMessage(chatId, `ℹ️ Chưa có dự án nào. Vui lòng đăng ký trên dashboard: ${this.getDashboardUrl()}`);
      return;
    }
    const text = this.buildProjectsListText(chatId);
    const keyboard = this.buildProjectPicker(chatId);
    await this.sendMessage(chatId, text, { inline_keyboard: keyboard });
  }

  private async handleUseCommand(chatId: number, argStr: string): Promise<void> {
    const trimmed = argStr.trim();
    if (!trimmed) {
      // /use with no args: show current selection
      const current = this.selectedProject.get(chatId);
      if (current) {
        const proj = this.projectRepo.get(current);
        if (proj?.archivedAt) {
          this.selectedProject.delete(chatId);
          await this.sendMessage(chatId, '📁 Dự án đã ẩn và không còn được chọn.');
          return;
        }
        const name = proj?.name ? `${proj.name} (${current})` : current;
        await this.sendMessage(
          chatId,
          `📁 Dự án đang chọn: <b>${this.escapeHtml(name)}</b>\n\nGõ <code>/use &lt;dự án&gt;</code> để đổi, hoặc <code>/use none</code> để bỏ chọn.`,
          { inline_keyboard: this.buildProjectPicker(chatId) },
        );
      } else {
        const projects = this.projectRepo.getAll().filter((p) => !p.archivedAt);
        if (projects.length === 0) {
          await this.sendMessage(chatId, 'ℹ️ Chưa chọn dự án nào và không có dự án nào trong hệ thống.');
          return;
        }
        const keyboard = this.buildProjectPicker(chatId);
        await this.sendMessage(chatId, '📁 Chưa chọn dự án nào. Chọn dự án:', { inline_keyboard: keyboard });
      }
      return;
    }
    if (trimmed === 'none') {
      this.selectedProject.delete(chatId);
      this.persistSelectedProject(chatId, undefined);
      await this.sendMessage(chatId, '📁 Đã bỏ chọn dự án. Tin nhắn sẽ gửi tới bộ não hệ thống.');
      return;
    }
    const project = this.projectRepo.getIncludingArchived ? this.projectRepo.getIncludingArchived(trimmed) : this.projectRepo.get(trimmed);
    if (!project) {
      await this.sendMessage(chatId, `❌ Không tìm thấy dự án "${this.escapeHtml(trimmed)}".`);
      return;
    }
    if (project.archivedAt) {
      await this.sendMessage(chatId, `❌ Dự án "${this.escapeHtml(trimmed)}" đã bị ẩn.`);
      return;
    }
    this.selectedProject.set(chatId, project.id);
    this.persistSelectedProject(chatId, project.id);
    const name = project.name ? `${project.name} (${project.id})` : project.id;
    await this.sendMessage(chatId, `📁 Đã chọn dự án <b>${this.escapeHtml(name)}</b>. Tin nhắn sẽ được gửi tới bộ não dự án này.`);
  }

  private persistSelectedProject(chatId: number, projectId: string | undefined): void {
    const chats = (this.config.telegram.chats || []).filter((c) => c.id !== chatId);
    // Find existing chat entry to preserve name/username
    const existing = (this.config.telegram.chats || []).find((c) => c.id === chatId);
    if (projectId) {
      chats.push({
        id: chatId,
        name: existing?.name || `Chat ${chatId}`,
        ...(existing?.username ? { username: existing.username } : {}),
        kind: 'chat',
        projectId,
      });
    } else if (existing) {
      const rest = { ...existing };
      delete rest.projectId;
      delete rest.kind;
      chats.push(rest);
    }
    this.config.telegram.chats = chats;
    updateConfigInMemory(this.config, { telegram: this.config.telegram });
    saveConfig(this.config.hubHome, { telegram: this.config.telegram });
  }

  /** Get the project selected for this chat via /use, if any. */
  getSelectedProject(chatId: number): string | undefined {
    return this.selectedProject.get(chatId);
  }

  /**
   * Returns a `[ProjectName]` prefix for a given projectId, for use in notifications.
   * Falls back to `[projectId]` if the project has no name.
   * Escapes HTML by default for safe interpolation into parse_mode HTML messages.
   * Pass options.raw = true to keep unescaped label (e.g. for queues that escape later).
   */
  private projectPrefix(projectId: string | null | undefined, options?: { raw?: boolean }): string {
    if (!projectId) return '';
    const proj = this.projectRepo.get(projectId);
    const label = proj?.name || projectId;
    const formatted = options?.raw ? label : this.escapeHtml(label);
    return `[${formatted}] `;
  }

  /**
   * Extract projectId from a taskId (e.g. "myproject/task-slug" -> "myproject")
   * or from event payload's projectId field.
   */
  private extractProjectId(taskId?: string | null, payload?: Record<string, unknown>): string | null {
    if (taskId && taskId.includes('/')) return taskId.slice(0, taskId.indexOf('/'));
    if (typeof payload?.projectId === 'string') return payload.projectId;
    return null;
  }

  /**
   * Returns true when this project is configured for minimal Telegram content,
   * meaning titles/content/diff/log should NOT be sent — only counts + dashboard link.
   */
  isMinimalProject(projectId: string | null | undefined): boolean {
    if (!projectId) return false;
    const proj = this.projectRepo.get(projectId);
    const settings = projectSettings(proj);
    return settings.notifications.telegramContent === 'minimal';
  }

  private sessionIdForChat(chatId: number): string {
    const selectedDeptId = this.selectedDepartment.get(chatId);
    if (selectedDeptId) {
      if (selectedDeptId === 'chung' && this.config.brain.director?.enabled) {
        return 'brain:director';
      }
      return `brain:department:${selectedDeptId}`;
    }
    // Assistant sessions are independent from resident brain turns, so user messages never queue behind events.
    const selectedProjectId = this.selectedProject.get(chatId);
    if (this.brainSession && this.config.assistant.enabled) {
      if (selectedProjectId) {
        const project = this.projectRepo.get(selectedProjectId);
        const mode = effectiveBrainMode(selectedProjectId, project, this.config.brain);
        if (mode === 'external' || mode === 'off') return `telegram:${chatId}:${selectedProjectId}`;
        return `assistant:${selectedProjectId}`;
      }
      return 'assistant';
    }
    if (selectedProjectId) {
      const project = this.projectRepo.get(selectedProjectId);
      const mode = effectiveBrainMode(selectedProjectId, project, this.config.brain);
      if (mode === 'external' || mode === 'off') {
        // External or off mode: use a project-scoped chat session (kind 'chat')
        const sessionId = `telegram:${chatId}:${selectedProjectId}`;
        this.chatSessions.set(chatId, sessionId);
        return sessionId;
      }
      return `brain:${selectedProjectId}`;
    }
    if (this.brainSession && this.config.brain?.mode && this.config.brain.mode !== 'off') return 'brain';
    const existing = this.chatSessions.get(chatId);
    if (existing) return existing;
    const sessionId = `telegram:${chatId}`;
    this.chatSessions.set(chatId, sessionId);
    return sessionId;
  }

  private recordAskReply(messageId: number, sessionId: string): void {
    if (this.askReplySessions.has(messageId)) {
      this.askReplySessions.delete(messageId);
    }
    while (this.askReplySessions.size >= 200) {
      const oldestKey = this.askReplySessions.keys().next().value;
      if (oldestKey === undefined) break;
      this.askReplySessions.delete(oldestKey);
    }
    this.askReplySessions.set(messageId, sessionId);
  }

  private brainSessionIdForChat(chatId: number): string {
    const selectedDeptId = this.selectedDepartment.get(chatId);
    if (selectedDeptId) {
      if (selectedDeptId === 'chung' && this.config.brain.director?.enabled) {
        return 'brain:director';
      }
      return `brain:department:${selectedDeptId}`;
    }
    const selectedProjectId = this.selectedProject.get(chatId);
    if (selectedProjectId) {
      return `brain:${selectedProjectId}`;
    }
    return 'brain';
  }

  private async handleAskCommand(chatId: number, argStr: string): Promise<void> {
    if (!this.chatService) {
      await this.sendMessage(chatId, 'ℹ️ Chat Claude chưa được bật.');
      return;
    }
    const question = argStr.trim();
    if (!question) {
      const selectedDeptId = this.selectedDepartment.get(chatId);
      const current = this.selectedProject.get(chatId);
      if (selectedDeptId) {
        const deptName = selectedDeptId === 'chung' ? 'Chung (Giám đốc)' : (this.departmentRepo?.get(selectedDeptId)?.name || selectedDeptId);
        await this.sendMessage(
          chatId,
          `💡 Cú pháp: <code>/ask &lt;câu hỏi&gt;</code> để hỏi hoặc trao đổi với bộ não.\nPhòng ban đang chọn: <b>${this.escapeHtml(deptName)}</b>.`,
        );
        return;
      }
      if (current) {
        const proj = this.projectRepo.get(current);
        const name = proj?.name ? `${proj.name} (${current})` : current;
        await this.sendMessage(
          chatId,
          `💡 Cú pháp: <code>/ask &lt;câu hỏi&gt;</code> để hỏi hoặc trao đổi với bộ não.\nDự án đang chọn: <b>${this.escapeHtml(name)}</b>.`,
        );
        return;
      }
      await this.sendMessage(
        chatId,
        '💡 Cú pháp: <code>/ask &lt;câu hỏi&gt;</code> để hỏi hoặc trao đổi với bộ não.\nChưa chọn dự án (sẽ dùng bộ não toàn cục). Gợi ý: dùng <code>/use &lt;dự án&gt;</code> để chọn dự án.',
      );
      return;
    }
    const sessionId = this.brainSessionIdForChat(chatId);
    try {
      await this.startChatTurn(chatId, '🧠 Bộ não đang suy nghĩ…', question, sessionId);
    } catch (err: unknown) {
      await this.sendMessage(chatId, `❌ ${this.escapeHtml(err instanceof Error ? err.message : String(err))}`);
    }
  }

  private async handleChatMessage(chatId: number, text: string): Promise<void> {
    if (!this.chatService) {
      await this.sendMessage(chatId, 'ℹ️ Tin nhắn thường chỉ được dùng để chat khi Chat Claude đã bật.');
      return;
    }
    if (!text) return;
    try {
      await this.startChatTurn(chatId, '⏳ Đang xử lý…', text);
    } catch (err: unknown) {
      await this.sendMessage(chatId, `❌ ${this.escapeHtml(err instanceof Error ? err.message : String(err))}`);
    }
  }

  private async startChatTurn(chatId: number, placeholder: string, text: string, forceSessionId?: string): Promise<void> {
    if (!this.chatService) throw new Error('Chat Claude chưa được bật.');
    const sessionId = forceSessionId || this.sessionIdForChat(chatId);
    const isBrain = sessionId === 'brain' || sessionId.startsWith('brain:');
    const isAssistant = sessionId === 'assistant' || sessionId.startsWith('assistant:');
    const selectedProjId = this.selectedProject.get(chatId);
    const threadId = this.activeThreadByChat.get(chatId);
    const isDeptBrain = sessionId.startsWith('brain:department:');
    const isDirector = sessionId === 'brain:director';
    const deptId = isDeptBrain ? sessionId.slice('brain:department:'.length) : undefined;
    const dept = deptId ? this.departmentRepo?.get(deptId) : undefined;

    const projectId = isDeptBrain || isDirector || sessionId === 'brain' || sessionId === 'assistant'
      ? null
      : sessionId.startsWith('brain:') || sessionId.startsWith('assistant:')
        ? sessionId.slice(sessionId.startsWith('assistant:') ? 'assistant:'.length : 'brain:'.length) === 'global'
          ? null
          : sessionId.slice(sessionId.startsWith('assistant:') ? 'assistant:'.length : 'brain:'.length)
        : (selectedProjId || null);

    if (isAssistant) {
      const brainId = projectId ? `brain:${projectId}` : 'brain';
      this.chatService.getOrCreateSession(brainId, {
        title: 'Bộ não', kind: 'brain', projectId, model: this.config.brain.model,
      });
    }

    const title = isDeptBrain
      ? (dept ? `Bộ não · ${dept.name}` : 'Bộ não')
      : isDirector
        ? 'Bộ não Giám đốc'
        : isBrain
          ? 'Bộ não'
          : isAssistant
            ? 'Trợ lý'
            : 'Cuộc trò chuyện Telegram';
    const mode = isDeptBrain
      ? (dept?.brainPermissions === 'full' ? 'full' : 'safe')
      : isDirector
        ? (this.config.brain.director?.permissions === 'full' ? 'full' : 'safe')
        : undefined;
    const model = isDeptBrain
      ? dept?.brainModel || this.config.brain.model
      : isDirector
        ? this.config.brain.director?.model || this.config.brain.model
        : isBrain
          ? this.config.brain.model
          : isAssistant
            ? this.config.assistant.model
            : undefined;

    this.chatService.getOrCreateSession(sessionId, {
      title,
      kind: isBrain ? 'brain' : isAssistant ? 'assistant' : 'chat',
      model,
      mode,
      projectId,
    });
    let initial: unknown;
    try {
      initial = await this.sendMessage(chatId, placeholder, undefined, threadId);
      const messageId = this.telegramMessageId(initial);
      if (messageId === null) throw new Error('Telegram không trả về message_id');
      if (isBrain) {
        this.recordAskReply(messageId, sessionId);
      }
      const result = this.chatService.sendMessage(sessionId, text, { queueIfBusy: true, ...(isAssistant ? { telegramChatId: chatId } : {}) });
      if (result?.queued) {
        // The session (usually a brain busy with an event turn) answers this message right after the
        // current turn; keep the placeholder and attach the reply to it when the queued turn starts.
        const queued = this.queuedChatTurns.get(sessionId) ?? [];
        queued.push({ chatId, messageId, ...(threadId !== undefined ? { threadId } : {}) });
        this.queuedChatTurns.set(sessionId, queued);
        await this.editMessage(chatId, messageId, isBrain
          ? `📥 Đang chờ bộ não rảnh. Tin nhắn đã xếp hàng (thứ ${result.position ?? queued.length}), sẽ trả lời ngay sau.`
          : `📥 Đang bận một việc khác. Tin nhắn đã xếp hàng (thứ ${result.position ?? queued.length}), sẽ trả lời ngay sau.`);
        return;
      }
      this.chatReplies.set(sessionId, { chatId, messageId, ...(threadId !== undefined ? { threadId } : {}), text: placeholder, lastEditAt: this.now(), editing: false });
    } catch (err) {
      const reply = this.chatReplies.get(sessionId);
      if (reply?.editTimer) clearTimeout(reply.editTimer);
      this.chatReplies.delete(sessionId);
      throw err;
    }
  }

  private async stopChat(chatId: number): Promise<void> {
    if (!this.chatService) {
      await this.sendMessage(chatId, 'Chat Claude chưa được bật.');
      return;
    }
    try {
      this.chatService.cancelSession(this.sessionIdForChat(chatId));
      await this.sendMessage(chatId, '⏹ Đã dừng lượt chat hiện tại.');
    } catch (err: unknown) {
      await this.sendMessage(chatId, `❌ ${this.escapeHtml(err instanceof Error ? err.message : String(err))}`);
    }
  }

  private handleChatEvent(type: string, taskId?: string, payload?: unknown): void {
    if (!this.chatService) return;
    const data = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
    const sessionId = typeof data.sessionId === 'string' ? data.sessionId : taskId;
    if (type === 'brain.question_asked' && typeof data.questionId === 'string' && typeof data.sourceChatId === 'number' && sessionId) {
      const questions = this.brainQuestions.get(sessionId) || new Map();
      questions.set(data.questionId, {
        chatId: data.sourceChatId,
        ...(typeof data.userMessageId === 'string' ? { userMessageId: data.userMessageId } : {}),
        ...(typeof data.assistantMessageId === 'string' ? { assistantMessageId: data.assistantMessageId } : {}),
      });
      this.brainQuestions.set(sessionId, questions);
      return;
    }
    if (!sessionId) return;
    if (type === 'chat.message' && data.role === 'user' && typeof data.content === 'string' && typeof data.messageId === 'string') {
      const questionId = data.content.match(/CÂU HỎI TỪ TRỢ LÝ \[([^\]]+)\]/)?.[1];
      const questions = questionId ? this.brainQuestions.get(sessionId) : undefined;
      const question = questionId ? questions?.get(questionId) : undefined;
      if (question) {
        question.userMessageId = data.messageId;
        if (typeof data.assistantMessageId === 'string') question.assistantMessageId = data.assistantMessageId;
      }
    }
    if (type === 'chat.message' && data.role === 'user' && data.fromQueue === true) {
      const next = this.queuedChatTurns.get(sessionId)?.shift();
      if (next) {
        if (this.queuedChatTurns.get(sessionId)?.length === 0) this.queuedChatTurns.delete(sessionId);
        const isBrain = sessionId === 'brain' || sessionId.startsWith('brain:');
        this.chatReplies.set(sessionId, { chatId: next.chatId, messageId: next.messageId, ...(next.threadId !== undefined ? { threadId: next.threadId } : {}), text: isBrain ? '🧠 Bộ não đang suy nghĩ…' : '⏳ Đang xử lý…', lastEditAt: 0, editing: false });
        this.scheduleChatEdit(sessionId);
      }
      return;
    }
    const reply = this.chatReplies.get(sessionId);
    const pending = this.pendingAutoTasks.get(sessionId);
    if (type === 'chat.done') {
      const questions = this.brainQuestions.get(sessionId);
      const questionEntry = typeof data.messageId === 'string'
        ? [...(questions?.entries() || [])].find(([, question]) => question.assistantMessageId === data.messageId)
        : undefined;
      if (questionEntry) {
        const [questionId, question] = questionEntry;
        questions?.delete(questionId);
        if (questions?.size === 0) this.brainQuestions.delete(sessionId);
        try {
          const answer = this.chatService.listMessages(sessionId, 5).messages.filter((m) => m.role === 'assistant').pop()?.content || 'Bộ não đã trả lời.';
          void this.sendMessage(question.chatId, `🧠 <b>Bộ não trả lời</b>\n${this.escapeHtml(answer)}`);
        } catch { /* best effort */ }
      }
      this.pendingAutoTasks.delete(sessionId);
      if (reply) void this.finishChatReply(sessionId, false);
      return;
    }
    if (type === 'chat.error') {
      if (reply) {
        reply.text = `❌ ${typeof data.message === 'string' ? data.message : 'Lỗi chat'}`;
        void this.finishChatReply(sessionId, true);
      }
      if (pending) {
        this.pendingAutoTasks.delete(sessionId);
        void this.saveFallbackDraft(pending.chatId, pending.description, pending.projectId);
      }
      return;
    }
    if (!reply) return;
    if (type === 'chat.delta' && typeof data.text === 'string') {
      reply.text += data.text;
      this.scheduleChatEdit(sessionId);
    } else if ((type === 'chat.permission_request' || type === 'chat.permission') && typeof data.id === 'string') {
      void this.sendPermissionRequest(reply.chatId, data);
    }
  }

  private scheduleChatEdit(sessionId: string): void {
    const reply = this.chatReplies.get(sessionId);
    if (!reply || reply.editing || reply.editTimer) return;
    const wait = Math.max(0, 2000 - (this.now() - reply.lastEditAt));
    reply.editTimer = setTimeout(() => {
      reply.editTimer = undefined;
      void this.editChatReply(sessionId);
    }, wait);
  }

  private isSessionMinimal(sessionId: string, chatId?: number): boolean {
    if (sessionId.startsWith('brain:')) {
      return this.isMinimalProject(sessionId.slice('brain:'.length));
    }
    if (chatId !== undefined) {
      const selected = this.selectedProject.get(chatId);
      if (selected) return this.isMinimalProject(selected);
    }
    const parts = sessionId.split(':');
    if (parts.length >= 3 && parts[0] === 'telegram') {
      return this.isMinimalProject(parts[2]);
    }
    return false;
  }

  private async editChatReply(sessionId: string): Promise<void> {
    const reply = this.chatReplies.get(sessionId);
    if (!reply || reply.editing) return;
    if (this.isSessionMinimal(sessionId, reply.chatId)) return;
    reply.editing = true;
    try {
      await this.editMessage(reply.chatId, reply.messageId, this.chatProgressText(reply.text));
      reply.lastEditAt = this.now();
    } catch {
      // The final reply is attempted again when the turn completes.
    } finally {
      reply.editing = false;
    }
    if (this.chatReplies.has(sessionId) && this.chatReplies.get(sessionId)?.text !== reply.text) this.scheduleChatEdit(sessionId);
  }

  private async finishChatReply(sessionId: string, keepText: boolean): Promise<void> {
    const reply = this.chatReplies.get(sessionId);
    if (!reply) return;
    if (reply.editTimer) clearTimeout(reply.editTimer);
    const minimal = this.isSessionMinimal(sessionId, reply.chatId);
    let text = reply.text;
    if (minimal) {
      text = 'Bộ não đã trả lời, xem dashboard';
    } else if (!keepText) {
      try {
        const last = this.chatService?.listMessages(sessionId, 5).messages.filter((m) => m.role === 'assistant').pop();
        if (last) text = last.content;
      } catch {
        // Keep streamed text when the session is already gone.
      }
    }
    this.chatReplies.delete(sessionId);
    if (minimal) {
      const dashboardUrl = this.getDashboardUrl();
      const keyboard: InlineKeyboardButton[][] = [
        [{ text: '🌐 Xem dashboard', url: dashboardUrl }],
      ];
      await this.editMessage(reply.chatId, reply.messageId, 'Bộ não đã trả lời, xem dashboard', {
        inline_keyboard: keyboard,
      });
      return;
    }
    const chunks = this.splitTelegramText(text || '');
    await this.editMessage(reply.chatId, reply.messageId, chunks.shift() || '');
    for (const chunk of chunks) {
      const extra = await this.sendMessage(reply.chatId, chunk, undefined, reply.threadId);
      const extraId = this.telegramMessageId(extra);
      if (extraId !== null && (sessionId === 'brain' || sessionId.startsWith('brain:'))) {
        this.recordAskReply(extraId, sessionId);
      }
    }
  }

  private async sendPermissionRequest(chatId: number, data: Record<string, unknown>): Promise<void> {
    const id = typeof data.id === 'string' ? data.id : undefined;
    if (!id) return;
    const tool = typeof data.toolName === 'string' ? data.toolName : 'công cụ';
    let input: Record<string, unknown> = {};
    try { input = typeof data.input === 'string' ? JSON.parse(data.input) as Record<string, unknown> : (data.input as Record<string, unknown> || {}); } catch { /* malformed input is still shown as a generic request */ }
    const command = typeof input.command === 'string' ? input.command : undefined;
    const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
    const threadId = sessionId ? this.chatReplies.get(sessionId)?.threadId : undefined;
    const session = this.chatService?.listSessions().find((item) => item.id === sessionId);
    const project = session?.projectId ? this.projectRepo.get(session.projectId) : undefined;
    const label = command ? commandPermissionLabel(command) : tool;
    const isAssistantSession = sessionId === 'assistant' || sessionId.startsWith('assistant:');
    const canAlwaysAllow = !isAssistantSession && (!command || canAlwaysAllowCommand(command));
    const text = [
      `🔐 <b>Dự án: ${this.escapeHtml(project ? `${project.name} (${project.id})` : 'Không gắn dự án')}</b>`,
      `Phiên: <b>${this.escapeHtml(session ? `${session.title || 'Phiên chat'} (${session.id})` : sessionId || 'Phiên chat')}</b> — Claude cần quyền`,
      `Công cụ: <b>${this.escapeHtml(tool)}</b>`,
      command ? `<pre>${this.escapeHtml(command.slice(0, 500))}</pre>` : '',
      typeof input.cwd === 'string' ? `Thư mục: <code>${this.escapeHtml(input.cwd)}</code>` : '',
      typeof input.file_path === 'string' ? `Tệp: <code>${this.escapeHtml(input.file_path)}</code>` : '',
    ].filter(Boolean).join('\n');
    await this.sendMessage(chatId, text, {
      inline_keyboard: [[
        { text: 'Cho phép', callback_data: `permission:allow:${id}` },
        ...(canAlwaysAllow ? [{ text: `Luôn cho phép ${label.slice(0, 30)}`, callback_data: `permission:always:${id}` }] : []),
        { text: 'Từ chối', callback_data: `permission:deny:${id}` },
      ]],
    }, threadId);
  }

  private async handlePermissionRules(chatId: number, args: string[]): Promise<void> {
    if (!this.chatService) return;
    const rules = this.chatService.listPermissionRules();
    if (args[0]?.toLowerCase() === 'del') {
      const index = Number(args[1]);
      const rule = Number.isInteger(index) && index > 0 ? rules[index - 1] : undefined;
      if (!rule || !this.chatService.deletePermissionRule(rule.id)) { await this.sendMessage(chatId, 'Không tìm thấy quy tắc. Dùng /rules để xem danh sách.'); return; }
      await this.sendMessage(chatId, `🗑️ Đã xoá quy tắc #${index}.`); return;
    }
    if (!rules.length) { await this.sendMessage(chatId, 'Chưa có quyền luôn cho phép nào.'); return; }
    const lines = rules.map((rule, i) => `${i + 1}. <code>${this.escapeHtml(rule.toolName)} ${this.escapeHtml(rule.pattern)}</code> (${rule.scope})`);
    await this.sendMessage(chatId, `🔐 <b>Quyền đã cấp</b>\n${lines.join('\n')}\n\nDùng <code>/rules del &lt;số&gt;</code> để xoá.`);
  }

  private telegramMessageId(value: unknown): number | null {
    const messageId = (value && typeof value === 'object' ? (value as { result?: { message_id?: unknown } }).result?.message_id : undefined);
    return typeof messageId === 'number' ? messageId : null;
  }

  private chatProgressText(text: string): string {
    return this.escapeHtml(text.slice(-3900));
  }

  private splitTelegramText(text: string): string[] {
    const safe = text || ' ';
    const chunks: string[] = [];
    for (let i = 0; i < safe.length; i += 3900) chunks.push(this.escapeHtml(safe.slice(i, i + 3900)));
    return chunks;
  }

  private async editMessage(
    chatId: number,
    messageId: number,
    text: string,
    replyMarkup?: { inline_keyboard: InlineKeyboardButton[][] },
  ): Promise<unknown> {
    if (!this.token) return null;
    const url = `https://api.telegram.org/bot${this.token}/editMessageText`;
    const request = async (parseMode: boolean): Promise<Response> => this.fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          text: text || ' ',
          ...(parseMode ? { parse_mode: 'HTML' } : {}),
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        }),
      });
    try {
      let res = await request(true);
      if (!res.ok) res = await request(false);
      if (!res.ok) throw new Error(`status ${res.status}`);
      return res.json();
    } catch (err) {
      throw new Error(`Telegram editMessageText request failed: ${redactTelegramToken(err, this.token)}`);
    }
  }

  // --- Callback Query Handling (Inline Buttons) ---

  private async handleCallbackQuery(query: NonNullable<TelegramUpdate['callback_query']>): Promise<void> {
    const chatId = query.message?.chat.id;
    const threadId = query.message?.message_thread_id;
    if (chatId !== undefined) {
      this.activeThreadByChat.set(chatId, threadId);
      if (threadId !== undefined) {
        const topicDept = this.findDepartmentByTopic(chatId, threadId);
        if (topicDept) {
          this.selectedDepartment.set(chatId, topicDept.id);
          this.selectedProject.delete(chatId);
        } else {
          const topicProject = Object.entries(this.config.telegram.projectTopics || {}).find(([, topic]) => topic.chatId === chatId && topic.threadId === threadId)?.[0];
          if (topicProject) {
            this.selectedProject.set(chatId, topicProject);
            this.selectedDepartment.delete(chatId);
          }
        }
      }
    }
    const userId = query.from.id;
    const isAllowed = Boolean(
      chatId &&
      (userId === chatId || this.config.telegram?.allowedChatIds?.includes(userId)) &&
      this.config.telegram?.allowedChatIds?.includes(chatId),
    );

    if (!isAllowed || !chatId) {
      await this.answerCallbackQuery(query.id);
      return;
    }

    const data = query.data || '';
    const parts = data.split(':');
    const domain = parts[0];
    const action = parts[1];
    const taskIdOrParam = parts.slice(2).join(':');

    if (domain === 'hubshutdown') {
      if (action !== 'confirm') {
        await this.answerCallbackQuery(query.id, 'Đã hủy.');
        return;
      }
      await this.answerCallbackQuery(query.id, 'Đang tắt AgentHub...');
      this.service.shutdownForUser();
      await this.sendMessage(chatId, '🛑 AgentHub đã lưu trạng thái và đang tắt. Bật lại từ máy bằng: <code>agenthub start</code>.');
      setImmediate(() => process.kill(process.pid, 'SIGTERM'));
      return;
    }

    if (domain === 'hubrestart') {
      if (action !== 'confirm') {
        await this.answerCallbackQuery(query.id, 'Đã hủy.');
        return;
      }
      await this.answerCallbackQuery(query.id, 'Đang khởi động lại...');
      this.service.shutdownForUser('hub_restart');
      await this.sendMessage(chatId, '🔄 Đang khởi động lại AgentHub; worker đã được đưa về hàng chờ.');
      this.service.triggerRestart();
      return;
    }

    if (domain === 'permission') {
      if (!this.chatService) {
        await this.answerCallbackQuery(query.id, 'Chat chưa sẵn sàng.');
        return;
      }
      const decision = action === 'allow' ? 'allow' : action === 'always' ? 'allow_always' : 'deny';
      try {
        this.chatService.decidePermission(taskIdOrParam, decision);
        await this.answerCallbackQuery(query.id, decision === 'deny' ? 'Đã từ chối.' : 'Đã cho phép.');
        if (query.message) {
          const result = decision === 'deny' ? '🚫 Đã từ chối.' : decision === 'allow_always' ? '✅ Đã luôn cho phép.' : '✅ Đã cho phép.';
          const previousText = this.escapeHtml(query.message.text || '');
          await this.editMessage(chatId, query.message.message_id, `${previousText}\n\n<b>${result}</b>`, { inline_keyboard: [] });
        }
      } catch {
        await this.answerCallbackQuery(query.id, 'Yêu cầu đã hết hạn.');
        if (query.message) {
          const previousText = this.escapeHtml(query.message.text || '');
          await this.editMessage(chatId, query.message.message_id, `${previousText}\n\n⚠️ Yêu cầu đã hết hạn.`, { inline_keyboard: [] });
        }
      }
      return;
    }

    switch (domain) {
      case 'braintrust': {
        if (action === 'full') {
          const project = this.projectRepo.get(taskIdOrParam);
          if (!project) {
            await this.answerCallbackQuery(query.id, 'Dự án không tồn tại.');
            return;
          }
          const updated = mergeProjectSettings(projectSettings(project), { brain: { permissions: 'full' } });
          this.projectRepo.update(project.id, { settings: JSON.stringify(updated) });
          this.eventBus.emit('brain.trust_changed', undefined, { projectId: project.id, permissions: 'full', source: 'telegram' });
          await this.answerCallbackQuery(query.id, 'Đã xác nhận Toàn quyền.');
          await this.sendMessage(chatId, `🧠 Đã đổi quyền bộ não dự án <b>${this.escapeHtml(project.id)}</b> sang <b>full</b>.`);
          return;
        }
        break;
      }
      case 'use': {
        if (action === 'select') {
          const projectId = taskIdOrParam;
          const project = this.projectRepo.getIncludingArchived ? this.projectRepo.getIncludingArchived(projectId) : this.projectRepo.get(projectId);
          if (!project) {
            await this.answerCallbackQuery(query.id, 'Dự án không tồn tại.');
            return;
          }
          if (project.archivedAt) {
            await this.answerCallbackQuery(query.id, 'Dự án đã bị ẩn.');
            return;
          }
          this.selectedProject.set(chatId, project.id);
          this.persistSelectedProject(chatId, project.id);
          const name = project.name ? `${project.name} (${project.id})` : project.id;
          await this.answerCallbackQuery(query.id, `Đã chọn ${project.id}`);

          let edited = false;
          if (query.message?.message_id) {
            try {
              let text: string;
              if (query.message.text?.includes('Dự án đang chọn') || query.message.text?.includes('Chưa chọn dự án nào')) {
                text = `📁 Dự án đang chọn: <b>${this.escapeHtml(name)}</b>\n\nGõ <code>/use &lt;dự án&gt;</code> để đổi, hoặc <code>/use none</code> để bỏ chọn.`;
              } else {
                text = this.buildProjectsListText(chatId);
              }
              const replyMarkup = { inline_keyboard: this.buildProjectPicker(chatId) };
              await this.editMessage(chatId, query.message.message_id, text, replyMarkup);
              edited = true;
            } catch {
              edited = false;
            }
          }
          if (!edited) {
            await this.sendMessage(chatId, `📁 Đã chọn dự án <b>${this.escapeHtml(name)}</b>. Tin nhắn sẽ được gửi tới bộ não dự án này.`);
          }
          return;
        }

        if (action === 'clear') {
          this.selectedProject.delete(chatId);
          this.persistSelectedProject(chatId, undefined);
          await this.answerCallbackQuery(query.id, 'Đã bỏ chọn dự án');

          let edited = false;
          if (query.message?.message_id) {
            try {
              let text: string;
              if (query.message.text?.includes('Dự án đang chọn') || query.message.text?.includes('Chưa chọn dự án nào')) {
                text = '📁 Chưa chọn dự án nào. Chọn dự án:';
              } else {
                text = this.buildProjectsListText(chatId);
              }
              const replyMarkup = { inline_keyboard: this.buildProjectPicker(chatId) };
              await this.editMessage(chatId, query.message.message_id, text, replyMarkup);
              edited = true;
            } catch {
              edited = false;
            }
          }
          if (!edited) {
            await this.sendMessage(chatId, '📁 Đã bỏ chọn dự án. Tin nhắn sẽ gửi tới bộ não hệ thống.');
          }
          return;
        }
        break;
      }
      case 'decision': {
        const decisionId = taskIdOrParam;
        if (action !== 'agree' && action !== 'reject') {
          await this.answerCallbackQuery(query.id, 'Lựa chọn không hợp lệ.');
          return;
        }
        const d = this.decisionTracker.getDecision(decisionId);
        if (!d || d.answered) {
          await this.answerCallbackQuery(query.id, 'Quyết định đã hết hạn hoặc đã trả lời.');
          return;
        }
        const answer = action;
        const updated = this.decisionTracker.answerDecision(decisionId, answer, this.now());
        const label = answer === 'agree' ? 'Đồng ý' : 'Không';
        const icon = answer === 'agree' ? '✅' : '❌';
        await this.answerCallbackQuery(query.id, `Bạn đã chọn: ${label}`);

        if (this.chatService) {
          forwardDecisionToBrain(this.chatService, decisionId, updated?.text || d.text, answer, updated?.taskId);
        }

        if (query.message) {
          const originalText = this.escapeHtml(query.message.text || '');
          const updatedText = `${originalText}\n\n${icon} <b>Đã phản hồi: ${label}</b>`;
          const keyboard: InlineKeyboardButton[][] = [
            [{ text: '🌐 Xem dashboard', url: this.getDashboardUrl() }],
          ];
          try {
            await this.editMessage(query.message.chat.id, query.message.message_id, updatedText, {
              inline_keyboard: keyboard,
            });
          } catch {
            await this.sendMessage(chatId, `${icon} <b>Đã phản hồi quyết định: ${label}</b>`);
          }
        } else {
          await this.sendMessage(chatId, `${icon} <b>Đã phản hồi quyết định: ${label}</b>`);
        }

        this.eventBus.emit('decision.answered', undefined, {
          decisionId,
          action: answer,
          answer,
          text: updated?.text || d.text,
        });
        break;
      }
      case 'triage': {
        if (!['do', 'split', 'ask', 'skip', 'skip-note', 'manual'].includes(action)) {
          await this.answerCallbackQuery(query.id, 'Lựa chọn không hợp lệ.');
          return;
        }
        const parts = taskIdOrParam.split(':');
        const sourceId = parts.slice(0, -1).join(':');
        const wpIdText = parts.at(-1) || '';
        const wpId = Number(wpIdText);
        if (!sourceId || !Number.isSafeInteger(wpId) || wpId <= 0) {
          await this.answerCallbackQuery(query.id, 'Mã ticket không hợp lệ.');
          return;
        }
        if (action === 'ask' || action === 'skip-note') {
          this.chatStates.set(chatId, { action: 'triage_note', sourceId, wpId, decision: action === 'ask' ? 'ask' : 'skip' });
          await this.answerCallbackQuery(query.id, 'Hãy nhập ghi chú hoặc lý do.');
          await this.sendMessage(chatId, action === 'ask' ? 'Nhập ghi chú bổ sung cho tester, hoặc /cancel:' : 'Nhập lý do không xử lý (hoặc /cancel):');
          return;
        }
        const resolvedAction = action as 'do' | 'split' | 'skip' | 'manual';
        try {
          const result = await this.service.decideOpenProjectTicket(sourceId, wpId, resolvedAction);
          await this.answerCallbackQuery(query.id, `Đã chọn: ${resolvedAction}`);
          await this.sendMessage(chatId, `🔗 ${this.escapeHtml(sourceId)}/${wpId}: đã chọn <b>${this.escapeHtml(resolvedAction)}</b>${result.taskIds.length ? `\nTask: <code>${this.escapeHtml(result.taskIds.join(', '))}</code>` : ''}`);
        } catch (error) {
          await this.answerCallbackQuery(query.id, 'Không thể thực hiện quyết định.');
          await this.sendMessage(chatId, `❌ Không thể quyết định triage: ${this.escapeHtml(error instanceof Error ? error.message : String(error))}`);
        }
        break;
      }
      case 'chatlimit': {
        if (!this.chatService) { await this.answerCallbackQuery(query.id, 'Chat chưa sẵn sàng.'); return; }
        const result = action === 'cancel' ? this.chatService.cancelLimitRetry(taskIdOrParam) : this.chatService.retryLimitNow(taskIdOrParam);
        await this.answerCallbackQuery(query.id, result.ok ? (action === 'cancel' ? 'Đã huỷ retry.' : 'Đã gửi lại.') : 'Retry không còn tồn tại.');
        if (result.ok) await this.sendMessage(chatId, action === 'cancel' ? '⏹ Đã huỷ tự gửi lại Claude.' : '▶️ Đã gửi lại lượt Claude ngay.');
        break;
      }
      case 'cancel': {
        if (action === 'confirm') {
          const resolved = this.resolveTask(taskIdOrParam);
          if ('error' in resolved) {
            await this.answerCallbackQuery(query.id, 'Không tìm thấy task.');
            return;
          }
          try {
            const who = query.from?.username ? `telegram:@${query.from.username}` : `telegram:${query.from?.id ?? chatId}`;
            this.service.cancelTask(resolved.id, { reason: 'Hủy bằng nút trên Telegram', by: who });
            await this.answerCallbackQuery(query.id, 'Đã hủy task.');
            await this.sendMessage(chatId, `🛑 Đã hủy task ${resolved.id}.`);
          } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            await this.answerCallbackQuery(query.id, 'Lỗi hủy task.');
            await this.sendMessage(chatId, `❌ Lỗi khi hủy task: ${errMsg}`);
          }
        } else {
          await this.answerCallbackQuery(query.id, 'Đã hủy thao tác.');
          await this.sendMessage(chatId, 'Đã hủy thao tác.');
        }
        break;
      }

      case 'review': {
        const resolved = this.resolveTask(taskIdOrParam);
        if ('error' in resolved) {
          await this.answerCallbackQuery(query.id, 'Không tìm thấy task.');
          return;
        }

        if (action === 'approve') {
          const project = this.projectRepo.get(resolved.projectId);
          const hasMerge = isProjectMergeEnabled(project);
          try {
            await this.service.reviewTask(resolved.id, {
              verdict: 'approved',
              merge: hasMerge,
              by: 'telegram',
            });
            await this.answerCallbackQuery(query.id, 'Đã duyệt task!');
            await this.sendMessage(
              chatId,
              `✅ Đã duyệt task ${resolved.id}${hasMerge ? ' (và merge vào nhánh mặc định)' : ''}.`,
            );
          } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            await this.answerCallbackQuery(query.id, 'Lỗi duyệt task.');
            await this.sendMessage(chatId, `❌ Lỗi khi duyệt task: ${errMsg}`);
          }
        } else if (action === 'reject_prompt') {
          await this.answerCallbackQuery(query.id, 'Vui lòng nhập nhận xét...');
          this.chatStates.set(chatId, { action: 'reject_feedback', taskId: resolved.id });
          await this.sendMessage(
            chatId,
            `💬 Vui lòng gửi nhận xét/yêu cầu sửa cho task ${resolved.id}:\n(Hoặc gửi /cancel để hủy)`,
          );
        }
        break;
      }

      case 'task': {
        const resolved = this.resolveTask(taskIdOrParam);
        if ('error' in resolved) {
          await this.answerCallbackQuery(query.id, 'Không tìm thấy task.');
          return;
        }

        if (action === 'diff') {
          if (this.isMinimalProject(resolved.projectId)) {
            await this.answerCallbackQuery(query.id, 'Dự án này ẩn nội dung trên Telegram, xem trên dashboard');
            await this.sendMessage(chatId, 'Dự án này ẩn nội dung trên Telegram, xem trên dashboard');
            return;
          }
          await this.answerCallbackQuery(query.id, 'Đang lấy diff...');
          const diffText = await this.getTaskDiffSummary(resolved);
          await this.sendMessage(
            chatId,
            `📊 Diff tóm tắt của task ${resolved.id}:\n\n<pre>${this.escapeHtml(diffText)}</pre>`,
          );
        } else if (action === 'retry') {
          try {
            this.service.retryTask(resolved.id, {});
            await this.answerCallbackQuery(query.id, 'Đã đưa vào hàng đợi.');
            await this.sendMessage(chatId, `🔄 Đã đưa task ${resolved.id} vào hàng đợi để chạy lại.`);
          } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            await this.answerCallbackQuery(query.id, 'Lỗi retry.');
            await this.sendMessage(chatId, `❌ Lỗi khi retry task: ${errMsg}`);
          }
        } else if (action === 'resume') {
          try {
            this.service.resumeTask(resolved.id);
            await this.answerCallbackQuery(query.id, 'Đã tiếp tục task.');
            await this.sendMessage(chatId, `▶️ Đã tiếp tục task <b>${this.escapeHtml(resolved.id)}</b>.`);
          } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            await this.answerCallbackQuery(query.id, 'Lỗi tiếp tục task.');
            await this.sendMessage(chatId, `❌ Lỗi khi tiếp tục task: ${errMsg}`);
          }
        } else if (action === 'log') {
          if (this.isMinimalProject(resolved.projectId)) {
            await this.answerCallbackQuery(query.id, 'Dự án này ẩn nội dung trên Telegram, xem trên dashboard');
            await this.sendMessage(chatId, 'Dự án này ẩn nội dung trên Telegram, xem trên dashboard');
            return;
          }
          await this.answerCallbackQuery(query.id, 'Đang lấy log...');
          const logText = this.getTaskLast30Lines(resolved.id);
          await this.sendMessage(
            chatId,
            `📄 30 dòng cuối log của ${resolved.id}:\n\n<pre>${this.escapeHtml(logText)}</pre>`,
          );
        } else if (action === 'publish') {
          try {
            await this.answerCallbackQuery(query.id, 'Đang đẩy lên git...');
            const res = await this.service.publishTask(resolved.id, { manual: true });
            if (res.ok && 'commit' in res) {
              const successText = `🚀 Đã đẩy task <b>${this.escapeHtml(resolved.id)}</b> lên <code>${this.escapeHtml(res.remote)}/${this.escapeHtml(res.branch)}</code> (commit <code>${this.escapeHtml(res.commit.slice(0, 7))}</code>).`;
              if (query.message) {
                const prev = this.escapeHtml(query.message.text || '');
                await this.editMessage(chatId, query.message.message_id, `${prev}\n\n${successText}`, { inline_keyboard: [] });
              } else {
                await this.sendMessage(chatId, successText);
              }
            } else if (!res.ok) {
              const failText = `❌ Đẩy task <b>${this.escapeHtml(resolved.id)}</b> thất bại: ${this.escapeHtml(res.error)}`;
              await this.sendMessage(chatId, failText);
            }
          } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            await this.answerCallbackQuery(query.id, 'Lỗi đẩy git.');
            await this.sendMessage(chatId, `❌ Lỗi khi đẩy task: ${this.escapeHtml(errMsg)}`);
          }
        }
        break;
      }

      case 'newtask': {
        if (action === 'cancel') {
          this.chatStates.delete(chatId);
          await this.answerCallbackQuery(query.id, 'Đã huỷ thao tác.');
          await this.sendMessage(chatId, 'Đã hủy thao tác tạo task.');
          return;
        }

        if (action === 'proj') {
          const projectId = taskIdOrParam;
          const currentState = this.chatStates.get(chatId);
          if (currentState?.action === 'newtask_description') {
            this.chatStates.set(chatId, { action: 'newtask_description', projectId });
            await this.answerCallbackQuery(query.id, `Đã chọn ${projectId}`);
            await this.sendMessage(chatId, `📁 Đã chọn project <b>${this.escapeHtml(projectId)}</b>. Hãy gửi một đoạn mô tả chung về việc cần làm:`);
            return;
          }
          if (currentState?.action === 'newtask_project_description') {
            this.chatStates.delete(chatId);
            await this.answerCallbackQuery(query.id, `Đã chọn ${projectId}`);
            await this.sendAutoTaskToClaude(chatId, projectId, currentState.description, currentState.externalRef);
            return;
          }
          this.chatStates.set(chatId, { action: 'newtask_title', projectId });
          await this.answerCallbackQuery(query.id, `Đã chọn ${projectId}`);
          await this.sendMessage(
            chatId,
            `📁 Dự án: <b>${this.escapeHtml(projectId)}</b>\n\n✏️ Vui lòng nhập <b>tiêu đề</b> cho task:\n(Gõ /cancel để huỷ)`,
          );
          return;
        }

        if (action === 'detail') {
          await this.answerCallbackQuery(query.id, 'Mở chế độ nhập chi tiết.');
          await this.startNewTaskWizard(chatId);
          return;
        }

        if (action === 'level') {
          const state = this.chatStates.get(chatId);
          const projectId = state && 'projectId' in state && typeof state.projectId === 'string' ? state.projectId : '';
          const title = state && 'title' in state ? state.title : '';
          const body = state && 'body' in state ? state.body : '';
          const level = (taskIdOrParam === 'hard' ? 'hard' : 'easy') as 'easy' | 'hard';
          const defaultModel =
            this.config.defaultModelChains[level]?.[0] ||
            (level === 'hard' ? 'codex:gpt-5.6-luna' : 'gemini-3.8-flash-medium');
          const modelOpts = this.service.getModelOptions();
          const allModels = Array.from(
            new Set([...(modelOpts.configured || []), ...(modelOpts.suggestions || [])]),
          );

          this.chatStates.set(chatId, {
            action: 'newtask_model',
            projectId,
            title,
            body,
            level,
            defaultModel,
          });

          const otherModels = allModels.filter((m) => m !== defaultModel);
          const modelButtons: InlineKeyboardButton[][] = [
            [{ text: `⭐ Mặc định (${defaultModel})`, callback_data: 'newtask:model:default' }],
          ];
          for (const m of otherModels) {
            modelButtons.push([{ text: m, callback_data: `newtask:model:${m}` }]);
          }
          modelButtons.push([{ text: '❌ Huỷ', callback_data: 'newtask:cancel' }]);

          await this.answerCallbackQuery(query.id, `Đã chọn ${level}`);
          await this.sendMessage(
            chatId,
            `⚙️ Độ khó: <b>${level}</b>\n\n🤖 Chọn <b>model</b> cho task:`,
            { inline_keyboard: modelButtons },
          );
          return;
        }

        if (action === 'model') {
          const modelChoice = taskIdOrParam;
          const state = this.chatStates.get(chatId);
          if (!state || state.action !== 'newtask_model') {
            await this.answerCallbackQuery(query.id, 'Thao tác đã hết hạn.');
            return;
          }

          const isDefault = modelChoice === 'default';
          const modelDisplay = isDefault ? `${state.defaultModel} (mặc định)` : modelChoice;
          const modelChain = isDefault ? undefined : [modelChoice];
          const slug = generateTaskSlug(state.title, state.projectId, this.taskRepo);

          this.chatStates.set(chatId, {
            action: 'newtask_confirm',
            projectId: state.projectId,
            title: state.title,
            body: state.body,
            level: state.level,
            slug,
            modelChain,
            modelDisplay,
          });

          const confirmKeyboard: InlineKeyboardButton[][] = [
            [
              { text: '🚀 Giao ngay', callback_data: 'newtask:confirm:queued' },
              { text: '💾 Lưu nháp', callback_data: 'newtask:confirm:draft' },
              { text: '❌ Huỷ', callback_data: 'newtask:confirm:cancel' },
            ],
            [
              { text: '🎫 Giao + ticket OP', callback_data: 'newtask:confirm:queued_ticket' },
              { text: '🎫 Nháp + ticket OP', callback_data: 'newtask:confirm:draft_ticket' },
            ],
          ];

          const summaryText =
            `📋 <b>Xác nhận tạo task</b>\n\n` +
            `• Dự án: <code>${this.escapeHtml(state.projectId)}</code>\n` +
            `• Tiêu đề: <b>${this.escapeHtml(state.title)}</b>\n` +
            `• Slug: <code>${this.escapeHtml(slug)}</code>\n` +
            `• Độ khó: <code>${state.level}</code>\n` +
            `• Model: <code>${this.escapeHtml(modelDisplay)}</code>\n` +
            `• Đề bài:\n<i>${this.escapeHtml(state.body || '(không có)')}</i>`;

          await this.answerCallbackQuery(query.id, 'Đã chọn model.');
          await this.sendMessage(chatId, summaryText, { inline_keyboard: confirmKeyboard });
          return;
        }

        if (action === 'confirm') {
          const choice = taskIdOrParam;
          const state = this.chatStates.get(chatId);
          if (!state || state.action !== 'newtask_confirm') {
            await this.answerCallbackQuery(query.id, 'Thao tác đã hết hạn.');
            return;
          }

          if (choice === 'cancel') {
            this.chatStates.delete(chatId);
            await this.answerCallbackQuery(query.id, 'Đã huỷ.');
            await this.sendMessage(chatId, 'Đã hủy thao tác tạo task.');
            return;
          }

          const withTicket = choice.endsWith('_ticket');
          const start = choice === 'queued' || choice === 'queued_ticket';
          try {
            const taskInput = {
              project: state.projectId,
              slug: state.slug,
              title: state.title,
              body: state.body,
              level: state.level,
              modelChain: state.modelChain,
              start,
              ...(withTicket ? { createTicket: {} } : {}),
            };
            const task = withTicket ? await this.service.createTaskWithTicket(taskInput) : this.service.createTask(taskInput);
            this.chatStates.delete(chatId);
            if (start) {
              await this.answerCallbackQuery(query.id, 'Đã giao việc!');
              await this.sendMessage(
                chatId,
                `🚀 Đã giao task <code>${task.id}</code> vào hàng đợi:\n<b>${this.escapeHtml(task.title)}</b>`,
              );
            } else {
              await this.answerCallbackQuery(query.id, 'Đã lưu nháp!');
              await this.sendMessage(
                chatId,
                `💾 Đã lưu nháp task <code>${task.id}</code>:\n<b>${this.escapeHtml(task.title)}</b>\n\nDùng /drafts để quản lý.`,
              );
            }
          } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            await this.answerCallbackQuery(query.id, 'Lỗi tạo task.');
            await this.sendMessage(chatId, `❌ Lỗi khi tạo task: ${errMsg}`);
          }
          return;
        }
        break;
      }

      case 'draft': {
        const taskId = taskIdOrParam;
        if (action === 'start') {
          try {
            this.service.startTask(taskId);
            await this.answerCallbackQuery(query.id, 'Đã giao task!');
            await this.sendMessage(chatId, `🚀 Đã giao task <code>${taskId}</code> vào hàng đợi.`);
          } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            await this.answerCallbackQuery(query.id, 'Lỗi giao task.');
            await this.sendMessage(chatId, `❌ Lỗi khi giao task: ${errMsg}`);
          }
        } else if (action === 'delete') {
          try {
            this.service.deleteTask(taskId);
            await this.answerCallbackQuery(query.id, 'Đã xoá task!');
            await this.sendMessage(chatId, `🗑️ Đã xoá task nháp <code>${taskId}</code>.`);
          } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            await this.answerCallbackQuery(query.id, 'Lỗi xoá task.');
            await this.sendMessage(chatId, `❌ Lỗi khi xoá task: ${errMsg}`);
          }
        } else if (action === 'keep') {
          await this.answerCallbackQuery(query.id, 'Đã lưu nháp.');
          await this.sendMessage(chatId, `💾 Đã lưu nháp task <code>${taskId}</code>. Dùng /drafts để xem và quản lý.`);
        }
        break;
      }

      case 'batch': {
        const batchId = taskIdOrParam;
        if (action === 'dispatch') {
          try {
            const result = this.service.dispatchBatch(batchId);
            await this.answerCallbackQuery(query.id, 'Đã giao cả đợt!');
            await this.sendMessage(
              chatId,
              `🚀 Đã giao ${result.dispatchedCount} task của đợt <b>${this.escapeHtml(batchId)}</b> vào hàng đợi.`,
            );
          } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            await this.answerCallbackQuery(query.id, 'Lỗi giao đợt.');
            await this.sendMessage(chatId, `❌ Lỗi khi giao đợt: ${errMsg}`);
          }
        } else if (action === 'discard') {
          try {
            this.service.discardBatch(batchId);
            await this.answerCallbackQuery(query.id, 'Đã huỷ đợt!');
            await this.sendMessage(chatId, `🛑 Đã huỷ đợt <b>${this.escapeHtml(batchId)}</b>.`);
          } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            await this.answerCallbackQuery(query.id, 'Lỗi huỷ đợt.');
            await this.sendMessage(chatId, `❌ Lỗi khi huỷ đợt: ${errMsg}`);
          }
        }
        break;
      }

      default:
        await this.answerCallbackQuery(query.id);
        break;
    }
  }

  // --- Command Implementations ---

  private async handleStatusCommand(chatId: number): Promise<void> {
    const status = this.service.getStatus();
    const tasks = status.tasks;
    const running = status.running || [];
    const isPaused = this.service.isSchedulerPaused();
    const brain = status.brain;

    let text = `📊 <b>Tổng quan trạng thái ${this.escapeHtml(this.appName)}</b>\n\n`;
    text = text + `• Điều phối: <b>${isPaused ? '⏸ Tạm dừng giao việc' : '▶️ Đang hoạt động'}</b>\n`;
    if (brain) text = text + `• Brain: <b>${this.brainLabel(brain)}</b>\n`;

    const waitingCount = tasks.waiting_quota || 0;
    let waitingSummaryHtml = `<b>${waitingCount}</b> chờ quota`;
    if (waitingCount > 0 && status.waitingReasons) {
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
      const entries = Object.entries(status.waitingReasons).filter(([, count]) => count > 0);
      if (entries.length === 1) {
        const [reason, count] = entries[0];
        const label = reasonLabels[reason] || reason;
        waitingSummaryHtml = `<b>${count}</b> chờ ${label}`;
      } else if (entries.length > 1) {
        const parts = entries.map(([reason, count]) => `${count} ${reasonLabels[reason] || reason}`);
        waitingSummaryHtml = `<b>${waitingCount}</b> đang chờ (${this.escapeHtml(parts.join(', '))})`;
      }
    }

    const completedTasksCount = (tasks.done || 0) + (tasks.pushed || 0);
    const pushedPart = tasks.pushed ? ` (${tasks.pushed} đã đẩy git)` : '';
    text = text + `• Tasks: <b>${tasks.running}</b> đang chạy, <b>${tasks.review}</b> chờ review, <b>${tasks.queued}</b> hàng đợi, ${waitingSummaryHtml}, <b>${tasks.failed}</b> lỗi, <b>${tasks.blocked}</b> bị chặn, <b>${completedTasksCount}</b> hoàn thành${pushedPart}\n`;

    if (running.length > 0) {
      text = text + '\n🏃 <b>Đang chạy:</b>\n';
      for (const r of running) {
        const taskObj = this.taskRepo.get(r.taskId);
        const titleStr = taskObj?.title || r.taskId;
        const pauseBadge = r.paused
          ? (r.pauseReason === 'load' || r.pauseReason === 'brain_load' ? ' ⏸ [Tạm dừng (quá tải)]' : ' ⏸ [Tạm dừng (thủ công)]')
          : '';
        text = text + `• <code>${r.taskId}</code> (${r.profileName}/${r.model})${pauseBadge}\n  <i>${this.escapeHtml(titleStr)}</i>\n`;
      }
    }

    if (status.disk) {
      text = text + `\n💾 Ổ đĩa: <b>${status.disk.freeGB} GB</b> trống (tối thiểu ${status.disk.minFreeGB} GB)\n`;
    }

    const quotaMarks = status.profiles
      ? status.profiles.flatMap((p: { quotaMarks?: Array<{ until: number; profileName: string; family: string }> }) => p.quotaMarks || [])
      : [];
    if (quotaMarks.length > 0) {
      text = text + '\n⏳ <b>Quota đang bị hạn chế:</b>\n';
      for (const q of quotaMarks) {
        const untilStr = formatReset(q.until, this.now(), 'vi');
        text = text + `• Hồ sơ ${q.profileName} (${q.family}): đến ${untilStr}\n`;
      }
    }

    await this.sendMessage(chatId, text);
  }

  private async handleDigestCommand(chatId: number): Promise<void> {
    const digest = this.buildCurrentDigest();
    const keyboard: InlineKeyboardButton[][] = [
      [{ text: '🌐 Xem dashboard', url: this.getDashboardUrl() }],
    ];
    await this.sendMessage(chatId, digest.text, { inline_keyboard: keyboard });
  }

  private async handleCiCommand(chatId: number, argStr: string): Promise<void> {
    const target = argStr.trim();
    const projects = this.projectRepo.getAll();

    if (!target) {
      const selected = this.selectedProject.get(chatId);
      if (selected) {
        await this.renderProjectCiStatus(chatId, selected);
        return;
      }

      // No argument and no selected project: list all projects
      if (projects.length === 0) {
        await this.sendMessage(chatId, 'ℹ️ Không có dự án nào trong hệ thống.');
        return;
      }

      let msg = '🚦 <b>Trạng thái CI các dự án:</b>\n\n';
      for (const p of projects) {
        const run = this.ciRepo?.getLatest(p.id);
        let icon = '⚪️';
        let statusSummary = 'Chưa có dữ liệu';
        if (run) {
          if (run.status !== 'completed') {
            icon = '🟡';
            statusSummary = `Đang chạy (${run.workflow})`;
          } else if (run.conclusion === 'success') {
            icon = '🟢';
            statusSummary = `Thành công (${run.workflow} @ ${run.sha.slice(0, 7)})`;
          } else if (run.conclusion === 'failure') {
            icon = '🔴';
            statusSummary = `Thất bại (${run.workflow} @ ${run.sha.slice(0, 7)})`;
          } else {
            statusSummary = `${run.conclusion || run.status} (${run.workflow})`;
          }
        }
        msg += `• <b>${this.escapeHtml(p.name)}</b> (<code>${p.id}</code>): ${icon} ${this.escapeHtml(statusSummary)}\n`;
      }
      msg += '\nGõ <code>/ci &lt;dự án&gt;</code> để xem chi tiết run và job lỗi.';
      await this.sendMessage(chatId, msg);
      return;
    }

    // Target provided
    let proj = this.projectRepo.get(target);
    if (!proj) {
      proj = projects.find(
        (p) =>
          p.name.toLowerCase() === target.toLowerCase() ||
          p.id.toLowerCase() === target.toLowerCase(),
      );
    }
    if (!proj) {
      await this.sendMessage(chatId, `❌ Không tìm thấy dự án <b>${this.escapeHtml(target)}</b>.`);
      return;
    }

    await this.renderProjectCiStatus(chatId, proj.id);
  }

  private async renderProjectCiStatus(chatId: number, projectId: string): Promise<void> {
    const proj = this.projectRepo.get(projectId);
    if (!proj) {
      await this.sendMessage(chatId, `❌ Không tìm thấy dự án <code>${this.escapeHtml(projectId)}</code>.`);
      return;
    }

    const run = this.ciRepo?.getLatest(proj.id);
    if (!run) {
      await this.sendMessage(
        chatId,
        `ℹ️ Dự án <b>${this.escapeHtml(proj.name)}</b> (<code>${proj.id}</code>) chưa có dữ liệu CI nào được ghi nhận.`,
      );
      return;
    }

    let statusIcon = '⚪️';
    let statusText = run.status;
    if (run.status !== 'completed') {
      statusIcon = '🟡';
      statusText = 'Đang chạy';
    } else if (run.conclusion === 'success') {
      statusIcon = '🟢';
      statusText = 'Thành công (Passed)';
    } else if (run.conclusion === 'failure') {
      statusIcon = '🔴';
      statusText = 'Thất bại (Failed)';
    } else {
      statusText = run.conclusion || run.status;
    }

    let msg = `🚦 <b>Trạng thái CI · ${this.escapeHtml(proj.name)}</b> (<code>${proj.id}</code>)\n\n`;
    msg += `• Trạng thái: ${statusIcon} <b>${this.escapeHtml(statusText)}</b>\n`;
    msg += `• Workflow: <b>${this.escapeHtml(run.workflow)}</b>\n`;
    if (run.sha) msg += `• Commit: <code>${this.escapeHtml(run.sha.slice(0, 7))}</code>\n`;
    if (run.completedAt) msg += `• Thời gian: ${this.escapeHtml(run.completedAt)}\n`;

    let jobs: Array<{
      id?: number;
      name?: string;
      conclusion?: string;
      annotations?: Array<{ message?: string; path?: string; start_line?: number }>;
    }> = [];
    try {
      jobs = JSON.parse(run.jobs);
    } catch {
      jobs = [];
    }

    const failedJobs = jobs.filter(
      (j) => j.conclusion === 'failure' || (j.annotations && j.annotations.length > 0),
    );
    if (failedJobs.length > 0) {
      msg += `\n❌ <b>Job lỗi (${failedJobs.length}):</b>\n`;
      for (const j of failedJobs) {
        msg += `\n• <b>${this.escapeHtml(j.name || 'Job')}</b>:`;
        if (j.annotations && j.annotations.length > 0) {
          for (const a of j.annotations.slice(0, 5)) {
            const loc = a.path ? ` (${this.escapeHtml(a.path)}${a.start_line ? `:${a.start_line}` : ''})` : '';
            msg += `\n  - ${this.escapeHtml(a.message || 'Lỗi')}${loc}`;
          }
          if (j.annotations.length > 5) {
            msg += `\n  <i>... và ${j.annotations.length - 5} chú thích lỗi khác.</i>`;
          }
        } else {
          msg += ` Thất bại`;
        }
      }
    }

    const keyboard: InlineKeyboardButton[][] = [];
    if (run.url) {
      keyboard.push([{ text: '🔗 Xem run trên GitHub', url: run.url }]);
    }
    await this.sendMessage(chatId, msg, keyboard.length > 0 ? { inline_keyboard: keyboard } : undefined);
  }

  private brainLabel(value: { state?: string; stale?: boolean }): string {
    if (value.state === 'waiting') return 'chờ bạn trả lời';
    if (value.state === 'working') return 'đang làm';
    if (value.state === 'inactive' || value.stale) return 'không hoạt động';
    return 'đang làm';
  }

  private async handleTasksCommand(chatId: number, statusFilter?: string): Promise<void> {
    const filter = statusFilter && statusFilter.trim() !== 'all' ? statusFilter.trim().toLowerCase() : undefined;
    const tasks = this.service.listTasks(filter ? { status: filter } : undefined);

    if (tasks.length === 0) {
      await this.sendMessage(chatId, `Không có task nào${filter ? ` ở trạng thái '${filter}'` : ''}.`);
      return;
    }

    let text = `📋 <b>Danh sách task${filter ? ` (${filter})` : ''}</b> (${tasks.length}):\n\n`;
    const displayList = tasks.slice(0, 15);
    for (const t of displayList) {
      const title = this.isMinimalProject(t.projectId)
        ? '(nội dung ẩn trên Telegram, xem trên dashboard)'
        : this.escapeHtml(t.title);
      const taskWithPaused = t as TaskRow & { paused?: boolean; pauseReason?: string | null };
      const isPaused = Boolean(taskWithPaused.paused);
      const pauseBadge = isPaused
        ? (taskWithPaused.pauseReason === 'load' || taskWithPaused.pauseReason === 'brain_load' ? ' [Tạm dừng (quá tải)]' : ' [Tạm dừng (thủ công)]')
        : '';
      text = text + `• [${t.status}]${pauseBadge} <code>${t.id}</code>: ${title}\n`;
    }

    if (tasks.length > 15) {
      text = text + `\n<i>... và còn ${tasks.length - 15} task khác.</i>`;
    }

    await this.sendMessage(chatId, text);
  }

  private async handleTaskDetailCommand(chatId: number, idOrSlug: string): Promise<void> {
    if (!idOrSlug) {
      await this.sendMessage(chatId, 'Vui lòng cung cấp task ID hoặc slug: /task <id>');
      return;
    }

    const resolved = this.resolveTask(idOrSlug);
    if ('error' in resolved) {
      await this.sendMessage(chatId, this.renderResolveError(idOrSlug, resolved));
      return;
    }

    if (this.isMinimalProject(resolved.projectId)) {
      await this.sendMessage(chatId, 'Dự án này ẩn nội dung trên Telegram, xem trên dashboard');
      return;
    }

    const detail = await this.service.getTask(resolved.id);
    const checks = detail.checks || [];
    let checksText = 'Chưa có kiểm tra';
    if (checks.length > 0) {
      const passed = checks.filter((c) => c.ok).length;
      checksText = `${passed === checks.length ? '✓' : '✗'} ${passed}/${checks.length} checks đạt`;
    }

    const dashboardUrl = `http://127.0.0.1:${this.config.port}/#/tasks/${toRouteId(resolved.id)}`;
    const isPaused = Boolean(detail.paused);
    const pauseBadge = isPaused
      ? (detail.pauseReason === 'load' || detail.pauseReason === 'brain_load' ? ' [Tạm dừng (quá tải)]' : ' [Tạm dừng (thủ công)]')
      : '';

    let text = `📌 <b>Task: ${resolved.id}</b>\n\n`;
    text = text + `• Tiêu đề: <b>${this.escapeHtml(detail.title)}</b>\n`;
    text = text + `• Trạng thái: <code>${detail.status}</code>${pauseBadge} (${detail.level})\n`;
    text = text + `• Nhánh: <code>${detail.branch || 'mặc định'}</code> (gốc: ${detail.baseRef || 'main'})\n`;
    text = text + `• Kiểm tra: ${checksText}\n`;
    text = text + `• Lượt chạy: ${detail.runs?.length || 0}\n`;
    text = text + `• Link: <a href="${dashboardUrl}">Mở trên Dashboard</a>\n`;

    // Dynamic action buttons depending on task status
    const buttons: InlineKeyboardButton[][] = [];
    if (detail.status === 'review') {
      buttons.push([
        { text: '✅ Duyệt & merge', callback_data: `review:approve:${resolved.id}` },
        { text: '↩️ Trả về', callback_data: `review:reject_prompt:${resolved.id}` },
      ]);
      buttons.push([{ text: '📊 Xem diff tóm tắt', callback_data: `task:diff:${resolved.id}` }]);
    } else if (detail.status === 'failed' || detail.status === 'blocked') {
      buttons.push([
        { text: '🔄 Chạy lại', callback_data: `task:retry:${resolved.id}` },
        { text: '📄 Xem log', callback_data: `task:log:${resolved.id}` },
      ]);
    } else if (detail.status === 'running' || detail.status === 'queued') {
      const row: InlineKeyboardButton[] = [];
      if (isPaused) {
        row.push({ text: '▶️ Tiếp tục', callback_data: `task:resume:${resolved.id}` });
      }
      row.push({ text: '🛑 Hủy task', callback_data: `cancel:confirm:${resolved.id}` });
      buttons.push(row);
    }

    await this.sendMessage(chatId, text, buttons.length > 0 ? { inline_keyboard: buttons } : undefined);
  }

  private async handleNewTaskCommand(chatId: number, argStr: string): Promise<void> {
    const trimmed = argStr.trim();
    if (!trimmed) {
      const projects = this.projectRepo.getAll();
      if (projects.length === 0) {
        await this.sendMessage(chatId, '❌ Không có project nào trong hệ thống.');
        return;
      }
      // If a project is selected via /use, pre-select it for newtask
      const selectedProjId = this.selectedProject.get(chatId);
      if (selectedProjId) {
        this.chatStates.set(chatId, { action: 'newtask_description', projectId: selectedProjId });
        const proj = this.projectRepo.get(selectedProjId);
        const projLabel = proj?.name ? `${proj.name} (${selectedProjId})` : selectedProjId;
        await this.sendMessage(
          chatId,
          `📝 Dự án: <b>${this.escapeHtml(projLabel)}</b>\nHãy gửi <b>một đoạn mô tả chung</b> về việc cần làm. Claude sẽ tự đặt tiêu đề, viết đề bài, chọn độ khó/model và tách task nếu cần.`,
        );
        return;
      }
      this.chatStates.set(chatId, { action: 'newtask_description' });
      const keyboard: InlineKeyboardButton[][] = [];
      // These are optional shortcuts; a description sent as the next message is
      // still resolved automatically and does not require choosing a project first.
      for (const project of projects) {
        keyboard.push([{ text: project.name ? `${project.name} (${project.id})` : project.id, callback_data: `newtask:proj:${project.id}` }]);
      }
      keyboard.push([{ text: '✍️ Nhập chi tiết', callback_data: 'newtask:detail' }]);
      await this.sendMessage(
        chatId,
        '📝 Hãy gửi <b>một đoạn mô tả chung</b> về việc cần làm. Claude sẽ tự đặt tiêu đề, viết đề bài, chọn độ khó/model và tách task nếu cần.\n\nChọn project cho task mới nếu muốn, hoặc bấm <b>Nhập chi tiết</b> để điền từng bước cũ:',
        { inline_keyboard: keyboard },
      );
      return;
    }

    // Keep the old one-line format working for callers that already use it.
    const pipeIdx = trimmed.indexOf('|');
    if (pipeIdx === -1) {
      const parsed = this.parseLeadingExternalRef(trimmed);
      await this.handleNewTaskDescription(chatId, parsed.text, parsed.externalRef);
      return;
    }

    const beforePipe = trimmed.slice(0, pipeIdx).trim();
    const body = trimmed.slice(pipeIdx + 1).trim();
    const firstToken = beforePipe.split(/\s+/, 1)[0];
    const parsedTitle = this.projectRepo.get(firstToken)
      ? { text: beforePipe }
      : this.parseLeadingExternalRef(beforePipe);
    const externalRef = parsedTitle.externalRef;
    const titlePart = parsedTitle.text;

    const selectedProjId = this.selectedProject.get(chatId);
    let project = '';
    let title = '';

    const firstSpace = titlePart.indexOf(' ');
    if (firstSpace === -1) {
      if (selectedProjId && this.projectRepo.get(selectedProjId)) {
        project = selectedProjId;
        title = titlePart;
      } else {
        await this.sendMessage(
          chatId,
          'Cú pháp dạng nhanh: /newtask &lt;project&gt; &lt;tiêu đề&gt; | &lt;đề bài&gt;',
        );
        return;
      }
    } else {
      const candidateProj = titlePart.slice(0, firstSpace).trim();
      if (this.projectRepo.get(candidateProj)) {
        project = candidateProj;
        title = titlePart.slice(firstSpace + 1).trim();
      } else if (selectedProjId && this.projectRepo.get(selectedProjId)) {
        project = selectedProjId;
        title = titlePart;
      } else {
        project = candidateProj;
        title = titlePart.slice(firstSpace + 1).trim();
      }
    }

    if (!project || !title) {
      await this.sendMessage(
        chatId,
        'Cú pháp dạng nhanh: /newtask &lt;project&gt; &lt;tiêu đề&gt; | &lt;đề bài&gt;',
      );
      return;
    }

    const projObj = this.projectRepo.get(project);
    if (!projObj) {
      await this.sendMessage(chatId, `❌ Project "${this.escapeHtml(project)}" không tồn tại.`);
      return;
    }

    const slug = generateTaskSlug(title, project, this.taskRepo);
    try {
      const task = this.service.createTask({
        project,
        slug,
        title,
        body,
        externalRef,
        level: 'easy',
        start: false,
      });

      const keyboard: InlineKeyboardButton[][] = [
        [
          { text: '🚀 Giao ngay', callback_data: `draft:start:${task.id}` },
          { text: '💾 Lưu nháp', callback_data: `draft:keep:${task.id}` },
        ],
      ];

      await this.sendMessage(
        chatId,
        `📝 Đã tạo nháp task <code>${task.id}</code>:\n<b>${this.escapeHtml(task.title)}</b>\n\nBạn muốn giao việc ngay hay lưu nháp?`,
        { inline_keyboard: keyboard },
      );
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.sendMessage(chatId, `❌ Lỗi khi tạo task: ${errMsg}`);
    }
  }

  private findProjectForDescription(description: string): ProjectRow | null | undefined {
    const projects = this.projectRepo.getAll();
    if (projects.length === 1) return projects[0];
    const haystack = description.toLocaleLowerCase();
    const matches = projects.filter((project) => {
      const candidates = [project.id, project.name].filter(Boolean).map((value) => value.toLocaleLowerCase());
      return candidates.some((candidate) => {
        if (!candidate) return false;
        const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, 'u').test(haystack);
      });
    });
    return matches.length === 1 ? matches[0] : null;
  }

  private parseLeadingExternalRef(text: string): { text: string; externalRef?: string } {
    const trimmed = text.trim();
    const match = trimmed.match(/^([^\s|]+)\s+(.+)$/);
    if (!match) {
      return { text: trimmed };
    }
    const token = match[1];
    const rest = match[2].trim();

    // 0. Exclude tokens ending with common sentence punctuation (: , . ; ! ?) or list ordinals/numbers.
    if (/[:.,;!?]$/u.test(token) || /^\p{N}+[.)]?$/u.test(token)) {
      return { text: trimmed };
    }

    // 1. Clear marker prefix (e.g. #123, #abc, [PROJ-45]) or structured token with internal delimiter
    // between letters/numbers (e.g. PROJ-45, OP#123, ABC-foo, ĐỀ-123, 営業-1, ref:đề).
    const hasMarker = /^#[\p{L}\p{N}_-]+$/u.test(token) || /^\[[\p{L}\p{N}_#/:.-]+\]$/u.test(token);
    const hasDelimitedRef = /^(?=.*\p{L})[\p{L}\p{N}]+[-_#/:][\p{L}\p{N}_#/:.-]*[\p{L}\p{N}]$/u.test(token);
    if (hasMarker || hasDelimitedRef) {
      return { externalRef: token, text: rest };
    }

    return { text: trimmed };
  }

  private async handleNewTaskDescription(chatId: number, description: string, externalRef?: string): Promise<void> {
    const trimmed = description.trim();
    if (!trimmed) {
      this.chatStates.set(chatId, { action: 'newtask_description' });
      await this.sendMessage(chatId, 'Mô tả không được để trống. Hãy gửi lại một đoạn mô tả hoặc /cancel.');
      return;
    }
    // Use project from chatState (set by /newtask with /use), or selected project via /use
    const state = this.chatStates.get(chatId);
    const preSelectedProjectId = (state && 'projectId' in state ? state.projectId : undefined) || this.selectedProject.get(chatId);
    if (preSelectedProjectId) {
      const proj = this.projectRepo.get(preSelectedProjectId);
      if (proj) {
        await this.sendAutoTaskToClaude(chatId, proj.id, trimmed, externalRef);
        return;
      }
    }
    const project = this.findProjectForDescription(trimmed);
    if (project === null) {
      const projects = this.projectRepo.getAll();
      this.chatStates.set(chatId, { action: 'newtask_project_description', description: trimmed, externalRef });
      await this.sendMessage(chatId, '📁 Mô tả chưa nói rõ project. Vui lòng chọn project:', {
        inline_keyboard: [
          ...projects.map((item) => [{ text: item.name ? `${item.name} (${item.id})` : item.id, callback_data: `newtask:proj:${item.id}` }]),
          [{ text: '❌ Huỷ', callback_data: 'newtask:cancel' }],
        ],
      });
      return;
    }
    if (!project) {
      await this.sendMessage(chatId, '❌ Không có project nào trong hệ thống.');
      return;
    }
    await this.sendAutoTaskToClaude(chatId, project.id, trimmed, externalRef);
  }

  private autoTaskPrompt(projectId: string, description: string, externalRef?: string): string {
    return `Người dùng muốn thực hiện việc sau trong project "${projectId}":\n${description}\n\n` +
      'Hãy xử lý như một yêu cầu việc mới theo docs/BRAIN-PLAYBOOK.md: tự đặt tiêu đề ngắn, slug, viết đề bài markdown chi tiết gồm phạm vi và tiêu chí nghiệm thu; đặt phần migration ở cuối nếu có; không commit .agenthub/. ' +
      'Chọn độ khó và model theo quy tắc: việc nặng dùng Codex trước, việc lá/UI dùng Gemini. Nếu việc lớn, tách thành nhiều task có phụ thuộc hợp lý. ' +
      `${externalRef ? `Ref bên ngoài bắt buộc cho task: ${externalRef}. Khi gọi tool tạo task, truyền externalRef đúng giá trị này. ` : ''}` +
      `${planningRule(this.config.planning)}Dùng các MCP tool của AgentHub để tạo task/batch. Trả lời ngắn gọn bằng tiếng Việt: đã tạo task nào (id + tiêu đề), hoặc đợt nháp nào đang chờ duyệt.`;
  }

  private async sendAutoTaskToClaude(chatId: number, projectId: string, description: string, externalRef?: string): Promise<void> {
    if (!this.chatService) {
      await this.saveFallbackDraft(chatId, description, projectId, externalRef);
      return;
    }
    const sessionId = this.sessionIdForChat(chatId);
    try {
      this.pendingAutoTasks.set(sessionId, { chatId, projectId, description, externalRef });
      await this.startChatTurn(chatId, '⏳ Đang nhờ Claude phân tích và tạo task…', this.autoTaskPrompt(projectId, description, externalRef));
    } catch {
      this.pendingAutoTasks.delete(sessionId);
      await this.saveFallbackDraft(chatId, description, projectId, externalRef);
    }
  }

  private async saveFallbackDraft(chatId: number, description: string, projectId: string, externalRef?: string): Promise<void> {
    if (!projectId) {
      await this.sendMessage(chatId, '❌ Không thể lưu nháp vì chưa xác định được project.');
      return;
    }
    const title = this.fallbackTaskTitle(description);
    try {
      const task = this.service.createTask({
        project: projectId,
        slug: generateTaskSlug(title, projectId, this.taskRepo),
        title,
        externalRef,
        body: description,
        level: 'easy',
        start: false,
      });
      await this.sendMessage(chatId, `💾 Đã lưu nháp từ mô tả; bạn có thể giao ngay hoặc nhờ Claude hoàn thiện sau.\nTask: <code>${task.id}</code>\n<b>${this.escapeHtml(task.title)}</b>`, {
        inline_keyboard: [[
          { text: '🚀 Giao ngay', callback_data: `draft:start:${task.id}` },
          { text: '💾 Giữ nháp', callback_data: `draft:keep:${task.id}` },
        ]],
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.sendMessage(chatId, `❌ Lỗi lưu nháp: ${this.escapeHtml(errMsg)}`);
    }
  }

  private fallbackTaskTitle(description: string): string {
    if (description.length <= 60) return description;
    const words = description.trim().split(/\s+/);
    let title = '';
    for (const word of words) {
      const next = title ? `${title} ${word}` : word;
      if (next.length > 59) break;
      title = next;
    }
    return `${title || description.slice(0, 59).trimEnd()}…`;
  }

  private async startNewTaskWizard(chatId: number): Promise<void> {
    const selectedProjId = this.selectedProject.get(chatId);
    if (selectedProjId && this.projectRepo.get(selectedProjId)) {
      this.chatStates.set(chatId, { action: 'newtask_title', projectId: selectedProjId });
      const proj = this.projectRepo.get(selectedProjId);
      const projLabel = proj?.name ? `${proj.name} (${selectedProjId})` : selectedProjId;
      await this.sendMessage(
        chatId,
        `📁 Dự án: <b>${this.escapeHtml(projLabel)}</b>\n\n✏️ Vui lòng nhập <b>tiêu đề</b> cho task:\n(Gõ /cancel để huỷ)`,
      );
      return;
    }

    const projects = this.projectRepo.getAll();
    if (projects.length === 0) {
      await this.sendMessage(chatId, '❌ Không có project nào trong hệ thống.');
      return;
    }

    const keyboard: InlineKeyboardButton[][] = projects.map((p) => [
      { text: p.name ? `${p.name} (${p.id})` : p.id, callback_data: `newtask:proj:${p.id}` },
    ]);
    keyboard.push([{ text: '❌ Huỷ', callback_data: 'newtask:cancel' }]);

    this.chatStates.set(chatId, { action: 'newtask_project' });
    await this.sendMessage(chatId, '📁 <b>Chọn project cho task mới:</b>', {
      inline_keyboard: keyboard,
    });
  }

  private async handlePlanCommand(chatId: number, args: string[]): Promise<void> {
    if (args.length < 2) {
      await this.sendMessage(chatId, 'Cú pháp: /plan &lt;project&gt; &lt;mục tiêu&gt;');
      return;
    }

    const project = args[0];
    const goal = args.slice(1).join(' ').trim();

    const projObj = this.projectRepo.get(project);
    if (!projObj) {
      await this.sendMessage(chatId, `❌ Project "${this.escapeHtml(project)}" không tồn tại.`);
      return;
    }

    if (!this.chatService) {
      await this.sendMessage(chatId, 'Chat Claude chưa được bật.');
      return;
    }

    const prompt = `Lập kế hoạch cho dự án "${project}" với mục tiêu: ${goal}\nHãy sử dụng công cụ hub_create_batch để đề xuất một đợt (batch) task nháp cho dự án này.`;
    await this.handleChatMessage(chatId, prompt);
  }

  private async handleDraftsCommand(chatId: number): Promise<void> {
    const draftTasks = this.service.listTasks({ status: 'draft' });
    const draftBatches = this.service.listBatches({ status: 'draft' });

    if (draftTasks.length === 0 && draftBatches.length === 0) {
      await this.sendMessage(chatId, '📝 Hiện không có task hoặc đợt nháp nào.');
      return;
    }

    let text = '📋 <b>Danh sách bản nháp:</b>\n';
    const keyboard: InlineKeyboardButton[][] = [];

    if (draftBatches.length > 0) {
      text = text + `\n📦 <b>Đợt nháp (${draftBatches.length}):</b>\n`;
      for (const b of draftBatches.slice(0, 5)) {
        text = text + `• <b>${this.escapeHtml(b.title)}</b> (<code>${b.id}</code>)\n`;
        keyboard.push([
          { text: `🚀 Giao đợt: ${b.title.slice(0, 15)}`, callback_data: `batch:dispatch:${b.id}` },
          { text: '🗑️ Xoá đợt', callback_data: `batch:discard:${b.id}` },
        ]);
      }
    }

    if (draftTasks.length > 0) {
      text = text + `\n📝 <b>Task nháp (${draftTasks.length}):</b>\n`;
      for (const t of draftTasks.slice(0, 10)) {
        text = text + `• <code>${t.id}</code>: ${this.escapeHtml(t.title)}\n`;
        keyboard.push([
          { text: `🚀 Giao: ${t.slug.slice(0, 15)}`, callback_data: `draft:start:${t.id}` },
          { text: '🗑️ Xoá', callback_data: `draft:delete:${t.id}` },
        ]);
      }
      if (draftTasks.length > 10) {
        text = text + `<i>... và còn ${draftTasks.length - 10} task nháp khác.</i>\n`;
      }
    }

    await this.sendMessage(chatId, text, keyboard.length > 0 ? { inline_keyboard: keyboard } : undefined);
  }

  private async handleLogCommand(chatId: number, idOrSlug: string): Promise<void> {
    if (!idOrSlug) {
      await this.sendMessage(chatId, 'Vui lòng cung cấp task ID hoặc slug: /log <id>');
      return;
    }

    const resolved = this.resolveTask(idOrSlug);
    if ('error' in resolved) {
      await this.sendMessage(chatId, this.renderResolveError(idOrSlug, resolved));
      return;
    }

    if (this.isMinimalProject(resolved.projectId)) {
      await this.sendMessage(chatId, 'Dự án này ẩn nội dung trên Telegram, xem trên dashboard');
      return;
    }

    const logLines = this.getTaskLast30Lines(resolved.id);
    await this.sendMessage(
      chatId,
      `📄 30 dòng cuối log của <code>${resolved.id}</code>:\n\n<pre>${this.escapeHtml(logLines)}</pre>`,
    );
  }

  private async handleRetryCommand(chatId: number, idOrSlug: string): Promise<void> {
    if (!idOrSlug) {
      await this.sendMessage(chatId, 'Vui lòng cung cấp task ID hoặc slug: /retry <id>');
      return;
    }

    const resolved = this.resolveTask(idOrSlug);
    if ('error' in resolved) {
      await this.sendMessage(chatId, this.renderResolveError(idOrSlug, resolved));
      return;
    }

    if (resolved.status !== 'failed' && resolved.status !== 'blocked') {
      await this.sendMessage(
        chatId,
        `Chỉ có thể retry task ở trạng thái failed hoặc blocked (hiện tại: ${resolved.status}).`,
      );
      return;
    }

    try {
      this.service.retryTask(resolved.id, {});
      await this.sendMessage(chatId, `🔄 Đã đưa task ${resolved.id} vào hàng đợi để chạy lại.`);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.sendMessage(chatId, `❌ Lỗi khi retry task: ${errMsg}`);
    }
  }

  private async handleCancelCommand(chatId: number, idOrSlug: string): Promise<void> {
    if (!idOrSlug) {
      await this.sendMessage(chatId, 'Vui lòng cung cấp task ID hoặc slug: /cancel <id>');
      return;
    }

    const resolved = this.resolveTask(idOrSlug);
    if ('error' in resolved) {
      await this.sendMessage(chatId, this.renderResolveError(idOrSlug, resolved));
      return;
    }

    const keyboard: InlineKeyboardButton[][] = [
      [
        { text: '✅ Xác nhận hủy', callback_data: `cancel:confirm:${resolved.id}` },
        { text: '❌ Không', callback_data: `cancel:abort:${resolved.id}` },
      ],
    ];

    await this.sendMessage(
      chatId,
      `❓ Bạn có chắc muốn hủy task <b>${resolved.id}</b> không?\n<i>Tiêu đề: ${this.escapeHtml(resolved.title)}</i>`,
      { inline_keyboard: keyboard },
    );
  }

  private async handleApproveCommand(chatId: number, idOrSlug: string): Promise<void> {
    if (!idOrSlug) {
      await this.sendMessage(chatId, 'Vui lòng cung cấp task ID hoặc slug: /approve <id>');
      return;
    }

    const resolved = this.resolveTask(idOrSlug);
    if ('error' in resolved) {
      await this.sendMessage(chatId, this.renderResolveError(idOrSlug, resolved));
      return;
    }

    if (resolved.status !== 'review') {
      await this.sendMessage(
        chatId,
        `Task ${resolved.id} không ở trạng thái review (hiện tại: ${resolved.status}).`,
      );
      return;
    }

    const project = this.projectRepo.get(resolved.projectId);
    const hasMerge = isProjectMergeEnabled(project);

    try {
      await this.service.reviewTask(resolved.id, {
        verdict: 'approved',
        merge: hasMerge,
        by: 'telegram',
      });
      await this.sendMessage(
        chatId,
        `✅ Đã duyệt task ${resolved.id}${hasMerge ? ' (và merge vào nhánh mặc định)' : ''}.`,
      );
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.sendMessage(chatId, `❌ Lỗi khi duyệt task: ${errMsg}`);
    }
  }

  private async handleRejectCommand(chatId: number, args: string[]): Promise<void> {
    if (args.length === 0) {
      await this.sendMessage(chatId, 'Cú pháp: /reject <id> <nhận xét>');
      return;
    }

    const idOrSlug = args[0];
    const resolved = this.resolveTask(idOrSlug);
    if ('error' in resolved) {
      await this.sendMessage(chatId, this.renderResolveError(idOrSlug, resolved));
      return;
    }

    if (resolved.status !== 'review') {
      await this.sendMessage(
        chatId,
        `Task ${resolved.id} không ở trạng thái review (hiện tại: ${resolved.status}).`,
      );
      return;
    }

    const feedback = args.slice(1).join(' ').trim();
    if (!feedback) {
      this.chatStates.set(chatId, { action: 'reject_feedback', taskId: resolved.id });
      await this.sendMessage(
        chatId,
        `💬 Vui lòng gửi nhận xét/yêu cầu sửa cho task ${resolved.id}:\n(Hoặc gửi /cancel để hủy)`,
      );
      return;
    }

    try {
      await this.service.reviewTask(resolved.id, {
        verdict: 'changes_requested',
        feedback,
        by: 'telegram',
      });
      await this.sendMessage(chatId, `↩️ Đã trả về task ${resolved.id} với nhận xét:\n${feedback}`);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.sendMessage(chatId, `❌ Lỗi khi trả về task: ${errMsg}`);
    }
  }

  private renderResolveError(idOrSlug: string, err: { error: 'not_found' | 'ambiguous'; matches?: string[] }): string {
    if (err.error === 'ambiguous') {
      return `⚠️ Có nhiều task trùng slug '${idOrSlug}':\n${(err.matches || []).join('\n')}\nVui lòng dùng dạng 'project/slug'.`;
    }
    return `❌ Không tìm thấy task '${idOrSlug}'.`;
  }

  // --- Task ID Resolution ---

  /**
   * Resolves a task by either `projectId/slug`, `projectId~slug`, or unique `slug`.
   */
  resolveTask(idOrSlug: string): TaskRow | { error: 'not_found' | 'ambiguous'; matches?: string[] } {
    const raw = idOrSlug.trim();
    if (raw.includes('/') || raw.includes('~')) {
      const normId = toTaskId(raw);
      const task = this.taskRepo.get(normId);
      return task || { error: 'not_found' };
    }

    const allTasks = this.taskRepo.getAll();
    const matches = allTasks.filter(
      (t) => t.slug === raw || t.id === raw || t.id.endsWith(`/${raw}`),
    );

    if (matches.length === 1) {
      return matches[0];
    }
    if (matches.length > 1) {
      return { error: 'ambiguous', matches: matches.map((m) => m.id) };
    }
    return { error: 'not_found' };
  }

  // --- EventBus Listener & Notification Sender ---

  handleEvent(type: string, taskId?: string, payload?: unknown): void {
    if (!this.config.telegram?.enabled) return;
    // Routing is scoped to this event only. Scheduled summaries and other direct
    // broadcasts must never inherit the last project's destination.
    this.notificationProjectId = null;
    const allowedChats = this.config.telegram?.allowedChatIds || [];
    if (allowedChats.length === 0) return;

    const notify = this.config.telegram?.notify || {
      reviewReady: true,
      failed: true,
      blocked: true,
      quotaAllExhausted: true,
      fallback: true,
    };
    const notifyAllExhausted = notify.quotaAllExhausted !== false;

    const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
    if (type === 'quota.cleared') {
      this.allQuotaNotified.delete('all');
      if (typeof p.family === 'string') this.allQuotaNotified.delete(p.family);
      for (const key of this.lastNotificationTime.keys()) {
        if (key.startsWith('quota.exhausted:')) this.lastNotificationTime.delete(key);
      }
      for (const key of this.lastBroadcast.keys()) {
        if (key.includes('Mọi tài khoản đều đã hết quota') || key.includes('Hết sạch quota')) this.lastBroadcast.delete(key);
      }
      const snapshot = this.quotaCapacity();
      if (this.quotaIncidentActive) {
        this.quotaIncidentActive = false;
        if (snapshot && snapshot.runnable.length > 0) this.broadcastMessage('✅ <b>Có quota trở lại</b>');
      }
    }
    if (type === 'task.waiting_quota' && p.reason === 'quota' && this.taskRepo) {
      this.queueWaitingQuotaCheck(notifyAllExhausted);
      return;
    }
    if ((type === 'quota.cleared' || type === 'task.queued') && this.taskRepo) this.queueWaitingQuotaCheck(notifyAllExhausted);

    if (type === 'merge.conflict') {
      const conflictCount = typeof p.conflictCount === 'number' ? p.conflictCount : undefined;
      const isRoutine = (conflictCount === undefined || conflictCount <= 3) && (
        p.autoRetried === true || (
          p.autoRetried === undefined &&
          (() => {
            if (!taskId || !this.taskRepo) return true;
            const task = this.taskRepo.get(taskId);
            return task && task.status !== 'cancelled';
          })()
        )
      );
      if (isRoutine) return;
    }

    if (type === 'merge.failed') {
      if (p.autoFixCreated === true) return;
      if (taskId && this.taskRepo?.getDerivedFrom(taskId).some((t) =>
        /-fix-merge(?:-\d+)?$/.test(t.slug) && !['done', 'pushed', 'cancelled', 'failed', 'blocked'].includes(t.status)
      )) {
        return;
      }
    }

    if (taskId && /-fix-merge(?:-\d+)?$/.test(taskId)) {
      const task = this.taskRepo?.get(taskId);
      if (!task || task.status === 'draft') return;
    }

    const now = this.now();
    if (type === 'quota.exhausted' || type === 'claude.quota_exhausted') {
      const snapshot = this.quotaCapacity();
      const isAllExhausted = this.isAllQuotaExhausted(p, now);

      const quotaKey = (typeof p.family === 'string' ? p.family : typeof p.model === 'string' ? p.model : '') || 'all';
      if (!isAllExhausted) {
        this.allQuotaNotified.delete(quotaKey);
        if (this.quotaIncidentActive) {
          this.quotaIncidentActive = false;
          if (snapshot && snapshot.runnable.length > 0) this.broadcastMessage('✅ <b>Có quota trở lại</b>');
        }
        return;
      }
    }

    if (type === 'review.fallback') {
      if (!this.isAllQuotaExhausted(p, now)) {
        return;
      }
    }

    const projectId = taskId?.includes('/') ? taskId.slice(0, taskId.indexOf('/')) : typeof p.projectId === 'string' ? p.projectId : null;
    if (!this.eventDeduper.shouldSend(type, taskId, payload)) return;

    // Deduplication check: ignore duplicate events within 10 seconds
    const profileKey = (p.profile || p.worker || p.profileName || '') as string;
    const familyKey = (p.family || p.model || '') as string;
    const batchKey = (p.batchId || '') as string;
    const decisionKey = (p.decisionId || '') as string;
    const textKey = typeof p.text === 'string' ? p.text.slice(0, 32) : '';
    const levelKey = (p.level || '') as string;
    const dedupKey = `${type}:${projectId || ''}:${taskId || batchKey || decisionKey}:${profileKey}:${familyKey}:${levelKey}:${textKey}`;
    const lastTime = this.lastNotificationTime.get(dedupKey) || 0;
    if (now - lastTime < 10_000) {
      return;
    }
    this.lastNotificationTime.set(dedupKey, now);

    // 1. Brain auto mode: suppress raw task notifications
    try {
      const isSystemEvent = type === 'quota.exhausted' || type === 'claude.quota_exhausted' || type.startsWith('disk.') || type.startsWith('system.') || type.startsWith('hub.') || type.startsWith('deploy.') || type.startsWith('remote_deploy.') || type === 'profile.auth_expired' || type === 'chat.limit_waiting' || type.startsWith('daily_report.');
    this.notificationProjectId = isSystemEvent ? null : projectId;
    this.notificationDedupProjectId = projectId;
    const focusProjectId = this.config.focus?.projectId;
    if (focusProjectId && projectId && projectId !== focusProjectId && this.isFocusDeferredEvent(type)) {
      this.focusDigest.set(projectId, (this.focusDigest.get(projectId) || 0) + 1);
      return;
    }
    const prefix = this.projectPrefix(projectId);
    const minimal = this.isMinimalProject(projectId);
    const effectiveMode = effectiveBrainMode(projectId, projectId ? this.projectRepo.get(projectId) : null, this.config.brain);
    if (effectiveMode === 'auto') {
      const isAllowedInAuto =
        type === 'brain.notify' ||
        type === 'disk.low' ||
        type === 'disk.ok' ||
        type === 'disk.docker_low' ||
        type === 'claude.quota_exhausted' ||
        type === 'hub.restart_failed' ||
        type === 'hub.restarting' ||
        type === 'hub.restart_timeout' ||
        type.startsWith('deploy.') ||
        type.startsWith('gitea.sync.') ||
        type.startsWith('remote_deploy.') ||
        type.startsWith('daily_report.') ||
        type === 'system.error' ||
        type === 'ci.failed' ||
        type === 'ci.passed' ||
        type === 'merge.conflict' ||
        type === 'merge.failed' ||
        type === 'review.fallback' ||
        type === 'quota.exhausted' ||
        (type === 'task.waiting_quota' && p.reason === 'no_department_profile') ||
        // Người dùng muốn biết kết quả dù bộ não tự duyệt/merge.
        (type === 'task.done' && (this.config.telegram.notify.taskDone !== false || this.config.telegram.notify.projectIdle !== false)) ||
        (type === 'task.pushed' && this.config.telegram.notify.taskDone !== false) ||
        (type === 'task.push_failed' && this.config.telegram.notify.failed !== false) ||
        (TelegramBotService.INTERRUPT_EVENTS.has(type) && this.config.telegram.notify.interrupted !== false);

        if (!isAllowedInAuto) {
          return;
        }
      }

      // 2. Quiet hours: only send level 'incident'
      if (isQuietHours(this.config.notifications?.quietHours, new Date(now))) {
      const isIncident = isSystemIncident(type, payload, this.profileRepo, this.quotaMarkRepo, now);
      if (!isIncident) {
        if (type === 'brain.notify' && p.level === 'decision') {
          const text = typeof p.text === 'string' ? p.text : '';
          const decisionId =
            typeof p.decisionId === 'string' && p.decisionId
              ? p.decisionId
              : `dec-${now}-${Math.random().toString(36).slice(2, 8)}`;
          this.decisionTracker.recordDecision(decisionId, text, allowedChats, now, taskId);
        }

        if (type === 'merge.conflict') {
          if (!taskId || this.isMergeConflictNotified(taskId)) return;
          this.markMergeConflictNotified(taskId);
        }

        const desc = this.describeEventForQuietHours(type, taskId, p);
        if (desc) {
          if (this.quietHoursQueue.length >= 200) {
            this.quietHoursQueue.shift();
          }
          this.quietHoursQueue.push({ text: desc, timestamp: now });
        }
        return;
      }
      }

      switch (type) {
      case 'task.waiting_quota': {
        if (p.reason !== 'no_department_profile') break;
        const department = typeof p.departmentName === 'string' ? p.departmentName : 'phòng ban';
        const message = typeof p.message === 'string' ? p.message : `Gán tài khoản cho ${department} hoặc bỏ gán`;
        this.broadcastMessage(`⚠️ <b>Task đang chờ vì thiếu tài khoản</b>\nPhòng: <b>${this.escapeHtml(department)}</b>\n${this.escapeHtml(message)}`, undefined, projectId || undefined, typeof p.departmentId === 'string' ? p.departmentId : undefined);
        break;
      }
      case 'brain.notify': {
        const text = typeof p.text === 'string' ? p.text : '';
        if (!text) break;

        if (p.level === 'decision') {
          const decisionId =
            typeof p.decisionId === 'string' && p.decisionId
              ? p.decisionId
              : `dec-${now}-${Math.random().toString(36).slice(2, 8)}`;

          this.decisionTracker.recordDecision(decisionId, text, allowedChats, now, taskId);

          const dashboardUrl = this.getDashboardUrl();
          const keyboard: InlineKeyboardButton[][] = [
            [
              { text: '✅ Đồng ý', callback_data: `decision:agree:${decisionId}` },
              { text: '❌ Không', callback_data: `decision:reject:${decisionId}` },
            ],
            [{ text: '🌐 Xem dashboard', url: dashboardUrl }],
          ];

          if (minimal) {
            this.broadcastMessage(`${prefix}📌 <b>Bộ não yêu cầu quyết định</b> — xem dashboard`, {
              inline_keyboard: keyboard,
            });
          } else {
            this.broadcastMessage(`${prefix}📌 <b>Bộ não yêu cầu quyết định</b>\n${this.escapeHtml(text)}`, {
              inline_keyboard: keyboard,
            });
          }
          break;
        }

        const icon = p.level === 'incident' ? '🚨' : 'ℹ️';
        const title = p.level === 'incident' ? 'Sự cố bộ não' : 'Bộ não';
        if (minimal) {
          this.broadcastMessage(`${prefix}${icon} <b>${title}</b> — Bộ não đã trả lời, xem dashboard`);
        } else {
          this.broadcastMessage(`${prefix}${icon} <b>${title}</b>\n${this.escapeHtml(text)}`);
        }
        break;
      }
      case 'batch.created': {
        const batchId = typeof p.batchId === 'string' ? p.batchId : undefined;
        let batchInfo: (TaskBatchRow & { tasks: TaskRow[] }) | null = null;
        if (batchId) {
          try {
            batchInfo = this.service.getBatch(batchId);
          } catch {
            // ignore
          }
        }

        const batchProjId = batchInfo?.projectId || (typeof p.projectId === 'string' ? p.projectId : null);
        const batchPrefix = this.projectPrefix(batchProjId);
        const batchMinimal = this.isMinimalProject(batchProjId);

        const count = batchInfo ? batchInfo.tasks.length : (typeof p.taskCount === 'number' ? p.taskCount : 0);
        const title = batchInfo?.title || (typeof p.title === 'string' ? p.title : 'Kế hoạch đề xuất');
        const who = typeof p.createdBy === 'string' && p.createdBy ? p.createdBy : 'Claude';
        const label = who.toLowerCase() === 'claude' ? 'Claude' : who;

        if (batchMinimal) {
          const keyboard: InlineKeyboardButton[][] = [];
          if (batchId) {
            const dashboardUrl = `http://127.0.0.1:${this.config.port}/#/plans/${encodeURIComponent(batchId)}`;
            keyboard.push([{ text: '🌐 Xem trên dashboard', url: dashboardUrl }]);
          }
          this.broadcastMessage(`${batchPrefix}📦 <b>Đợt task mới: ${count} task</b>`, keyboard.length > 0 ? { inline_keyboard: keyboard } : undefined);
          break;
        }

        let text = `${batchPrefix}📦 <b>${this.escapeHtml(label)} đề xuất đợt task mới:</b>\n`;
        text = text + `• Tiêu đề đợt: <b>${this.escapeHtml(title)}</b>\n`;
        text = text + `• Số lượng: <b>${count} task</b>\n\n`;

        if (batchInfo && batchInfo.tasks.length > 0) {
          text = text + '<b>Danh sách task:</b>\n';
          for (const t of batchInfo.tasks) {
            let depStr = '';
            let parsedDeps: string[] = [];
            if (typeof t.dependsOn === 'string') {
              try {
                const parsed = JSON.parse(t.dependsOn);
                if (Array.isArray(parsed)) parsedDeps = parsed;
                else if (parsed) parsedDeps = [String(parsed)];
              } catch {
                if (t.dependsOn.trim()) parsedDeps = [t.dependsOn.trim()];
              }
            } else if (Array.isArray(t.dependsOn)) {
              parsedDeps = t.dependsOn;
            }
            if (parsedDeps.length > 0) {
              depStr = ` <i>(phụ thuộc: ${this.escapeHtml(parsedDeps.join(', '))})</i>`;
            }
            text = text + `• <code>${t.id}</code>: ${this.escapeHtml(t.title)}${depStr}\n`;
          }
        }

        const keyboard: InlineKeyboardButton[][] = [];
        if (batchId) {
          const dashboardUrl = `http://127.0.0.1:${this.config.port}/#/plans/${encodeURIComponent(batchId)}`;
          keyboard.push([
            { text: '🚀 Giao cả đợt', callback_data: `batch:dispatch:${batchId}` },
            { text: '❌ Huỷ đợt', callback_data: `batch:discard:${batchId}` },
          ]);
          keyboard.push([{ text: '🌐 Xem trên dashboard', url: dashboardUrl }]);
        }

        this.broadcastMessage(text, keyboard.length > 0 ? { inline_keyboard: keyboard } : undefined);
        break;
      }

      case 'review.escalated':
      case 'task.review_ready': {
        if (!notify.reviewReady) return;
        const task = taskId ? this.taskRepo.get(taskId) : null;
        if (minimal) {
          const dashboardUrl = this.getDashboardUrl(taskId ? `#/tasks/${toRouteId(taskId)}` : '');
          const keyboard: InlineKeyboardButton[][] = [
            [{ text: '🌐 Xem dashboard', url: dashboardUrl }],
          ];
          this.broadcastMessage(`${prefix}1 task cần duyệt`, { inline_keyboard: keyboard });
          break;
        }

        const title = this.resolveTaskTitle(taskId, p, task);
        let checksText = '';
        if (typeof p.checksPassed === 'boolean') {
          checksText = `\nChecks: ${p.checksPassed ? '✓ Đạt' : '✗ Thất bại'}`;
        }

        const isEscalated = type === 'review.escalated';
        const header = isEscalated ? '🚨 <b>Cần người duyệt (Escalated)</b>' : '📋 <b>Task chờ review</b>';

        const keyboard: InlineKeyboardButton[][] = [
          [
            { text: '✅ Duyệt & merge', callback_data: `review:approve:${taskId}` },
            { text: '↩️ Trả về', callback_data: `review:reject_prompt:${taskId}` },
          ],
          [{ text: '📊 Xem diff tóm tắt', callback_data: `task:diff:${taskId}` }],
        ];

        this.broadcastMessage(
          `${prefix}${header}\nID: <code>${taskId}</code>\nTiêu đề: <b>${this.escapeHtml(title)}</b>${checksText}`,
          { inline_keyboard: keyboard },
        );
        break;
      }

      case 'review.auto_merge_skipped': {
        if (!notify.reviewReady) return;
        const task = taskId ? this.taskRepo?.get(taskId) : null;
        const title = this.resolveTaskTitle(taskId, p, task);
        const checks = Array.isArray(p.checks) ? p.checks as Array<{ name?: string; ok?: boolean; outputTail?: string }> : [];
        const failed = checks.find((check) => !check.ok || check.outputTail);
        const firstError = firstCheckError(failed?.outputTail);
        const detail = firstError ? `\n<code>${this.escapeHtml(firstError)}</code>` : '';
        const retryText = p.retried === true ? ' (đã chạy lại 1 lần)' : '';
        const reason = p.reason === 'checks_failed' ? `check <code>${this.escapeHtml(failed?.name || 'test')}</code> đỏ${retryText}` : `lý do: ${this.escapeHtml(autoMergeReasonLabel(p.reason))}`;
        const keyboard: InlineKeyboardButton[][] = [[{ text: '🌐 Xem dashboard', url: this.getDashboardUrl(taskId ? `#/tasks/${toRouteId(taskId)}` : '') }]];
        this.broadcastMessage(`${prefix}✋ <b>${this.escapeHtml(title)}</b> đã được duyệt nhưng chưa tự merge: ${reason}. Cần duyệt tay.${detail}`, { inline_keyboard: keyboard });
        break;
      }

      case 'review.fallback': {
        if (!notify.fallback) return;
        if (!this.isAllQuotaExhausted(p, now)) return;
        if (taskId && this.reviewFallbackNotified.has(taskId)) return;
        if (taskId) this.reviewFallbackNotified.add(taskId);

        const task = taskId ? this.taskRepo.get(taskId) : null;
        const dashboardUrl = this.getDashboardUrl(taskId ? `#/tasks/${toRouteId(taskId)}` : '');
        const keyboard: InlineKeyboardButton[][] = [
          [{ text: '🌐 Xem dashboard', url: dashboardUrl }],
        ];

        if (minimal) {
          this.broadcastMessage(`${prefix}Codex hết quota, Claude đang duyệt …`, { inline_keyboard: keyboard });
          break;
        }

        const title = this.resolveTaskTitle(taskId, p, task);
        const header = '🔀 <b>Codex hết quota, Claude đang duyệt …</b>';
        this.broadcastMessage(
          `${prefix}${header}\nID: <code>${taskId}</code>\nTiêu đề: <b>${this.escapeHtml(title)}</b>`,
          { inline_keyboard: keyboard },
        );
        break;
      }

      case 'hub.restarting':
      case 'hub.restart_timeout': {
        const timeout = type === 'hub.restart_timeout';
        const waiting = typeof p.waiting === 'number'
          ? p.waiting
          : Array.isArray(p.waitingFor) ? p.waitingFor.length : 0;
        this.broadcastMessage(timeout
          ? `${prefix}⏳ <b>Khởi động lại hub hết thời gian chờ</b>\nHub tiếp tục chạy bình thường; còn ${waiting} việc đang hoạt động.`
          : `${prefix}🔄 <b>Hub đang khởi động lại</b>\nCác worker đã hoàn tất; dịch vụ sẽ khởi động lại ngay.`);
        break;
      }

      case 'task.cancelled': {
        if (notify.interrupted === false) return;
        const title = this.resolveTaskTitle(taskId, p);
        const reason = typeof p.reason === 'string' && p.reason ? p.reason : (typeof p.message === 'string' && p.message ? p.message : 'Không ghi lý do');
        const by = typeof p.by === 'string' && p.by ? p.by : 'không rõ';
        const prev = typeof p.previousStatus === 'string' && p.previousStatus ? `\nTrạng thái trước: <code>${this.escapeHtml(p.previousStatus)}</code>` : '';
        const keyboard: InlineKeyboardButton[][] = taskId
          ? [[{ text: '🔄 Chạy lại', callback_data: `task:retry:${taskId}` }, { text: '🌐 Xem task', url: this.getDashboardUrl(`#/tasks/${toRouteId(taskId)}`) }]]
          : [];
        this.broadcastMessage(
          `${prefix}🛑 <b>Task bị hủy</b>\nID: <code>${taskId}</code>${minimal ? '' : `\nTiêu đề: <b>${this.escapeHtml(title)}</b>`}\nLý do: ${this.escapeHtml(reason)}\nBởi: <b>${this.escapeHtml(by)}</b>${prev}`,
          keyboard.length ? { inline_keyboard: keyboard } : undefined,
        );
        break;
      }

      case 'task.timeout':
      case 'task.no_commit':
      case 'task.looping':
      case 'task.overlap':
      case 'task.failover':
      case 'task.auto_closed': {
        if (notify.interrupted === false) return;
        const title = this.resolveTaskTitle(taskId, p);
        const head = TelegramBotService.INTERRUPT_LABELS[type] || '⚠️ Task bị ngắt';
        let detail = '';
        if (type === 'task.no_commit') {
          detail = `Đã chạy ${typeof p.minutes === 'number' ? Math.round(p.minutes) : '?'} phút mà chưa có commit mới.`;
        } else if (type === 'task.looping') {
          detail = `Lặp lệnh <code>${this.escapeHtml(String(p.command || ''))}</code> ${typeof p.count === 'number' ? p.count : '?'} lần.`;
        } else if (type === 'task.failover') {
          const from = p.from && typeof p.from === 'object' ? (p.from as { profile?: string; model?: string }) : {};
          const to = p.to && typeof p.to === 'object' ? (p.to as { profile?: string; model?: string }) : null;
          detail = `Từ <b>${this.escapeHtml(String(from.profile || '?'))}</b> (${this.escapeHtml(String(from.model || ''))}) sang ${to ? `<b>${this.escapeHtml(String(to.profile || '?'))}</b> (${this.escapeHtml(String(to.model || ''))})` : 'hàng chờ'}${typeof p.reason === 'string' ? `. Lý do: ${this.escapeHtml(p.reason)}` : ''}`;
        } else if (type === 'task.auto_closed') {
          detail = `Nhánh <code>${this.escapeHtml(String(p.branch || ''))}</code> đã được merge vào <code>${this.escapeHtml(String(p.targetBranch || ''))}</code> ở nơi khác, task tự đóng.`;
        } else if (type === 'task.overlap') {
          detail = `Sửa cùng file <code>${this.escapeHtml(String(p.file || ''))}</code> với task <code>${this.escapeHtml(String(p.otherTaskId || ''))}</code>, có thể xung đột khi merge.`;
        } else if (type === 'task.timeout') {
          detail = 'Worker chạy quá thời gian cho phép, task chuyển sang thất bại.';
        } else if (typeof p.message === 'string') {
          detail = this.escapeHtml(p.message);
        } else if (typeof p.reason === 'string') {
          detail = this.escapeHtml(p.reason);
        }
        const keyboard: InlineKeyboardButton[][] = taskId
          ? [[{ text: '🌐 Xem task', url: this.getDashboardUrl(`#/tasks/${toRouteId(taskId)}`) }]]
          : [];
        this.broadcastMessage(
          `${prefix}${head}\nID: <code>${taskId}</code>${minimal ? '' : `\nTiêu đề: <b>${this.escapeHtml(title)}</b>`}${detail ? `\n${detail}` : ''}`,
          keyboard.length ? { inline_keyboard: keyboard } : undefined,
        );
        break;
      }

      case 'task.done': {
        const wantDone = notify.taskDone !== false;
        const wantIdle = notify.projectIdle !== false;
        if (!wantDone && !wantIdle) return;
        if (wantDone && taskId) {
          const title = this.resolveTaskTitle(taskId, p);
          const how = p.reason === 'merged_elsewhere'
            ? '\nĐã merge ở nơi khác, tự đóng.'
            : typeof p.by === 'string' && p.by
              ? `\nDuyệt bởi: <b>${this.escapeHtml(p.by)}</b>`
              : '';
          const keyboard: InlineKeyboardButton[][] = [
            [{ text: '🌐 Xem task', url: this.getDashboardUrl(`#/tasks/${toRouteId(taskId)}`) }],
          ];
          this.broadcastMessage(
            minimal
              ? `${prefix}✅ <b>Task hoàn thành</b>\nID: <code>${taskId}</code>`
              : `${prefix}✅ <b>Task hoàn thành</b>\nID: <code>${taskId}</code>\nTiêu đề: <b>${this.escapeHtml(title)}</b>${how}`,
            { inline_keyboard: keyboard },
          );
        }
        if (wantIdle && projectId) this.notifyProjectIdle(projectId, taskId);
        break;
      }

      case 'task.pushed': {
        if (notify.taskDone === false) return;
        const branchStr = typeof p.branch === 'string' ? p.branch : '';
        const commitStr = typeof p.commit === 'string' ? p.commit.slice(0, 7) : '';
        const remoteStr = typeof p.remote === 'string' ? p.remote : '';
        const compareUrl = typeof p.compareUrl === 'string' && p.compareUrl ? p.compareUrl : '';
        const title = this.resolveTaskTitle(taskId, p);

        const keyboard: InlineKeyboardButton[][] = [];
        const actionsRow: InlineKeyboardButton[] = [];
        if (taskId) {
          actionsRow.push({ text: '🌐 Xem task', url: this.getDashboardUrl(`#/tasks/${toRouteId(taskId)}`) });
        }
        if (compareUrl) {
          actionsRow.push({ text: '🔗 Xem commit', url: compareUrl });
        }
        if (actionsRow.length) {
          keyboard.push(actionsRow);
        }

        let body = `${prefix}🚀 <b>Đã đẩy lên git</b>\nID: <code>${taskId}</code>`;
        if (!minimal && title) {
          body += `\nTiêu đề: <b>${this.escapeHtml(title)}</b>`;
        }
        if (remoteStr || branchStr) {
          body += `\nNhánh: <code>${this.escapeHtml(remoteStr ? `${remoteStr}/${branchStr}` : branchStr)}</code>`;
        }
        if (commitStr) {
          body += `\nCommit: <code>${this.escapeHtml(commitStr)}</code>`;
        }

        this.broadcastMessage(
          body,
          keyboard.length ? { inline_keyboard: keyboard } : undefined,
        );
        break;
      }

      case 'task.push_failed': {
        if (notify.failed === false) return;
        const errorMsg = typeof p.error === 'string' ? p.error : 'Lỗi không xác định';
        const title = this.resolveTaskTitle(taskId, p);

        const keyboard: InlineKeyboardButton[][] = [
          [
            { text: '🔄 Đẩy lại', callback_data: `task:publish:${taskId}` },
            { text: '🌐 Xem task', url: this.getDashboardUrl(taskId ? `#/tasks/${toRouteId(taskId)}` : '') },
          ],
        ];

        let body = `${prefix}❌ <b>Đẩy git thất bại</b>\nID: <code>${taskId}</code>`;
        if (!minimal && title) {
          body += `\nTiêu đề: <b>${this.escapeHtml(title)}</b>`;
        }
        body += `\nLý do: ${this.escapeHtml(errorMsg)}`;

        this.broadcastMessage(
          body,
          { inline_keyboard: keyboard },
        );
        break;
      }

      case 'task.failed': {
        if (!notify.failed) return;
        if (minimal) {
          const dashboardUrl = this.getDashboardUrl(taskId ? `#/tasks/${toRouteId(taskId)}` : '');
          const keyboard: InlineKeyboardButton[][] = [
            [{ text: '🌐 Xem dashboard', url: dashboardUrl }],
          ];
          this.broadcastMessage(
            `${prefix}❌ <b>Task thất bại</b>\nID: <code>${taskId}</code>`,
            { inline_keyboard: keyboard },
          );
          break;
        }
        const title = this.resolveTaskTitle(taskId, p);
        const keyboard: InlineKeyboardButton[][] = [
          [
            { text: '🔄 Chạy lại', callback_data: `task:retry:${taskId}` },
            { text: '📄 Xem log', callback_data: `task:log:${taskId}` },
          ],
        ];

        this.broadcastMessage(
          `${prefix}❌ <b>Task thất bại</b>\nID: <code>${taskId}</code>\nTiêu đề: <b>${this.escapeHtml(title)}</b>`,
          { inline_keyboard: keyboard },
        );
        break;
      }

      case 'task.blocked': {
        if (!notify.blocked) return;
        const reason = typeof p.message === 'string' ? `\nLý do: ${this.escapeHtml(p.message)}` : '';
        if (minimal) {
          const dashboardUrl = this.getDashboardUrl(taskId ? `#/tasks/${toRouteId(taskId)}` : '');
          const keyboard: InlineKeyboardButton[][] = [
            [{ text: '🌐 Xem dashboard', url: dashboardUrl }],
          ];
          this.broadcastMessage(
            `${prefix}⚠️ <b>Task bị chặn</b>\nID: <code>${taskId}</code>${reason}`,
            { inline_keyboard: keyboard },
          );
          break;
        }
        const title = this.resolveTaskTitle(taskId, p);
        const keyboard: InlineKeyboardButton[][] = [
          [
            { text: '🔄 Chạy lại', callback_data: `task:retry:${taskId}` },
            { text: '📄 Xem log', callback_data: `task:log:${taskId}` },
          ],
        ];

        this.broadcastMessage(
          `${prefix}⚠️ <b>Task bị chặn</b>\nID: <code>${taskId}</code>\nTiêu đề: <b>${this.escapeHtml(title)}</b>${reason}`,
          { inline_keyboard: keyboard },
        );
        break;
      }

      case 'tracker.ticket_imported':
      case 'tracker.triage_started':
      case 'tracker.comment':
      case 'tracker.poll_failed':
      case 'tracker.resolved':
      case 'tracker.review_requested':
      case 'tracker.writeback_failed': {
        const ref = typeof p.displayId === 'string' ? p.displayId : typeof p.sourceId === 'string' ? p.sourceId : 'OpenProject';
        const label = type === 'tracker.ticket_imported' ? 'đã nhập ticket thành task' : type === 'tracker.triage_started' ? 'đã tạo task phân tích' : type === 'tracker.comment' ? 'có comment mới' : type === 'tracker.poll_failed' ? 'đồng bộ thất bại' : type === 'tracker.resolved' ? 'đã resolve' : type === 'tracker.review_requested' ? 'cần quyết định' : 'ghi ngược thất bại';
        this.broadcastMessage(`${prefix}🔗 <b>${this.escapeHtml(ref)}</b> ${label}.`);
        break;
      }
      case 'tracker.timesheet.posted': {
        const rows = Array.isArray(p.entries) ? p.entries as Array<{ displayId?: string; subject?: string; hours?: number; rawHours?: number; estimateHours?: number }> : [];
        const skipped = Array.isArray(p.estimateSkipped) && p.estimateSkipped.length ? `\nBỏ qua estimate: ${p.estimateSkipped.map((item: { displayId?: string; reason?: string }) => `[${this.escapeHtml(String(item.displayId || '?'))}] ${this.escapeHtml(String(item.reason || ''))}`).join(', ')}` : '';
        const missing = Array.isArray(p.withoutTicket) && p.withoutTicket.length ? `\nChưa có ticket: ${p.withoutTicket.map((item: { taskId?: string; subject?: string }) => `${this.escapeHtml(String(item.taskId || '?'))} ${this.escapeHtml(String(item.subject || ''))}`).join(', ')}` : '';
        const stale = Array.isArray(p.missingFromDate) && p.missingFromDate.length ? `\nTicket không còn trong ngày: ${p.missingFromDate.join(', ')}` : '';
        const minimum = p.overMinimum ? '\nTổng vượt giờ do mức tối thiểu.' : '';
        this.broadcastMessage(`${prefix}🕒 <b>Đã ghi bảng giờ</b> (${this.escapeHtml(formatHours(p.hours))}h)\n${rows.map((row) => `[${this.escapeHtml(String(row.displayId || '?'))}] ${this.escapeHtml(String(row.subject || ''))} — thực tế ${formatHours(row.hours)}h · estimate ${formatHours(row.estimateHours ?? row.rawHours ?? row.hours)}h`).join('\n')}${skipped}${missing}${stale}${minimum}`);
        break;
      }
      case 'tracker.timesheet.failed':
        {
          const posted = Array.isArray(p.entries) ? p.entries as Array<{ displayId?: string; hours?: number }> : [];
          const partial = posted.length ? `\nĐã ghi được: ${posted.map((row) => `[${this.escapeHtml(String(row.displayId || '?'))}] ${formatHours(row.hours)}h`).join(', ')}` : '';
          const skipped = Array.isArray(p.estimateSkipped) && p.estimateSkipped.length ? `\nBỏ qua estimate: ${p.estimateSkipped.map((item: { displayId?: string; reason?: string }) => `[${this.escapeHtml(String(item.displayId || '?'))}] ${this.escapeHtml(String(item.reason || ''))}`).join(', ')}` : '';
          this.broadcastMessage(`${prefix}❌ <b>Ghi bảng giờ thất bại</b>: ${this.escapeHtml(String(p.error || ''))}${partial}${skipped}`);
        }
        break;
      case 'tracker.triage_ready': {
        const sourceId = typeof p.sourceId === 'string' ? p.sourceId : '';
        const wpId = typeof p.wpId === 'number' ? p.wpId : 0;
        const analysis = p.analysis && typeof p.analysis === 'object' ? p.analysis as { conclusion?: string; size?: string; summary?: string } : {};
        if (p.autoDispatch === true) {
          this.broadcastMessage(`${prefix}✅ <b>[${this.escapeHtml(String(p.displayId || 'ticket'))}] Đã tự giao</b>\nKết luận: ${this.escapeHtml(String(analysis.conclusion || ''))}\nĐộ lớn: ${this.escapeHtml(String(analysis.size || ''))}`);
          break;
        }
        const rows: InlineKeyboardButton[][] = [[
          { text: analysis.conclusion === 'việc thủ công' ? '🙋 Tôi tự làm' : '✅ Làm', callback_data: `triage:${analysis.conclusion === 'việc thủ công' ? 'manual' : 'do'}:${sourceId}:${wpId}` },
          ...((analysis.size === 'lớn' || analysis.size === 'lớn (cần chia)') ? [{ text: '🧩 Làm + chia', callback_data: `triage:split:${sourceId}:${wpId}` }] : []),
        ], [
          { text: '❓ Hỏi tester', callback_data: `triage:ask:${sourceId}:${wpId}` },
          { text: '🚫 Không làm', callback_data: `triage:skip:${sourceId}:${wpId}` },
          { text: '🚫 Không làm + lý do', callback_data: `triage:skip-note:${sourceId}:${wpId}` },
        ]];
        const summary = String(analysis.summary || '').slice(0, 900);
        const ticketUrl = typeof p.ticketUrl === 'string' ? `\n<a href="${this.escapeHtml(p.ticketUrl)}">Mở ticket</a>` : '';
        const dashboardUrl = typeof p.taskId === 'string' ? `\n<a href="${this.escapeHtml(this.getDashboardUrl(`#/tasks/${toRouteId(p.taskId)}`))}">Mở trên hub</a>` : '';
        const displayId = String(p.displayId || 'ticket');
        if (sourceId && Number.isSafeInteger(wpId) && wpId > 0) this.triageReplies.set(displayId, { sourceId, wpId });
        this.broadcastMessage(`${prefix}🔎 <b>[${this.escapeHtml(displayId)}] Phân tích xong</b>\nKết luận: ${this.escapeHtml(String(analysis.conclusion || ''))}\nĐộ lớn: ${this.escapeHtml(String(analysis.size || ''))}\n${this.escapeHtml(summary)}\n<i>Trả lời tin nhắn này để gửi thêm thông tin</i>${ticketUrl}${dashboardUrl}`, { inline_keyboard: rows });
        break;
      }

      case 'daily_report.created': {
        if (p.telegram && typeof p.content === 'string') {
          this.broadcastMessage(this.escapeHtml(p.content));
        }
        break;
      }

      case 'daily_report.failed': {
        const source = typeof p.sourceId === 'string' ? p.sourceId : 'OpenProject';
        const err = typeof p.error === 'string' ? `: ${p.error}` : '';
        this.broadcastMessage(`${prefix}❌ <b>Tạo báo cáo ngày thất bại: ${this.escapeHtml(source)}</b>${this.escapeHtml(err)}`);
        break;
      }

      case 'quota.exhausted':
      case 'claude.quota_exhausted': {
        const quotaKey = (typeof p.family === 'string' ? p.family : typeof p.model === 'string' ? p.model : '') || 'all';
        const snapshot = this.quotaCapacity();
        if (!notifyAllExhausted || this.quotaIncidentActive) return;
        this.allQuotaNotified.add(quotaKey);
        this.quotaIncidentActive = true;
        this.broadcastMessage(this.quotaIncidentMessage(snapshot));
        break;
      }

      case 'task.paused':
      case 'load.task_paused':
      case 'load.high': {
        if (now - this.lastSentLoadSummary < 15 * 60_000) break;
        this.lastSentLoadSummary = now;
        this.broadcastMessage(`⚠️ <b>AgentHub tạm dừng/gặp tải cao</b> — xem dashboard để biết chi tiết.`);
        break;
      }

      case 'task.pause_reminder': {
        const title = this.resolveTaskTitle(taskId, p);
        const minutes = typeof p.pausedMinutes === 'number' ? p.pausedMinutes : 30;
        const taskLabel = taskId || 'Task';
        const pauseBadge = (p.reason === 'load' || p.reason === 'brain_load') ? 'Tạm dừng (quá tải)' : 'Tạm dừng (thủ công)';
        const keyboard: InlineKeyboardButton[][] = [];
        if (taskId) {
          keyboard.push([
            { text: '▶️ Tiếp tục', callback_data: `task:resume:${taskId}` },
          ]);
        }
        this.broadcastMessage(
          `${prefix}⏸ <b>Nhắc nhở: ${pauseBadge}</b>\nID: <code>${taskLabel}</code>\nTiêu đề: <b>${this.escapeHtml(title)}</b>\nTask đã bị dừng hơn ${minutes} phút trong khi máy không quá tải.`,
          keyboard.length > 0 ? { inline_keyboard: keyboard } : undefined,
        );
        break;
      }

      case 'merge.conflict': {
        if (!taskId) return;
        if (this.isMergeConflictNotified(taskId)) return;
        this.markMergeConflictNotified(taskId);

        const count = typeof p.conflictCount === 'number' ? p.conflictCount : 1;
        const filesText = this.extractConflictFiles(p);
        this.broadcastMessage(`${prefix}⚠️ ${this.escapeHtml(taskId)} xung đột merge lần thứ ${count}, cần xem: ${this.escapeHtml(filesText)}`);
        break;
      }

      case 'merge.failed': {
        if (p.autoFixCreated === true) return;
        if (taskId && this.taskRepo?.getDerivedFrom(taskId).some((t) =>
          /-fix-merge(?:-\d+)?$/.test(t.slug) && !['done', 'pushed', 'cancelled', 'failed', 'blocked'].includes(t.status)
        )) {
          return;
        }
        const message = typeof p.message === 'string' ? p.message : 'Lỗi khi merge tự động';
        const taskLabel = taskId || 'Task';
        const title = p.environment ? 'Lỗi môi trường khi tự động gộp' : 'Lỗi tự động gộp';
        this.broadcastMessage(`${prefix}❌ <b>${title}: ${this.escapeHtml(taskLabel)}</b>\n${this.escapeHtml(message)}`);
        break;
      }

      case 'brain.updated': {
        const currentBrain = this.service.getStatus().brain;
        // Only Claude Code sessions outside the hub (e.g. an editor) can be silently waiting:
        // hub chat / brain replies already reached the user, so they never trigger this.
        const waiting = (currentBrain?.sessions || []).filter((session) => !session.isHubChat && session.state === 'waiting' && this.now() - Date.parse(session.lastActivityAt) > 5 * 60_000);
        const waitingIds = new Set(waiting.map((session) => session.sessionId));
        for (const id of [...this.brainWaitingNotified]) if (!waitingIds.has(id)) this.brainWaitingNotified.delete(id);
        const fresh = waiting.filter((session) => !this.brainWaitingNotified.has(session.sessionId));
        if (notify.brainWaiting === false || fresh.length === 0) return;
        for (const session of fresh) this.brainWaitingNotified.add(session.sessionId);
        const lines = fresh.map((session) => `• <b>${this.escapeHtml(session.title)}</b>${session.lastUserRequest ? `\n  Yêu cầu cuối: ${this.escapeHtml(session.lastUserRequest)}` : ''}`).join('\n');
        this.broadcastMessage(`🧠 <b>Phiên Claude Code đang chờ bạn trả lời</b> (ngoài hub, quá 5 phút)\n${lines}`);
        break;
      }

      case 'chat.limit_waiting': {
        if (!notifyAllExhausted || !this.chatService || typeof p.sessionId !== 'string') return;
        const resetAt = typeof p.resetAt === 'number' ? formatReset(p.resetAt * 1000 + 60_000, this.now(), 'vi') : 'sau khi reset';
        this.broadcastMessage(`⏳ <b>Claude đạt giới hạn 5 giờ</b>\nTự gửi lại lúc <b>${resetAt}</b>.`, { inline_keyboard: [[{ text: '⏹ Huỷ', callback_data: `chatlimit:cancel:${p.sessionId}` }, { text: '▶️ Gửi lại ngay', callback_data: `chatlimit:now:${p.sessionId}` }]] });
        break;
      }

      case 'deploy.started':
      case 'deploy.restarting':
      case 'deploy.restart_waiting':
      case 'deploy.succeeded':
      case 'deploy.failed': {
        if (!notify.fallback) return;
        const isFailure = type === 'deploy.failed';
        const isSuccess = type === 'deploy.succeeded';
        const title = isFailure ? 'Triển khai thất bại' : isSuccess ? 'Triển khai thành công' : type === 'deploy.started' ? 'Bắt đầu triển khai' : 'Đang chờ triển khai';
        const icon = isFailure ? '🚨' : isSuccess ? '✅' : '🚀';
        const details = typeof p.error === 'string' ? `\n${this.escapeHtml(p.error)}` : typeof p.message === 'string' ? `\n${this.escapeHtml(p.message)}` : '';
        this.broadcastMessage(`${icon} <b>${title}</b>${details}`);
        break;
      }

      case 'remote_deploy.started':
      case 'remote_deploy.succeeded':
      case 'remote_deploy.failed':
      case 'remote_deploy.health_timeout': {
        if (!notify.fallback) return;
        const isFailure = type === 'remote_deploy.failed' || type === 'remote_deploy.health_timeout';
        const isSuccess = type === 'remote_deploy.succeeded';
        const title = isSuccess
          ? 'Remote deploy thành công'
          : type === 'remote_deploy.health_timeout'
            ? 'Remote deploy hết thời gian chờ health check'
            : isFailure
              ? 'Remote deploy thất bại'
              : 'Bắt đầu remote deploy';
        const icon = isSuccess ? '✅' : isFailure ? '🚨' : '🚀';
        const proj = typeof p.projectId === 'string' ? ` [${this.escapeHtml(p.projectId)}]` : '';
        const details = typeof p.error === 'string' ? `\n${this.escapeHtml(p.error)}` : typeof p.message === 'string' ? `\n${this.escapeHtml(p.message)}` : '';
        this.broadcastMessage(`${icon} <b>${title}</b>${proj}${details}`);
        break;
      }

      case 'disk.low': {
        const notifyDisk = this.config.telegram?.notify?.disk !== false;
        if (!notifyDisk) return;

        const isHubHomeLow = p.source === 'hub_home'
          || p.label === 'Ổ chứa dữ liệu hub (~/.agenthub)'
          || p.label === 'Dữ liệu hub (~/.agenthub)';

        let waitingTasks: Array<{ id: string; slug?: string; title?: string }> = [];
        if (Array.isArray(p.tasks)) {
          waitingTasks = p.tasks.map((item) => typeof item === 'string' ? { id: item, slug: item, title: item } : item as { id: string; slug?: string; title?: string });
        } else if (this.taskRepo) {
          waitingTasks = this.taskRepo.getByStatus('waiting_quota').filter((t) => t.waitReason === 'disk');
        }

        const isBlocking = isHubHomeLow || waitingTasks.length > 0 || p.isBlocking === true;

        if (isBlocking) {
          const diskKey = typeof p.path === 'string' && p.path ? path.resolve(p.path) : (typeof p.label === 'string' ? p.label : 'default');
          const lastSent = this.lastSentDiskBlockedByPath.get(diskKey) ?? 0;
          if (lastSent > 0 && now - lastSent < 60 * 60_000) return;
          this.diskBlockedNotified = true;
          this.lastSentDiskBlocked = now;
          this.lastSentDiskBlockedByPath.set(diskKey, now);
          this.lastSentDisk.set('low', now);

          const label = typeof p.label === 'string' && p.label ? this.escapeHtml(p.label) : 'Ổ đĩa';
          const pathStr = typeof p.path === 'string' && p.path ? ` (${this.escapeHtml(p.path)})` : '';
          const freeGB = typeof p.freeGB === 'number' ? p.freeGB : 0;
          const minFreeGB = typeof p.minFreeGB === 'number' ? p.minFreeGB : 0;
          const taskNames = waitingTasks.map((t) => t.slug || t.title || t.id).filter(Boolean);
          const taskListStr = taskNames.length > 0
            ? ` ${taskNames.length} task đang phải chờ: ${taskNames.map((name) => this.escapeHtml(name)).join(', ')}.`
            : '';

          const rawCacheDir = typeof p.cacheDir === 'string' && p.cacheDir ? p.cacheDir : this.config.cacheDir;
          const cacheBytes = typeof p.cacheBytes === 'number' ? p.cacheBytes : 0;
          const cacheGB = cacheBytes > 0
            ? `${(cacheBytes / (1024 ** 3)).toFixed(1)} GB`
            : typeof p.cacheGB === 'number' ? `${p.cacheGB} GB` : '';
          const cacheDir = rawCacheDir ? this.escapeHtml(rawCacheDir) : '';
          const cacheSuggestion = cacheDir
            ? ` Gợi ý: dọn thùng rác hoặc cache node_modules (${cacheDir}${cacheGB ? `, ${cacheGB}` : ''}).`
            : ' Gợi ý: dọn thùng rác hoặc cache node_modules.';

          this.broadcastMessage(`💾 Hết dung lượng: ${label}${pathStr} còn ${freeGB} GB, cần ${minFreeGB} GB.${taskListStr}${cacheSuggestion}`);
          break;
        }

        const last = this.lastSentDisk.get('low');
        if (last !== undefined && now - last < 60 * 60_000) return;
        this.lastSentDisk.set('low', now);
        const freeGB = typeof p.freeGB === 'number' ? p.freeGB : 0;
        const minFreeGB = typeof p.minFreeGB === 'number' ? p.minFreeGB : 3;
        const cacheDir = typeof p.cacheDir === 'string' ? `\nCache node_modules: <code>${this.escapeHtml(p.cacheDir)}</code>` : '';
        const largest = typeof p.largestCacheEntry === 'string'
          ? `\nBản cache lớn nhất: <code>${this.escapeHtml(p.largestCacheEntry)}</code>${typeof p.largestCacheEntryBytes === 'number' ? ` (${(p.largestCacheEntryBytes / 1024 ** 3).toFixed(2)} GB)` : ''}`
          : '';
        this.broadcastMessage(`💾 <b>Ổ đĩa thấp</b>\nCòn ${freeGB} GB (&lt; ${minFreeGB} GB): tạm dừng khởi chạy task mới.${cacheDir}${largest}`);
        break;
      }

      case 'disk.ok': {
        const notifyDisk = this.config.telegram?.notify?.disk !== false;
        if (!notifyDisk) return;

        const resumedCount = typeof p.resumedCount === 'number'
          ? p.resumedCount
          : Array.isArray(p.tasks)
          ? p.tasks.length
          : 0;

        if (this.diskBlockedNotified) {
          this.lastSentDisk.set('ok', now);
          if (resumedCount > 0) {
            this.broadcastMessage(`✅ Đã đủ dung lượng, ${resumedCount} task tiếp tục chạy`);
          }
          if (typeof p.remainingCount === 'number' && p.remainingCount > 0) {
            if (typeof p.path === 'string' && p.path) {
              const resolved = path.resolve(p.path);
              this.lastSentDiskBlockedByPath.delete(resolved);
              for (const key of Array.from(this.lastSentDiskBlockedByPath.keys())) {
                if (key === resolved || key.startsWith(resolved + path.sep) || resolved.startsWith(key + path.sep)) {
                  this.lastSentDiskBlockedByPath.delete(key);
                }
              }
              for (const key of Array.from(this.lastBroadcast.keys())) {
                if (key.includes(p.path) || key.includes(resolved)) {
                  this.lastBroadcast.delete(key);
                }
              }
            }
            if (typeof p.label === 'string' && p.label) {
              this.lastSentDiskBlockedByPath.delete(p.label);
            }
            if (this.lastSentDiskBlockedByPath.size === 0) {
              this.diskBlockedNotified = false;
            }
          } else {
            this.diskBlockedNotified = false;
            this.lastSentDiskBlockedByPath.clear();
            for (const key of Array.from(this.lastBroadcast.keys())) {
              if (key.includes('💾 Hết dung lượng')) {
                this.lastBroadcast.delete(key);
              }
            }
          }
          break;
        }

        const last = this.lastSentDisk.get('ok');
        if (last !== undefined && now - last < 60 * 60_000) return;
        this.lastSentDisk.set('ok', now);
        const freeGB = typeof p.freeGB === 'number' ? p.freeGB : 0;
        this.broadcastMessage(`💾 <b>Ổ đĩa đã đủ chỗ</b> (${freeGB} GB): tiếp tục chạy task.`);
        break;
      }

      case 'profile.auth_expired': {
        if (!notify.fallback) return;
        const name = typeof p.name === 'string' ? p.name : 'tài khoản';
        this.broadcastMessage(`🔑 <b>Tài khoản ${this.escapeHtml(name)}</b> cần đăng nhập lại.`);
        break;
      }

      case 'ci.failed': {
        const projId = (typeof p.projectId === 'string' ? p.projectId : taskId) || null;
        const workflow = (typeof p.workflow === 'string' ? p.workflow : '') || 'CI';
        const sha = typeof p.sha === 'string' ? p.sha.slice(0, 7) : '';
        const throttleKey = `ci:${projId}:${workflow}`;
        const last = this.lastSentCi.get(throttleKey) || 0;
        if (now - last < 3600_000) {
          break;
        }
        this.lastSentCi.set(throttleKey, now);

        const prefix = this.projectPrefix(projId);
        const jobs = Array.isArray(p.jobs)
          ? (p.jobs as Array<{ name?: string; annotations?: Array<{ message?: string; path?: string; start_line?: number }> }>)
          : [];
        const annotations = Array.isArray(p.annotations)
          ? (p.annotations as Array<{ message?: string; path?: string; start_line?: number }>)
          : [];

        let text = `${prefix}⚠️ <b>CI thất bại: ${this.escapeHtml(workflow)}</b>`;
        if (sha) text += ` (<code>${this.escapeHtml(sha)}</code>)`;
        if (jobs.length > 0) {
          text += '\n\n<b>Job lỗi:</b>\n';
          for (const j of jobs) {
            text += `• <b>${this.escapeHtml(j.name || 'Job')}</b>\n`;
          }
        }
        if (annotations.length > 0) {
          text += '\n<b>Chi tiết lỗi:</b>\n';
          for (const a of annotations.slice(0, 5)) {
            const loc = a.path ? ` (${this.escapeHtml(a.path)}${a.start_line ? `:${a.start_line}` : ''})` : '';
            text += `• ${this.escapeHtml(a.message || 'Lỗi')}${loc}\n`;
          }
          if (annotations.length > 5) {
            text += `<i>... và ${annotations.length - 5} chú thích lỗi khác.</i>\n`;
          }
        }

        const keyboard: InlineKeyboardButton[][] = [];
        if (typeof p.url === 'string' && p.url) {
          keyboard.push([{ text: '🔗 Xem trên GitHub', url: p.url }]);
        }
        this.broadcastMessage(text, keyboard.length > 0 ? { inline_keyboard: keyboard } : undefined);
        break;
      }

      case 'ci.passed': {
        if (p.recoveredFromFailure !== true && p.previousConclusion !== 'failure') {
          break;
        }
        const projId = (typeof p.projectId === 'string' ? p.projectId : taskId) || null;
        const workflow = (typeof p.workflow === 'string' ? p.workflow : '') || 'CI';
        const sha = typeof p.sha === 'string' ? p.sha.slice(0, 7) : '';
        const prefix = this.projectPrefix(projId);

        let text = `${prefix}🟢 <b>CI đã xanh: ${this.escapeHtml(workflow)}</b>`;
        if (sha) text += ` (<code>${this.escapeHtml(sha)}</code>)`;

        const keyboard: InlineKeyboardButton[][] = [];
        if (typeof p.url === 'string' && p.url) {
          keyboard.push([{ text: '🔗 Xem trên GitHub', url: p.url }]);
        }
        this.broadcastMessage(text, keyboard.length > 0 ? { inline_keyboard: keyboard } : undefined);
        break;
      }

      case 'gitea.sync.started': {
        const source = typeof p.sourceBranch === 'string' ? p.sourceBranch : '';
        const target = typeof p.targetBranch === 'string' ? p.targetBranch : '';
        this.broadcastMessage(`${prefix}🔄 <b>Bắt đầu đồng bộ Gitea</b>: <code>${this.escapeHtml(source)}</code> → <code>${this.escapeHtml(target)}</code>`);
        break;
      }

      case 'gitea.sync.skipped': {
        const reason = typeof p.reason === 'string' ? p.reason : 'Không có commit mới';
        this.broadcastMessage(`${prefix}⏭️ <b>Bỏ qua đồng bộ Gitea</b>: ${this.escapeHtml(reason)}`);
        break;
      }

      case 'gitea.sync.succeeded': {
        const prNum = typeof p.prNumber === 'number' ? `PR #${p.prNumber}` : 'PR';
        const commit = typeof p.commit === 'string' ? ` (<code>${this.escapeHtml(p.commit.slice(0, 7))}</code>)` : '';
        const keyboard: InlineKeyboardButton[][] = [];
        if (typeof p.url === 'string' && p.url) {
          keyboard.push([{ text: '🔗 Xem trên Gitea', url: p.url }]);
        }
        this.broadcastMessage(
          `${prefix}✅ <b>Đồng bộ Gitea thành công</b>: ${prNum}${commit}`,
          keyboard.length ? { inline_keyboard: keyboard } : undefined,
        );
        break;
      }

      case 'gitea.sync.failed': {
        const err = typeof p.error === 'string' ? p.error : 'Lỗi không xác định';
        const prNum = typeof p.prNumber === 'number' ? ` (PR #${p.prNumber})` : '';
        const keyboard: InlineKeyboardButton[][] = [];
        if (typeof p.url === 'string' && p.url) {
          keyboard.push([{ text: '🔗 Xem trên Gitea', url: p.url }]);
        }
        this.broadcastMessage(
          `${prefix}❌ <b>Đồng bộ Gitea thất bại</b>${prNum}: ${this.escapeHtml(err)}`,
          keyboard.length ? { inline_keyboard: keyboard } : undefined,
        );
        break;
      }

      case 'gitea.sync.conflict': {
        const files = Array.isArray(p.conflictingFiles) ? (p.conflictingFiles as string[]) : [];
        const fileList = files.length > 0
          ? `\n\n<b>File xung đột:</b>\n${files.slice(0, 5).map((f) => `• <code>${this.escapeHtml(f)}</code>`).join('\n')}`
          : '';
        this.broadcastMessage(`${prefix}⚠️ <b>Xung đột khi đồng bộ Gitea</b>: đã tạo task gỡ xung đột${fileList}`);
        break;
      }
      }
    } finally {
      this.notificationProjectId = null;
      this.notificationDedupProjectId = null;
    }
  }

  private queueWaitingQuotaCheck(notifyAllExhausted: boolean): void {
    if (this.waitingQuotaCheckTimer || !this.taskRepo) return;
    this.waitingQuotaCheckTimer = setTimeout(() => {
      this.waitingQuotaCheckTimer = undefined;
      const waiting = this.taskRepo?.getByStatus('waiting_quota').filter((task) => task.waitReason === 'quota') || [];
      if (waiting.length === 0) {
        this.waitingQuotaNotified = false;
        return;
      }
      if (!notifyAllExhausted || this.waitingQuotaNotified) return;
      this.waitingQuotaNotified = true;
      const active = this.quotaMarkRepo?.getActive(Math.floor(this.now() / 1000)) || [];
      const until = active.length > 0 ? Math.min(...active.map((mark) => mark.until)) : 0;
      const time = until ? new Date(until * 1000).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : 'sớm';
      this.broadcastMessage(`⏳ <b>${waiting.length} task đang chờ quota</b>\nSớm nhất mở lại lúc <b>${time}</b>.`);
    }, WAITING_QUOTA_BATCH_DELAY_MS);
  }

  broadcastMessage(
    text: string,
    replyMarkup?: { inline_keyboard: InlineKeyboardButton[][] },
    projectId = this.notificationProjectId,
    departmentId?: string,
  ): void {
    // Event notifications can fire repeatedly for the same state (quota polls, scheduler ticks).
    const now = this.now();
    const dedupKey = `${this.notificationDedupProjectId || projectId || ''}:${text}`;
    const last = this.lastBroadcast.get(dedupKey);
    if (last !== undefined && now - last < NOTIFY_REPEAT_WINDOW_MS) return;
    this.lastBroadcast.set(dedupKey, now);
    for (const [key, at] of this.lastBroadcast) if (now - at >= NOTIFY_REPEAT_WINDOW_MS) this.lastBroadcast.delete(key);
    const allowed = this.config.telegram?.allowedChatIds || [];

    const isDeptMode = this.config.telegram.topicMode === 'department';
    let targets: Array<{ chatId: number; threadId?: number | null }> = [];

    if (isDeptMode) {
      if (projectId) {
        const project = this.projectRepo.get(projectId);
        const resolvedDeptId = departmentId || project?.departmentId || 'chung';
        const deptTopic = this.getDepartmentTopic(resolvedDeptId);
        if (deptTopic && allowed.includes(deptTopic.chatId)) {
          targets = [deptTopic];
        } else {
          targets = allowed.map((chatId) => ({ chatId, threadId: null }));
        }
      } else {
        // System event / periodic digest: send to topic "Chung" if available
        const chungTopic = this.getDepartmentTopic(departmentId || 'chung');
        if (chungTopic && allowed.includes(chungTopic.chatId)) {
          targets = [chungTopic];
        } else {
          targets = allowed.map((chatId) => ({ chatId, threadId: null }));
        }
      }
    } else {
      if (departmentId) {
        const deptTopic = this.getDepartmentTopic(departmentId);
        if (deptTopic && allowed.includes(deptTopic.chatId)) {
          targets = [deptTopic];
        }
      }
      if (targets.length === 0) {
        targets = projectId && this.config.telegram.projectTopics?.[projectId] && allowed.includes(this.config.telegram.projectTopics[projectId].chatId)
          ? [this.config.telegram.projectTopics[projectId]]
          : projectId
            ? (this.config.telegram.chats || []).filter((chat) => chat.projectId === projectId && allowed.includes(chat.id)).map((chat) => ({ chatId: chat.id, threadId: null }))
            : allowed.map((chatId) => ({ chatId, threadId: null }));
        // Legacy configurations have allowedChatIds but no per-project mapping.
        if (projectId && targets.length === 0) targets = allowed.map((chatId) => ({ chatId, threadId: null }));
      }
    }

    for (const target of targets) {
      void this.sendMessage(target.chatId, text, replyMarkup, target.threadId);
    }
  }

  // --- Message Sending & Anti-Flood Queue (1 msg/sec/chat) ---

  // Not `async`: an async wrapper would re-wrap the rejection in a new, unhandled promise.
  sendMessage(
    chatId: number,
    text: string,
    replyMarkup?: { inline_keyboard: InlineKeyboardButton[][] },
    threadId: number | null | undefined = this.activeThreadByChat?.get(chatId),
  ): Promise<unknown> {
    const promise = new Promise<unknown>((resolve, reject) => {
      let queue = this.chatQueues.get(chatId);
      if (!queue) {
        queue = [];
        this.chatQueues.set(chatId, queue);
      }

      queue.push({ chatId, threadId, text, replyMarkup, resolve, reject });
      void this.processChatQueue(chatId);
    });
    // Many callers fire and forget (notifications). A network blip must never become an
    // unhandled rejection: that crashed the whole daemon on 21/10. Awaiting callers still
    // receive the rejection.
    promise.catch((err) => {
      console.error(`[telegram] send failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    return promise;
  }

  private async processChatQueue(chatId: number): Promise<void> {
    if (this.chatProcessing.get(chatId)) {
      return;
    }
    this.chatProcessing.set(chatId, true);

    try {
      while (true) {
        const queue = this.chatQueues.get(chatId);
        if (!queue || queue.length === 0) {
          break;
        }

        const item = queue.shift()!;
        const now = this.now();
        const lastSent = this.chatLastSent.get(chatId) || 0;
        const elapsed = now - lastSent;

        // Anti-flood: ensure at least 1000ms between messages to the same chat
        if (elapsed < 1000) {
          await this.sleepFn(1000 - elapsed);
        }

        this.chatLastSent.set(chatId, this.now());

        try {
          let res: unknown;
          for (let attempt = 1; ; attempt += 1) {
            try {
              res = await this.sendDirectMessage(item.chatId, item.text, item.replyMarkup, item.threadId);
              break;
            } catch (err) {
              // Retry transient network errors (fetch failed, timeouts) a couple of times.
              const transient = /fetch failed|ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND|network|socket/i.test(err instanceof Error ? `${err.message} ${String((err as { cause?: unknown }).cause ?? '')}` : String(err));
              if (!transient || attempt >= 3) throw err;
              await this.sleepFn(2000 * attempt);
            }
          }
          item.resolve(res);
        } catch (err) {
          item.reject(err);
        }
      }
    } finally {
      this.chatProcessing.set(chatId, false);
    }
  }

  /**
   * Flush any queued messages for a chat immediately (mainly for test cleanup).
   */
  async flushQueue(chatId?: number): Promise<void> {
    const chatIds = chatId ? [chatId] : Array.from(this.chatQueues.keys());
    for (const id of chatIds) {
      const queue = this.chatQueues.get(id);
      while (queue && queue.length > 0) {
        const item = queue.shift()!;
        try {
          const res = await this.sendDirectMessage(item.chatId, item.text, item.replyMarkup, item.threadId);
          item.resolve(res);
        } catch (err) {
          item.reject(err);
        }
      }
    }
  }

  private async sendDirectMessage(
    chatId: number,
    text: string,
    replyMarkup?: { inline_keyboard: InlineKeyboardButton[][] },
    threadId?: number | null,
  ): Promise<unknown> {
    if (!this.token) {
      return null;
    }

    const url = `https://api.telegram.org/bot${this.token}/sendMessage`;
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
    };
    if (threadId !== undefined && threadId !== null && threadId > 0) body.message_thread_id = threadId;
    if (replyMarkup) {
      body.reply_markup = replyMarkup;
    }

    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(`Telegram sendMessage request failed: ${redactTelegramToken(err, this.token)}`);
    }

    if (!res.ok) {
      throw new Error(`Telegram sendMessage failed with status ${res.status}`);
    }

    return res.json();
  }

  private async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    if (!this.token) return;

    try {
      const url = `https://api.telegram.org/bot${this.token}/answerCallbackQuery`;
      await this.fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          callback_query_id: callbackQueryId,
          text,
        }),
      });
    } catch {
      // ignore
    }
  }

  // --- Diff and Log Helpers ---

  private async getTaskDiffSummary(task: TaskRow): Promise<string> {
    const project = this.projectRepo.get(task.projectId);
    if (!project) return 'Không tìm thấy project của task.';

    const cwd = task.worktreePath && fs.existsSync(task.worktreePath)
      ? task.worktreePath
      : project.path;
    const baseRef = task.baseRef || project.defaultBranch || 'main';
    const branch = task.branch || 'HEAD';
    const target = cwd === task.worktreePath ? `${baseRef}...HEAD` : `${baseRef}...${branch}`;

    try {
      const { stdout } = await this.execFileFn('git', ['diff', '--stat', target], {
        cwd,
        timeout: 10_000,
      });
      const trimmed = stdout.trim();
      if (!trimmed) return 'Không có thay đổi file nào.';
      return trimmed.length > 3500 ? trimmed.slice(0, 3500) + '\n... (đã cắt bớt)' : trimmed;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return `Không thể lấy diff: ${errMsg}`;
    }
  }

  private getTaskLast30Lines(taskId: string): string {
    const fullLog = this.service.getTaskLog(taskId, { tail: 64 }) || '';
    if (!fullLog.trim()) {
      return 'Chưa có log cho task này.';
    }

    const lines = fullLog.split('\n');
    const last30 = lines.slice(-30).join('\n');
    return last30.length > 3500 ? last30.slice(0, 3500) + '\n... (đã cắt bớt)' : last30;
  }

  /** Sự kiện làm task bị ngắt giữa chừng; báo Telegram khi notify.interrupted bật (kể cả brain auto). */
  private static readonly INTERRUPT_EVENTS = new Set(['task.cancelled', 'task.timeout', 'task.no_commit', 'task.looping', 'task.overlap', 'task.failover', 'task.auto_closed', 'hub.restart_timeout']);
  private static readonly INTERRUPT_LABELS: Record<string, string> = {
    'task.timeout': '⏱ <b>Task quá thời gian</b>',
    'task.no_commit': '⚠️ <b>Task lâu không commit</b>',
    'task.looping': '🔁 <b>Task đang lặp lệnh</b>',
    'task.overlap': '⚠️ <b>Task chồng lấn</b>',
    'task.failover': '🔀 <b>Task chuyển tài khoản/model</b>',
    'task.auto_closed': '📦 <b>Task tự đóng</b>',
    'hub.restart_timeout': '⏳ <b>Khởi động lại hub hết thời gian chờ</b>',
  };

  /** Trạng thái coi là "còn việc": task chưa kết thúc. */
  private static readonly PROJECT_ACTIVE_STATUSES = new Set(['queued', 'running', 'checking', 'review', 'waiting_quota']);

  /**
   * Khi task vừa xong mà project không còn task nào đang chờ/chạy/duyệt thì báo
   * "project đã hết task". Mỗi lần project rỗng chỉ báo một lần; có task mới
   * rồi lại rỗng thì báo lại.
   */
  private notifyProjectIdle(projectId: string, justFinishedTaskId?: string): void {
    const remaining = this.taskRepo.getByProject(projectId).filter((task) =>
      task.id !== justFinishedTaskId && TelegramBotService.PROJECT_ACTIVE_STATUSES.has(task.status));
    if (remaining.length > 0) {
      this.projectIdleNotified.delete(projectId);
      return;
    }
    if (this.projectIdleNotified.has(projectId)) return;
    this.projectIdleNotified.add(projectId);
    const project = this.projectRepo.get(projectId);
    const name = project?.name || projectId;
    const doneCount = this.taskRepo.getByProject(projectId).filter((task) => task.status === 'done' || task.status === 'pushed').length;
    this.broadcastMessage(
      `🏁 <b>${this.escapeHtml(name)} đã hết task</b>\nKhông còn task nào đang chờ, chạy hay chờ duyệt. Tổng ${doneCount} task đã hoàn thành.`,
      { inline_keyboard: [[{ text: '🌐 Xem dashboard', url: this.getDashboardUrl(`#/tasks?project=${encodeURIComponent(projectId)}`) }]] },
      projectId,
    );
  }

  private resolveTaskTitle(taskId?: string, payload?: Record<string, unknown>, taskObj?: TaskRow | null): string {
    if (payload?.title && typeof payload.title === 'string') return payload.title;
    if (taskObj?.title) return taskObj.title;
    if (taskId) {
      const task = this.taskRepo.get(taskId) || this.taskRepo.get(toTaskId(taskId));
      if (task?.title) return task.title;
      return taskId;
    }
    return 'Task';
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  private describeEventForQuietHours(type: string, taskId?: string, p?: Record<string, unknown>): string {
    const projectId = taskId?.includes('/') ? taskId.slice(0, taskId.indexOf('/')) : typeof p?.projectId === 'string' ? p.projectId : null;
    const prefix = this.projectPrefix(projectId, { raw: true });
    const minimal = this.isMinimalProject(projectId);
    switch (type) {
      case 'brain.notify':
        return minimal ? `${prefix}Bộ não: đã trả lời` : `${prefix}Bộ não: ${p?.text || 'Thông báo mới'}`;
      case 'task.review_ready':
        return minimal ? `${prefix}1 task cần duyệt` : `${prefix}Task ${this.resolveTaskTitle(taskId, p)} chờ review`;
      case 'task.failed':
        return minimal ? `${prefix}Task thất bại` : `${prefix}Task ${this.resolveTaskTitle(taskId, p)} thất bại`;
      case 'task.blocked':
        return minimal ? `${prefix}Task bị chặn` : `${prefix}Task ${this.resolveTaskTitle(taskId, p)} bị chặn`;
      case 'batch.created':
        return minimal ? `${prefix}Đợt task mới` : `${prefix}Đợt task mới: ${p?.title || 'Kế hoạch đề xuất'}`;
      case 'ci.failed':
        return minimal ? `${prefix}CI thất bại` : `${prefix}CI thất bại: ${p?.workflow || 'CI'}`;
      case 'ci.passed':
        return minimal ? `${prefix}CI đã xanh` : `${prefix}CI đã xanh: ${p?.workflow || 'CI'}`;
      case 'tracker.ticket_imported':
        return `${prefix}Đã nhập ticket ${p?.displayId || 'OpenProject'} thành task`;
      case 'tracker.comment':
        return `${prefix}Ticket ${p?.displayId || 'OpenProject'} có comment mới`;
      case 'tracker.poll_failed':
        return `${prefix}Đồng bộ OpenProject thất bại: ${p?.sourceId || ''}`;
      case 'tracker.resolved':
        return `${prefix}OpenProject ticket đã resolve: ${p?.displayId || ''}`;
      case 'tracker.review_requested':
        return `${prefix}OpenProject ticket cần quyết định: ${p?.displayId || ''}`;
      case 'tracker.writeback_failed':
        return `${prefix}Ghi ngược OpenProject thất bại: ${p?.error || ''}`;
      case 'daily_report.created':
        return `${prefix}Đã tạo báo cáo ngày cho ${p?.sourceId || 'OpenProject'}`;
      case 'daily_report.failed':
        return `${prefix}Tạo báo cáo ngày thất bại: ${p?.sourceId || ''}`;
      case 'gitea.sync.succeeded':
        return `${prefix}Đồng bộ Gitea thành công`;
      case 'gitea.sync.failed':
        return `${prefix}Đồng bộ Gitea thất bại: ${p?.error || ''}`;
      case 'gitea.sync.conflict':
        return `${prefix}Xung đột khi đồng bộ Gitea`;
      case 'merge.conflict': {
        const count = typeof p?.conflictCount === 'number' ? p.conflictCount : 1;
        const filesText = this.extractConflictFiles((p && typeof p === 'object' ? p : {}) as Record<string, unknown>);
        return `${prefix}⚠️ ${taskId || 'task'} xung đột merge lần thứ ${count}, cần xem: ${filesText}`;
      }
      case 'merge.failed':
        return `${prefix}Lỗi khi merge tự động (${taskId || 'task'})`;
      case 'review.fallback':
        if (!this.isAllQuotaExhausted(p)) return '';
        return `${prefix}Codex hết quota, Claude đang duyệt …`;
      case 'quota.exhausted':
      case 'claude.quota_exhausted':
        return 'Hết sạch quota ở mọi tài khoản và model';
      default:
        return taskId ? `${prefix}${type} (${taskId})` : type;
    }
  }

  private extractConflictFiles(p: Record<string, unknown>): string {
    if (typeof p.files === 'string' && p.files.trim()) return p.files.trim();
    if (Array.isArray(p.files) && p.files.length > 0) return p.files.join(', ');
    if (typeof p.message === 'string') {
      const match = p.message.match(/Xung đột merge ở:\s*(.+)/i);
      if (match && match[1].trim()) return match[1].trim();
      return p.message.trim();
    }
    return '(không rõ file)';
  }

  private isMergeConflictNotified(taskId: string): boolean {
    if (this.mergeConflictNotified.has(taskId)) return true;
    if (this.taskRepo?.isNotificationSent('telegram', 'merge.conflict', taskId)) {
      this.mergeConflictNotified.add(taskId);
      return true;
    }
    return false;
  }

  private markMergeConflictNotified(taskId: string): void {
    this.mergeConflictNotified.add(taskId);
    this.taskRepo?.markNotificationSent('telegram', 'merge.conflict', taskId);
  }

  private renderHelp(): string {
    return `🤖 <b>Danh sách lệnh ${this.escapeHtml(this.appName)} Telegram Bot:</b>

/use &lt;dự án&gt; - Chọn dự án hiện tại cho chat (/use để xem, /use none để bỏ chọn)
/projects - Danh sách dự án, bấm để chọn nhanh
/ask &lt;câu hỏi&gt; - Hỏi/trao đổi với bộ não: /ask &lt;câu hỏi&gt;
/status - Xem tổng quan hệ thống (task, hồ sơ, quota, ổ đĩa)
/focus &lt;dự án&gt; - Tập trung tài nguyên cho dự án; /focus off để tắt
/shutdown - Tắt AgentHub; bật lại từ máy bằng <code>agenthub start</code>
/restart - Khởi động lại khi rảnh; dùng <code>/restart now</code> để xác nhận dừng ngay
/digest - Xem tóm tắt hệ thống (task hoàn thành, đã merge, quota, việc cần quyết định)
/plans - Xem 5 kế hoạch gần nhất và tiến độ
/ci [dự án] - Xem trạng thái CI GitHub Actions gần nhất và job lỗi
/brain - Xem Claude đang làm gì và bộ não từng dự án · /brain mode [dự án] off|suggest|auto|external|inherit
/knowledge - Liệt kê kiến thức ghim và checklist của project đang chọn
/directives - Xem chỉ thị cho bộ não của project đang chọn · /directives add &lt;nội dung&gt; · /directives del &lt;id&gt;
/tasks [trạng thái] - Xem danh sách task (vd: /tasks review, /tasks running)
/task &lt;id&gt; - Xem chi tiết task, kết quả checks và link dashboard
/newtask &lt;mô tả chung&gt; - Giao một yêu cầu mới cho Claude tự phân tích và tạo task
/newtask - Nhập mô tả ở tin nhắn kế tiếp
/newtask_detail - Tạo task theo từng bước (project, tiêu đề, đề bài, độ khó, model)
/plan &lt;project&gt; &lt;mục tiêu&gt; - Nhờ Claude lập kế hoạch và đề xuất một đợt task nháp
/drafts - Xem danh sách task và đợt nháp, kèm nút giao hoặc xoá
/log &lt;id&gt; - Xem 30 dòng cuối log của task
/retry &lt;id&gt; - Chạy lại task bị failed hoặc blocked
/cancel &lt;id&gt; - Hủy task (kèm nút xác nhận)
/approve &lt;id&gt; - Duyệt task (+ merge nếu project có cấu hình)
/reject &lt;id&gt; &lt;nhận xét&gt; - Trả về task yêu cầu sửa đổi
/pause - Tạm dừng giao task mới
/resume - Tiếp tục giao task mới
/help - Hướng dẫn sử dụng

<i>Lưu ý: Task ID có thể dùng dạng đầy đủ 'project/slug' hoặc chỉ 'slug' nếu không trùng.</i>`;
  }
}

function formatHours(h: unknown): string {
  const num = typeof h === 'number' ? h : Number(h || 0);
  if (Number.isNaN(num)) return '0';
  const rounded = Math.round(num * 100) / 100;
  return String(rounded).replace('.', ',');
}
