import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChildProcess } from 'node:child_process';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { AgentHubConfig } from '../config.js';
import {
  ChatSessionRepo,
  ChatMessageRepo,
  ProjectRepo,
  TaskRepo,
  RunRepo,
  ProfileRepo,
  QuotaMarkRepo,
  QuotaUsageRepo,
  EventRepo,
  ChatSessionRow,
  ChatRetryRepo,
  ChatRetryRow,
  KnowledgeRepo,
} from '../db/index.js';
import { PermissionBroker, canAlwaysAllowCommand, commandPermissionLabel } from './permissions.js';
import { EventBus } from '../scheduler/index.js';
import { HttpError } from '../services/index.js';
import { isProfileLoggedIn, resolveClaudeProfile, resolveCodexProfile } from '../profiles/index.js';
import { detectClaudeQuota, ParsedStreamEvent, StreamChunkParser, AssistantUsage, ClaudeQuotaSignal } from './parse.js';
import { ClaudeFailoverState, ClaudeFallbackStep } from './failover.js';
import { decodeCursor } from '../pagination.js';
import { findClaudeBin,
  checkClaudePartialSupport,
  checkClaudeStreamJsonSupport,
  ensureChatMcpConfig,
  chatMcpConfigPath,
  buildClaudeArgs,
  spawnClaude,
  killProcessGroup,
  interruptProcess,
  streamJsonMessage,
  buildHubSnapshot,
  readHubSnapshotFiles,
  FORK_SUMMARY_PROMPT,
  buildAssistantPrompt,
  buildBrainPrompt,
} from './claude.js';
import { findProjectRoot } from '../cli.js';
import { readCodexRateLimits } from '../quota/codex-usage.js';
import { buildProjectKnowledgeContext } from '../projects/knowledge-context.js';
import { projectSettings } from '../projects/settings.js';
import { effectiveBrainCodexProfile, effectiveBrainEngine } from '../brain/engine.js';
import { effectiveBrainPermission } from '../brain/mode.js';
import { CodexEngine } from '../engines/index.js';

async function setBrainActivity(activity: 'talking' | 'idle'): Promise<void> {
  try {
    const brainModulePath = '../brain.js';
    const brainModule = (await import(brainModulePath)) as { setActivity?: (act: string) => void };
    if (brainModule && typeof brainModule.setActivity === 'function') {
      brainModule.setActivity(activity);
    }
  } catch {
    // ignore if brain module does not exist
  }

}

export interface QueuedTurn {
  sessionId: string;
  messageId: string;
  text: string;
  projectId: string | null;
  mode: 'safe' | 'full';
  claudeSessionId: string | null;
  model: string;
  profileName: string | null;
}

export interface RunningTurn {
  sessionId: string;
  messageId: string;
  child: ChildProcess;
  timeoutTimer: NodeJS.Timeout;
  cancelled: boolean;
  persistent?: boolean;
  cancelTimer?: NodeJS.Timeout;
  idleTimer?: NodeJS.Timeout;
  waitingPermission?: boolean;
  pendingToolUse?: boolean;
  isCompact?: boolean;
  isForkSummary?: boolean;
  accumulatedText?: string;
  toolExecutions?: Map<string, { messageId: string; startedAt: number; name: string; summary: string; input?: Record<string, unknown> }>;
  onFinish?: (err?: Error, result?: { contextTokens?: number; summary?: string }) => void;
}

const TOOL_OUTPUT_LIMIT = 4096;
const SECRET_TOOL_PATH = /(?:^|[\\/\s'"])(?:auth\.json|\.?credentials?\.json|[^\\/\s'"]*token[^\\/\s'"]*\.json|keyring[^\\/\s'"]*|\.env(?:\.[^\\/\s'"]+)?)(?=$|[\\/\s'"])/i;
const SECRET_TOOL_DIRECTORY = /(?:~?[\\/]\.codex(?:[\\/]|$)|~?[\\/]\.agy-homes(?:[\\/]|$))/i;

function isSecretToolInput(input?: Record<string, unknown>): boolean {
  if (!input) return false;
  const values = ['file_path', 'path', 'file', 'cwd', 'command']
    .map((key) => input[key])
    .filter((value): value is string => typeof value === 'string');
  return values.some((value) => SECRET_TOOL_PATH.test(value) || SECRET_TOOL_DIRECTORY.test(value));
}

function boundedToolOutput(output: string | undefined, input?: Record<string, unknown>): string | undefined {
  if (output === undefined || isSecretToolInput(input)) return undefined;
  return output.length > TOOL_OUTPUT_LIMIT ? `${output.slice(0, TOOL_OUTPUT_LIMIT)}\n…` : output;
}

function boundedToolInput(input: Record<string, unknown>): Record<string, unknown> {
  const sanitized = isSecretToolInput(input)
    ? Object.fromEntries(Object.entries(input).map(([key, value]) => (
      ['content', 'new_string', 'old_string'].includes(key) && typeof value === 'string'
        ? [key, '[đã ẩn]']
        : [key, value]
    )))
    : input;
  const compact = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return value.length > 2000 ? `${value.slice(0, 2000)}\n…` : value;
    }
    if (Array.isArray(value)) return value.map(compact);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, compact(child)]));
    }
    return value;
  };
  const compacted = compact(sanitized) as Record<string, unknown>;
  const serialized = JSON.stringify(compacted);
  if (serialized.length <= TOOL_OUTPUT_LIMIT) return compacted;
  return { truncated: true, preview: `${serialized.slice(0, TOOL_OUTPUT_LIMIT - 1)}…` };
}

function toolDiff(name: string, input?: Record<string, unknown>): string | undefined {
  if (!/(?:edit|write|multiedit|notebookedit)/i.test(name) || !input || isSecretToolInput(input)) return undefined;
  const oldText = typeof input.old_string === 'string' ? input.old_string : '';
  const newText = typeof input.new_string === 'string' ? input.new_string : typeof input.content === 'string' ? input.content : '';
  if (!oldText && !newText) return undefined;
  return [
    ...oldText.split('\n').filter(Boolean).map((line) => `- ${line}`),
    ...newText.split('\n').filter(Boolean).map((line) => `+ ${line}`),
  ].join('\n');
}

interface PersistentProcess {
  sessionId: string;
  child: ChildProcess;
  parser: StreamChunkParser;
  active?: RunningTurn;
  idleTimer?: NodeJS.Timeout;
  lastUsedAt: number;
  model: string;
  profileName: string | null;
  stderrOutput: string;
  lastAssistantUsage?: AssistantUsage;
  limitResetSeconds?: number;
}

interface WaitingUserMessage {
  text: string;
  userMessageId: string;
  assistantMessageId: string;
}

const MAX_WAITING_USER_MESSAGES = 10;

export class ChatService {
  private stopped = false;
  private queue: QueuedTurn[] = [];
  /** Messages people sent while the session was busy, delivered in order after the current turn. */
  private waitingUserMessages = new Map<string, WaitingUserMessage[]>();
  private drainTimers = new Map<string, NodeJS.Timeout>();
  private delayedQueueTimer?: NodeJS.Timeout;
  private runningTurns = new Map<string, RunningTurn>();
  private lastEngines = new Map<string, 'claude' | 'codex'>();
  private forceClaude = new Set<string>();
  private claudeBinOverride?: string;
  private codexBinOverride?: string;
  private persistentProcesses = new Map<string, PersistentProcess>();
  private snapshotAt = new Map<string, number>();
  private snapshotEventAt = new Map<string, number>();
  private retryTimers = new Map<string, NodeJS.Timeout>();
  private telegramChatBySession = new Map<string, number>();
  private earlyRetryAt = new Map<string, number>();
  private lastClaudeQuotaEventUntil?: number;

  constructor(
    public config: AgentHubConfig,
    public chatSessionRepo: ChatSessionRepo,
    public chatMessageRepo: ChatMessageRepo,
    public permissionBroker: PermissionBroker,
    public projectRepo: ProjectRepo,
    public eventBus: EventBus,
    public taskRepo?: TaskRepo,
    public runRepo?: RunRepo,
    public profileRepo?: ProfileRepo,
    public quotaMarkRepo?: QuotaMarkRepo,
    public quotaUsageRepo?: QuotaUsageRepo,
    public eventRepo?: EventRepo,
    options?: { claudeBin?: string; codexBin?: string; failoverState?: ClaudeFailoverState; retryRepo?: ChatRetryRepo; knowledgeRepo?: KnowledgeRepo },
  ) {
    if (options?.claudeBin) {
      this.claudeBinOverride = options.claudeBin;
    }
    if (options?.codexBin) {
      this.codexBinOverride = options.codexBin;
    }
    this.failoverState = options?.failoverState || new ClaudeFailoverState(path.join(config.hubHome, 'claude-failover.json'));
    // Daemon khởi động lại thì reset busy=0 cho mọi phiên
    this.chatSessionRepo.resetAllBusy();
    this.retryRepo = options?.retryRepo;
    this.knowledgeRepo = options?.knowledgeRepo;
    for (const retry of this.retryRepo?.getPending() || []) this.armRetry(retry);
  }

  private failoverState: ClaudeFailoverState;
  private retryRepo?: ChatRetryRepo;
  private knowledgeRepo?: KnowledgeRepo;

  private assistantPrompt(session: ChatSessionRow): string {
    const project = session.projectId ? this.projectRepo.get(session.projectId) : undefined;
    const context = project && this.knowledgeRepo
      ? buildProjectKnowledgeContext(this.knowledgeRepo.getByProject(project.id), projectSettings(project).references, undefined, project.path).text
      : undefined;
    return buildAssistantPrompt(context);
  }

  private hubSnapshot(session: ChatSessionRow, refresh = false): string {
    const project = session.projectId ? this.projectRepo.get(session.projectId) : undefined;
    const now = Date.now();
    const previousEvent = this.snapshotEventAt.get(session.id) || 0;
    const updates = refresh && this.eventRepo
      ? this.eventRepo.getSince(previousEvent).slice(-8).map((event) => event.type + (event.taskId ? ` ${event.taskId}` : '')).join(', ')
      : '';
    const files = project ? readHubSnapshotFiles(project.path) : {};
    this.snapshotAt.set(session.id, now);
    if (this.eventRepo) this.snapshotEventAt.set(session.id, this.eventRepo.getRecent(1)[0]?.id || previousEvent);
    return buildHubSnapshot({
      projects: this.projectRepo.getAll().map(({ id, name, path: projectPath, defaultBranch }) => ({ id, name, path: projectPath, defaultBranch })),
      tasks: this.taskRepo?.getAll().map(({ id, projectId, title, status }) => ({ id, projectId, title, status })) || [],
      runs: this.runRepo?.getRunning().map(({ taskId, model, outcome }) => ({ taskId, model, outcome })) || [],
      profiles: this.profileRepo?.getAll().filter((profile) => Boolean(profile.enabled)).map(({ name, engine, email, authState, enabled }) => ({ name, engine, email, authState, enabled })) || [],
      quotaUsage: this.quotaUsageRepo?.getAll() || [],
      quotaMarks: this.quotaMarkRepo?.getAll() || [],
      currentProject: project ? { id: project.id, path: project.path } : null,
      ...files,
      capturedAt: new Date(now).toISOString(),
      eventUpdate: updates,
    });
  }

  getClaudeFailover(): ReturnType<ClaudeFailoverState['snapshot']> {
    return this.failoverState.snapshot();
  }

  clearClaudeFailover(): ReturnType<ClaudeFailoverState['snapshot']> {
    this.failoverState.clear();
    this.eventBus.emit('claude.failover_cleared', undefined, { reason: 'manual' });
    return this.failoverState.snapshot();
  }

  getClaudeApiKeyStatus(): { configured: boolean } {
    return { configured: this.failoverState.snapshot().apiKeyConfigured };
  }

  setClaudeApiKey(value: string): void {
    this.failoverState.setApiKey(value);
  }

  setTelegramChat(sessionId: string, chatId: number): void { this.telegramChatBySession.set(sessionId, chatId); }
  getTelegramChat(sessionId: string): number | undefined { return this.telegramChatBySession.get(sessionId); }

  configureFailoverSteps(steps: ClaudeFallbackStep[]): void {
    this.failoverState.configureSteps(steps);
  }

  listPermissions(sessionId?: string) {
    return this.permissionBroker.listPending(sessionId).map((row) => {
      const session = this.chatSessionRepo.get(row.sessionId);
      const project = session?.projectId ? this.projectRepo.get(session.projectId) : undefined;
      const input = JSON.parse(row.input) as Record<string, unknown>;
      return {
        ...row,
        input,
        sessionTitle: session?.title || null,
        projectName: project?.name || null,
        permissionLabel: typeof input.command === 'string' ? commandPermissionLabel(input.command) : row.toolName,
        canAlwaysAllow: session?.kind !== 'assistant' && (typeof input.command !== 'string' || canAlwaysAllowCommand(input.command)),
      };
    });
  }

  listPermissionRules() { return this.permissionBroker.listRules(); }
  pagePermissionRules(options: { limit?: string; cursor?: string }) { return this.permissionBroker.pageRules(options.limit, options.cursor); }

  getPermission(id: string) { return this.permissionBroker.get(id); }

  deletePermissionRule(id: string): { ok: boolean } {
    if (!this.permissionBroker.deleteRule(id)) throw new HttpError(404, 'not_found', 'Quy tắc không tồn tại');
    return { ok: true };
  }

  decidePermission(id: string, decision: 'allow' | 'deny' | 'allow_always', message?: string): { ok: boolean } {
    if (!this.permissionBroker.resolve(id, decision, message)) {
      throw new HttpError(404, 'not_found', 'Yêu cầu cấp quyền không tồn tại hoặc đã được xử lý');
    }
    const request = this.permissionBroker.get(id);
    if (request) {
      this.emitEvent('chat.permission_resolved', {
        id,
        sessionId: request.sessionId,
        messageId: request.messageId,
        decision,
        message: message || null,
      });
      this.chatSessionRepo.updateState(request.sessionId, 'running');
    }
    return { ok: true };
  }

