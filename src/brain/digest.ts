import { TaskRepo, ProjectRepo, ProfileRepo, QuotaMarkRepo, EventRepo, CiRepo, ProfileRow, QuotaMarkRow } from '../db/index.js';
import type { QuietHoursConfig } from '../config.js';
import type { ChatService } from '../chat/service.js';
import { projectSettings } from '../projects/settings.js';
import { QuotaService } from '../quota/index.js';

export interface PendingDecision {
  id: string;
  text: string;
  level: 'decision';
  createdAt: number;
  chatIds: number[];
  answered: boolean;
  answer?: 'agree' | 'reject';
  answeredAt?: number;
  remindersCount: number;
  lastReminderAt: number;
  taskId?: string | null;
}

export class DecisionTracker {
  private decisions = new Map<string, PendingDecision>();

  recordDecision(
    id: string,
    text: string,
    chatIds: number[] = [],
    createdAt = Date.now(),
    taskId?: string | null,
  ): PendingDecision {
    const existing = this.decisions.get(id);
    if (existing) return existing;

    const decision: PendingDecision = {
      id,
      text,
      level: 'decision',
      createdAt,
      chatIds: [...chatIds],
      answered: false,
      remindersCount: 0,
      lastReminderAt: createdAt,
      taskId: taskId || null,
    };
    this.decisions.set(id, decision);
    return decision;
  }

  getDecision(id: string): PendingDecision | undefined {
    return this.decisions.get(id);
  }

  answerDecision(
    id: string,
    answer: 'agree' | 'reject',
    answeredAt = Date.now(),
  ): PendingDecision | null {
    const d = this.decisions.get(id);
    if (!d) return null;
    d.answered = true;
    d.answer = answer;
    d.answeredAt = answeredAt;
    return d;
  }

  getPending(): PendingDecision[] {
    return Array.from(this.decisions.values()).filter((d) => !d.answered);
  }

  getPendingDecisions(): PendingDecision[] {
    return this.getPending();
  }

  getAll(): PendingDecision[] {
    return Array.from(this.decisions.values());
  }

  getRemindersDue(
    now = Date.now(),
    intervalMs = 2 * 60 * 60 * 1000,
    maxReminders = 2,
  ): Array<{ decision: PendingDecision; reminderIndex: number }> {
    const due: Array<{ decision: PendingDecision; reminderIndex: number }> = [];
    for (const d of this.decisions.values()) {
      if (d.answered) continue;
      if (d.remindersCount >= maxReminders) continue;
      if (now - d.lastReminderAt >= intervalMs) {
        due.push({
          decision: d,
          reminderIndex: d.remindersCount + 1,
        });
      }
    }
    return due;
  }

  markReminderSent(id: string, now = Date.now()): void {
    const d = this.decisions.get(id);
    if (!d) return;
    d.remindersCount += 1;
    d.lastReminderAt = now;
  }

  clear(): void {
    this.decisions.clear();
  }
}

/**
 * Forwards an answered decision to the resident Claude brain session for the related project.
 */
export function forwardDecisionToBrain(
  chatService: Pick<ChatService, 'getOrCreateSession' | 'sendMessage'> | undefined,
  decisionId: string,
  text: string,
  answer: 'agree' | 'reject',
  taskId?: string | null,
): void {
  if (!chatService) return;
  const label = answer === 'agree' ? 'Đồng ý' : 'Không';
  const brainMsg = `Người dùng trả lời quyết định ${decisionId} («${text}»): ${label}`;
  try {
    const projectId = taskId?.includes('/') ? taskId.slice(0, taskId.indexOf('/')) : null;
    const sessionId = projectId ? `brain:${projectId}` : 'brain';
    chatService.getOrCreateSession(sessionId, projectId
      ? { title: `Bộ não · ${projectId}`, kind: 'brain', projectId }
      : { title: 'Bộ não', kind: 'brain' });
    chatService.sendMessage(sessionId, brainMsg, { queueIfBusy: true });
  } catch {
    // ignore if brain session cannot receive (e.g. busy)
  }
}

