import { Locale, translations, getNestedValue } from '../locales';
import { getActiveLocale } from './apiError';

export const ALL_BACKEND_EVENT_TYPES: string[] = [
  'batch.created',
  'batch.discarded',
  'batch.dispatched',
  'brain.department_summary',
  'brain.digest',
  'brain.directive_added',
  'brain.limited',
  'brain.morning_summary',
  'brain.notify',
  'brain.question_asked',
  'brain.status',
  'brain.trust_changed',
  'brain.updated',
  'brain.waiting',
  'chat.compacted',
  'chat.delta',
  'chat.done',
  'chat.error',
  'chat.limit_cancelled',
  'chat.limit_waiting',
  'chat.message',
  'chat.permission',
  'chat.permission_request',
  'chat.permission_resolved',
  'chat.queued',
  'chat.status',
  'chat.tool',
  'ci.failed',
  'ci.passed',
  'claude.auto_resumed',
  'claude.failover_cleared',
  'claude.failover_enabled',
  'claude.fallback_changed',
  'claude.quota_available',
  'claude.quota_exhausted',
  'config.updated',
  'daemon.shutdown_requested',
  'decision.answered',
  'deploy.failed',
  'deploy.restart_waiting',
  'deploy.restarting',
  'deploy.started',
  'deploy.succeeded',
  'disk.docker_low',
  'disk.low',
  'disk.ok',
  'focus.changed',
  'load.high',
  'load.ok',
  'load.task_paused',
  'load.task_resumed',
  'merge.conflict',
  'merge.failed',
  'profile.auth_expired',
  'profile.check',
  'profile.created',
  'profile.deleted',
  'profile.updated',
  'project.available',
  'project.unavailable',
  'quota.cleared',
  'quota.exhausted',
  'reference.modified',
  'review.completed',
  'review.escalated',
  'review.failed',
  'review.fallback',
  'review.gate_completed',
  'review.gate_ready',
  'review.gate_started',
  'review.started',
  'review.waiting',
  'run.crashed',
  'run.output',
  'run.stalled',
  'run.timeout_deferred',
  'scheduler.paused',
  'scheduler.resumed',
  'setup.install_done',
  'setup.install_progress',
  'setup.install_refresh_error',
  'task.blocked',
  'task.cancelled',
  'task.checking',
  'task.done',
  'task.failed',
  'task.looping',
  'task.merged',
  'task.model_skipped',
  'task.no_commit',
  'task.note',
  'task.overlap',
  'task.paused',
  'task.pause_reminder',
  'task.queued',
  'task.resumed',
  'task.review_ready',
  'task.running',
  'task.timeout',
  'task.updated',
  'task.waiting_quota',
  'telegram.pairing_failed',
  'worktree.cleaned',
  'worktree.hook',
  'worktree.install_failed',
];

/**
 * Fallback formatter for unknown event types.
 * Turns "task.queued" into "Task · queued", "deploy.restart_waiting" into "Deploy · restart_waiting"
 */
export function fallbackFormatEventType(type: string): string {
  if (!type) return '';
  const parts = type.split('.');
  if (parts.length <= 1) {
    return type.charAt(0).toUpperCase() + type.slice(1);
  }
  const prefix = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
  const rest = parts.slice(1).join(' · ');
  return `${prefix} · ${rest}`;
}

/**
 * Returns localized event label for any SSE event type.
 * If the event type is not in the translation dictionary, returns a pretty-printed fallback
 * (e.g. "Task · queued") instead of the raw technical key.
 */
export function formatEventType(type: string | undefined | null, locale?: Locale): string {
  if (!type) return '';
  const loc = locale || getActiveLocale();
  const dict = translations[loc] || translations.vi;

  const text = getNestedValue(dict, `events.${type}`) || getNestedValue(translations.vi, `events.${type}`);
  if (text) {
    return text;
  }

  return fallbackFormatEventType(type);
}

/**
 * Returns localized check name (e.g. "zero-byte" -> "File rỗng (0 bytes)", "lint" -> "Kiểm tra lint").
 * Falls back to the check's original name if unmapped.
 */
export function formatCheckName(name: string | undefined | null, locale?: Locale): string {
  if (!name) return '';
  const loc = locale || getActiveLocale();
  const dict = translations[loc] || translations.vi;

  const text = getNestedValue(dict, `checks.${name}`) || getNestedValue(translations.vi, `checks.${name}`);
  if (text) {
    return text;
  }
  return name;
}

/**
 * Returns localized reason text for task waiting, review waiting, or failover.
 * Falls back to the raw reason if unmapped.
 */
export function formatReason(reason: string | undefined | null, locale?: Locale): string {
  if (!reason) return '';
  const loc = locale || getActiveLocale();
  const dict = translations[loc] || translations.vi;

  const text = getNestedValue(dict, `reasons.${reason}`) || getNestedValue(translations.vi, `reasons.${reason}`);
  if (text) {
    return text;
  }
  return reason;
}

/**
 * Specialized helper for review waiting reasons (e.g. lock_busy, quota, department_claude_budget).
 */
export function formatReviewWaitingReason(reason: string | undefined | null, locale?: Locale): string {
  return formatReason(reason, locale);
}
