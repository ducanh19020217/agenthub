import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { attributeTurn, taskRefsFromToolInput } from './attribution.js';
import { ClaudeSessionRepo } from './repo.js';
import { ClaudeFailoverState } from '../chat/failover.js';
import { buildClaudeArgs, ensureChatMcpConfig, findClaudeBin, spawnClaude } from '../chat/claude.js';
import { EventBus } from '../scheduler/index.js';
import { projectWorktreeRoots } from '../projects/paths.js';

export interface ClaudeScanOptions {
  dir: string;
  maxAgeDays?: number;
  include?: string[];
  hubHome?: string;
  worktreesDir?: string;
  weights?: { cacheCreation?: number; cacheRead?: number };
  failoverState?: ClaudeFailoverState;
  failoverIdleSec?: number;
  autoResume?: { enabled: boolean; prompt: string; allowFullMode?: boolean; claudeBin?: string; claudeConfigDir?: string; profileName?: string | null };
  eventBus?: EventBus;
}

export function isRealClaudeAssistant(event: ClaudeTranscriptEvent): boolean {
  if (event.type !== 'assistant' || event.isApiErrorMessage) return false;
  const model = typeof event.message?.model === 'string' ? event.message.model : '';
  const output = integer(event.message?.usage?.output_tokens);
  return model.length > 0 && model !== '<synthetic>' && output > 0;
}

