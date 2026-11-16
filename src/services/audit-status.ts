import type { TaskRow, ProjectRow, EventRow, ReviewRow } from '../db/index.js';
import { toApiTime } from '../db/time.js';
import { projectSettings } from '../projects/settings.js';

export interface TaskAuditFinding {
  severity: 'P1' | 'P2' | 'P3' | string;
  kind: string;
  file: string;
  line: number;
  detail: string;
}

export interface TaskAuditRoundHistory {
  round: number;
  state: 'auditing' | 'audit_passed' | 'audit_failed' | 'audit_skipped';
  substate?: 'returned_to_worker' | 'blocked';
  summary?: string | null;
  findings?: TaskAuditFinding[];
  startedAt?: string | null;
  finishedAt?: string | null;
  model?: string | null;
  engine?: string | null;
}

export interface TaskAuditInfo {
  state: 'auditing' | 'audit_failed' | 'audit_passed' | 'audit_skipped';
  substate?: 'returned_to_worker' | 'blocked';
  rounds: number;
  maxRounds: number;
  summary?: string | null;
  findings: TaskAuditFinding[];
  startedAt?: string | null;
  finishedAt?: string | null;
  model?: string | null;
  engine?: string | null;
  blockedByTaskId?: string | null;
  blockedByTask?: string | null;
  history?: TaskAuditRoundHistory[];
}

export type DerivedAuditStatus = 'auditing' | 'audit_failed' | 'audit_passed' | 'audit_skipped';

function parseJsonSafely<T = Record<string, unknown>>(raw: unknown): T | null {
  if (!raw) return null;
  if (typeof raw === 'object') return raw as T;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }
  return null;
}