/**
 * Calculates the number of minutes elapsed since the most recent occurrence of the given HH:MM time.
 */
export function getMinutesSinceTime(timeStr: string, now = new Date()): number {
  const parts = (timeStr || '00:00').split(':').map(Number);
  const target = new Date(now);
  target.setHours(parts[0] || 0, parts[1] || 0, 0, 0);
  if (target.getTime() > now.getTime()) {
    target.setDate(target.getDate() - 1);
  }
  return (now.getTime() - target.getTime()) / (60 * 1000);
}

/**
 * Checks whether the current time falls inside quiet hours.
 * Handles ranges spanning midnight (e.g. 22:00 -> 07:00).
 */
export function isQuietHours(config?: QuietHoursConfig | null, now = new Date()): boolean {
  if (!config || !config.enabled) return false;

  const startParts = (config.start || '22:00').split(':').map(Number);
  const endParts = (config.end || '07:00').split(':').map(Number);
  const startMins = (startParts[0] || 0) * 60 + (startParts[1] || 0);
  const endMins = (endParts[0] || 0) * 60 + (endParts[1] || 0);
  const curMins = now.getHours() * 60 + now.getMinutes();

  if (startMins === endMins) return false;
  if (startMins < endMins) {
    return curMins >= startMins && curMins < endMins;
  } else {
    // Spans midnight, e.g. 22:00 to 07:00
    return curMins >= startMins || curMins < endMins;
  }
}

/**
 * Determines if all configured active/enabled profiles are currently quota-exhausted.
 */
export function areAllProfilesQuotaExhausted(
  profileRepo?: ProfileRepo | { getAll(): ProfileRow[] },
  quotaMarkRepo?: QuotaMarkRepo | { getActive(nowSec?: number): QuotaMarkRow[] },
  now = Date.now(),
  family?: string,
  engine?: string,
): boolean {
  if (!profileRepo || !quotaMarkRepo) return false;
  const profiles = profileRepo.getAll().filter((profile) => profile.enabled === 1);
  if (profiles.length === 0) return false;

  const marks = quotaMarkRepo.getActive(Math.floor(now / 1000)).filter((m) => m.until > Math.floor(now / 1000));
  const normFamily = (f?: string) => {
    if (!f) return undefined;
    if (f.startsWith('codex')) return 'codex';
    if (f.startsWith('gemini')) return 'gemini';
    if (f.startsWith('claude')) return 'claude';
    return f;
  };
  const targetFamily = normFamily(family);
  const exhausted = new Set(
    marks
      .filter((mark) => !targetFamily || normFamily(mark.family) === targetFamily || mark.family === family)
      .map((m) => m.profileName),
  );

  const groups = new Map<string, typeof profiles>();
  for (const profile of profiles) {
    if (engine && profile.engine !== engine) continue;
    const group = groups.get(profile.engine) || [];
    group.push(profile);
    groups.set(profile.engine, group);
  }
  if (groups.size === 0) return false;

  // A quota event is actionable when every account of one engine is exhausted,
  // not only when every profile in the whole hub is exhausted.
  return [...groups.values()].some((group) => group.every((profile) => exhausted.has(profile.name)));
}

/**
 * Resolves the engine-wide quota state for a notification event.  Producers
 * include `allExhausted` as a hint, but consumers must recompute it from the
 * repositories whenever they are available so a stale or incomplete event
 * cannot interrupt the user.
 */