  async requestPermission(input: { sessionId: string; messageId?: string | null; toolName: string; input: Record<string, unknown>; kind?: 'brain' | 'user' }) {
    const running = this.runningTurns.get(input.sessionId);
    if (running) {
      running.waitingPermission = true;
      this.pauseTurnWatchdog(running);
    }
    this.setSessionState(input.sessionId, 'waiting_permission');
    const result = await this.permissionBroker.request(input);
    if (running && this.runningTurns.get(input.sessionId) === running && !running.cancelled) {
      running.waitingPermission = false;
      this.resetTurnWatchdog(running);
    }
    const latest = this.permissionBroker.getLatest(input.sessionId, input.messageId, input.toolName);
    if (latest) this.emitEvent('chat.permission_resolved', { id: latest.id, sessionId: input.sessionId, decision: latest.status });
    if (this.chatSessionRepo.get(input.sessionId)?.state === 'waiting_permission') {
      this.setSessionState(input.sessionId, 'running');
    }
    return result;
  }

  private recordClaudeQuota(streamText: string, stderr: string, exitCode?: number | null): ClaudeQuotaSignal {
    const result = detectClaudeQuota({ streamText, stderr, exitCode });
    if (!result.exhausted) return result;
    const snapshot = this.failoverState.snapshot().active
      ? this.failoverState.advance('claude_usage_limit')
      : this.failoverState.activate(result.resetSeconds || this.config.reviewer.failoverSec, 'claude_usage_limit');
    if (snapshot.until === null || this.lastClaudeQuotaEventUntil === undefined || snapshot.until - this.lastClaudeQuotaEventUntil > 10 * 60) {
      if (snapshot.until !== null) this.lastClaudeQuotaEventUntil = snapshot.until;
      this.eventBus.emit('claude.quota_exhausted', undefined, {
        until: snapshot.until,
        reason: snapshot.reason,
        fallbackAvailable: snapshot.step !== null && snapshot.step.type !== 'wait',
      });
    }
    this.eventBus.emit('claude.fallback_changed', undefined, { step: snapshot.step, reason: snapshot.reason, resetAt: snapshot.resetAt });
    this.eventBus.emit('claude.failover_enabled', undefined, { until: snapshot.until, step: snapshot.step });
    return result;
  }

  private shouldRetryLimit(): boolean {
    const snapshot = this.failoverState.snapshot();
    return !snapshot.active || snapshot.step?.type === 'wait';
  }

  private scheduleLimitRetry(turn: QueuedTurn, resetSeconds?: number, message?: string): boolean {
    if (!this.retryRepo || !this.shouldRetryLimit()) return false;
    const existing = this.retryRepo.get(turn.messageId);
    const attempts = existing?.attempts || 0;
    if (attempts >= 6) {
      this.retryRepo.markFailed(turn.messageId);
      return false;
    }
    const resetAt = Math.floor(Date.now() / 1000) + (resetSeconds || 5 * 3600);
    if (existing) this.retryRepo.defer(turn.messageId, resetAt);
    else this.retryRepo.insert({ sessionId: turn.sessionId, messageId: turn.messageId, text: turn.text, resetAt });
    this.chatSessionRepo.setWaitingLimit(turn.sessionId, resetAt);
    this.emitEvent('chat.error', { sessionId: turn.sessionId, messageId: turn.messageId, message: message || 'Claude đã chạm giới hạn sử dụng', pendingRetry: true, resetAt });
    this.emitEvent('chat.limit_waiting', { sessionId: turn.sessionId, messageId: turn.messageId, resetAt, attempts });
    this.armRetry(this.retryRepo.get(turn.messageId)!);
    return true;
  }

  private armRetry(retry: ChatRetryRow): void {
    const old = this.retryTimers.get(retry.messageId);
    if (old) clearTimeout(old);
    const delay = Math.max(0, retry.resetAt * 1000 + 60_000 - Date.now());
    const timer = setTimeout(() => this.runRetry(retry.messageId), delay);
    timer.unref?.();
    this.retryTimers.set(retry.messageId, timer);
  }

  private runRetry(messageId: string): void {
    if (this.stopped) return;
    const retry = this.retryRepo?.get(messageId);
    if (!retry || retry.status !== 'pending') return;
    if (retry.attempts >= 6) { this.retryRepo?.markFailed(messageId); return; }
    this.retryRepo?.markSent(messageId);
    this.chatSessionRepo.clearWaitingLimit(retry.sessionId);
    const session = this.chatSessionRepo.get(retry.sessionId);
    if (!session) return;
    this.queue.push({ sessionId: retry.sessionId, messageId: retry.messageId, text: retry.text, projectId: session.projectId, mode: session.mode, claudeSessionId: session.claudeSessionId, model: session.model, profileName: session.profileName });
    this.chatSessionRepo.setBusy(retry.sessionId, 1);
    this.setSessionState(retry.sessionId, 'running');
    this.processQueue();
  }

  cancelLimitRetry(sessionId: string): { ok: boolean } {
    const retry = this.retryRepo?.getPending().find((item) => item.sessionId === sessionId);
    if (!retry) return { ok: false };
    const timer = this.retryTimers.get(retry.messageId); if (timer) clearTimeout(timer);
    this.retryTimers.delete(retry.messageId);
    this.retryRepo?.markCancelled(retry.messageId);
    this.chatSessionRepo.clearWaitingLimit(sessionId);
    this.emitEvent('chat.limit_cancelled', { sessionId, messageId: retry.messageId });
    return { ok: true };
  }

  retryLimitNow(sessionId: string): { ok: boolean } {
    const retry = this.retryRepo?.getPending().find((item) => item.sessionId === sessionId);
    if (!retry) return { ok: false };
    this.retryRepo?.defer(retry.messageId, Math.floor(Date.now() / 1000) - 1);
    this.runRetry(retry.messageId);
    return { ok: true };
  }

  retryWaitingForProfile(profileName: string): number {
    const now = Date.now();
    let retried = 0;
    for (const retry of this.retryRepo?.getPending() || []) {
      const session = this.chatSessionRepo.get(retry.sessionId);
      if (!session || session.profileName !== profileName) continue;
      const last = this.earlyRetryAt.get(retry.sessionId) || 0;
      if (now - last < 15 * 60_000) continue;
      this.earlyRetryAt.set(retry.sessionId, now);
      if (this.retryLimitNow(retry.sessionId).ok) retried++;
    }
    return retried;
  }

  private failoverExecution(turn: QueuedTurn): { engine: 'claude' | 'codex'; model: string; profileName: string | null; env?: Record<string, string>; pausedUntil?: number } {
    const snapshot = this.failoverState.snapshot();
    const step = snapshot.active ? snapshot.step : null;
    const session = this.chatSessionRepo.get(turn.sessionId);
    const project = turn.projectId ? this.projectRepo.get(turn.projectId) : undefined;
    if (this.forceClaude.delete(turn.sessionId)) {
      return {
        engine: 'claude',
        model: turn.model,
        profileName: resolveClaudeProfile(this.profileRepo || { getAll: () => [] }, this.config.chat.claudeProfile, this.config.chat.claudeProfileExplicit),
      };
    }
    // BrainRunner pins the effective department Codex profile on the session. Keep
    // that choice when the common runner handles the turn; otherwise a department
    // Brain would silently fall back to the global Claude engine/profile.
    const sessionProfile = session?.profileName ? this.profileRepo?.get(session.profileName) : undefined;
    const requestedEngine = session?.kind === 'brain'
      ? sessionProfile?.engine === 'codex' ? 'codex' : effectiveBrainEngine(project, this.config.brain)
      : 'claude';
    const selectCodex = (configured?: string): string | null => {
      return resolveCodexProfile(
        this.profileRepo || { getAll: () => [] },
        configured || effectiveBrainCodexProfile(project, this.config.brain),
        this.quotaUsageRepo,
        this.quotaMarkRepo,
      );
    };
    const codex = (model?: string, profile?: string): { engine: 'codex'; model: string; profileName: string } | null => {
      const name = selectCodex(profile || (sessionProfile?.engine === 'codex' ? sessionProfile.name : undefined) || this.config.brain.codexProfile);
      if (!name) return null;
      return { engine: 'codex', model: model || this.config.brain.codexModel || turn.model || 'gpt-5.6-luna', profileName: name };
    };
    if (!step) {
      if (requestedEngine === 'codex') {
        const selected = codex();
        if (selected) return selected;
        this.eventBus.emit('claude.fallback_changed', undefined, { reason: 'codex_unavailable', step: null });
      }
      return { engine: 'claude', model: turn.model, profileName: turn.profileName };
    }
    if (step.type === 'wait') return { engine: 'claude', model: turn.model, profileName: turn.profileName, pausedUntil: snapshot.until || undefined };
    if (step.type === 'model') return { engine: 'claude', model: step.model, profileName: turn.profileName };
    if (step.type === 'engine') {
      const selected = codex();
      if (selected) return selected;
      const next = this.failoverState.advance('codex_unavailable');
      this.eventBus.emit('claude.fallback_changed', undefined, { step: next.step, reason: next.reason, resetAt: next.resetAt });
      return this.failoverExecution(turn);
    }
    if (step.type === 'profile') {
      const selected = step.profile
        ? this.profileRepo?.getEnabled().find((profile) => profile.engine === 'claude' && profile.name === step.profile && profile.name !== turn.profileName && isProfileLoggedIn(profile))?.name
        : this.profileRepo?.getEnabled().find((profile) => profile.engine === 'claude' && profile.name !== turn.profileName && isProfileLoggedIn(profile))?.name;
      if (selected) return { engine: 'claude', model: turn.model, profileName: selected };
      const next = this.failoverState.advance('profile_unavailable');
      this.eventBus.emit('claude.fallback_changed', undefined, { step: next.step, reason: next.reason, resetAt: next.resetAt });
      return this.failoverExecution(turn);
    }
    if (step.type === 'apiKey') {
      const key = this.failoverState.getApiKey();
      if (key && snapshot.dailyCostUSD < step.dailyCapUSD) return { engine: 'claude', model: turn.model, profileName: turn.profileName, env: { ANTHROPIC_API_KEY: key } };
      const next = this.failoverState.advance(key ? 'daily_cap_reached' : 'api_key_unconfigured');
      this.eventBus.emit('claude.fallback_changed', undefined, { step: next.step, reason: next.reason, resetAt: next.resetAt, dailyCostUSD: next.dailyCostUSD });
      return this.failoverExecution(turn);
    }
    return { engine: 'claude', model: turn.model, profileName: turn.profileName };
  }

  setClaudeBinOverride(bin?: string): void {
    this.claudeBinOverride = bin;
  }

  setCodexBinOverride(bin?: string): void {
    this.codexBinOverride = bin;
  }

  getLastEngine(sessionId: string): 'claude' | 'codex' | undefined {
    return this.lastEngines.get(sessionId);
  }

  getRunningPids(): number[] {
    const pids: number[] = [];
    for (const turn of this.runningTurns.values()) {
      if (turn.child.pid) pids.push(turn.child.pid);
    }
    for (const proc of this.persistentProcesses.values()) {
      if (proc.child.pid) pids.push(proc.child.pid);
    }
    return pids;
  }

  stop(): void {
    this.stopped = true;
    for (const turn of this.runningTurns.values()) {
      clearTimeout(turn.timeoutTimer);
      if (turn.idleTimer) clearTimeout(turn.idleTimer);
      if (turn.cancelTimer) clearTimeout(turn.cancelTimer);
      turn.cancelled = true;
      if (turn.child.stdout) {
        turn.child.stdout.removeAllListeners();
        turn.child.stdout.destroy();
      }
      if (turn.child.stderr) {
        turn.child.stderr.removeAllListeners();
        turn.child.stderr.destroy();
      }
      turn.child.removeAllListeners();
      if (turn.child.pid) {
        killProcessGroup(turn.child.pid);
      }
    }
    this.runningTurns.clear();
    for (const proc of this.persistentProcesses.values()) {
      if (proc.idleTimer) clearTimeout(proc.idleTimer);
      if (proc.active?.timeoutTimer) clearTimeout(proc.active.timeoutTimer);
      if (proc.active?.idleTimer) clearTimeout(proc.active.idleTimer);
      if (proc.active?.cancelTimer) clearTimeout(proc.active.cancelTimer);
      if (proc.active) proc.active.cancelled = true;
      if (proc.child.stdout) {
        proc.child.stdout.removeAllListeners();
        proc.child.stdout.destroy();
      }
      if (proc.child.stderr) {
        proc.child.stderr.removeAllListeners();
        proc.child.stderr.destroy();
      }
      proc.child.removeAllListeners();
      if (proc.child.pid) killProcessGroup(proc.child.pid);
    }
    this.persistentProcesses.clear();
    for (const timer of this.retryTimers.values()) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();
    for (const timer of this.drainTimers.values()) {
      clearTimeout(timer);
    }
    this.drainTimers.clear();
    if (this.delayedQueueTimer) {
      clearTimeout(this.delayedQueueTimer);
      this.delayedQueueTimer = undefined;
    }
    this.waitingUserMessages.clear();
    this.queue = [];
  }