export function computeTaskAudit(
  task: TaskRow,
  events: EventRow[],
  project?: ProjectRow | null,
  reviews?: ReviewRow[],
): TaskAuditInfo | null {
  if (project) {
    const settings = projectSettings(project);
    if (settings.publish?.audit?.enabled === false) {
      return null;
    }
  }

  const defaultMaxRounds = project ? (projectSettings(project).publish?.audit?.maxFixRounds ?? 2) : 2;

  const pr = parseJsonSafely<Record<string, unknown>>(task.pushResult);

  // Filter task-relevant events in chronological order
  const taskEvents = [...events].sort((a, b) => {
    const ta = new Date(a.ts).getTime();
    const tb = new Date(b.ts).getTime();
    return ta - tb;
  });

  const auditEvents = taskEvents.filter((e) =>
    e.type === 'task.auditing' ||
    e.type === 'task.audit_started' ||
    e.type === 'task.audit_passed' ||
    e.type === 'task.audit_failed' ||
    e.type === 'task.audit_skipped' ||
    e.type === 'task.pushed' ||
    e.type === 'task.push_failed'
  );

  const lastAuditEvent = auditEvents.filter((e) =>
    e.type === 'task.auditing' ||
    e.type === 'task.audit_started' ||
    e.type === 'task.audit_passed' ||
    e.type === 'task.audit_failed' ||
    e.type === 'task.audit_skipped'
  ).at(-1);

  // Check if task has any audit trace at all
  const hasAuditPr = Boolean(
    pr &&
    (pr.state === 'auditing' ||
      pr.auditFailed === true ||
      pr.auditPassed === true ||
      pr.auditSkipped === true ||
      pr.blockedByTaskId ||
      pr.blockedByTask ||
      typeof pr.auditFixRounds === 'number')
  );

  const hasAuditEvents = auditEvents.some((e) =>
    e.type === 'task.auditing' ||
    e.type === 'task.audit_started' ||
    e.type === 'task.audit_passed' ||
    e.type === 'task.audit_failed' ||
    e.type === 'task.audit_skipped'
  );

  const auditReviews = (reviews || []).filter((r) => r.actor === 'audit-prepublish');

  if (!hasAuditPr && !hasAuditEvents && auditReviews.length === 0) {
    return null;
  }

  // 1. Determine current state
  let state: DerivedAuditStatus | null = null;
  let substate: 'returned_to_worker' | 'blocked' | undefined = undefined;

  const isTerminalCancelledOrFailed = task.status === 'cancelled' || task.status === 'failed';
  const isPushed = task.status === 'pushed' || Boolean(task.pushedAt);

  // Check if actively auditing
  const prIsAuditing = pr?.state === 'auditing';
  const lastIsAuditStarted = lastAuditEvent && (lastAuditEvent.type === 'task.auditing' || lastAuditEvent.type === 'task.audit_started');

  if (prIsAuditing || (lastIsAuditStarted && !isTerminalCancelledOrFailed && !isPushed)) {
    // If subsequent audit result or push happened after startedAt, it's no longer auditing
    const startedAtRaw = (pr?.startedAt as string) || (lastAuditEvent ? lastAuditEvent.ts : null);
    const startedAtTs = startedAtRaw ? new Date(startedAtRaw).getTime() : 0;

    let hasSubsequentResult = false;
    if (startedAtTs > 0) {
      for (const ev of auditEvents) {
        const evTs = new Date(ev.ts).getTime();
        if (evTs > startedAtTs && (ev.type === 'task.audit_passed' || ev.type === 'task.audit_failed' || ev.type === 'task.pushed')) {
          hasSubsequentResult = true;
          break;
        }
      }
    }

    if (!hasSubsequentResult && !isTerminalCancelledOrFailed && !isPushed) {
      state = 'auditing';
    }
  }

  // Check skipped
  if (!state) {
    if (pr?.auditSkipped === true || (lastAuditEvent && lastAuditEvent.type === 'task.audit_skipped')) {
      // `task.audit_skipped` is emitted before the successful push. The
      // pushResult flag is the durable verdict and must not be invalidated by
      // the later `task.pushed` event.
      state = 'audit_skipped';
    }
  }

  // Check failed or passed
  if (!state) {
    // Determine the most recent audit verdict
    let lastVerdictTs = 0;
    let lastVerdictType: 'passed' | 'failed' | null = null;
    let lastVerdictPayload: Record<string, unknown> | null = null;

    for (const ev of auditEvents) {
      if (ev.type === 'task.audit_passed') {
        const ts = new Date(ev.ts).getTime();
        if (ts >= lastVerdictTs) {
          lastVerdictTs = ts;
          lastVerdictType = 'passed';
          lastVerdictPayload = parseJsonSafely<Record<string, unknown>>(ev.payload);
        }
      } else if (ev.type === 'task.audit_failed') {
        const ts = new Date(ev.ts).getTime();
        if (ts >= lastVerdictTs) {
          lastVerdictTs = ts;
          lastVerdictType = 'failed';
          lastVerdictPayload = parseJsonSafely<Record<string, unknown>>(ev.payload);
        }
      }
    }

    // Also compare with pushResult
    let prVerdictType: 'passed' | 'failed' | null = null;
    let prVerdictTs = 0;
    if (pr?.auditPassed === true) {
      prVerdictType = 'passed';
      prVerdictTs = pr.finishedAt ? new Date(pr.finishedAt as string).getTime() : (task.pushedAt ? new Date(task.pushedAt).getTime() : 0);
    } else if (pr?.auditFailed === true || pr?.blockedByTaskId || pr?.blockedByTask) {
      prVerdictType = 'failed';
      prVerdictTs = pr.failedAt ? new Date(pr.failedAt as string).getTime() : (task.updatedAt ? new Date(task.updatedAt).getTime() : 0);
    }

    const effectiveVerdictType = prVerdictTs > lastVerdictTs ? prVerdictType : (lastVerdictType || prVerdictType);

    if (effectiveVerdictType === 'passed') {
      state = 'audit_passed';
    } else if (effectiveVerdictType === 'failed' && !isTerminalCancelledOrFailed && !isPushed) {
      state = 'audit_failed';

      // Distinguish returned_to_worker vs blocked
      const exceededMaxRounds = pr?.exceededMaxRounds === true || lastVerdictPayload?.exceededMaxRounds === true;
      const isBlockedByOther = Boolean(pr?.blockedByTaskId || pr?.blockedByTask);
      const isIndeterminateFail = pr?.state === 'push_failed' && pr?.retryable === true && !pr?.auditFixRounds && (!pr.findings || (Array.isArray(pr.findings) && pr.findings.length === 0));
      const isExecutionError = Boolean(pr?.error && pr?.retryable === true && !pr?.findings && pr?.auditFailed);

      const auditRoundsFromPr = typeof pr?.auditFixRounds === 'number' ? pr.auditFixRounds : undefined;
      const roundsFromReviews = auditReviews.length;
      const computedRounds = auditRoundsFromPr ?? (roundsFromReviews > 0 ? roundsFromReviews : 1);
      const maxRounds = typeof pr?.maxFixRounds === 'number' ? pr.maxFixRounds : defaultMaxRounds;

      if (exceededMaxRounds || isBlockedByOther || isIndeterminateFail || isExecutionError || computedRounds > maxRounds) {
        substate = 'blocked';
      } else {
        substate = 'returned_to_worker';
      }
    } else if (effectiveVerdictType === 'failed' && isPushed) {
      // If task was already pushed, it cannot be currently audit_failed
      state = 'audit_passed';
    }
  }

  if (!state) {
    if (isPushed && (pr?.auditPassed || auditEvents.some((e) => e.type === 'task.audit_passed'))) {
      state = 'audit_passed';
    } else {
      return null;
    }
  }

  // 2. Compute rounds and maxRounds
  const maxRounds = typeof pr?.maxFixRounds === 'number' ? pr.maxFixRounds : defaultMaxRounds;
  const auditRoundsFromPr = typeof pr?.auditFixRounds === 'number' ? pr.auditFixRounds : undefined;
  const roundsFromReviews = auditReviews.length;
  let rounds = auditRoundsFromPr ?? (roundsFromReviews > 0 ? roundsFromReviews : 1);
  if (state === 'audit_passed') {
    rounds = Math.max(1, roundsFromReviews + 1);
  }

  // 3. Extract summary and findings
  let summary: string | null = null;
  let findings: TaskAuditFinding[] = [];
  let model: string | null = (pr?.model as string) || null;
  let engine: string | null = (pr?.engine as string) || null;
  let startedAt: string | null = (pr?.startedAt as string) || null;
  let finishedAt: string | null = (pr?.failedAt as string) || null;

  if (pr?.summary && typeof pr.summary === 'string') {
    summary = pr.summary;
  }
  if (Array.isArray(pr?.findings)) {
    findings = pr.findings as TaskAuditFinding[];
  }

  // Check last relevant audit event for summary/findings/model/engine
  const lastRelevantEvent = auditEvents.filter((e) => e.type === 'task.audit_passed' || e.type === 'task.audit_failed').at(-1);
  if (lastRelevantEvent) {
    const payload = parseJsonSafely<Record<string, unknown>>(lastRelevantEvent.payload);
    if (payload) {
      if (!summary && typeof payload.summary === 'string') summary = payload.summary;
      if (findings.length === 0 && Array.isArray(payload.findings)) findings = payload.findings as TaskAuditFinding[];
      if (!model && typeof payload.model === 'string') model = payload.model;
      if (!engine && typeof payload.engine === 'string') engine = payload.engine;
      if (!finishedAt) finishedAt = toApiTime(lastRelevantEvent.ts) || lastRelevantEvent.ts;
    }
  }

  if (!startedAt) {
    const startEvent = auditEvents.filter((e) => e.type === 'task.audit_started' || e.type === 'task.auditing').at(-1);
    if (startEvent) {
      startedAt = toApiTime(startEvent.ts) || startEvent.ts;
    }
  }

  if (!engine && auditReviews.length > 0) {
    const lastRev = auditReviews.at(-1);
    if (lastRev?.engine) engine = lastRev.engine;
  }

  // Reconstruct history
  const history: TaskAuditRoundHistory[] = [];
  let currentRoundNum = 1;

  for (const ev of auditEvents) {
    if (ev.type === 'task.audit_failed') {
      const p = parseJsonSafely<Record<string, unknown>>(ev.payload);
      const isExceeded = p?.exceededMaxRounds === true;
      history.push({
        round: (p?.auditFixRounds as number) || (p?.round as number) || currentRoundNum,
        state: 'audit_failed',
        substate: isExceeded ? 'blocked' : 'returned_to_worker',
        summary: (p?.summary as string) || null,
        findings: Array.isArray(p?.findings) ? (p?.findings as TaskAuditFinding[]) : [],
        startedAt: (p?.startedAt as string) || startedAt,
        finishedAt: toApiTime(ev.ts) || ev.ts,
        model: (p?.model as string) || model,
        engine: (p?.engine as string) || engine,
      });
      currentRoundNum++;
    } else if (ev.type === 'task.audit_passed') {
      const p = parseJsonSafely<Record<string, unknown>>(ev.payload);
      history.push({
        round: currentRoundNum,
        state: 'audit_passed',
        summary: (p?.summary as string) || null,
        findings: Array.isArray(p?.findings) ? (p?.findings as TaskAuditFinding[]) : [],
        startedAt: (p?.startedAt as string) || startedAt,
        finishedAt: toApiTime(ev.ts) || ev.ts,
        model: (p?.model as string) || model,
        engine: (p?.engine as string) || engine,
      });
    }
  }

  // If history is empty but we have audit info in pushResult
  if (history.length === 0 && (state === 'audit_failed' || state === 'audit_passed' || state === 'auditing')) {
    history.push({
      round: rounds,
      state,
      substate,
      summary,
      findings,
      startedAt,
      finishedAt,
      model,
      engine,
    });
  }

  return {
    state,
    ...(substate ? { substate } : {}),
    rounds,
    maxRounds,
    summary,
    findings,
    startedAt: toApiTime(startedAt) || startedAt,
    finishedAt: toApiTime(finishedAt) || finishedAt,
    model,
    engine,
    blockedByTaskId: (pr?.blockedByTaskId as string) || null,
    blockedByTask: (pr?.blockedByTask as string) || null,
    history,
  };
}

export function getDerivedAuditStatus(
  task: TaskRow,
  events: EventRow[],
  project?: ProjectRow | null,
  reviews?: ReviewRow[],
): DerivedAuditStatus | null {
  const audit = computeTaskAudit(task, events, project, reviews);
  return audit ? audit.state : null;
}