export function isQuotaEventEngineWide(
  payload: unknown,
  profileRepo?: ProfileRepo | { getAll(): ProfileRow[]; get?(name: string): ProfileRow | undefined },
  quotaMarkRepo?: QuotaMarkRepo | { getActive(nowSec?: number): QuotaMarkRow[] },
  now = Date.now(),
): boolean {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const rawFamily = typeof p.family === 'string' ? p.family : typeof p.model === 'string' ? p.model : undefined;
  const family = rawFamily ? (rawFamily.startsWith('codex') ? 'codex' : rawFamily.startsWith('gemini') ? 'gemini' : rawFamily.startsWith('claude') ? 'claude' : rawFamily) : undefined;
  let engine = typeof p.engine === 'string' ? p.engine : undefined;

  const profileName = typeof p.profile === 'string' ? p.profile
    : typeof p.profileName === 'string' ? p.profileName
    : typeof p.worker === 'string' ? p.worker : undefined;

  if (profileRepo && !engine && profileName) {
    if ('get' in profileRepo && typeof profileRepo.get === 'function') {
      const profile = profileRepo.get(profileName);
      engine = profile?.engine;
    } else {
      const profiles = profileRepo.getAll();
      const profile = profiles.find((pr) => pr.name === profileName);
      engine = profile?.engine;
    }
  }

  if (!engine && (rawFamily || family)) {
    const f = rawFamily || family || '';
    if (f.startsWith('codex')) engine = 'codex';
    else engine = 'agy';
  }

  if (profileRepo && quotaMarkRepo) {
    const allProfiles = profileRepo.getAll().filter((pr) => pr.enabled !== 0 && (pr.enabled as unknown) !== false);
    if (allProfiles.length > 0) {
      const engineProfiles = engine ? allProfiles.filter((pr) => pr.engine === engine) : allProfiles;
      if (engineProfiles.length > 0) {
        return areAllProfilesQuotaExhausted(profileRepo, quotaMarkRepo, now, rawFamily || family, engine);
      }
    }
    return Boolean(p.allExhausted === true);
  }
  return Boolean(p.allExhausted === true);
}

/** Whether every enabled profile for the engine/family has an active mark. */
export function areAllProfilesQuotaExhaustedForFamily(
  profileRepo?: ProfileRepo,
  quotaMarkRepo?: QuotaMarkRepo,
  family?: string,
  now = Date.now(),
  engine?: string,
): boolean {
  if (!profileRepo || !quotaMarkRepo || !family) return false;
  const allEnabled = profileRepo.getAll(true);
  const profiles = allEnabled.filter((profile) => {
    if (engine) return profile.engine === engine;
    if (family === 'codex') return profile.engine === 'codex';
    if (family === 'claude') return profile.engine === 'claude' || profile.engine === 'agy';
    return profile.engine === 'agy';
  });
  if (profiles.length === 0) return false;
  const epoch = Math.floor(now / 1000);
  const exhausted = new Set(
    quotaMarkRepo.getActive(epoch)
      .filter((mark) => mark.until > epoch && mark.family === family)
      .map((mark) => mark.profileName),
  );
  return profiles.every((profile) => exhausted.has(profile.name));
}

/**
 * Checks whether an event qualifies as a system incident that should bypass quiet hours and auto-mode suppression.
 */
export function isSystemIncident(
  type: string,
  payload?: unknown,
  profileRepo?: ProfileRepo,
  quotaMarkRepo?: QuotaMarkRepo,
  now = Date.now(),
): boolean {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;

  if (p.level === 'incident') return true;
  if (p.urgency === 'critical' || p.critical === true) return true;

  if (type === 'disk.low' || type === 'disk.docker_low') return true;
  if (type === 'hub.restart_failed' || type === 'system.error') return true;

  if (type === 'quota.exhausted' || type === 'claude.quota_exhausted') {
    if (profileRepo && profileRepo.getAll().length > 0 && quotaMarkRepo) {
      const quotaService = new QuotaService(quotaMarkRepo, profileRepo);
      return quotaService.runnableCapacity(undefined, Math.floor(now / 1000)).length === 0;
    }
    return Boolean(p.allExhausted === true);
  }

  return false;
}