  listSessions(options?: { search?: string; archived?: string | number | boolean }): Array<{
    id: string;
    projectId: string | null;
    title: string | null;
    mode: 'safe' | 'full';
    model: string;
    profileName: string | null;
    busy: number;
    state: ChatSessionRow['state'];
    pinned: number;
    archived: number;
    lastMessageAt: string | null;
    inputTokens: number;
    outputTokens: number;
    contextTokens: number;
    createdAt: string;
    updatedAt: string;
    lastMessage?: {
      id: string;
      role: string;
      content: string;
      createdAt: string;
    };
  }> {
    const search = options?.search?.trim();
    const archivedParam = options?.archived;
    const archivedFilter: number | null =
      archivedParam === 'all'
        ? null
        : archivedParam === '1' || archivedParam === 1 || archivedParam === true
        ? 1
        : 0;

    const sessions = search
      ? this.chatSessionRepo.search(search, { archived: archivedFilter })
      : this.chatSessionRepo.getAll({ archived: archivedFilter });
    return sessions.map((s) => {
      const last = this.chatMessageRepo.getLastBySession(s.id);
      const res: {
        id: string;
        projectId: string | null;
        title: string | null;
        mode: 'safe' | 'full';
        model: string;
        profileName: string | null;
        busy: number;
        state: ChatSessionRow['state'];
        pinned: number;
        archived: number;
        lastMessageAt: string | null;
        inputTokens: number;
        outputTokens: number;
        contextTokens: number;
        createdAt: string;
        updatedAt: string;
        kind: ChatSessionRow['kind'];
        lastMessage?: {
          id: string;
          role: string;
          content: string;
          createdAt: string;
        };
      } = {
        id: s.id,
        projectId: s.projectId,
        title: s.title,
        mode: s.mode,
        model: s.model,
        profileName: s.profileName,
        busy: s.busy,
        state: s.state || 'idle',
        pinned: s.pinned ?? 0,
        archived: s.archived ?? 0,
        lastMessageAt: s.lastMessageAt ?? last?.createdAt ?? null,
        inputTokens: s.inputTokens ?? 0,
        outputTokens: s.outputTokens ?? 0,
        contextTokens: s.contextTokens ?? 0,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        kind: s.kind,
      };
      if (last) {
        res.lastMessage = {
          id: last.id,
          role: last.role,
          content: last.content,
          createdAt: last.createdAt,
        };
      }
      return res;
    });
  }

  pageSessions(options?: { search?: string; archived?: string | number | boolean; limit?: string | number; cursor?: string }) {
    const archivedParam = options?.archived;
    const archivedFilter: number | null = archivedParam === 'all' ? null : archivedParam === '1' || archivedParam === 1 || archivedParam === true ? 1 : 0;
    const page = this.chatSessionRepo.page({ search: options?.search, archived: archivedFilter, limit: options?.limit, cursor: options?.cursor });
    const mapped = this.listSessions({ search: options?.search, archived: options?.archived });
    return { ...page, items: page.items.map((s) => mapped.find((item) => item.id === s.id)!).filter(Boolean) };
  }

  createSession(body: {
    projectId?: string | null;
    title?: string | null;
    mode?: 'safe' | 'full';
    model?: string;
    profileName?: string | null;
    kind?: 'chat' | 'brain' | 'assistant';
  }): ChatSessionRow {
    const { mode, model } = this.validateSessionOptions(body);

    const id = crypto.randomUUID();
    const title = body.title && body.title.trim().length > 0 ? body.title.trim() : 'Cuộc trò chuyện mới';

    this.chatSessionRepo.insert({
      id,
      projectId: body.projectId || null,
      title,
      mode,
      model,
      busy: 0,
      profileName: body.profileName ?? resolveClaudeProfile(
        this.profileRepo || { getAll: () => [] },
        this.config.chat.claudeProfile,
        this.config.chat.claudeProfileExplicit,
      ),
      kind: body.kind,
    });

    const session = this.chatSessionRepo.get(id)!;
    if (body.profileName && session.profileName && this.profileRepo && !this.profileRepo.get(session.profileName)) {
      throw new HttpError(400, 'bad_request', `Hồ sơ Claude "${session.profileName}" không tồn tại`);
    }
    return session;
  }

  getOrCreateSession(id: string, body: {
    title?: string | null;
    projectId?: string | null;
    mode?: 'safe' | 'full';
    model?: string;
    profileName?: string | null;
    kind?: 'chat' | 'brain' | 'assistant';
  }): ChatSessionRow {
    const existing = this.chatSessionRepo.get(id);
    if (existing) return existing;
    const { mode, model } = this.validateSessionOptions(body);
    this.chatSessionRepo.insert({
      id,
      projectId: body.projectId || null,
      title: body.title || 'Cuộc trò chuyện Telegram',
      mode,
      model,
      busy: 0,
      profileName: body.profileName ?? resolveClaudeProfile(
        this.profileRepo || { getAll: () => [] },
        this.config.chat.claudeProfile,
        this.config.chat.claudeProfileExplicit,
      ),
      kind: body.kind,
    });
    return this.chatSessionRepo.get(id)!;
  }

  /** Apply a changed brain permission on the next turn. Running processes are closed safely. */
  setSessionMode(id: string, mode: 'safe' | 'full'): ChatSessionRow {
    const session = this.chatSessionRepo.get(id);
    if (!session) throw new HttpError(404, 'not_found', `Phiên trò chuyện "${id}" không tồn tại`);
    if (session.mode === mode) return session;
    if (session.busy === 1 || this.runningTurns.has(id)) throw new HttpError(409, 'conflict', 'Không thể đổi quyền khi brain đang chạy');
    const proc = this.persistentProcesses.get(id);
    if (proc) this.closePersistentProcess(proc);
    this.chatSessionRepo.updateMode(id, mode);
    return this.chatSessionRepo.get(id)!;
  }

  private validateSessionOptions(body: {
    mode?: 'safe' | 'full';
    model?: string;
    kind?: 'chat' | 'brain' | 'assistant';
  }): { mode: 'safe' | 'full'; model: string } {
    const mode = body.mode || 'safe';
    const fullAllowed = body.kind === 'brain' || (body.kind === 'assistant' && this.config.assistant?.permissions === 'full') || this.config.chat?.allowFullMode === true;
    if (mode === 'full' && !fullAllowed) {
      throw new HttpError(403, 'forbidden', 'Chế độ full chưa được cho phép trong cấu hình');
    }
    const model = body.model ?? this.config.chat.model;
    const allowedModels = new Set(['', ...(this.config.chat.models || ['opus', 'sonnet', 'haiku']), this.config.chat.model]);
    if (!allowedModels.has(model)) {
      throw new HttpError(400, 'bad_request', 'Model chat phải là mặc định, sonnet hoặc haiku');
    }
    return { mode, model };
  }

  updateSession(
    id: string,
    body: {
      title?: string;
      pinned?: boolean | number;
      archived?: boolean | number;
      model?: string;
    },
  ): ChatSessionRow {
    const session = this.chatSessionRepo.get(id);
    if (!session) {
      throw new HttpError(404, 'not_found', `Phiên trò chuyện "${id}" không tồn tại`);
    }

    if (body.model !== undefined) {
      const { model } = this.validateSessionOptions({ model: body.model });
      if (session.busy === 1 || this.runningTurns.has(id)) {
        throw new HttpError(409, 'conflict', 'Hãy đợi lượt chat hiện tại kết thúc trước khi đổi model');
      }
      const proc = this.persistentProcesses.get(id);
      if (proc) this.closePersistentProcess(proc);
      this.chatSessionRepo.updateModel(id, model);
    }

    if (body.title !== undefined) {
      this.chatSessionRepo.updateTitle(id, body.title);
    }
    if (body.pinned !== undefined) {
      this.chatSessionRepo.updatePinned(id, body.pinned ? 1 : 0);
    }
    if (body.archived !== undefined) {
      this.chatSessionRepo.updateArchived(id, body.archived ? 1 : 0);
    }

    return this.chatSessionRepo.get(id)!;
  }

  deleteSession(id: string): { ok: boolean } {
    const session = this.chatSessionRepo.get(id);
    if (!session) {
      throw new HttpError(404, 'not_found', `Phiên trò chuyện "${id}" không tồn tại`);
    }

    if (session.busy === 1 || this.runningTurns.has(id)) {
      throw new HttpError(409, 'conflict', 'Không thể xóa phiên đang bận');
    }

    // Close persistent process if any
    const proc = this.persistentProcesses.get(id);
    if (proc) {
      this.closePersistentProcess(proc);
    }

    // Remove from queue if any
    this.queue = this.queue.filter((t) => t.sessionId !== id);
    this.removeChatMcpConfig(id);
    this.chatSessionRepo.delete(id);
    return { ok: true };
  }

  listMessages(
    sessionId: string,
    optionsOrLimit?: number | { limit?: number; before?: string },
  ): {
    messages: Array<{
      id: string;
      sessionId: string;
      role: string;
      content: string;
      meta: unknown;
      createdAt: string;
    }>;
    hasMore: boolean;
  } {
    const session = this.chatSessionRepo.get(sessionId);
    if (!session) {
      throw new HttpError(404, 'not_found', `Phiên trò chuyện "${sessionId}" không tồn tại`);
    }

    const limit = typeof optionsOrLimit === 'number'
      ? optionsOrLimit
      : optionsOrLimit?.limit ?? 50;
    const before = typeof optionsOrLimit === 'object'
      ? optionsOrLimit?.before
      : undefined;
    const safeLimit = isNaN(limit) || limit <= 0 ? 50 : limit;

    const { messages, hasMore } = this.chatMessageRepo.getPaginated(sessionId, before, safeLimit);

    return {
      messages: messages.map((m) => {
        let parsedMeta: unknown = null;
        if (m.meta) {
          try {
            parsedMeta = JSON.parse(m.meta);
          } catch {
            parsedMeta = m.meta;
          }
        }
        return {
          id: m.id,
          sessionId: m.sessionId,
          role: m.role,
          content: m.content,
          meta: parsedMeta,
          createdAt: m.createdAt,
        };
      }),
      hasMore,
    };
  }

  exportSession(sessionId: string): string {
    const session = this.chatSessionRepo.get(sessionId);
    if (!session) {
      throw new HttpError(404, 'not_found', `Phiên trò chuyện "${sessionId}" không tồn tại`);
    }

    const messages = this.chatMessageRepo.getBySession(sessionId, 100000);
    const lines: string[] = [];
    lines.push(`# ${session.title || 'Cuộc trò chuyện'}\n`);
    lines.push(`- **ID:** \`${session.id}\``);
    lines.push(`- **Mode:** \`${session.mode}\``);
    if (session.model) {
      lines.push(`- **Model:** \`${session.model}\``);
    }
    lines.push(`- **Created:** ${session.createdAt}`);
    if (session.inputTokens > 0 || session.outputTokens > 0) {
      lines.push(
        `- **Tokens:** ${session.inputTokens} input, ${session.outputTokens} output (${session.contextTokens} context)`,
      );
    }
    lines.push('\n---\n');

    for (const msg of messages) {
      let roleLabel = 'User';
      if (msg.role === 'assistant') {
        roleLabel = 'Assistant';
      } else if (msg.role === 'tool') {
        let toolName = '';
        if (msg.meta) {
          try {
            const parsed = JSON.parse(msg.meta);
            if (parsed && typeof parsed.name === 'string') {
              toolName = `: ${parsed.name}`;
            }
          } catch {
            // ignore
          }
        }
        roleLabel = `Tool${toolName}`;
      } else if (msg.role === 'error') {
        roleLabel = 'Error';
      } else if (msg.role === 'system') {
        roleLabel = 'System';
      }

      lines.push(`### ${roleLabel}\n`);
      lines.push(`${msg.content}\n`);
    }

    return lines.join('\n');
  }

  sendMessage(
    sessionId: string,
    text: string,
    opts: {
      queueIfBusy?: boolean;
      fromQueue?: boolean;
      telegramChatId?: number;
      messageIds?: { userMessageId: string; assistantMessageId: string };
    } = {},
  ): { userMessageId: string; assistantMessageId: string; queued?: boolean; position?: number } {
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new HttpError(400, 'bad_request', 'Nội dung tin nhắn không được để trống');
    }
    if (text.length > 20000) {
      throw new HttpError(400, 'bad_request', 'Nội dung tin nhắn tối đa 20.000 ký tự');
    }

    let session = this.chatSessionRepo.get(sessionId);
    if (!session) {
      throw new HttpError(404, 'not_found', `Phiên trò chuyện "${sessionId}" không tồn tại`);
    }
    if (session.kind === 'assistant' && session.busy !== 1 && !this.runningTurns.has(sessionId)) {
      // Follow assistant.permissions on every message, so a config change applies without new sessions.
      const wanted = this.config.assistant?.permissions === 'full' ? 'full' : 'safe';
      if (session.mode !== wanted) session = this.setSessionMode(sessionId, wanted);
    }
    if (opts.telegramChatId !== undefined) this.setTelegramChat(sessionId, opts.telegramChatId);

    const userMessageId = opts.messageIds?.userMessageId || crypto.randomUUID();
    const assistantMessageId = opts.messageIds?.assistantMessageId || crypto.randomUUID();

    if (session.busy === 1 || this.runningTurns.has(sessionId)) {
      // A person writing to a busy session (typically a brain in the middle of an event turn) is
      // queued instead of rejected; the message runs as soon as the current turn finishes.
      if (opts.queueIfBusy) {
        const waiting = this.waitingUserMessages.get(sessionId) ?? [];
        if (waiting.length >= MAX_WAITING_USER_MESSAGES) {
          throw new HttpError(409, 'conflict', 'Phiên đang bận và hàng đợi đã đầy');
        }
        waiting.push({ text, userMessageId, assistantMessageId });
        this.waitingUserMessages.set(sessionId, waiting);
        this.emitEvent('chat.queued', { sessionId, position: waiting.length });
        return { userMessageId, assistantMessageId, queued: true, position: waiting.length };
      }
      throw new HttpError(409, 'conflict', 'Phiên đang bận');
    }

    this.failoverState.noteActivity();

    // Auto set title from first user message (cut to 60 chars) if not yet set
    const isFirstMessage = this.chatMessageRepo.getBySession(sessionId, 1).length === 0;
    const needsTitle = !session.title || session.title.trim() === '' || session.title === 'Cuộc trò chuyện mới';
    if (isFirstMessage && needsTitle) {
      const autoTitle = text.trim().slice(0, 60);
      if (autoTitle) {
        this.chatSessionRepo.updateTitle(sessionId, autoTitle);
        session.title = autoTitle;
      }
    }