export function redactTranscriptText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  let text = value.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]');
  text = text.replace(/(?:sk|pk|api|token|secret|key)[-_A-Za-z0-9]*\s*[:=]\s*["']?[-A-Za-z0-9_./+=]{12,}["']?/gi, '[secret]');
  text = text.replace(/\b(?:bearer\s+)?[A-Za-z0-9_-]{24,}\b/gi, '[secret]');
  return text.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function messageText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.filter((item) => isRecord(item) && item.type === 'text').map((item) => String(item.text || '')).join(' ');
  return '';
}

export class ClaudeSessionScanner {
  private timer?: NodeJS.Timeout;
  private lastBrainEventAt = 0;
  private scanning = false;
  private readonly weights: { cacheCreation: number; cacheRead: number };
  constructor(private db: Database.Database, private options: ClaudeScanOptions) {
    this.weights = { cacheCreation: options.weights?.cacheCreation ?? 1.25, cacheRead: options.weights?.cacheRead ?? 0.1 };
  }
  setEventBus(eventBus: EventBus) { this.options.eventBus = eventBus; }
  start() {
    this.cleanExpiredLimits();
    void this.scan().catch(() => undefined);
    this.timer = setInterval(() => void this.scan().catch(() => undefined), 60_000);
    this.timer.unref?.();
  }
  cleanExpiredLimits(maxAgeSeconds = 24 * 3600) {
    const threshold = Math.floor(Date.now() / 1000) - maxAgeSeconds;
    this.db.prepare('UPDATE claude_sessions SET limitResetAt = NULL, limitHitAt = NULL WHERE limitResetAt IS NOT NULL AND limitResetAt <= ?').run(threshold);
  }
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
  async scan() {
    // Quét lâu hơn chu kỳ 60s thì bỏ lượt mới, tránh nhiều lượt đọc cùng file chồng nhau.
    if (this.scanning) return;
    this.scanning = true;
    try { await this.scanOnce(); } finally { this.scanning = false; }
  }
  private async scanOnce() {
    this.cleanExpiredLimits();
    const repo = new ClaudeSessionRepo(this.db);
    const tasks = this.db.prepare('SELECT id,slug FROM tasks').all() as Array<{ id: string; slug: string }>;
    // Only open transcripts of projects the hub manages (or hub chats). Other Claude Code projects on
    // this machine (e.g. company work) must not be read or recorded at all.
    const encodedRoots = this.allowedRoots().map(encodeProjectDir);
    const dirAllowed = (name: string) => encodedRoots.some((root) => name === root || name.startsWith(`${root}-`));
    const files = findTranscriptFiles(this.options.dir, this.options.maxAgeDays ?? 14, dirAllowed, (sessionId) => this.isHubChat(sessionId));
    for (const file of files) await this.scanFile(file, repo, tasks);
  }
  private async scanFile(file: string, repo: ClaudeSessionRepo, tasks: Array<{ id: string; slug: string }>) {
    let stat: fs.Stats;
    try { stat = await fs.promises.stat(file); } catch { return; }
    const existing = this.db.prepare('SELECT * FROM claude_scan_state WHERE path=?').get(file) as { inode:number;size:number;offset:number;turnId:string;turnTasks:string;eligible:number } | undefined;
    const reset = !existing || existing.inode !== stat.ino || stat.size < existing.size;
    const start = reset ? 0 : existing.offset;
    let offset = start;
    let sessionId = path.basename(file, '.jsonl');
    let eligible = reset ? (!!repo.get(sessionId) || this.isHubChat(sessionId)) : existing.eligible === 1;
    let turnId = reset ? `${sessionId}:initial` : (existing.turnId || `${sessionId}:initial`);
    let turnTasks = new Set<string>(reset ? [] : parseTaskState(existing.turnTasks));
    let latestLimit: { resetAt: number; observedAt: string } | null = null;
    let latestActivity: string | null = null;
    const previous = repo.get(sessionId);
    let lastUserRequest = previous?.lastUserRequest || null;
    let lastToolName = previous?.lastToolName || null;
    let lastToolSummary = previous?.lastToolSummary || null;
    let lastEventKind = previous?.lastEventKind || null;
    let fiveHourTokens = previous?.fiveHourTokens ?? null;
    let metadataChanged = false;
    let firstUserMessage: string | null = null;
    let aiTitle: string | null = null;
    let latestCwd = '';
    const records: Array<{ event: ClaudeTranscriptEvent; sessionId: string; turnId: string; tasks: string[]; line: number }> = [];
    const turns = new Map<string, Set<string>>();
    const stream = fs.createReadStream(file, { start, encoding: 'utf8' });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      // Số dòng trước offset chỉ dùng để ghi chú vị trí (failover); chỉ đếm khi thật sự có dòng mới,
      // file không đổi thì không đọc lại phần đã quét.
      let lineNumber: number | null = start === 0 ? 0 : null;
      for await (const line of lines) {
        if (lineNumber === null) lineNumber = await countNewlines(file, start);
        lineNumber += 1;
        const raw = line as string;
        const bytes = Buffer.byteLength(raw + '\n');
        offset += bytes;
        let event: ClaudeTranscriptEvent;
        try { event = JSON.parse(raw); } catch { offset -= bytes; break; }
        if (!event || typeof event !== 'object') continue;
        if (typeof event.sessionId === 'string') sessionId = event.sessionId;
        if (typeof event.cwd === 'string' && event.cwd.length > 0) latestCwd = event.cwd;
        if (!eligible && this.isAllowed(event, sessionId)) eligible = true;
        const quota = quotaInfo(event);
        if (eligible && quota) {
          repo.setQuota({ ...quota, profileName: this.profileForSession(sessionId), observedAt: typeof event.timestamp === 'string' ? event.timestamp : new Date().toISOString() });
          if (isClaudeQuotaLimited(quota.status) && quota.resetsAt) latestLimit = { resetAt: quota.resetsAt, observedAt: typeof event.timestamp === 'string' ? event.timestamp : new Date().toISOString() };
        }
        if (event.type === 'assistant' || event.type === 'user') latestActivity = typeof event.timestamp === 'string' ? event.timestamp : latestActivity;
        if (eligible && event.type === 'user' && !hasToolResult(event)) {
          const request = redactTranscriptText(messageText(event.message?.content ?? event.content), 200);
          if (request) lastUserRequest = request;
          lastEventKind = 'user';
          metadataChanged = true;
        }
        if (!eligible) continue;
        if (event.type === 'user' && !hasToolResult(event)) {
          turnId = `${sessionId}:${event.uuid || offset}`;
          turnTasks = new Set();
          if (!firstUserMessage) firstUserMessage = extractUserText(event);
        }
        if (event.type === 'ai-title' && typeof event.aiTitle === 'string' && event.aiTitle.trim()) {
          aiTitle = event.aiTitle.trim().slice(0, 120);
          repo.upsert({ sessionId, cwd: String(event.cwd || latestCwd || ''), title: aiTitle });
        }
        if (event.type !== 'assistant' || !event.message) continue;
        const toolBlocks = Array.isArray(event.message.content)
          ? event.message.content.filter((block): block is { type: string; input?: unknown } => isRecord(block) && block.type === 'tool_use')
          : [];
        if (toolBlocks.length) {
          const block = toolBlocks.at(-1)!;
          lastToolName = typeof (block as { name?: unknown }).name === 'string' ? redactTranscriptText((block as unknown as { name: string }).name, 80) : 'tool';
          lastToolSummary = redactTranscriptText(toolSummary(block.input), 120);
          lastEventKind = 'tool_use';
          metadataChanged = true;
        } else {
          lastEventKind = 'assistant_text';
          metadataChanged = true;
        }
        for (const block of toolBlocks) for (const id of taskRefsFromToolInput(block.input, tasks)) turnTasks.add(id);
        records.push({ event, sessionId, turnId, tasks: [...turnTasks], line: lineNumber });
        turns.set(turnId, new Set(turnTasks));
      }
    } finally { lines.close(); stream.close(); }
    const existingTitle = repo.get(sessionId)?.title;
    const titleToSet = aiTitle || existingTitle || firstUserMessage || null;
    if (eligible && records.length) {
      const tx = this.db.transaction(() => {
        for (const record of records) {
          const event = record.event;
          const usage = event.message?.usage || {};
          const input = integer(usage.input_tokens); const output = integer(usage.output_tokens);
          const cacheCreation = integer(usage.cache_creation_input_tokens); const cacheRead = integer(usage.cache_read_input_tokens);
          const effective = input + output + cacheCreation * this.weights.cacheCreation + cacheRead * this.weights.cacheRead;
          const ts = typeof event.timestamp === 'string' ? event.timestamp : new Date().toISOString();
          const model = typeof event.message?.model === 'string' ? event.message.model : null;
          const messageId = String(event.message?.id || event.requestId || `${record.sessionId}:${offset}`);
          repo.addUsage({ sessionId: record.sessionId, messageId, ts, turnId: record.turnId, model, input, output, cacheCreation, cacheRead, effective, isSidechain: event.isSidechain ? 1 : 0 });
          const quota = quotaInfo(event);
          const profileName = this.profileForSession(record.sessionId);
          if (quota) repo.setQuota({ ...quota, profileName, observedAt: ts });
          else if (isRealClaudeAssistant(event)) {
            if (repo.markAllowedAfter(profileName, ts)) this.options.eventBus?.emit('claude.quota_available', undefined, { profileName, observedAt: ts, source: 'transcript' });
          }
        }
        for (const [id, refs] of turns) {
          const total = repo.turnTotal(sessionId, id).effective;
          repo.setTasks(sessionId, id, attributeTurn(total, [...refs]));
        }
        const totals = this.db.prepare("SELECT COUNT(*) messages, COALESCE(SUM(input),0) input, COALESCE(SUM(output),0) output, COALESCE(SUM(cacheCreation),0) creation, COALESCE(SUM(cacheRead),0) read, COALESCE(SUM(effective),0) effective, MIN(ts) firstAt, MAX(ts) lastAt, COALESCE(SUM(CASE WHEN ts >= datetime('now', '-5 hours') THEN input + output ELSE 0 END),0) fiveHourTokens FROM claude_usage WHERE sessionId=?").get(sessionId) as { messages:number; input:number; output:number; creation:number; read:number; effective:number; firstAt:string|null; lastAt:string|null; fiveHourTokens:number };
        fiveHourTokens = totals.fiveHourTokens;
        const last = records.at(-1)?.event;
        repo.upsert({ sessionId, cwd: String(last?.cwd || latestCwd || ''), title: titleToSet, firstAt: totals.firstAt, lastAt: latestActivity || totals.lastAt, model: typeof last?.message?.model === 'string' ? last.message.model : null, messages: totals.messages, inputTokens: totals.input, outputTokens: totals.output, cacheCreationTokens: totals.creation, cacheReadTokens: totals.read, effectiveTokens: totals.effective, isHubChat: this.isHubChat(sessionId) ? 1 : 0, lastUserRequest, lastToolName, lastToolSummary, lastEventKind, fiveHourTokens });
      });
      tx();
      this.updateFailover(file, records);
    } else if (eligible && titleToSet && !existingTitle) {
      repo.upsert({ sessionId, cwd: String(latestCwd || ''), title: titleToSet });
    }
    if (eligible && metadataChanged && !records.length) {
      repo.updateActivity(sessionId, { lastAt: latestActivity, lastUserRequest, lastToolName, lastToolSummary, lastEventKind, fiveHourTokens });
    }
    if (eligible && latestLimit) {
      const stillLimited = !latestActivity || Date.parse(latestActivity) <= Date.parse(latestLimit.observedAt);
      const isExpired = latestLimit.resetAt * 1000 + 24 * 3600_000 <= Date.now();
      const resetToSet = stillLimited && !isExpired ? latestLimit.resetAt : null;
      const hitToSet = stillLimited && !isExpired ? latestLimit.observedAt : null;
      repo.upsert({ sessionId, cwd: '', limitResetAt: resetToSet, limitHitAt: hitToSet });
      repo.setLimit(sessionId, resetToSet, hitToSet);
    }
    await this.maybeAutoResume(file, sessionId, repo, existing, stat);
    this.db.prepare('INSERT OR REPLACE INTO claude_scan_state (path,inode,size,offset,mtime,turnId,turnTasks,eligible) VALUES (?,?,?,?,?,?,?,?)').run(file, stat.ino, stat.size, offset, stat.mtimeMs, turnId, JSON.stringify([...turnTasks]), eligible ? 1 : 0);
    const currentSession = repo.get(sessionId);
    const waitingTooLong = currentSession?.lastEventKind === 'assistant_text' && currentSession.lastAt
      ? Date.now() - Date.parse(currentSession.lastAt) > 5 * 60_000
      : false;
    if (eligible && (metadataChanged || waitingTooLong) && Date.now() - this.lastBrainEventAt >= 10_000) {
      this.lastBrainEventAt = Date.now();
      const eventBus = this.options.eventBus as (EventBus & { emitEphemeral?: EventBus['emitEphemeral'] }) | undefined;
      if (eventBus?.emitEphemeral) eventBus.emitEphemeral('brain.updated', undefined, { sessionId });
      else eventBus?.emit('brain.updated', undefined, { sessionId });
    }
  }
  private async maybeAutoResume(file: string, sessionId: string, repo: ClaudeSessionRepo, existing: { size: number; eligible: number } | undefined, stat: fs.Stats) {
    const auto = this.options.autoResume;
    const session = repo.get(sessionId);
    const now = Date.now();
    if (!auto?.enabled || !session?.autoResumeEnabled || !session.limitResetAt || !session.limitHitAt) return;
    if (session.limitResetAt * 1000 + 10 * 60_000 > now) return;
    if (existing && (existing.size !== stat.size || existing.eligible !== 1)) return;
    if (stat.mtimeMs > Date.parse(session.limitHitAt)) return;
    if (isClaudeProcessOpen(session.cwd)) return;
    const bin = findClaudeBin(auto.claudeBin);
    if (!bin || !session.cwd) return;
    const chatSessionId = crypto.randomUUID();
    const project = this.db.prepare('SELECT id FROM projects WHERE path = ? LIMIT 1').get(session.cwd) as { id: string } | undefined;
    this.db.prepare(`INSERT INTO chat_sessions (id,projectId,claudeSessionId,title,mode,busy,model,profileName,state)
      VALUES (?,?,?,?,?,0,? ,?,'running')`).run(
      chatSessionId, project?.id || null, sessionId, `Tự tiếp tục: ${session.title || sessionId}`,
      auto.allowFullMode ? 'full' : 'safe', '', auto.profileName || null,
    );
    const messageId = crypto.randomUUID();
    this.db.prepare('INSERT INTO chat_messages (id,sessionId,role,content) VALUES (?,?,?,?)').run(messageId, chatSessionId, 'user', auto.prompt);
    const mcp = ensureChatMcpConfig(this.options.hubHome, chatSessionId);
    const args = buildClaudeArgs({ text: auto.prompt, claudeSessionId: sessionId, mode: auto.allowFullMode ? 'full' : 'safe', mcpConfigPath: mcp });
    // <configDir>/projects/<project>/<session>.jsonl. The machine's default ~/.claude must NOT be
    // passed as CLAUDE_CONFIG_DIR: Claude would then look for ~/.claude/.claude.json and lose its login.
    const derivedConfigDir = auto.claudeConfigDir || path.dirname(path.dirname(path.dirname(file)));
    const claudeConfigDir = path.resolve(derivedConfigDir) === path.join(os.homedir(), '.claude') ? undefined : derivedConfigDir;
    repo.setLimit(sessionId, null, null);
    const child = spawnClaude(bin, args, session.cwd, auto.prompt, { chatSessionId, claudeConfigDir });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('close', (code) => {
      const content = stdout.trim() || stderr.trim() || `Claude process exited with code ${code ?? 'unknown'}`;
      const role = code === 0 ? 'assistant' : 'error';
      this.db.prepare('INSERT INTO chat_messages (id,sessionId,role,content) VALUES (?,?,?,?)').run(crypto.randomUUID(), chatSessionId, role, content);
      this.db.prepare("UPDATE chat_sessions SET busy=0,state=?,lastMessageAt=datetime('now'),updatedAt=datetime('now') WHERE id=?").run(role === 'assistant' ? 'idle' : 'error', chatSessionId);
      this.options.eventBus?.emit('claude.auto_resumed', chatSessionId, { sessionId, chatSessionId, ok: code === 0, error: code === 0 ? undefined : content });
    });
    child.unref();
    this.options.eventBus?.emit('claude.auto_resumed', chatSessionId, { sessionId, chatSessionId, started: true, cwd: session.cwd });
  }
  private updateFailover(file: string, records: Array<{ event: ClaudeTranscriptEvent; line: number }>) {
    const state = this.options.failoverState;
    if (!state || records.length === 0) return;
    const now = Date.now();
    const maxAge = (this.options.failoverIdleSec ?? 5 * 60) * 2 * 1000;
    let latestActivity: string | null = null;
    let latestQuota: { event: ClaudeTranscriptEvent; line: number; observedAt: string } | null = null;
    for (const record of records) {
      const observedAt = typeof record.event.timestamp === 'string' ? record.event.timestamp : null;
      if (!observedAt || Number.isNaN(Date.parse(observedAt))) continue;
      if (record.event.type === 'assistant' || record.event.type === 'user') latestActivity = observedAt;
      const quota = quotaInfo(record.event);
      if (quota && isClaudeQuotaLimited(quota.status)) {
        latestQuota = { event: record.event, line: record.line, observedAt };
      }
    }
    if (latestActivity && (!latestQuota || Date.parse(latestActivity) > Date.parse(latestQuota.observedAt))) {
      state.noteActivity(latestActivity);
      return;
    }
    if (!latestQuota) return;
    const quotaAt = Date.parse(latestQuota.observedAt);
    if (now - quotaAt > maxAge) return;
    const resetsAt = numberOrNull(quotaInfo(latestQuota.event)?.resetsAt);
    if (!resetsAt || resetsAt <= now / 1000) return;
    const resetSeconds = Math.ceil(resetsAt - now / 1000);
    state.activate(resetSeconds, 'claude_usage_limit', { file, line: latestQuota.line, observedAt: latestQuota.observedAt });
  }
  private isHubChat(sessionId: string) { return !!this.db.prepare('SELECT 1 FROM chat_sessions WHERE claudeSessionId=?').get(sessionId); }
  private profileForSession(sessionId: string): string | null {
    const row = this.db.prepare('SELECT profileName FROM chat_sessions WHERE claudeSessionId=? AND profileName IS NOT NULL ORDER BY updatedAt DESC LIMIT 1').get(sessionId) as { profileName: string } | undefined;
    return row?.profileName || null;
  }
  private isAllowed(event: ClaudeTranscriptEvent, sessionId: string): boolean {
    if (this.isHubChat(sessionId)) return true;
    if (typeof event.cwd !== 'string' || event.cwd.length === 0) return false;
    return this.allowedRoots().some((root) => isWithin(event.cwd!, root));
  }
  private allowedRoots(): string[] {
    const projectRoots = (this.db.prepare('SELECT id, path, settings FROM projects').all() as Array<{ id: string; path: string; settings?: string | null }>)
      .flatMap((project) => projectWorktreeRoots(project, this.options.hubHome, this.options.worktreesDir));
    return [
      ...(this.options.include || []),
      this.options.hubHome,
      this.options.worktreesDir,
      ...projectRoots,
      ...(this.db.prepare('SELECT path FROM projects').all() as Array<{ path: string }>).map((project) => project.path),
    ].filter((root): root is string => typeof root === 'string' && root.length > 0);
  }
}

