import Database from 'better-sqlite3';
import { decodeCursor, encodeCursor, PageResult } from '../pagination.js';

export interface ClaudeSessionRow { sessionId: string; cwd: string; title: string | null; firstAt: string | null; lastAt: string | null; model: string | null; messages: number; inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number; effectiveTokens: number; isHubChat: number; limitResetAt: number | null; limitHitAt: string | null; autoResumeEnabled: number; lastUserRequest: string | null; lastToolName: string | null; lastToolSummary: string | null; lastEventKind: string | null; fiveHourTokens: number | null }
export interface ClaudeUsageRow { sessionId: string; messageId: string; ts: string; turnId: string; model: string | null; input: number; output: number; cacheCreation: number; cacheRead: number; effective: number; isSidechain: number }

export class ClaudeSessionRepo {
  constructor(private db: Database.Database) {}
  get(id: string) { return this.db.prepare('SELECT * FROM claude_sessions WHERE sessionId = ?').get(id) as ClaudeSessionRow | undefined; }
  list() { return this.db.prepare('SELECT * FROM claude_sessions ORDER BY lastAt DESC').all() as ClaudeSessionRow[]; }
  page(limit: number, offset = 0, cursor?: string, sort: 'lastAt' | 'title' | 'messages' | 'effectiveTokens' = 'lastAt', order: 'asc' | 'desc' = 'desc'): PageResult<ClaudeSessionRow> {
    const total = (this.db.prepare('SELECT COUNT(*) AS count FROM claude_sessions').get() as { count: number }).count;
    const decoded = decodeCursor(cursor);
    if (cursor && !decoded) throw new Error('Invalid pagination cursor');
    const values: unknown[] = [];
    const sortColumn = sort === 'title' ? 'title' : sort === 'messages' ? 'messages' : sort === 'effectiveTokens' ? 'effectiveTokens' : 'lastAt';
    const descending = order !== 'asc';
    const comparison = descending ? '<' : '>';
    const where = decoded ? ` WHERE (COALESCE(${sortColumn}, '') ${comparison} ? OR (COALESCE(${sortColumn}, '') = ? AND sessionId ${comparison} ?))` : '';
    if (decoded) values.push(decoded.value, decoded.value, decoded.id);
    const rows = this.db.prepare(`SELECT * FROM claude_sessions${where} ORDER BY COALESCE(${sortColumn}, '') ${descending ? 'DESC' : 'ASC'}, sessionId ${descending ? 'DESC' : 'ASC'} LIMIT ? OFFSET ?`).all(...values, limit + 1, decoded ? 0 : Math.max(0, Math.floor(offset))) as ClaudeSessionRow[];
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items.at(-1);
    return { items, total, nextCursor: hasMore && last ? encodeCursor((last[sortColumn as keyof ClaudeSessionRow] as string | number | null) ?? '', last.sessionId) : null };
  }
  upsert(row: Partial<ClaudeSessionRow> & Pick<ClaudeSessionRow, 'sessionId' | 'cwd'>) {
    this.db.prepare(`INSERT INTO claude_sessions (sessionId,cwd,title,firstAt,lastAt,model,messages,inputTokens,outputTokens,cacheCreationTokens,cacheReadTokens,effectiveTokens,isHubChat,limitResetAt,limitHitAt,autoResumeEnabled,lastUserRequest,lastToolName,lastToolSummary,lastEventKind,fiveHourTokens) VALUES (@sessionId,@cwd,@title,@firstAt,@lastAt,@model,@messages,@inputTokens,@outputTokens,@cacheCreationTokens,@cacheReadTokens,@effectiveTokens,@isHubChat,@limitResetAt,@limitHitAt,@autoResumeEnabled,@lastUserRequest,@lastToolName,@lastToolSummary,@lastEventKind,@fiveHourTokens) ON CONFLICT(sessionId) DO UPDATE SET cwd=COALESCE(NULLIF(excluded.cwd,''),claude_sessions.cwd),title=COALESCE(excluded.title,claude_sessions.title),firstAt=COALESCE(excluded.firstAt,claude_sessions.firstAt),lastAt=CASE WHEN excluded.lastAt IS NULL THEN claude_sessions.lastAt WHEN claude_sessions.lastAt IS NULL THEN excluded.lastAt ELSE MAX(claude_sessions.lastAt,excluded.lastAt) END,model=COALESCE(excluded.model,claude_sessions.model),messages=excluded.messages,inputTokens=excluded.inputTokens,outputTokens=excluded.outputTokens,cacheCreationTokens=excluded.cacheCreationTokens,cacheReadTokens=excluded.cacheReadTokens,effectiveTokens=excluded.effectiveTokens,isHubChat=excluded.isHubChat,lastUserRequest=COALESCE(excluded.lastUserRequest,claude_sessions.lastUserRequest),lastToolName=COALESCE(excluded.lastToolName,claude_sessions.lastToolName),lastToolSummary=COALESCE(excluded.lastToolSummary,claude_sessions.lastToolSummary),lastEventKind=COALESCE(excluded.lastEventKind,claude_sessions.lastEventKind),fiveHourTokens=COALESCE(excluded.fiveHourTokens,claude_sessions.fiveHourTokens)`).run({ title: null, firstAt: null, lastAt: null, model: null, messages: 0, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, effectiveTokens: 0, isHubChat: 0, limitResetAt: null, limitHitAt: null, autoResumeEnabled: 0, lastUserRequest: null, lastToolName: null, lastToolSummary: null, lastEventKind: null, fiveHourTokens: null, ...row });
  }
  /** Update only activity metadata; never touches counters, cwd or title (scalar MAX() with NULL returns NULL in SQLite). */
  updateActivity(sessionId: string, row: { lastAt: string | null; lastUserRequest: string | null; lastToolName: string | null; lastToolSummary: string | null; lastEventKind: string | null; fiveHourTokens: number | null }) {
    this.db.prepare(`UPDATE claude_sessions SET
      lastAt=CASE WHEN @lastAt IS NULL THEN lastAt WHEN lastAt IS NULL THEN @lastAt ELSE MAX(lastAt,@lastAt) END,
      lastUserRequest=COALESCE(@lastUserRequest,lastUserRequest), lastToolName=COALESCE(@lastToolName,lastToolName),
      lastToolSummary=COALESCE(@lastToolSummary,lastToolSummary), lastEventKind=COALESCE(@lastEventKind,lastEventKind),
      fiveHourTokens=COALESCE(@fiveHourTokens,fiveHourTokens) WHERE sessionId=@sessionId`).run({ sessionId, ...row });
  }
  addUsage(row: ClaudeUsageRow) { return this.db.prepare('INSERT OR IGNORE INTO claude_usage VALUES (@sessionId,@messageId,@ts,@turnId,@model,@input,@output,@cacheCreation,@cacheRead,@effective,@isSidechain)').run(row); }
  usage(sessionId: string) { return this.db.prepare('SELECT * FROM claude_usage WHERE sessionId = ? ORDER BY ts').all(sessionId) as ClaudeUsageRow[]; }
  turnTotal(sessionId: string, turnId: string) {
    return this.db.prepare('SELECT COALESCE(SUM(effective),0) effective FROM claude_usage WHERE sessionId=? AND turnId=?').get(sessionId, turnId) as { effective: number };
  }
  setTasks(sessionId: string, turnId: string, rows: Array<{ taskId: string; effectiveTokens: number }>) { const del = this.db.prepare('DELETE FROM claude_task_usage WHERE sessionId=? AND turnId=?'); const ins = this.db.prepare('INSERT INTO claude_task_usage VALUES (?,?,?,?)'); const tx = this.db.transaction(() => { del.run(sessionId, turnId); for (const row of rows) ins.run(row.taskId, sessionId, turnId, row.effectiveTokens); }); tx(); }
  topTasks(sessionId: string, limit = 5) { return this.db.prepare('SELECT taskId, SUM(effectiveTokens) effectiveTokens FROM claude_task_usage WHERE sessionId=? GROUP BY taskId ORDER BY effectiveTokens DESC LIMIT ?').all(sessionId, limit) as Array<{taskId:string; effectiveTokens:number}>; }
  taskCost(taskId: string) { return this.db.prepare('SELECT COALESCE(SUM(effectiveTokens),0) effectiveTokens, COUNT(DISTINCT sessionId) sessions FROM claude_task_usage WHERE taskId=?').get(taskId) as { effectiveTokens: number; sessions: number }; }
  quota(profileName?: string | null) {
    const row = profileName
      ? this.db.prepare('SELECT status,resetsAt,rateLimitType,observedAt FROM claude_quota_profiles WHERE profileName=?').get(profileName)
      : this.db.prepare('SELECT status,resetsAt,rateLimitType,observedAt FROM claude_quota WHERE id=1').get();
    return row as {status:string|null;resetsAt:number|null;rateLimitType:string|null;observedAt:string}|undefined;
  }
  quotaProfiles() { return this.db.prepare('SELECT profileName,status,resetsAt,rateLimitType,isUsingOverage,observedAt FROM claude_quota_profiles ORDER BY profileName').all() as Array<{profileName:string;status:string|null;resetsAt:number|null;rateLimitType:string|null;isUsingOverage:number;observedAt:string}>; }
  setQuota(row: {status:string;resetsAt:number|null;rateLimitType:string|null;isUsingOverage:boolean;observedAt:string;profileName?:string|null}) {
    if (row.profileName) {
      const previous = this.quota(row.profileName);
      if (previous?.observedAt && Date.parse(previous.observedAt) > Date.parse(row.observedAt)) return;
      this.db.prepare('INSERT INTO claude_quota_profiles (profileName,status,resetsAt,rateLimitType,isUsingOverage,observedAt) VALUES (?,?,?,?,?,?) ON CONFLICT(profileName) DO UPDATE SET status=excluded.status,resetsAt=excluded.resetsAt,rateLimitType=excluded.rateLimitType,isUsingOverage=excluded.isUsingOverage,observedAt=excluded.observedAt').run(row.profileName,row.status,row.resetsAt,row.rateLimitType,row.isUsingOverage?1:0,row.observedAt);
      return;
    }
    this.db.prepare('INSERT OR REPLACE INTO claude_quota VALUES (1,?,?,?,?,?)').run(row.status,row.resetsAt,row.rateLimitType,row.isUsingOverage?1:0,row.observedAt);
  }
  markAllowedAfter(profileName: string | null | undefined, observedAt: string): boolean {
    const current = this.quota(profileName);
    if (!current || Date.parse(observedAt) <= Date.parse(current.observedAt)) return false;
    // A profile can produce many healthy transcript records after recovering.
    // Announce only the transition from a limited state to an available one.
    if (current.status === 'allowed') {
      this.setQuota({ profileName, status: current.status, resetsAt: current.resetsAt, rateLimitType: current.rateLimitType, isUsingOverage: false, observedAt });
      return false;
    }
    this.setQuota({ profileName, status: 'allowed', resetsAt: current.resetsAt, rateLimitType: current.rateLimitType, isUsingOverage: false, observedAt });
    return true;
  }
  setLimit(sessionId: string, resetAt: number | null, hitAt: string | null) { this.db.prepare('UPDATE claude_sessions SET limitResetAt=?,limitHitAt=? WHERE sessionId=?').run(resetAt, hitAt, sessionId); }
  setAutoResume(sessionId: string, enabled: boolean) { this.db.prepare('UPDATE claude_sessions SET autoResumeEnabled=? WHERE sessionId=?').run(enabled ? 1 : 0, sessionId); return this.get(sessionId); }
}