    this.chatSessionRepo.touchLastMessage(sessionId);

    // Store user message
    this.chatMessageRepo.insert({
      id: userMessageId,
      sessionId,
      role: 'user',
      content: text,
    });
    this.emitEvent('chat.message', {
      sessionId,
      messageId: userMessageId,
      assistantMessageId,
      role: 'user',
      content: text,
      ...(opts.fromQueue ? { fromQueue: true } : {}),
    });

    // Mark session busy
    this.chatSessionRepo.setBusy(sessionId, 1);
    this.setSessionState(sessionId, 'running');

    // Enqueue turn
    this.enqueueTurn({
      sessionId,
      messageId: assistantMessageId,
      text,
      projectId: session.projectId,
      mode: session.mode,
      claudeSessionId: session.claudeSessionId,
      model: session.model,
      profileName: session.profileName,
    });

    return { userMessageId, assistantMessageId };
  }

  warmSession(sessionId: string): { ok: boolean; warmed: boolean } {
    const session = this.chatSessionRepo.get(sessionId);
    if (!session) throw new HttpError(404, 'not_found', `Phiên trò chuyện "${sessionId}" không tồn tại`);
    const claudeBin = findClaudeBin(this.claudeBinOverride || this.config.chat?.claudeBin);
    if (!claudeBin || !checkClaudeStreamJsonSupport(claudeBin)) return { ok: true, warmed: false };
    return { ok: true, warmed: Boolean(this.ensurePersistentProcess(session, claudeBin)) };
  }

  cancelSession(sessionId: string): { ok: boolean } {
    const session = this.chatSessionRepo.get(sessionId);
    if (!session) {
      throw new HttpError(404, 'not_found', `Phiên trò chuyện "${sessionId}" không tồn tại`);
    }
    // Stopping a session also drops messages queued behind the cancelled turn.
    this.waitingUserMessages.delete(sessionId);

    // Check if in queue
    const queuedIndex = this.queue.findIndex((t) => t.sessionId === sessionId);
    if (queuedIndex >= 0) {
      this.queue.splice(queuedIndex, 1);
      this.chatSessionRepo.setBusy(sessionId, 0);
      this.setSessionState(sessionId, 'idle');
      return { ok: true };
    }

    // Check if running
    const running = this.runningTurns.get(sessionId);
    if (running) {
      running.cancelled = true;
      clearTimeout(running.timeoutTimer);
      if (running.persistent && running.child.pid) {
        interruptProcess(running.child.pid);
        running.cancelTimer = setTimeout(() => {
          if (this.runningTurns.get(sessionId) === running) {
            if (running.child.pid) killProcessGroup(running.child.pid);
            this.runningTurns.delete(sessionId);
            this.chatSessionRepo.setBusy(sessionId, 0);
            this.setSessionState(sessionId, 'idle');
            this.emitChatError(sessionId, running.messageId, 'Đã hủy lượt chat');
            const proc = this.persistentProcesses.get(sessionId);
            if (proc) this.closePersistentProcess(proc);
            this.processQueue();
          }
        }, 3000);
        return { ok: true };
      }
      if (running.child.pid) {
        killProcessGroup(running.child.pid);
      }
      this.runningTurns.delete(sessionId);
      this.chatSessionRepo.setBusy(sessionId, 0);
      this.setSessionState(sessionId, 'idle');
      this.emitChatError(sessionId, running.messageId, 'Đã hủy lượt chat');
      setBrainActivity('idle').catch(() => {});
      this.processQueue();
      return { ok: true };
    }

    // Session not currently running
    this.chatSessionRepo.setBusy(sessionId, 0);
    this.setSessionState(sessionId, 'idle');
    return { ok: true };
  }

  async compactSession(sessionId: string): Promise<{ ok: boolean; contextTokens?: number }> {
    const session = this.chatSessionRepo.get(sessionId);
    if (!session) {
      throw new HttpError(404, 'not_found', `Phiên trò chuyện "${sessionId}" không tồn tại`);
    }

    if (session.busy === 1 || this.runningTurns.has(sessionId)) {
      throw new HttpError(409, 'conflict', 'Phiên đang bận');
    }

    const claudeBin = findClaudeBin(this.claudeBinOverride || this.config.chat?.claudeBin);
    if (!claudeBin) {
      throw new HttpError(500, 'server_error', 'Không tìm thấy lệnh claude trên hệ thống');
    }

    this.chatSessionRepo.setBusy(sessionId, 1);
    this.setSessionState(sessionId, 'running');

    return new Promise<{ ok: boolean; contextTokens?: number }>((resolve, reject) => {
      const isPersistent = checkClaudeStreamJsonSupport(claudeBin);

      if (isPersistent) {
        const proc = this.ensurePersistentProcess(session, claudeBin);
        if (!proc) {
          this.chatSessionRepo.setBusy(sessionId, 0);
          this.setSessionState(sessionId, 'idle');
          return reject(new HttpError(503, 'service_unavailable', 'Không thể khởi động tiến trình Claude'));
        }

        const messageId = crypto.randomUUID();
        const timeoutTimer = setTimeout(() => {
          this.timeoutPersistentTurn(proc);
          reject(new HttpError(504, 'gateway_timeout', 'Lượt nén ngữ cảnh quá thời gian'));
        }, 5 * 60 * 1000);

        const running: RunningTurn = {
          sessionId,
          messageId,
          child: proc.child,
          timeoutTimer,
          cancelled: false,
          persistent: true,
          isCompact: true,
          onFinish: (err, res) => {
            if (err) {
              reject(err);
            } else {
              resolve({ ok: true, contextTokens: res?.contextTokens });
            }
          },
        };

        proc.active = running;
        proc.lastUsedAt = Date.now();
        proc.lastAssistantUsage = undefined;
        this.runningTurns.set(sessionId, running);
        this.armTurnWatchdog(running);

        try {
          proc.child.stdin?.write(streamJsonMessage('/compact'));
        } catch (err) {
          clearTimeout(timeoutTimer);
          this.finishPersistentError(
            proc,
            {
              sessionId,
              messageId,
              text: '/compact',
              projectId: null,
              mode: session.mode,
              claudeSessionId: session.claudeSessionId,
              model: session.model,
              profileName: session.profileName,
            },
            err instanceof Error ? err.message : 'Không thể gửi lệnh /compact',
          );
          reject(err);
        }
      } else {
        // Non-persistent mode fallback
        let cwd = os.homedir();
        if (session.projectId) {
          const project = this.projectRepo.get(session.projectId);
          if (project?.path) cwd = project.path;
        }

        const mcpConfigPath = ensureChatMcpConfig(
          this.config.hubHome,
          sessionId,
          this.config.port,
          this.config.chat.permissionTimeoutSec,
          session.projectId,
          session.kind,
        );
        const args = buildClaudeArgs({ planning: this.config.planning,
          text: '/compact',
          claudeSessionId: session.claudeSessionId,
          mode: session.mode,
          mcpConfigPath,
          model: session.model,
          systemPrompt: session.kind === 'assistant' ? this.assistantPrompt(session) : undefined,
        });

        let child: ChildProcess;
        try {
          child = spawnClaude(claudeBin, args, cwd, '/compact', {
            disableToolSearch: this.config.chat.disableToolSearch,
            chatSessionId: sessionId,
            port: this.config.port,
          });
        } catch (err: unknown) {
          this.chatSessionRepo.setBusy(sessionId, 0);
          this.setSessionState(sessionId, 'idle');
          return reject(err);
        }

        const parser = new StreamChunkParser();
        let lastAssistantUsage: AssistantUsage | undefined;
        let resultUsage:
          | {
              inputTokens: number;
              outputTokens: number;
              cacheReadInputTokens?: number;
              cacheCreationInputTokens?: number;
            }
          | undefined = undefined;

        child.stdout?.on('data', (chunk: Buffer) => {
          if (this.stopped) return;
          for (const ev of parser.feed(chunk)) {
            if (ev.type === 'assistant_text' && ev.usage) {
              lastAssistantUsage = ev.usage;
            } else if (ev.type === 'result') {
              if (ev.usage) resultUsage = ev.usage;
            }
          }
        });

        child.on('close', (code) => {
          if (this.stopped) return;
          this.chatSessionRepo.setBusy(sessionId, 0);
          this.setSessionState(sessionId, 'idle');
          if (code !== 0) {
            return reject(new HttpError(500, 'compact_failed', `Claude process exited with code ${code}`));
          }
          const finalContextTokens = lastAssistantUsage?.contextTokens ?? resultUsage?.inputTokens ?? 0;
          if (resultUsage) {
            this.chatSessionRepo.addUsage(sessionId, {
              ...resultUsage,
              contextTokens: finalContextTokens,
            });
          }
          this.chatMessageRepo.insert({
            id: crypto.randomUUID(),
            sessionId,
            role: 'system',
            content: 'Đã nén ngữ cảnh',
          });
          this.emitEvent('chat.compacted', { sessionId, contextTokens: finalContextTokens });
          resolve({ ok: true, contextTokens: finalContextTokens });
        });
      }
    });
  }

  async forkSummary(sessionId: string): Promise<{ id: string; sessionId: string }> {
    const session = this.chatSessionRepo.get(sessionId);
    if (!session) {
      throw new HttpError(404, 'not_found', `Phiên trò chuyện "${sessionId}" không tồn tại`);
    }

    if (session.busy === 1 || this.runningTurns.has(sessionId)) {
      throw new HttpError(409, 'conflict', 'Phiên đang bận');
    }

    const claudeBin = findClaudeBin(this.claudeBinOverride || this.config.chat?.claudeBin);
    if (!claudeBin) {
      throw new HttpError(500, 'server_error', 'Không tìm thấy lệnh claude trên hệ thống');
    }

    this.chatSessionRepo.setBusy(sessionId, 1);
    this.setSessionState(sessionId, 'running');

    return new Promise<{ id: string; sessionId: string }>((resolve, reject) => {
      const isPersistent = checkClaudeStreamJsonSupport(claudeBin);

      if (isPersistent) {
        const proc = this.ensurePersistentProcess(session, claudeBin);
        if (!proc) {
          this.chatSessionRepo.setBusy(sessionId, 0);
          this.setSessionState(sessionId, 'idle');
          return reject(new HttpError(503, 'service_unavailable', 'Không thể khởi động tiến trình Claude'));
        }

        const messageId = crypto.randomUUID();
        const timeoutTimer = setTimeout(() => {
          this.timeoutPersistentTurn(proc);
          reject(new HttpError(504, 'gateway_timeout', 'Lượt tóm tắt quá thời gian'));
        }, 5 * 60 * 1000);

        const running: RunningTurn = {
          sessionId,
          messageId,
          child: proc.child,
          timeoutTimer,
          cancelled: false,
          persistent: true,
          isForkSummary: true,
          onFinish: (err, res) => {
            if (err) {
              reject(err);
            } else {
              try {
                const summaryText = res?.summary || 'Bản tóm tắt phiên trò chuyện.';
                const newSession = this.createSession({
                  projectId: session.projectId,
                  title: session.title ? `${session.title} (tóm tắt)` : 'Phiên mới (tóm tắt)',
                  mode: session.mode,
                  model: session.model,
                  profileName: (session.profileName && this.profileRepo?.get(session.profileName)) ? session.profileName : undefined,
                });

                this.chatMessageRepo.insert({
                  id: crypto.randomUUID(),
                  sessionId: newSession.id,
                  role: 'user',
                  content: summaryText,
                });
                this.chatSessionRepo.touchLastMessage(newSession.id);

                resolve({ id: newSession.id, sessionId: newSession.id });
              } catch (createErr) {
                reject(createErr);
              }
            }
          },
        };

        proc.active = running;
        proc.lastUsedAt = Date.now();
        proc.lastAssistantUsage = undefined;
        this.runningTurns.set(sessionId, running);
        this.armTurnWatchdog(running);

        try {
          proc.child.stdin?.write(streamJsonMessage(FORK_SUMMARY_PROMPT));
        } catch (err) {
          clearTimeout(timeoutTimer);
          this.finishPersistentError(
            proc,
            {
              sessionId,
              messageId,
              text: FORK_SUMMARY_PROMPT,
              projectId: null,
              mode: session.mode,
              claudeSessionId: session.claudeSessionId,
              model: session.model,
              profileName: session.profileName,
            },
            err instanceof Error ? err.message : 'Không thể gửi lệnh tóm tắt',
          );
          reject(err);
        }
      } else {
        // Non-persistent mode fallback
        let cwd = os.homedir();
        if (session.projectId) {
          const project = this.projectRepo.get(session.projectId);
          if (project?.path) cwd = project.path;
        }

        const mcpConfigPath = ensureChatMcpConfig(
          this.config.hubHome,
          sessionId,
          this.config.port,
          this.config.chat.permissionTimeoutSec,
          session.projectId,
          session.kind,
        );
        const args = buildClaudeArgs({ planning: this.config.planning,
          text: FORK_SUMMARY_PROMPT,
          claudeSessionId: session.claudeSessionId,
          mode: session.mode,
          mcpConfigPath,
          model: session.model,
          systemPrompt: session.kind === 'assistant' ? this.assistantPrompt(session) : undefined,
        });

        let child: ChildProcess;
        try {
          child = spawnClaude(claudeBin, args, cwd, FORK_SUMMARY_PROMPT, {
            disableToolSearch: this.config.chat.disableToolSearch,
            chatSessionId: sessionId,
            port: this.config.port,
          });
        } catch (err: unknown) {
          this.chatSessionRepo.setBusy(sessionId, 0);
          this.setSessionState(sessionId, 'idle');
          return reject(err);
        }

        const parser = new StreamChunkParser();
        let summaryResult = '';

        child.stdout?.on('data', (chunk: Buffer) => {
          if (this.stopped) return;
          for (const ev of parser.feed(chunk)) {
            if (ev.type === 'assistant_text' && ev.text) {
              summaryResult += ev.text;
            } else if (ev.type === 'text_delta') {
              summaryResult += ev.text;
            } else if (ev.type === 'result' && ev.result) {
              summaryResult = ev.result;
            }
          }
        });

        child.on('close', (code) => {
          if (this.stopped) return;
          this.chatSessionRepo.setBusy(sessionId, 0);
          this.setSessionState(sessionId, 'idle');
          if (code !== 0) {
            return reject(new HttpError(500, 'summary_failed', `Claude process exited with code ${code}`));
          }
          try {
            const summaryText = summaryResult || 'Bản tóm tắt phiên trò chuyện.';
            const newSession = this.createSession({
              projectId: session.projectId,
              title: session.title ? `${session.title} (tóm tắt)` : 'Phiên mới (tóm tắt)',
              mode: session.mode,
              model: session.model,
              profileName: (session.profileName && this.profileRepo?.get(session.profileName)) ? session.profileName : undefined,
            });

            this.chatMessageRepo.insert({
              id: crypto.randomUUID(),
              sessionId: newSession.id,
              role: 'user',
              content: summaryText,
            });
            this.chatSessionRepo.touchLastMessage(newSession.id);

            resolve({ id: newSession.id, sessionId: newSession.id });
          } catch (createErr) {
            reject(createErr);
          }
        });
      }
    });
  }

  private checkAutoCompact(sessionId: string): void {
    const autoCompactPercent = this.config.chat?.autoCompactPercent ?? 85;
    if (autoCompactPercent <= 0) return;
    const session = this.chatSessionRepo.get(sessionId);
    if (!session) return;
    const CLAUDE_CONTEXT_WINDOW = 200_000;
    const threshold = (autoCompactPercent / 100) * CLAUDE_CONTEXT_WINDOW;
    if (session.contextTokens >= threshold) {
      this.compactSession(sessionId).catch(() => {
        // error logged/handled internally
      });
    }
  }

  private enqueueTurn(turn: QueuedTurn): void {
    this.queue.push(turn);
    this.processQueue();
  }

  private processQueue(): void {
    if (this.stopped) return;
    const maxConcurrent = this.config.chat?.maxConcurrent ?? 2;
    while (this.runningTurns.size < maxConcurrent && this.queue.length > 0) {
      const nextTurn = this.queue.shift()!;
      const session = this.chatSessionRepo.get(nextTurn.sessionId);
      if (!session) continue;
      this.executeTurn(nextTurn);
    }
  }

  private executeTurn(turn: QueuedTurn): void {
    if (this.stopped) return;
    const planned = this.failoverExecution(turn);
    this.lastEngines.set(turn.sessionId, planned.engine);
    if (planned.pausedUntil) {
      const delay = Math.max(100, planned.pausedUntil * 1000 - Date.now());
      if (this.delayedQueueTimer) clearTimeout(this.delayedQueueTimer);
      this.delayedQueueTimer = setTimeout(() => {
        if (this.stopped) return;
        this.queue.push(turn);
        this.processQueue();
      }, delay);
      return;
    }
    if (planned.engine === 'codex') {
      if (!planned.profileName) {
        this.chatSessionRepo.setBusy(turn.sessionId, 0);
        this.setSessionState(turn.sessionId, 'error');
        this.emitChatError(turn.sessionId, turn.messageId, 'Không tìm thấy hồ sơ Codex khả dụng');
        this.processQueue();
        return;
      }
      this.executeCodexTurn(turn, { model: planned.model, profileName: planned.profileName });
      return;
    }
    const claudeBin = findClaudeBin(this.claudeBinOverride || this.config.chat?.claudeBin);
    if (!claudeBin) {
      this.chatSessionRepo.setBusy(turn.sessionId, 0);
      this.setSessionState(turn.sessionId, 'error');
      const errMsg = 'Không tìm thấy lệnh claude trên hệ thống';
      this.chatMessageRepo.insert({
        id: turn.messageId,
        sessionId: turn.sessionId,
        role: 'error',
        content: errMsg,
      });
      this.emitChatError(turn.sessionId, turn.messageId, errMsg);
      setBrainActivity('idle').catch(() => {});
      this.processQueue();
      return;
    }

    if (checkClaudeStreamJsonSupport(claudeBin)) {
      this.executePersistentTurn(turn, claudeBin);
      return;
    }

    // Determine cwd
    let cwd = os.homedir();
    if (turn.projectId) {
      const project = this.projectRepo.get(turn.projectId);
      if (project && project.path) {
        cwd = project.path;
      }
    }

    const session = this.chatSessionRepo.get(turn.sessionId);
    const mcpConfigPath = ensureChatMcpConfig(this.config.hubHome, turn.sessionId, this.config.port, this.config.chat.permissionTimeoutSec, turn.projectId, session?.kind);
    const supportsPartial = checkClaudePartialSupport(claudeBin);
    const execution = this.failoverExecution(turn);
    const profile = execution.profileName && this.profileRepo ? this.profileRepo.get(execution.profileName) : undefined;
    const args = buildClaudeArgs({ planning: this.config.planning,
      text: turn.text,
      claudeSessionId: turn.claudeSessionId,
      mode: turn.mode,
      mcpConfigPath,
      supportsPartial,
      model: execution.model,
      systemPrompt: session?.kind === 'assistant' ? this.assistantPrompt(session) : undefined,
      hubSnapshot: session ? this.hubSnapshot(session) : undefined,
    });

    setBrainActivity('talking').catch(() => {});

    let child: ChildProcess;
    try {
      child = spawnClaude(claudeBin, args, cwd, turn.text, { disableToolSearch: this.config.chat.disableToolSearch, chatSessionId: turn.sessionId, chatKind: session?.kind, port: this.config.port, claudeConfigDir: profile?.kind === 'isolated' ? profile.home || undefined : undefined, env: execution.env });
    } catch (err: unknown) {
      this.chatSessionRepo.setBusy(turn.sessionId, 0);
      this.setSessionState(turn.sessionId, 'error');
      const errMsg = err instanceof Error ? err.message : 'Lỗi khởi chạy claude';
      this.chatMessageRepo.insert({
        id: turn.messageId,
        sessionId: turn.sessionId,
        role: 'error',
        content: errMsg,
      });
      this.emitChatError(turn.sessionId, turn.messageId, errMsg);
      setBrainActivity('idle').catch(() => {});
      this.processQueue();
      return;
    }

    // 15 minutes timeout
    const timeoutTimer = setTimeout(() => {
      const running = this.runningTurns.get(turn.sessionId);
      if (running) {
        running.cancelled = true;
        if (running.child.pid) {
          killProcessGroup(running.child.pid);
        }
        this.runningTurns.delete(turn.sessionId);
        this.chatSessionRepo.setBusy(turn.sessionId, 0);
        this.setSessionState(turn.sessionId, 'error');
        const timeoutMsg = 'Lượt chat bị quá thời gian (15 phút)';
        this.chatMessageRepo.insert({
          id: turn.messageId,
          sessionId: turn.sessionId,
          role: 'error',
          content: timeoutMsg,
        });
        this.emitChatError(turn.sessionId, turn.messageId, timeoutMsg);
        setBrainActivity('idle').catch(() => {});
        this.processQueue();
      }
    }, 15 * 60 * 1000);

    const runningTurn: RunningTurn = {
      sessionId: turn.sessionId,
      messageId: turn.messageId,
      child,
      timeoutTimer,
      cancelled: false,
    };
    this.runningTurns.set(turn.sessionId, runningTurn);
    this.armTurnWatchdog(runningTurn);

    const parser = new StreamChunkParser();
    let accumulatedText = '';
    let hasStreamedPartials = false;
    let resultHandled = false;
    let lastAssistantUsage: AssistantUsage | undefined;
    let limitResetSeconds: number | undefined;
    const startTime = Date.now();

    child.stdout?.on('data', (chunk: Buffer) => {
      if (this.stopped) return;
      this.resetTurnWatchdog(runningTurn);
      const events = parser.feed(chunk);
      for (const ev of events) {
        if (ev.type === 'init') {
          if (ev.sessionId) {
            const sess = this.chatSessionRepo.get(turn.sessionId);
            if (sess && !sess.claudeSessionId) {
              this.chatSessionRepo.updateClaudeSessionId(turn.sessionId, ev.sessionId);
            }
          }
        } else if (ev.type === 'text_delta') {
          hasStreamedPartials = true;
          accumulatedText += ev.text;
          this.emitChatDelta(turn.sessionId, turn.messageId, ev.text);
        } else if (ev.type === 'assistant_text') {
          if (ev.usage) {
            lastAssistantUsage = ev.usage;
          }
          if (ev.text && !hasStreamedPartials) {
            accumulatedText += ev.text;
            this.emitChatDelta(turn.sessionId, turn.messageId, ev.text);
          }
        } else if (ev.type === 'tool_use') {
          if (ev.usage) {
            lastAssistantUsage = ev.usage;
          }
          runningTurn.pendingToolUse = true;
          this.pauseTurnWatchdog(runningTurn);
          this.recordToolStart(runningTurn, ev);
        } else if (ev.type === 'permission_request') {
          runningTurn.waitingPermission = true;
          this.pauseTurnWatchdog(runningTurn);
          this.setSessionState(turn.sessionId, 'waiting_permission');
          this.emitEvent('chat.permission', { sessionId: turn.sessionId, messageId: turn.messageId, message: ev.message || 'Claude cần bạn cấp quyền công cụ' });
        } else if (ev.type === 'tool_result') {
          this.recordToolResult(runningTurn, ev);
          runningTurn.pendingToolUse = false;
          runningTurn.waitingPermission = false;
          this.resetTurnWatchdog(runningTurn);
        } else if (ev.type === 'rate_limit_info' && /rejected|limited|exhausted/i.test(ev.status)) {
          limitResetSeconds = ev.resetsAt ? Math.max(1, ev.resetsAt - Math.floor(Date.now() / 1000) + 60) : 5 * 3600;
        } else if (ev.type === 'result') {
          resultHandled = true;
          if (ev.result) accumulatedText += ev.result;
          if (ev.sessionId) {
            const sess = this.chatSessionRepo.get(turn.sessionId);
            if (sess && !sess.claudeSessionId) {
              this.chatSessionRepo.updateClaudeSessionId(turn.sessionId, ev.sessionId);
            }
          }
          if (ev.usage) {
            const contextTokens = lastAssistantUsage?.contextTokens ?? ev.usage.inputTokens;
            this.chatSessionRepo.addUsage(turn.sessionId, {
              ...ev.usage,
              contextTokens,
            });
          }

          if (ev.isError) {
            const errMsg = ev.result || 'Claude error';
            const quota = detectClaudeQuota({ streamText: errMsg });
            // Let the close handler record the signal once and select the next
            // engine. Scheduling a Claude retry here used to run before the
            // failover state was activated, leaving a healthy Codex idle.
            if (quota.exhausted) {
              if (this.chatSessionRepo.get(turn.sessionId)?.kind !== 'brain') {
                if (this.scheduleLimitRetry(turn, quota.resetSeconds, errMsg)) continue;
                // Without a retry store, retain the normal error handling below.
                limitResetSeconds = undefined;
              } else {
                limitResetSeconds = quota.resetSeconds || 5 * 3600;
                continue;
              }
            }
            if (turn.claudeSessionId && /session|resume|conversation/i.test(errMsg) && /not found|invalid|unknown|exist/i.test(errMsg)) {
              this.chatSessionRepo.clearClaudeSessionId(turn.sessionId);
              this.chatMessageRepo.insert({ id: crypto.randomUUID(), sessionId: turn.sessionId, role: 'error', content: 'Đã mở phiên mới, ngữ cảnh cũ không còn' });
            }
            this.setSessionState(turn.sessionId, 'error');
            this.chatMessageRepo.insert({
              id: turn.messageId,
              sessionId: turn.sessionId,
              role: 'error',
              content: errMsg,
            });
            this.emitChatError(turn.sessionId, turn.messageId, errMsg);
          } else {
            if (ev.costUsd !== undefined) {
              const before = this.failoverState.snapshot();
              const after = this.failoverState.recordCost(ev.costUsd);
              if (before.step?.type === 'apiKey' && after.step?.type === 'apiKey' && ev.costUsd > 0) {
                this.eventBus.emit('claude.fallback_changed', undefined, { step: after.step, reason: 'cost_recorded', resetAt: after.resetAt, dailyCostUSD: after.dailyCostUSD });
              }
            }
            this.setSessionState(turn.sessionId, 'idle');
            const finalText = ev.result ?? accumulatedText;
            this.chatMessageRepo.insert({
              id: turn.messageId,
              sessionId: turn.sessionId,
              role: 'assistant',
              content: finalText,
              meta: JSON.stringify({
                costUsd: ev.costUsd,
                numTurns: ev.numTurns,
                durationMs: ev.durationMs,
                ...(ev.usage ? { usage: ev.usage } : {}),
              }),
            });
            this.emitChatDone(turn.sessionId, turn.messageId, {
              durationMs: ev.durationMs ?? (Date.now() - startTime),
              costUsd: ev.costUsd,
              numTurns: ev.numTurns,
              usage: ev.usage,
            });
          }
        }
      }
    });

    let stderrOutput = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrOutput += chunk.toString('utf-8');
    });

    child.on('close', (code) => {
      clearTimeout(timeoutTimer);
      if (this.stopped) return;
      if (runningTurn.idleTimer) clearTimeout(runningTurn.idleTimer);
      const flushed = parser.flush();
      for (const ev of flushed) {
        if (ev.type === 'init' && ev.sessionId) {
          const sess = this.chatSessionRepo.get(turn.sessionId);
          if (sess && !sess.claudeSessionId) {
            this.chatSessionRepo.updateClaudeSessionId(turn.sessionId, ev.sessionId);
          }
        } else if (ev.type === 'text_delta') {
          hasStreamedPartials = true;
          accumulatedText += ev.text;
          this.emitChatDelta(turn.sessionId, turn.messageId, ev.text);
        } else if (ev.type === 'assistant_text') {
          if (ev.usage) {
            lastAssistantUsage = ev.usage;
          }
          if (!hasStreamedPartials) {
            accumulatedText += ev.text;
            this.emitChatDelta(turn.sessionId, turn.messageId, ev.text);
          }
        } else if (ev.type === 'tool_use') {
          if (ev.usage) {
            lastAssistantUsage = ev.usage;
          }
          runningTurn.pendingToolUse = true;
          this.pauseTurnWatchdog(runningTurn);
          this.recordToolStart(runningTurn, ev);
        } else if (ev.type === 'tool_result') {
          this.recordToolResult(runningTurn, ev);
          runningTurn.pendingToolUse = false;
          runningTurn.waitingPermission = false;
          this.resetTurnWatchdog(runningTurn);
        }
      }

      const running = this.runningTurns.get(turn.sessionId);
      if (running && !running.cancelled) {
        const quota = this.recordClaudeQuota(accumulatedText, stderrOutput, code);
        if (!quota.exhausted && limitResetSeconds) { quota.exhausted = true; quota.resetSeconds = limitResetSeconds; }
        const fallback = this.failoverState.snapshot();
        if (this.chatSessionRepo.get(turn.sessionId)?.kind === 'brain' && quota.exhausted && fallback.step && fallback.step.type !== 'wait') {
          this.runningTurns.delete(turn.sessionId);
          this.chatSessionRepo.setBusy(turn.sessionId, 0);
          this.emitEvent('chat.failover', {
            sessionId: turn.sessionId,
            messageId: turn.messageId,
            fromEngine: 'claude',
            toEngine: fallback.step.type === 'engine' ? 'codex' : 'claude',
            reason: 'claude_quota_exhausted',
            step: fallback.step,
          });
          this.executeTurn(turn);
          return;
        }
        if (!resultHandled) {
          if (quota.exhausted && this.scheduleLimitRetry(turn, quota.resetSeconds, stderrOutput.trim())) {
            // The original user message remains pending until the retry succeeds.
          } else if (code !== 0) {
            const errMsg = stderrOutput.trim() || `Claude process exited with code ${code}`;
            try {
              this.chatMessageRepo.insert({
                id: turn.messageId,
                sessionId: turn.sessionId,
                role: 'error',
                content: errMsg,
              });
            } catch {
              // ignore db error on shutdown
            }
            this.emitChatError(turn.sessionId, turn.messageId, errMsg);
            this.setSessionState(turn.sessionId, 'error');
          } else {
            const errMsg = 'Claude process đã dừng trước khi trả về kết quả';
            try { this.chatMessageRepo.insert({ id: turn.messageId, sessionId: turn.sessionId, role: 'error', content: errMsg }); } catch { /* shutdown */ }
            this.emitChatError(turn.sessionId, turn.messageId, errMsg);
            this.setSessionState(turn.sessionId, 'error');
          }
        }
        this.runningTurns.delete(turn.sessionId);
        try {
          this.chatSessionRepo.setBusy(turn.sessionId, 0);
        } catch {
          // ignore db error on shutdown
        }
        setBrainActivity('idle').catch(() => {});
        this.processQueue();
        if (resultHandled) {
          this.checkAutoCompact(turn.sessionId);
        }
      }
    });
  }

  /** Run a resident brain turn through Codex while retaining chat's event format. */
  private executeCodexTurn(turn: QueuedTurn, execution: { model: string; profileName: string }): void {
    const session = this.chatSessionRepo.get(turn.sessionId);
    const profile = this.profileRepo?.get(execution.profileName);
    if (!session || !profile) {
      this.chatSessionRepo.setBusy(turn.sessionId, 0);
      this.emitChatError(turn.sessionId, turn.messageId, 'Không tìm thấy hồ sơ Codex đã chọn');
      this.processQueue();
      return;
    }
    const cwd = turn.projectId ? this.projectRepo.get(turn.projectId)?.path || os.homedir() : os.homedir();
    const mcpConfigPath = ensureChatMcpConfig(this.config.hubHome, turn.sessionId, this.config.port, this.config.chat.permissionTimeoutSec, turn.projectId, session.kind);
    const sessionDir = path.join(this.config.hubHome, 'sessions', turn.sessionId.replace(/[^a-zA-Z0-9_-]/g, '_'));
    fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });

    const configTomlPath = path.join(sessionDir, 'config.toml');
    const projectRoot = findProjectRoot();
    const cliPath = path.resolve(projectRoot, 'dist', 'cli.js');
    const nodePath = process.execPath;
    const tomlContent = [
      '[mcp_servers.agenthub]',
      `command = ${JSON.stringify(nodePath)}`,
      `args = [${JSON.stringify(cliPath)}, "mcp"]`,
      '[mcp_servers.agenthub.env]',
      `AGENTHUB_CHAT_SESSION_ID = ${JSON.stringify(turn.sessionId)}`,
      ...(turn.projectId ? [`AGENTHUB_MCP_PROJECT = ${JSON.stringify(turn.projectId)}`] : []),
      ...(session.kind ? [`AGENTHUB_CHAT_KIND = ${JSON.stringify(session.kind)}`] : []),
      `AGENTHUB_PORT = ${JSON.stringify(String(this.config.port || 7700))}`,
      `AGENTHUB_PERMISSION_TIMEOUT_SEC = ${JSON.stringify(String(this.config.chat.permissionTimeoutSec || 600))}`,
    ].join('\n');
    fs.writeFileSync(configTomlPath, tomlContent, { encoding: 'utf-8', mode: 0o600 });
    fs.chmodSync(configTomlPath, 0o600);

    const logPath = path.join(sessionDir, 'codex.log');
    const engine = new CodexEngine(this.codexBinOverride, session.mode === 'full' ? 'off' : 'workspace-write');
    const project = turn.projectId ? this.projectRepo.get(turn.projectId) : undefined;
    const permission = effectiveBrainPermission(project, this.config.brain);
    const projectKnowledge = project && this.knowledgeRepo
      ? buildProjectKnowledgeContext(this.knowledgeRepo.getByProject(project.id), projectSettings(project).references, undefined, project.path).text
      : undefined;
    const systemPrompt = session.kind === 'assistant'
      ? this.assistantPrompt(session)
      : (buildBrainPrompt(this.config.planning) + (projectKnowledge ? `\n\n[Kiến thức dự án]\n${projectKnowledge}` : ''));
    const snapshot = this.hubSnapshot(session);
    const recentMessages = this.chatMessageRepo.getBySession(turn.sessionId);
    const history = recentMessages
      .filter((m) => m.id !== turn.messageId && (m.role === 'user' || m.role === 'assistant'))
      .slice(-10)
      .map((m) => `${m.role === 'user' ? 'Người dùng' : 'Trợ lý'}: ${m.content}`)
      .join('\n\n');

    const promptParts: string[] = [systemPrompt];
    if (snapshot) promptParts.push(`[Trạng thái AgentHub]\n${snapshot}`);
    if (history) promptParts.push(`[Lịch sử hội thoại]\n${history}`);
    promptParts.push(`[Yêu cầu]\n${turn.text}`);
    const codexPrompt = promptParts.join('\n\n');

    let child: ChildProcess;
    try {
      child = engine.spawn({
        profile,
        model: execution.model,
        cwd,
        prompt: codexPrompt,
        logPath,
        streamOutput: true,
        mcpConfigPath,
        hubHome: this.config.hubHome,
        codexSandbox: session.mode === 'full' ? 'off' : 'workspace-write',
        // Codex has no Claude-style allowedTools callback. Its approval policy
        // is the process-level enforcement boundary for non-full brain modes:
        // standard/trusted commands must be approved by Codex instead of being
        // executed autonomously; full is the sole explicit bypass mode.
        codexApproval: permission === 'full' ? 'never' : permission === 'standard' ? 'untrusted' : 'on-request',
        brainPolicy: permission === 'full' ? undefined : permission,
        project: this.projectRepo.get(turn.projectId || '') || undefined,
      });
    } catch (error) {
      this.chatSessionRepo.setBusy(turn.sessionId, 0);
      this.setSessionState(turn.sessionId, 'error');
      this.emitChatError(turn.sessionId, turn.messageId, error instanceof Error ? error.message : String(error));
      this.processQueue();
      return;
    }
    const timeoutTimer = setTimeout(() => { if (child.pid) killProcessGroup(child.pid); }, (this.config.brain.turnTimeoutSec || 1200) * 1000);
    const running: RunningTurn = { sessionId: turn.sessionId, messageId: turn.messageId, child, timeoutTimer, cancelled: false };
    this.runningTurns.set(turn.sessionId, running);
    this.armTurnWatchdog(running);
    setBrainActivity('talking').catch(() => {});
    const parser = new StreamChunkParser();
    const startedAt = Date.now();
    let text = '';
    let result: Extract<ParsedStreamEvent, { type: 'result' }> | undefined;
    let lastAssistantUsage: AssistantUsage | undefined;
    let stderr = '';
    const consume = (event: ParsedStreamEvent) => {
      if (this.stopped) return;
      if (event.type === 'init' && event.sessionId) {
        this.chatSessionRepo.updateClaudeSessionId(turn.sessionId, event.sessionId);
      } else if (event.type === 'assistant_text' || event.type === 'text_delta') {
        text += event.text;
        if (event.type === 'assistant_text' && event.usage) lastAssistantUsage = event.usage;
        this.emitChatDelta(turn.sessionId, turn.messageId, event.text);
      } else if (event.type === 'tool_use') {
        running.pendingToolUse = true;
        this.pauseTurnWatchdog(running);
        this.recordToolStart(running, event);
      } else if (event.type === 'tool_result') {
        this.recordToolResult(running, event);
        running.pendingToolUse = false;
        this.resetTurnWatchdog(running);
      } else if (event.type === 'result') {
        result = event;
      }
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      if (this.stopped) return;
      this.resetTurnWatchdog(running);
      for (const event of parser.feed(chunk)) consume(event);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (this.stopped) return;
      stderr += chunk.toString('utf8');
    });
    child.on('close', (code) => {
      clearTimeout(timeoutTimer);
      if (this.stopped) return;
      if (running.idleTimer) clearTimeout(running.idleTimer);
      for (const event of parser.flush()) consume(event);
      if (this.runningTurns.get(turn.sessionId) !== running) return;
      this.runningTurns.delete(turn.sessionId);
      this.chatSessionRepo.setBusy(turn.sessionId, 0);

      const finalUsage = result?.usage || lastAssistantUsage;
      if (finalUsage) {
        this.chatSessionRepo.addUsage(turn.sessionId, {
          ...finalUsage,
          contextTokens: lastAssistantUsage?.contextTokens ?? finalUsage.inputTokens,
        });
      }
      if (profile.home) {
        try {
          const limits = readCodexRateLimits(path.join(profile.home, '.codex'));
          if (limits && this.quotaUsageRepo) {
            for (const w of limits.windows) {
              this.quotaUsageRepo.upsert({
                profileName: profile.name,
                grp: 'codex',
                window: w.window,
                remainingPct: Math.max(0, 100 - w.usedPercent),
                resetAt: w.resetAt,
                fetchedAt: Math.floor(Date.now() / 1000),
              });
            }
          }
        } catch { /* ignore */ }
      }

      const output = result?.result || text;
      if (result?.isError || code !== 0) {
        const message = output || stderr.trim() || `Codex process exited with code ${code}`;
        const quota = new CodexEngine().detectQuota(`${output}\n${stderr}`);
        const loginFailure = /(?:not logged in|login required|log in to codex|authentication|unauthori[sz]ed|未 đăng nhập)/i.test(`${message}\n${stderr}`);
        if (quota.exhausted || loginFailure) {
          if (execution.profileName && this.quotaMarkRepo) {
            if (quota.exhausted) this.quotaMarkRepo.mark(execution.profileName, 'codex', Math.floor(Date.now() / 1000) + 3600, 'codex_quota');
          }
          const failover = this.failoverState.snapshot();
          if (failover.active) {
            this.failoverState.advance(quota.exhausted ? 'codex_quota' : 'codex_login');
            this.chatSessionRepo.setBusy(turn.sessionId, 0);
            this.setSessionState(turn.sessionId, 'waiting_limit');
            this.emitEvent('chat.failover', {
              sessionId: turn.sessionId,
              messageId: turn.messageId,
              fromEngine: 'codex',
              toEngine: null,
              reason: quota.exhausted ? 'codex_quota' : 'codex_login',
              message: 'Claude và Codex đều không khả dụng; đang chờ quota hoặc đăng nhập lại.',
            });
            this.emitChatError(turn.sessionId, turn.messageId, 'Claude đã hết quota và Codex hiện không khả dụng; phiên đang chờ quota hoặc đăng nhập lại.');
            setBrainActivity('idle').catch(() => {});
            this.processQueue();
            return;
          }
          this.eventBus.emit('claude.fallback_changed', undefined, { reason: quota.exhausted ? 'codex_quota' : 'codex_login', step: null });
          this.forceClaude.add(turn.sessionId);
          this.chatSessionRepo.setBusy(turn.sessionId, 0);
          this.setSessionState(turn.sessionId, 'idle');
          this.lastEngines.set(turn.sessionId, 'claude');
          this.executeTurn(turn);
          return;
        }
        this.setSessionState(turn.sessionId, 'error');
        this.emitChatError(turn.sessionId, turn.messageId, message);
      } else {
        this.setSessionState(turn.sessionId, 'idle');
        this.chatMessageRepo.insert({
          id: turn.messageId,
          sessionId: turn.sessionId,
          role: 'assistant',
          content: output,
          meta: JSON.stringify({ engine: 'codex', usage: finalUsage || null }),
        });
        this.emitChatDone(turn.sessionId, turn.messageId, { usage: finalUsage, durationMs: Date.now() - startedAt });
      }
      setBrainActivity('idle').catch(() => {});
      this.processQueue();
    });
  }

  private executePersistentTurn(turn: QueuedTurn, claudeBin: string): void {
    const session = this.chatSessionRepo.get(turn.sessionId);
    if (!session) return;
    const proc = this.ensurePersistentProcess(session, claudeBin);
    if (!proc) {
      this.queue.unshift(turn);
      return;
    }
    const timeoutTimer = setTimeout(() => this.timeoutPersistentTurn(proc), 15 * 60 * 1000);
    const running: RunningTurn = { sessionId: turn.sessionId, messageId: turn.messageId, child: proc.child, timeoutTimer, cancelled: false, persistent: true };
    proc.active = running;
    proc.lastUsedAt = Date.now();
    proc.lastAssistantUsage = undefined;
    this.runningTurns.set(turn.sessionId, running);
    this.armTurnWatchdog(running);
    setBrainActivity('talking').catch(() => {});
    try {
      const lastSnapshot = this.snapshotAt.get(turn.sessionId) || 0;
      const update = Date.now() - lastSnapshot > 10 * 60 * 1000 ? `Cập nhật hub: ${this.hubSnapshot(session, true)}\n\n` : '';
      proc.child.stdin?.write(streamJsonMessage(`${update}${turn.text}`));
    } catch (err) {
      this.finishPersistentError(proc, turn, err instanceof Error ? err.message : 'Không thể gửi tin nhắn tới Claude');
    }
  }

  private ensurePersistentProcess(session: ChatSessionRow, claudeBin: string): PersistentProcess | undefined {
    const existing = this.persistentProcesses.get(session.id);
    if (existing && !existing.child.killed) return existing;
    const max = this.config.chat.maxConcurrent ?? 2;
    if (this.persistentProcesses.size >= max) {
      const idle = [...this.persistentProcesses.values()].filter((p) => !p.active).sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
      if (!idle) return undefined;
      this.closePersistentProcess(idle);
    }
    let cwd = os.homedir();
    if (session.projectId) cwd = this.projectRepo.get(session.projectId)?.path || cwd;
    const execution = this.failoverExecution({ sessionId: session.id, messageId: '', text: '', projectId: session.projectId, mode: session.mode, claudeSessionId: session.claudeSessionId, model: session.model, profileName: session.profileName });
    if (execution.pausedUntil) return undefined;
    const profile = execution.profileName && this.profileRepo ? this.profileRepo.get(execution.profileName) : undefined;
    const proc = spawnClaude(claudeBin, buildClaudeArgs({ planning: this.config.planning,
      mode: session.mode,
      claudeSessionId: session.claudeSessionId,
      mcpConfigPath: ensureChatMcpConfig(this.config.hubHome, session.id, this.config.port, this.config.chat.permissionTimeoutSec, session.projectId, session.kind),
      supportsPartial: checkClaudePartialSupport(claudeBin),
      persistent: true,
      model: execution.model,
      hubSnapshot: this.hubSnapshot(session, (this.snapshotAt.get(session.id) || 0) > 0 && Date.now() - (this.snapshotAt.get(session.id) || 0) > 10 * 60 * 1000),
      systemPrompt: session.kind === 'assistant' ? this.assistantPrompt(session) : undefined,
    }), cwd, undefined, { disableToolSearch: this.config.chat.disableToolSearch, chatSessionId: session.id, chatKind: session.kind, port: this.config.port, claudeConfigDir: profile?.kind === 'isolated' ? profile.home || undefined : undefined, env: execution.env });
    const state: PersistentProcess = { sessionId: session.id, child: proc, parser: new StreamChunkParser(), lastUsedAt: Date.now(), model: session.model, profileName: session.profileName, stderrOutput: '' };
    this.persistentProcesses.set(session.id, state);
    proc.stdout?.on('data', (chunk: Buffer) => this.handlePersistentOutput(state, chunk));
    proc.stderr?.on('data', (chunk: Buffer) => { state.stderrOutput += chunk.toString('utf8'); });
    proc.on('close', () => this.handlePersistentClose(state));
    this.armIdleTimer(state);
    return state;
  }

  private handlePersistentOutput(proc: PersistentProcess, chunk: Buffer): void {
    if (this.stopped) return;
    if (proc.active) this.resetTurnWatchdog(proc.active);
    for (const ev of proc.parser.feed(chunk)) {
      if ((ev.type === 'init' || ev.type === 'result') && ev.sessionId && !this.chatSessionRepo.get(proc.sessionId)?.claudeSessionId) {
        this.chatSessionRepo.updateClaudeSessionId(proc.sessionId, ev.sessionId);
      }
      if (ev.type === 'result' && proc.active) this.finishPersistentTurn(proc, ev);
      else if (ev.type === 'rate_limit_info' && /rejected|limited|exhausted/i.test(ev.status)) proc.limitResetSeconds = ev.resetsAt ? Math.max(1, ev.resetsAt - Math.floor(Date.now() / 1000) + 60) : 5 * 3600;
      else if (ev.type === 'tool_use' && proc.active) {
        if (ev.usage) proc.lastAssistantUsage = ev.usage;
        proc.active.pendingToolUse = true;
        this.pauseTurnWatchdog(proc.active);
        this.recordToolStart(proc.active, ev);
      } else if (ev.type === 'permission_request' && proc.active) {
        proc.active.waitingPermission = true;
        this.pauseTurnWatchdog(proc.active);
        this.setSessionState(proc.sessionId, 'waiting_permission');
        this.emitEvent('chat.permission', { sessionId: proc.sessionId, messageId: proc.active.messageId, message: ev.message || 'Claude cần bạn cấp quyền công cụ' });
      } else if (ev.type === 'tool_result' && proc.active) {
        this.recordToolResult(proc.active, ev);
        proc.active.pendingToolUse = false;
        proc.active.waitingPermission = false;
        this.resetTurnWatchdog(proc.active);
      } else if (ev.type === 'assistant_text' && proc.active) {
        if (ev.usage) proc.lastAssistantUsage = ev.usage;
        if (ev.text) {
          proc.active.accumulatedText = (proc.active.accumulatedText || '') + ev.text;
          if (!proc.active.isCompact && !proc.active.isForkSummary) {
            this.emitChatDelta(proc.sessionId, proc.active.messageId, ev.text);
          }
        }
      } else if (ev.type === 'text_delta' && proc.active) {
        proc.active.accumulatedText = (proc.active.accumulatedText || '') + ev.text;
        if (!proc.active.isCompact && !proc.active.isForkSummary) {
          this.emitChatDelta(proc.sessionId, proc.active.messageId, ev.text);
        }
      }
    }
  }

  private finishPersistentTurn(proc: PersistentProcess, ev: Extract<ParsedStreamEvent, { type: 'result' }>): void {
    const running = proc.active;
    if (!running) return;
    clearTimeout(running.timeoutTimer);
    if (running.idleTimer) clearTimeout(running.idleTimer);
    if (running.cancelTimer) clearTimeout(running.cancelTimer);
    proc.active = undefined;
    this.runningTurns.delete(proc.sessionId);
    const quota = this.recordClaudeQuota(ev.result || '', proc.stderrOutput, 0);
    if (!quota.exhausted && proc.limitResetSeconds) { quota.exhausted = true; quota.resetSeconds = proc.limitResetSeconds; }
    if (ev.costUsd !== undefined) this.failoverState.recordCost(ev.costUsd);
    this.chatSessionRepo.setBusy(proc.sessionId, 0);
    let contextTokens = 0;
    if (ev.usage) {
      contextTokens = proc.lastAssistantUsage?.contextTokens ?? ev.usage.inputTokens;
      this.chatSessionRepo.addUsage(proc.sessionId, {
        ...ev.usage,
        contextTokens,
      });
    }
    proc.lastAssistantUsage = undefined;

    const isCompact = running.isCompact;
    const isForkSummary = running.isForkSummary;
    const onFinish = running.onFinish;

    proc.limitResetSeconds = undefined;
    if (ev.isError) {
      const session = this.chatSessionRepo.get(proc.sessionId);
      const retryTurn: QueuedTurn = { sessionId: proc.sessionId, messageId: running.messageId, text: this.chatMessageRepo.getBySession(proc.sessionId, 100000).find((message) => message.role === 'user' && message.id !== running.messageId)?.content || '', projectId: session?.projectId || null, mode: session?.mode || 'safe', claudeSessionId: session?.claudeSessionId || null, model: proc.model, profileName: proc.profileName };
      if (quota.exhausted && retryTurn.text && this.scheduleLimitRetry(retryTurn, quota.resetSeconds, ev.result)) {
        this.armIdleTimer(proc);
        setBrainActivity('idle').catch(() => {});
        this.processQueue();
        return;
      }
      this.setSessionState(proc.sessionId, 'error');
      if (session?.claudeSessionId && /session|resume|conversation/i.test(ev.result || '') && /not found|invalid|unknown|exist/i.test(ev.result || '')) {
        this.chatSessionRepo.clearClaudeSessionId(proc.sessionId);
        this.chatMessageRepo.insert({ id: crypto.randomUUID(), sessionId: proc.sessionId, role: 'error', content: 'Đã mở phiên mới, ngữ cảnh cũ không còn' });
      }
      this.chatMessageRepo.insert({ id: running.messageId, sessionId: proc.sessionId, role: 'error', content: ev.result || 'Claude error' });
      this.emitChatError(proc.sessionId, running.messageId, ev.result || 'Claude error');
      if (onFinish) onFinish(new Error(ev.result || 'Claude error'));
    } else if (isCompact) {
      this.setSessionState(proc.sessionId, 'idle');
      this.chatMessageRepo.insert({
        id: crypto.randomUUID(),
        sessionId: proc.sessionId,
        role: 'system',
        content: 'Đã nén ngữ cảnh',
      });
      const updatedSess = this.chatSessionRepo.get(proc.sessionId);
      const finalContext = updatedSess?.contextTokens ?? contextTokens;
      this.emitEvent('chat.compacted', {
        sessionId: proc.sessionId,
        contextTokens: finalContext,
      });
      if (onFinish) onFinish(undefined, { contextTokens: finalContext });
    } else if (isForkSummary) {
      this.setSessionState(proc.sessionId, 'idle');
      const summaryText = ev.result || running.accumulatedText || 'Bản tóm tắt phiên trò chuyện.';
      if (onFinish) onFinish(undefined, { summary: summaryText });
    } else {
      this.setSessionState(proc.sessionId, 'idle');
      this.chatMessageRepo.insert({
        id: running.messageId,
        sessionId: proc.sessionId,
        role: 'assistant',
        content: ev.result || '',
        meta: JSON.stringify({
          costUsd: ev.costUsd,
          durationMs: ev.durationMs,
          numTurns: ev.numTurns,
          ...(ev.usage ? { usage: ev.usage } : {}),
        }),
      });
      this.emitChatDone(proc.sessionId, running.messageId, {
        durationMs: ev.durationMs || 0,
        costUsd: ev.costUsd,
        numTurns: ev.numTurns,
        usage: ev.usage,
      });
      this.checkAutoCompact(proc.sessionId);
    }
    proc.lastUsedAt = Date.now();
    this.armIdleTimer(proc);
    setBrainActivity('idle').catch(() => {});
    this.processQueue();
  }

  private finishPersistentError(proc: PersistentProcess, turn: QueuedTurn, message: string): void {
    if (proc.active?.onFinish) {
      proc.active.onFinish(new Error(message));
    }
    if (proc.active) clearTimeout(proc.active.timeoutTimer);
    if (proc.active?.idleTimer) clearTimeout(proc.active.idleTimer);
    proc.active = undefined;
    this.runningTurns.delete(turn.sessionId);
    this.chatSessionRepo.setBusy(turn.sessionId, 0);
    this.setSessionState(turn.sessionId, 'error');
    this.chatMessageRepo.insert({ id: turn.messageId, sessionId: turn.sessionId, role: 'error', content: message });
    this.emitChatError(turn.sessionId, turn.messageId, message);
    this.closePersistentProcess(proc);
    this.processQueue();
  }

  private timeoutPersistentTurn(proc: PersistentProcess): void {
    const running = proc.active;
    if (!running) return;
    running.cancelled = true;
    if (proc.child.pid) killProcessGroup(proc.child.pid);
    this.finishPersistentError(proc, { sessionId: proc.sessionId, messageId: running.messageId, text: '', projectId: null, mode: 'safe', claudeSessionId: null, model: proc.model, profileName: proc.profileName }, 'Lượt chat bị quá thời gian (15 phút)');
  }

  private armIdleTimer(proc: PersistentProcess): void {
    if (proc.idleTimer) clearTimeout(proc.idleTimer);
    proc.idleTimer = setTimeout(() => { if (!proc.active) this.closePersistentProcess(proc); }, (this.config.chat.idleTimeoutSec || 600) * 1000);
  }

  private closePersistentProcess(proc: PersistentProcess): void {
    if (proc.idleTimer) clearTimeout(proc.idleTimer);
    this.persistentProcesses.delete(proc.sessionId);
    if (proc.child.pid) killProcessGroup(proc.child.pid);
  }

  private removeChatMcpConfig(sessionId: string): void {
    try { fs.rmSync(chatMcpConfigPath(this.config.hubHome, sessionId), { force: true }); } catch { /* best effort */ }
  }

  private handlePersistentClose(proc: PersistentProcess): void {
    if (this.stopped) return;
    if (proc.active) {
      const active = proc.active;
      clearTimeout(active.timeoutTimer);
      this.runningTurns.delete(proc.sessionId);
      const quota = this.recordClaudeQuota('', proc.stderrOutput, null);
      if (!quota.exhausted && proc.limitResetSeconds) { quota.exhausted = true; quota.resetSeconds = proc.limitResetSeconds; }
      this.chatSessionRepo.setBusy(proc.sessionId, 0);
      this.setSessionState(proc.sessionId, 'error');
      const session = this.chatSessionRepo.get(proc.sessionId);
      const retryTurn: QueuedTurn = { sessionId: proc.sessionId, messageId: active.messageId, text: this.chatMessageRepo.getBySession(proc.sessionId, 100000).find((message) => message.role === 'user')?.content || '', projectId: session?.projectId || null, mode: session?.mode || 'safe', claudeSessionId: session?.claudeSessionId || null, model: proc.model, profileName: proc.profileName };
      if (!active.cancelled && quota.exhausted && retryTurn.text && this.scheduleLimitRetry(retryTurn, quota.resetSeconds, proc.stderrOutput.trim())) {
        this.closePersistentProcess(proc);
      } else if (!active.cancelled) {
        this.chatMessageRepo.insert({ id: active.messageId, sessionId: proc.sessionId, role: 'error', content: 'Claude process đã dừng' });
        this.emitChatError(proc.sessionId, active.messageId, 'Claude process đã dừng');
      }
    }
    this.persistentProcesses.delete(proc.sessionId);
    this.processQueue();
  }

  private emitChatDelta(sessionId: string, messageId: string, text: string): void {
    this.emitEvent('chat.delta', { sessionId, messageId, text });
  }

  private emitChatTool(
    sessionId: string,
    messageId: string,
    toolMessageId: string,
    toolUseId: string,
    name: string,
    summary: string,
    data: { input?: Record<string, unknown>; output?: string; status: 'running' | 'done' | 'error'; durationMs?: number; diff?: string; } = { status: 'running' },
  ): void {
    this.emitEvent('chat.tool', {
      sessionId, messageId, toolMessageId, toolUseId, name, summary,
      ...(data.input !== undefined ? { input: data.input } : {}),
      ...(data.output !== undefined ? { output: data.output } : {}),
      status: data.status,
      ...(data.durationMs !== undefined ? { durationMs: data.durationMs } : {}),
      ...(data.diff !== undefined ? { diff: data.diff } : {}),
    });
  }

  private recordToolStart(turn: RunningTurn, ev: Extract<ParsedStreamEvent, { type: 'tool_use' }>): void {
    const id = ev.id || crypto.randomUUID();
    const toolMessageId = crypto.randomUUID();
    const input = boundedToolInput(ev.input || {});
    const meta = { name: ev.name, summary: ev.summary, input, status: 'running' as const, diff: toolDiff(ev.name, input), id };
    if (!turn.toolExecutions) turn.toolExecutions = new Map();
    turn.toolExecutions.set(id, { messageId: toolMessageId, startedAt: Date.now(), name: ev.name, summary: ev.summary, input });
    this.chatMessageRepo.insert({ id: toolMessageId, sessionId: turn.sessionId, role: 'tool', content: ev.summary, meta: JSON.stringify(meta) });
    this.emitChatTool(turn.sessionId, turn.messageId, toolMessageId, id, ev.name, ev.summary, { input, status: 'running', diff: meta.diff });
  }

  private recordToolResult(turn: RunningTurn, ev: Extract<ParsedStreamEvent, { type: 'tool_result' }>): void {
    const executions = turn.toolExecutions;
    if (!executions || executions.size === 0) return;
    const id = ev.toolUseId && executions.has(ev.toolUseId) ? ev.toolUseId : [...executions.keys()].at(-1);
    if (!id) return;
    const execution = executions.get(id);
    if (!execution) return;
    const output = boundedToolOutput(ev.output, execution.input);
    const status = ev.isError ? 'error' as const : 'done' as const;
    const durationMs = Date.now() - execution.startedAt;
    const meta = { name: execution.name, summary: execution.summary, input: execution.input, output, status, durationMs, diff: toolDiff(execution.name, execution.input), id };
    this.chatMessageRepo.upsert({ id: execution.messageId, sessionId: turn.sessionId, role: 'tool', content: execution.summary, meta: JSON.stringify(meta) });
    this.emitChatTool(turn.sessionId, turn.messageId, execution.messageId, id, execution.name, execution.summary, { input: execution.input, output, status, durationMs, diff: meta.diff });
    executions.delete(id);
  }

  private emitChatDone(
    sessionId: string,
    messageId: string,
    data: {
      durationMs: number;
      costUsd?: number;
      numTurns?: number;
      usage?: { inputTokens: number; outputTokens: number };
    },
  ): void {
    this.emitEvent('chat.done', {
      sessionId,
      messageId,
      durationMs: data.durationMs,
      ...(data.costUsd !== undefined ? { costUsd: data.costUsd } : {}),
      ...(data.numTurns !== undefined ? { numTurns: data.numTurns } : {}),
      ...(data.usage !== undefined ? { usage: data.usage } : {}),
    });
  }

  private emitChatError(sessionId: string, messageId: string, message: string): void {
    this.emitEvent('chat.error', { sessionId, messageId, message });
  }

  private setSessionState(sessionId: string, state: ChatSessionRow['state']): void {
    try { this.chatSessionRepo.updateState(sessionId, state); } catch { return; }
    this.emitEvent('chat.status', { sessionId, status: state });
  }

  private armTurnWatchdog(turn: RunningTurn): void {
    if (turn.waitingPermission || turn.pendingToolUse) return;
    const timeoutMs = Math.max(1, this.config.chat.idleTimeoutSec || 300) * 1000;
    turn.idleTimer = setTimeout(() => {
      if (this.runningTurns.get(turn.sessionId) !== turn || turn.cancelled) return;
      turn.cancelled = true;
      if (turn.child.pid) killProcessGroup(turn.child.pid);
      clearTimeout(turn.timeoutTimer);
      this.runningTurns.delete(turn.sessionId);
      this.chatSessionRepo.setBusy(turn.sessionId, 0);
      this.setSessionState(turn.sessionId, 'error');
      const message = `Claude không có output trong ${this.config.chat.idleTimeoutSec || 300} giây; hãy thử lại`;
      this.chatMessageRepo.insert({ id: turn.messageId, sessionId: turn.sessionId, role: 'error', content: message });
      this.emitChatError(turn.sessionId, turn.messageId, message);
      this.processQueue();
    }, timeoutMs);
  }

  private resetTurnWatchdog(turn: RunningTurn): void {
    if (turn.idleTimer) clearTimeout(turn.idleTimer);
    this.armTurnWatchdog(turn);
  }

  private pauseTurnWatchdog(turn: RunningTurn): void {
    if (turn.idleTimer) {
      clearTimeout(turn.idleTimer);
      turn.idleTimer = undefined;
    }
  }

  /** Start the next queued user message of a session once its current turn has finished. */
  private drainWaitingUserMessages(sessionId: string): void {
    if (this.stopped) return;
    const old = this.drainTimers.get(sessionId);
    if (old) {
      clearTimeout(old);
      this.drainTimers.delete(sessionId);
    }
    const waiting = this.waitingUserMessages.get(sessionId);
    if (!waiting || waiting.length === 0) return;
    const session = this.chatSessionRepo.get(sessionId);
    if (!session) {
      this.waitingUserMessages.delete(sessionId);
      return;
    }
    // The finishing turn may not have released the session yet (busy is cleared right after
    // chat.done), or another turn slipped in: check again shortly until the session is free.
    if (session.busy === 1 || this.runningTurns.has(sessionId)) {
      const timer = setTimeout(() => this.drainWaitingUserMessages(sessionId), 300);
      timer.unref?.();
      this.drainTimers.set(sessionId, timer);
      return;
    }
    const next = waiting.shift()!;
    if (waiting.length === 0) this.waitingUserMessages.delete(sessionId);
    try {
      this.sendMessage(sessionId, next.text, {
        fromQueue: true,
        messageIds: {
          userMessageId: next.userMessageId,
          assistantMessageId: next.assistantMessageId,
        },
      });
    } catch (error) {
      console.error(`[chat] queued message for ${sessionId} failed:`, error);
    }
  }

  private emitEvent(type: string, payload: unknown): void {
    if (typeof (this.eventBus as unknown as { emitEphemeral?: (t: string, tid?: string, p?: unknown) => boolean }).emitEphemeral === 'function') {
      (this.eventBus as unknown as { emitEphemeral: (t: string, tid?: string, p?: unknown) => boolean }).emitEphemeral(
        type,
        undefined,
        payload,
      );
    } else {
      this.eventBus.emit(type, undefined, payload);
    }
    if (type === 'chat.done' || type === 'chat.error') {
      const sessionId = (payload as { sessionId?: unknown } | null)?.sessionId;
      if (typeof sessionId === 'string' && this.waitingUserMessages.has(sessionId)) {
        setImmediate(() => this.drainWaitingUserMessages(sessionId));
      }
    }
  }
}