function integer(value: unknown) { return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0; }
function numberOrNull(value: unknown) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
type ClaudeTranscriptEvent = {
  type?: string;
  sessionId?: string;
  cwd?: string;
  timestamp?: string;
  uuid?: string;
  requestId?: string;
  aiTitle?: string;
  isApiErrorMessage?: boolean;
  isSidechain?: boolean;
  quotaLimits?: { status?: unknown; resetsAt?: unknown; rateLimitType?: unknown; isUsingOverage?: unknown };
  rate_limit_info?: { status?: unknown; resetsAt?: unknown; rateLimitType?: unknown; utilization?: unknown };
  rateLimitInfo?: { status?: unknown; resetsAt?: unknown; rateLimitType?: unknown; utilization?: unknown };
  message?: { id?: unknown; model?: unknown; usage?: Record<string, unknown>; content?: unknown };
  content?: unknown;
};
function quotaInfo(event: ClaudeTranscriptEvent): { status: string; resetsAt: number | null; rateLimitType: string | null; isUsingOverage: boolean } | null {
  const info = event.quotaLimits || event.rate_limit_info || event.rateLimitInfo;
  if (!info) return null;
  const status = typeof info.status === 'string' ? info.status : '';
  const rateLimitType = typeof info.rateLimitType === 'string' ? info.rateLimitType : null;
  return { status, resetsAt: numberOrNull(info.resetsAt), rateLimitType, isUsingOverage: false };
}
function hasToolResult(event: ClaudeTranscriptEvent) { return JSON.stringify(event.message?.content || event.content || '').includes('tool_result'); }
function toolSummary(input: unknown): string {
  if (!isRecord(input)) return '';
  if (typeof input.command === 'string') return `Bash: ${input.command}`;
  if (typeof input.file_path === 'string') return `file: ${input.file_path}`;
  if (typeof input.path === 'string') return `path: ${input.path}`;
  return Object.keys(input).slice(0, 4).join(', ');
}
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object'; }
export function isClaudeQuotaLimited(status?: string): boolean {
  const normalized = status?.trim() || '';
  return normalized.length > 0 && (/^(rejected|limited|exhausted)$/i.test(normalized) || !/^allowed(?:$|[_-])/i.test(normalized));
}
function parseTaskState(value: string | undefined): string[] { try { const parsed = JSON.parse(value || '[]'); return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []; } catch { return []; } }
function isWithin(child: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(child));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
/** Claude Code stores a project's transcripts under ~/.claude/projects/<cwd with non-alphanumerics as '-'>. */
export function encodeProjectDir(cwd: string): string {
  return path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-');
}
function findTranscriptFiles(dir: string, maxAgeDays: number, dirAllowed: (name: string) => boolean, isHubChat: (sessionId: string) => boolean): string[] {
  const cutoff = Date.now() - maxAgeDays * 86_400_000; const files: string[] = [];
  let projects: string[]; try { projects = fs.readdirSync(dir); } catch { return files; }
  for (const project of projects) {
    const allowed = dirAllowed(project);
    const projectDir = path.join(dir, project); let entries: fs.Dirent[];
    try { entries = fs.readdirSync(projectDir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      if (!allowed && !isHubChat(path.basename(entry.name, '.jsonl'))) continue;
      const file = path.join(projectDir, entry.name);
      try { if (fs.statSync(file).mtimeMs >= cutoff) files.push(file); } catch { /* raced */ }
    }
  }
  return files;
}

async function countNewlines(file: string, end: number): Promise<number> {
  // Đọc từng khúc, không nạp cả phần đầu file (có thể hàng trăm MB) vào bộ nhớ và không chặn event loop.
  let count = 0;
  try {
    const stream = fs.createReadStream(file, { start: 0, end: end - 1, highWaterMark: 1 << 20 });
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      let index = chunk.indexOf(10);
      while (index !== -1) { count += 1; index = chunk.indexOf(10, index + 1); }
    }
  } catch { return count; }
  return count;
}