export interface GenerateDigestOptions {
  taskRepo: TaskRepo;
  projectRepo?: ProjectRepo;
  profileRepo?: ProfileRepo;
  quotaMarkRepo?: QuotaMarkRepo;
  quotaService?: QuotaService;
  eventRepo?: EventRepo;
  decisionTracker?: DecisionTracker;
  ciRepo?: CiRepo;
  now?: () => number;
  accumulatedQuietHoursMessages?: string[];
  port?: number;
}

export interface DigestData {
  generatedAt: string;
  tasks: {
    done: number;
    doneTotal?: number;
    running: number;
    failed: number;
    blocked: number;
    review: number;
    queued: number;
    waiting_quota: number;
    total: number;
  };
  merged: Array<{
    taskId: string;
    title: string;
    mergeCommit?: string;
  }>;
  quota: {
    summary: string;
    totalProfiles: number;
    availableProfiles: string[];
    exhaustedProfiles: Array<{
      profileName: string;
      family: string;
      until: string;
    }>;
  };
  decisions: Array<{
    id: string;
    text: string;
    createdAt: string;
    remindersCount?: number;
  }>;
  accumulatedQuietHoursMessages?: string[];
  text: string;
  markdown: string;
}

export function generateDigest(opts: GenerateDigestOptions): DigestData {
  const nowMs = opts.now ? opts.now() : Date.now();
  const nowDate = new Date(nowMs);
  const nowIso = nowDate.toISOString();
  const timeStr = `${String(nowDate.getHours()).padStart(2, '0')}:${String(nowDate.getMinutes()).padStart(2, '0')}`;
  const dateStr = `${timeStr} ${String(nowDate.getDate()).padStart(2, '0')}/${String(nowDate.getMonth() + 1).padStart(2, '0')}/${nowDate.getFullYear()}`;

  // 1. Task counts
  const doneTasks = opts.taskRepo.getByStatus('done');
  const runningTasks = opts.taskRepo.getByStatus('running');
  const failedTasks = opts.taskRepo.getByStatus('failed');
  const blockedTasks = opts.taskRepo.getByStatus('blocked');
  const reviewTasks = opts.taskRepo.getByStatus('review');
  const queuedTasks = opts.taskRepo.getByStatus('queued');
  const waitingQuotaTasks = opts.taskRepo.getByStatus('waiting_quota');
  const totalTasks =
    doneTasks.length +
    runningTasks.length +
    failedTasks.length +
    blockedTasks.length +
    reviewTasks.length +
    queuedTasks.length +
    waitingQuotaTasks.length;

  const dayAgoMs = nowMs - 24 * 60 * 60 * 1000;
  const done24hTasks = doneTasks.filter((t) => {
    if (!t.updatedAt) return true;
    const ut = new Date(t.updatedAt.includes('T') ? t.updatedAt : t.updatedAt.replace(' ', 'T') + 'Z').getTime();
    return isNaN(ut) || ut >= dayAgoMs;
  });

  const tasksSummary = {
    done: done24hTasks.length,
    doneTotal: doneTasks.length,
    running: runningTasks.length,
    failed: failedTasks.length,
    blocked: blockedTasks.length,
    review: reviewTasks.length,
    queued: queuedTasks.length,
    waiting_quota: waitingQuotaTasks.length,
    total: totalTasks,
  };

  // 2. Merged tasks in the last 24h
  const merged: Array<{ taskId: string; title: string; mergeCommit?: string }> = [];
  if (opts.eventRepo) {
    const recentEvents = opts.eventRepo.getRecent(200);
    const dayAgoMs = nowMs - 24 * 60 * 60 * 1000;
    for (const ev of recentEvents) {
      if (ev.type === 'task.merged') {
        const evTime = ev.ts ? new Date(ev.ts).getTime() : nowMs;
        if (evTime >= dayAgoMs) {
          const taskId = ev.taskId || '';
          const task = taskId ? opts.taskRepo.get(taskId) : null;
          const p = (ev.payload && typeof ev.payload === 'object' ? ev.payload : {}) as Record<string, unknown>;
          const mergeCommit = typeof p.mergeCommit === 'string' ? p.mergeCommit.slice(0, 7) : undefined;
          merged.push({
            taskId,
            title: task?.title || taskId || 'Task',
            mergeCommit,
          });
        }
      }
    }
  }

  // 3. Quota summary
  const profiles = opts.profileRepo ? opts.profileRepo.getAll(true) : [];
  const quotaService = opts.quotaService || (opts.profileRepo && opts.quotaMarkRepo ? new QuotaService(opts.quotaMarkRepo, opts.profileRepo) : undefined);
  const runnable = quotaService?.runnableCapacity(undefined, Math.floor(nowMs / 1000)) || [];
  const runnableProfiles = new Set(runnable.map((entry) => entry.profileName));
  const activeMarks = opts.quotaMarkRepo
    ? opts.quotaMarkRepo.getActive(Math.floor(nowMs / 1000)).filter((m) => m.until > Math.floor(nowMs / 1000))
    : [];
  const exhaustedMap = new Map<string, { family: string; until: string }>();
  for (const m of activeMarks) {
    const d = new Date(m.until * 1000);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    exhaustedMap.set(m.profileName, {
      family: m.family,
      until: `${hh}:${mm}`,
    });
  }

  const exhaustedList: Array<{ profileName: string; family: string; until: string }> = [];
  const availableList: string[] = [];

  for (const p of profiles) {
    const ex = exhaustedMap.get(p.name);
    if (ex && !runnableProfiles.has(p.name)) {
      exhaustedList.push({ profileName: p.name, ...ex });
    } else {
      availableList.push(p.name);
    }
  }

  let quotaSummary = '';
  if (profiles.length === 0) {
    quotaSummary = 'Không có tài khoản nào được cấu hình';
  } else if (runnable.length > 0 && exhaustedList.length === 0) {
    quotaSummary = `Tất cả tài khoản đều sẵn sàng (${profiles.length}/${profiles.length})`;
  } else if (runnable.length === 0) {
    quotaSummary = `Mọi tài khoản đều hết quota (0/${profiles.length}). Hệ thống tạm dừng thực thi task.`;
  } else {
    quotaSummary = `${runnable.length} tổ hợp profile/model còn chạy được`;
  }

  // Helper to extract projectId
  const getTaskProjectId = (t: { projectId?: string | null; id?: string }): string | null => {
    if (t.projectId) return t.projectId;
    if (t.id && t.id.includes('/')) return t.id.slice(0, t.id.indexOf('/'));
    return null;
  };

  const isProjectMinimal = (projectId: string | null | undefined): boolean => {
    if (!projectId || !opts.projectRepo) return false;
    const proj = opts.projectRepo.get(projectId);
    return projectSettings(proj).notifications.telegramContent === 'minimal';
  };

  // 4. Pending decisions
  const decisions: Array<{ id: string; text: string; createdAt: string; remindersCount?: number }> = [];
  if (opts.decisionTracker) {
    for (const d of opts.decisionTracker.getPending()) {
      const projId = d.taskId?.includes('/') ? d.taskId.slice(0, d.taskId.indexOf('/')) : null;
      const proj = projId && opts.projectRepo ? opts.projectRepo.get(projId) : null;
      const minimal = isProjectMinimal(projId);
      const projLabel = proj?.name || projId;
      const prefix = projLabel ? `[${projLabel}] ` : '';
      decisions.push({
        id: d.id,
        text: minimal ? `${prefix}1 việc cần quyết định` : (prefix ? `${prefix}${d.text}` : d.text),
        createdAt: new Date(d.createdAt).toISOString(),
        remindersCount: d.remindersCount,
      });
    }
  }

  // Also include escalated review tasks that require human decision
  for (const t of reviewTasks) {
    if (t.reviewerEscalated) {
      const projId = getTaskProjectId(t);
      const proj = projId && opts.projectRepo ? opts.projectRepo.get(projId) : null;
      const minimal = isProjectMinimal(projId);
      const projLabel = proj?.name || projId;
      const prefix = projLabel ? `[${projLabel}] ` : '';
      decisions.push({
        id: `review:${t.id}`,
        text: minimal ? `${prefix}1 task cần duyệt` : `${prefix}Duyệt task escalated: ${t.title || t.id}`,
        createdAt: t.updatedAt || nowIso,
      });
    }
  }

  // Format Telegram HTML text
  const projects = opts.projectRepo ? opts.projectRepo.getAll() : [];
  const projectLines: string[] = [];
  const projectMarkdownLines: string[] = [];

  if (projects.length > 0) {
    for (const proj of projects) {
      const pDone24h = done24hTasks.filter((t) => getTaskProjectId(t) === proj.id).length;
      const pRunning = runningTasks.filter((t) => getTaskProjectId(t) === proj.id).length;
      const pFailed = failedTasks.filter((t) => getTaskProjectId(t) === proj.id).length;
      const pBlocked = blockedTasks.filter((t) => getTaskProjectId(t) === proj.id).length;
      const pReview = reviewTasks.filter((t) => getTaskProjectId(t) === proj.id).length;
      const label = proj.name || proj.id;
      // Requirement 5: tóm tắt theo từng dự án + một dòng tổng; dự án minimal chỉ hiện số
      projectLines.push(
        `• <b>[${escapeHtml(label)}]</b>: Hoàn thành: <b>${pDone24h}</b> · Đang chạy: <b>${pRunning}</b> · Lỗi: <b>${pFailed}</b>${pBlocked ? ` · Bị chặn: <b>${pBlocked}</b>` : ''}${pReview ? ` · Chờ review: <b>${pReview}</b>` : ''}`
      );
      projectMarkdownLines.push(
        `- **[${label}]**: Hoàn thành: **${pDone24h}** · Đang chạy: **${pRunning}** · Lỗi: **${pFailed}**${pBlocked ? ` · Bị chặn: **${pBlocked}**` : ''}${pReview ? ` · Chờ review: **${pReview}**` : ''}`
      );
    }
  }

  const totalLine = `• <b>Tổng cộng</b>: Hoàn thành: <b>${tasksSummary.done}</b> (tổng: ${tasksSummary.doneTotal ?? tasksSummary.done}) · Đang chạy: <b>${tasksSummary.running}</b> · Lỗi: <b>${tasksSummary.failed}</b>${tasksSummary.blocked ? ` · Bị chặn: <b>${tasksSummary.blocked}</b>` : ''}${tasksSummary.review ? ` · Chờ review: <b>${tasksSummary.review}</b>` : ''}`;
  const totalMarkdownLine = `- **Tổng cộng**: Hoàn thành: **${tasksSummary.done}** (tổng: ${tasksSummary.doneTotal ?? tasksSummary.done}) · Đang chạy: **${tasksSummary.running}** · Lỗi: **${tasksSummary.failed}**${tasksSummary.blocked ? ` · Bị chặn: **${tasksSummary.blocked}**` : ''}${tasksSummary.review ? ` · Chờ review: **${tasksSummary.review}**` : ''}`;

  const taskLines = projects.length > 0
    ? [...projectLines, totalLine]
    : [
        `• Hoàn thành: <b>${tasksSummary.done}</b> (tổng: ${tasksSummary.doneTotal ?? tasksSummary.done})`,
        `• Đang chạy: <b>${tasksSummary.running}</b>`,
        `• Lỗi: <b>${tasksSummary.failed}</b>${tasksSummary.blocked ? ` (Bị chặn: <b>${tasksSummary.blocked}</b>)` : ''}${tasksSummary.review ? ` (Chờ review: <b>${tasksSummary.review}</b>)` : ''}`,
      ];

  const markdownTaskLines = projects.length > 0
    ? [...projectMarkdownLines, totalMarkdownLine].join('\n')
    : [
        `- Hoàn thành: **${tasksSummary.done}** (tổng: ${tasksSummary.doneTotal ?? tasksSummary.done})`,
        `- Đang chạy: **${tasksSummary.running}**`,
        `- Lỗi: **${tasksSummary.failed}**`,
        `- Chờ review: **${tasksSummary.review}**`,
        `- Bị chặn: **${tasksSummary.blocked}**`,
      ].join('\n');

  let mergedSection = '';
  let markdownMergedSection = '';
  if (merged.length === 0) {
    mergedSection = '• <i>Không có task nào được merge trong 24h qua</i>';
    markdownMergedSection = '_Không có task nào được merge trong 24h qua_';
  } else {
    // Count minimal merged tasks per project so we only show counts
    const minimalMergedCounts = new Map<string, number>();
    for (const m of merged) {
      const projId = m.taskId.includes('/') ? m.taskId.slice(0, m.taskId.indexOf('/')) : null;
      if (isProjectMinimal(projId) && projId) {
        minimalMergedCounts.set(projId, (minimalMergedCounts.get(projId) || 0) + 1);
      }
    }
    const renderedMinimalHtml = new Set<string>();
    const renderedMinimalMd = new Set<string>();
    const htmlLines: string[] = [];
    const mdLines: string[] = [];

    for (const m of merged.slice(0, 10)) {
      const projId = m.taskId.includes('/') ? m.taskId.slice(0, m.taskId.indexOf('/')) : null;
      const proj = projId && opts.projectRepo ? opts.projectRepo.get(projId) : null;
      const minimal = isProjectMinimal(projId);
      const label = proj?.name || projId || '';

      if (minimal && projId) {
        if (!renderedMinimalHtml.has(projId)) {
          renderedMinimalHtml.add(projId);
          const count = minimalMergedCounts.get(projId) || 1;
          htmlLines.push(`• [${escapeHtml(label)}]: ${count} task đã merge`);
        }
        if (!renderedMinimalMd.has(projId)) {
          renderedMinimalMd.add(projId);
          const count = minimalMergedCounts.get(projId) || 1;
          mdLines.push(`- [${label}]: ${count} task đã merge`);
        }
      } else {
        const prefix = label ? `[${escapeHtml(label)}] ` : '';
        htmlLines.push(`• ${prefix}<code>${escapeHtml(m.taskId)}</code>: ${escapeHtml(m.title)}${m.mergeCommit ? ` <i>(${m.mergeCommit})</i>` : ''}`);
        const mdPrefix = label ? `[${label}] ` : '';
        mdLines.push(`- ${mdPrefix}\`${m.taskId}\`: ${m.title}${m.mergeCommit ? ` (${m.mergeCommit})` : ''}`);
      }
    }

    mergedSection = htmlLines.join('\n');
    markdownMergedSection = mdLines.join('\n');
    if (merged.length > 10) {
      mergedSection += `\n• <i>... và ${merged.length - 10} task khác</i>`;
      markdownMergedSection += `\n- _... và ${merged.length - 10} task khác_`;
    }
  }

  let quotaSection = `• ${escapeHtml(quotaSummary)}`;
  if (exhaustedList.length > 0) {
    quotaSection += '\n' + exhaustedList.map((e) => `  - Hồ sơ <b>${escapeHtml(e.profileName)}</b> (${escapeHtml(e.family)}): đến ${e.until}`).join('\n');
  }

  let decisionsSection = '';
  if (decisions.length === 0) {
    decisionsSection = '• <i>Không có việc nào cần xử lý</i>';
  } else {
    decisionsSection = decisions
      .map((d) => `• [Cần quyết định] ${escapeHtml(d.text)}`)
      .join('\n');
  }

  let quietSection = '';
  if (opts.accumulatedQuietHoursMessages && opts.accumulatedQuietHoursMessages.length > 0) {
    quietSection = `\n\n🌅 <b>Tin dồn giờ yên tĩnh (${opts.accumulatedQuietHoursMessages.length}):</b>\n` +
      opts.accumulatedQuietHoursMessages.slice(0, 5).map((m) => `• ${escapeHtml(m)}`).join('\n');
    if (opts.accumulatedQuietHoursMessages.length > 5) {
      quietSection += `\n• <i>... và ${opts.accumulatedQuietHoursMessages.length - 5} tin khác</i>`;
    }
  }

  // 5. CI status per project
  const ciLines: string[] = [];
  const ciMarkdownLines: string[] = [];
  if (projects.length > 0) {
    for (const proj of projects) {
      const label = proj.name || proj.id;
      const latestRun = opts.ciRepo?.getLatest(proj.id);
      let statusText = 'Chưa có run';
      let icon = '⚪️';
      if (latestRun) {
        const wf = latestRun.workflow || 'CI';
        const sha = latestRun.sha ? ` (${latestRun.sha.slice(0, 7)})` : '';
        if (latestRun.status !== 'completed') {
          icon = '🟡';
          statusText = `Đang chạy · ${wf}${sha}`;
        } else if (latestRun.conclusion === 'success') {
          icon = '🟢';
          statusText = `Đạt · ${wf}${sha}`;
        } else if (latestRun.conclusion === 'failure') {
          icon = '🔴';
          statusText = `Thất bại · ${wf}${sha}`;
        } else {
          icon = '⚪️';
          statusText = `${latestRun.conclusion || latestRun.status} · ${wf}${sha}`;
        }
      }
      ciLines.push(`• <b>[${escapeHtml(label)}]</b>: ${icon} ${escapeHtml(statusText)}`);
      ciMarkdownLines.push(`- **[${label}]**: ${icon} ${statusText}`);
    }
  }
  const ciSection = ciLines.length > 0 ? ciLines.join('\n') : '• <i>Chưa có dự án nào</i>';
  const markdownCiSection = ciMarkdownLines.length > 0 ? ciMarkdownLines.join('\n') : '_Chưa có dự án nào_';

  const text =
    `📋 <b>TÓM TẮT HỆ THỐNG AGENTHUB</b>\n` +
    `<i>${dateStr}</i>\n\n` +
    `📊 <b>Tiến độ công việc:</b>\n${taskLines.join('\n')}\n\n` +
    `🔀 <b>Đã merge (24h):</b>\n${mergedSection}\n\n` +
    `🚦 <b>Trạng thái CI:</b>\n${ciSection}\n\n` +
    `⏳ <b>Quota tài khoản:</b>\n${quotaSection}\n\n` +
    `📌 <b>Việc cần quyết định (${decisions.length}):</b>\n${decisionsSection}${quietSection}`;

  // Markdown format for web / dashboard
  const markdown =
    `# Tóm tắt hệ thống AgentHub (${dateStr})\n\n` +
    `### Tiến độ công việc\n` +
    `${markdownTaskLines}\n\n` +
    `### Đã merge (24h)\n` +
    `${markdownMergedSection}\n\n` +
    `### Trạng thái CI\n` +
    `${markdownCiSection}\n\n` +
    `### Quota tài khoản\n` +
    `- ${quotaSummary}\n` +
    (exhaustedList.length > 0
      ? exhaustedList.map((e) => `  - ${e.profileName} (${e.family}) đến ${e.until}`).join('\n') + '\n\n'
      : '\n') +
    `### Việc cần quyết định (${decisions.length})\n` +
    (decisions.length === 0
      ? `_Không có việc nào cần xử lý_\n`
      : decisions.map((d) => `- ${d.text}`).join('\n') + '\n');

  return {
    generatedAt: nowIso,
    tasks: tasksSummary,
    merged,
    quota: {
      summary: quotaSummary,
      totalProfiles: profiles.length,
      availableProfiles: availableList,
      exhaustedProfiles: exhaustedList,
    },
    decisions,
    accumulatedQuietHoursMessages: opts.accumulatedQuietHoursMessages ? [...opts.accumulatedQuietHoursMessages] : undefined,
    text,
    markdown,
  };
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