export function registerChatRoutes(fastify: FastifyInstance, chatService: ChatService): void {
  // MCP permission-prompt-tool calls this endpoint and waits for the dashboard decision.
  fastify.post('/api/chat/permissions', async (req: FastifyRequest) => {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as {
      sessionId?: string; messageId?: string; tool_name?: string; input?: unknown; kind?: 'brain' | 'user';
    };
    if (!body.sessionId || !body.tool_name || !body.input || typeof body.input !== 'object') {
      throw new HttpError(400, 'bad_request', 'Thiếu sessionId, tool_name hoặc input');
    }
    return chatService.requestPermission({
      sessionId: body.sessionId,
      messageId: body.messageId,
      toolName: body.tool_name,
      input: body.input as Record<string, unknown>,
      kind: body.kind,
    });
  });

  fastify.get('/api/chat/permissions', async (req: FastifyRequest) => {
    const sessionId = (req.query as { sessionId?: string }).sessionId;
    return chatService.listPermissions(sessionId);
  });

  fastify.get('/api/chat/permission-rules', async (req: FastifyRequest) => {
    const query = req.query as { limit?: string; cursor?: string };
    if (query.cursor && !decodeCursor(query.cursor)) throw new HttpError(400, 'bad_request', 'Invalid pagination cursor');
    return query.limit === undefined ? chatService.listPermissionRules() : chatService.pagePermissionRules(query);
  });
  fastify.delete('/api/chat/permission-rules/:id', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return chatService.deletePermissionRule(id);
  });

  fastify.post('/api/chat/permissions/:id', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as { decision?: string; message?: string };
    if (body.decision !== 'allow' && body.decision !== 'deny' && body.decision !== 'allow_always') {
      throw new HttpError(400, 'bad_request', 'decision phải là allow, deny hoặc allow_always');
    }
    return chatService.decidePermission(id, body.decision, body.message);
  });

  // GET /api/chat/sessions
  fastify.get('/api/chat/sessions', async (req: FastifyRequest) => {
    const query = req.query as { search?: string; archived?: string; limit?: string; cursor?: string };
    if (query.limit !== undefined) {
      if (query.cursor && !decodeCursor(query.cursor)) throw new HttpError(400, 'bad_request', 'Invalid pagination cursor');
      return chatService.pageSessions(query);
    }
    return chatService.listSessions(query);
  });

  // POST /api/chat/sessions
  fastify.post('/api/chat/sessions', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const session = chatService.createSession({
      ...(typeof body.projectId === 'string' || body.projectId === null ? { projectId: body.projectId } : {}),
      ...(typeof body.title === 'string' ? { title: body.title } : {}),
      ...(body.mode === 'safe' || body.mode === 'full' ? { mode: body.mode } : {}),
      ...(typeof body.model === 'string' ? { model: body.model } : {}),
      ...(typeof body.profileName === 'string' || body.profileName === null ? { profileName: body.profileName } : {}),
    });
    return reply.status(201).send(session);
  });

  // POST /api/chat/sessions/:id/warm
  fastify.post('/api/chat/sessions/:id/warm', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return chatService.warmSession(id);
  });

  // PATCH /api/chat/sessions/:id
  fastify.patch('/api/chat/sessions/:id', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as {
      title?: string;
      pinned?: boolean | number;
      archived?: boolean | number;
    };
    return chatService.updateSession(id, body);
  });

  // DELETE /api/chat/sessions/:id
  fastify.delete('/api/chat/sessions/:id', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return chatService.deleteSession(id);
  });

  // GET /api/chat/sessions/:id/messages?before=<messageId>&limit=50
  fastify.get('/api/chat/sessions/:id/messages', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    const query = req.query as { limit?: string; before?: string };
    const limit = query?.limit ? parseInt(query.limit, 10) : 50;
    return chatService.listMessages(id, {
      limit: isNaN(limit) ? 50 : limit,
      before: query?.before,
    });
  });

  // GET /api/chat/sessions/:id/export
  fastify.get('/api/chat/sessions/:id/export', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const markdown = chatService.exportSession(id);
    return reply.type('text/markdown; charset=utf-8').send(markdown);
  });

  // POST /api/chat/sessions/:id/messages
  fastify.post('/api/chat/sessions/:id/messages', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as { text?: unknown };
    const result = chatService.sendMessage(id, body.text as string, { queueIfBusy: true });
    return reply.status(202).send(result);
  });

  // POST /api/chat/sessions/:id/compact
  fastify.post('/api/chat/sessions/:id/compact', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return chatService.compactSession(id);
  });

  // POST /api/chat/sessions/:id/fork-summary
  fastify.post('/api/chat/sessions/:id/fork-summary', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const result = await chatService.forkSummary(id);
    return reply.status(201).send(result);
  });

  // POST /api/chat/sessions/:id/cancel
  fastify.post('/api/chat/sessions/:id/cancel', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return chatService.cancelSession(id);
  });

  fastify.post('/api/chat/sessions/:id/limit-retry/cancel', async (req: FastifyRequest) => {
    return chatService.cancelLimitRetry((req.params as { id: string }).id);
  });

  fastify.post('/api/chat/sessions/:id/limit-retry/now', async (req: FastifyRequest) => {
    return chatService.retryLimitNow((req.params as { id: string }).id);
  });

  fastify.post('/api/chat/sessions/:id/stop', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return chatService.cancelSession(id);
  });
}