function extractUserText(event: ClaudeTranscriptEvent): string | null {
  const content = event.message?.content || event.content;
  if (typeof content === 'string') {
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed.slice(0, 80) : null;
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block === 'string') {
        const trimmed = block.trim();
        if (trimmed.length > 0) return trimmed.slice(0, 80);
      }
      if (isRecord(block) && (block.type === 'text' || !block.type) && typeof block.text === 'string') {
        const trimmed = block.text.trim();
        if (trimmed.length > 0) return trimmed.slice(0, 80);
      }
    }
  }
  return null;
}

export function isClaudeProcessOpen(cwd: string, procDir = '/proc'): boolean {
  if (!cwd) return false;
  let targetCwd: string;
  try {
    targetCwd = fs.realpathSync(cwd);
  } catch {
    targetCwd = path.resolve(cwd);
  }
  let entries: string[];
  try { entries = fs.readdirSync(procDir); } catch { return false; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmdline = fs.readFileSync(path.join(procDir, entry, 'cmdline'), 'utf8');
      if (!cmdline.includes('claude')) continue;
      const cwdLink = path.join(procDir, entry, 'cwd');
      let processCwd: string;
      try {
        processCwd = fs.realpathSync(cwdLink);
      } catch {
        processCwd = fs.readlinkSync(cwdLink);
      }
      if (processCwd === targetCwd) return true;
    } catch { /* process exited */ }
  }
  return false;
}
