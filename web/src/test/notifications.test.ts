import { describe, expect, it, beforeEach, vi } from 'vitest';
import { browserNotificationBody, notifyBrowserEvent, shouldNotifyBrowserEvent } from '../notifications';
import { EventItem } from '../types/api';

const event = (type: string, payload: Record<string, unknown> = {}): EventItem => ({
  id: 1, ts: new Date().toISOString(), type, taskId: null, payload,
});

describe('browser notification policy', () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      value: class MockNotification {
        static permission = 'granted';
        constructor() {}
      },
    });
  });

  it('does not turn background SSE events into browser notifications', () => {
    expect(shouldNotifyBrowserEvent(event('run.output'), 'all')).toBe(false);
    expect(shouldNotifyBrowserEvent(event('deploy.restart_waiting'), 'all')).toBe(false);
    expect(shouldNotifyBrowserEvent(event('claude.quota_available'), 'all')).toBe(false);
    expect(shouldNotifyBrowserEvent(event('brain.updated'), 'all')).toBe(false);
  });

  it('requires engine-wide quota exhaustion at important level', () => {
    expect(shouldNotifyBrowserEvent(event('quota.exhausted', { profile: 'g1' }), 'important')).toBe(false);
    expect(shouldNotifyBrowserEvent(event('quota.exhausted', { allExhausted: true }), 'important')).toBe(false);
    expect(shouldNotifyBrowserEvent(event('quota.exhausted', { allExhausted: true, engine: 'agy', family: 'gemini' }), 'important')).toBe(true);
    expect(shouldNotifyBrowserEvent(event('quota.exhausted', { profile: 'g1' }), 'all')).toBe(false);
    expect(shouldNotifyBrowserEvent(event('quota.exhausted', { allExhausted: true }), 'all')).toBe(false);
    expect(shouldNotifyBrowserEvent(event('quota.exhausted', { allExhausted: true, engine: 'agy', family: 'gemini' }), 'all')).toBe(true);
  });

  it('derives engine-wide quota from enabled profiles and normalized families', () => {
    const profiles = [
      { name: 'g1', engine: 'agy', enabled: true, quotaMarks: [{ family: 'gemini', until: 2_000 }] },
      { name: 'g2', engine: 'agy', enabled: true, quotaMarks: [{ family: 'gemini', until: 2_000 }] },
      { name: 'c1', engine: 'codex', enabled: true, quotaMarks: [] },
    ];
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    expect(shouldNotifyBrowserEvent(event('quota.exhausted', { engine: 'agy', family: 'gemini-2.5' }), 'important', profiles)).toBe(true);
    expect(shouldNotifyBrowserEvent(event('quota.exhausted', { engine: 'codex', family: 'codex' }), 'important', profiles)).toBe(false);
    vi.restoreAllMocks();
  });

  it('throttles changing disk messages by state for one hour', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    notifyBrowserEvent(event('disk.low', { freeGB: 1, minFreeGB: 3 }), 'all');
    notifyBrowserEvent(event('disk.low', { freeGB: 0.5, minFreeGB: 3 }), 'all');
    expect(localStorage.length).toBe(1);
    now.mockRestore();
  });

  it('requires the disk hysteresis margin before browser recovery notification', () => {
    expect(shouldNotifyBrowserEvent(event('disk.low', { freeGB: 4, minFreeGB: 3 }), 'all')).toBe(false);
    expect(shouldNotifyBrowserEvent(event('disk.ok', { freeGB: 3.5, minFreeGB: 3 }), 'all')).toBe(false);
    expect(shouldNotifyBrowserEvent(event('disk.ok', { freeGB: 4, minFreeGB: 3 }), 'all')).toBe(true);
  });

  it('shares the desktop load-summary window across pause and load event types', () => {
    notifyBrowserEvent(event('task.paused', { reason: 'load' }), 'all');
    notifyBrowserEvent(event('load.task_paused', { reason: 'load' }), 'all');
    notifyBrowserEvent(event('load.high', { cpu: 99 }), 'all');
    expect(localStorage.length).toBe(1);
  });

  it('keeps engine and family quota notifications independent', () => {
    notifyBrowserEvent(event('quota.exhausted', { allExhausted: true, engine: 'agy', family: 'gemini' }), 'all');
    notifyBrowserEvent(event('quota.exhausted', { allExhausted: true, engine: 'codex', family: 'codex' }), 'all');
    expect(localStorage.length).toBe(2);
  });

  it('uses the same grouped body for the load/pause notification family', () => {
    expect(browserNotificationBody(event('load.high'))).toContain('tải cao');
    expect(browserNotificationBody(event('task.paused'))).toBe(browserNotificationBody(event('load.task_paused')));
  });

  it('applies quiet hours and automatic brain mode before browser delivery', () => {
    const duringQuietHours = new Date(2026, 0, 1, 23, 30).toISOString();
    expect(shouldNotifyBrowserEvent(
      { ...event('task.failed'), ts: duringQuietHours },
      'all',
      [],
      { quietHours: { enabled: true, start: '22:00', end: '07:00' } },
    )).toBe(false);
    expect(shouldNotifyBrowserEvent(
      event('task.failed'),
      'all',
      [],
      { brainMode: 'auto' },
    )).toBe(false);
    expect(shouldNotifyBrowserEvent(
      event('brain.notify', { text: 'Cần chú ý' }),
      'all',
      [],
      { brainMode: 'auto' },
    )).toBe(true);
  });

  it('suppresses routine merge conflict and auto-fix browser notifications', () => {
    // Routine conflicts 1 to 3 auto-reassigned: false
    expect(shouldNotifyBrowserEvent(event('merge.conflict', { conflictCount: 1, autoRetried: true }))).toBe(false);
    expect(shouldNotifyBrowserEvent(event('merge.conflict', { conflictCount: 2, autoRetried: true }))).toBe(false);
    expect(shouldNotifyBrowserEvent(event('merge.conflict', { conflictCount: 3, autoRetried: true }))).toBe(false);

    // Conflict 4: true
    const ev4 = { ...event('merge.conflict', { conflictCount: 4, autoRetried: false, files: 'file1.ts, file2.ts' }), taskId: 'p/task-1' };
    expect(shouldNotifyBrowserEvent(ev4)).toBe(true);
    expect(browserNotificationBody(ev4)).toBe('⚠️ p/task-1 xung đột merge lần thứ 4, cần xem: file1.ts, file2.ts');

    // Cannot auto-reassign: true
    const evCannot = { ...event('merge.conflict', { conflictCount: 1, autoRetried: false, message: 'bad.ts' }), taskId: 'p/task-cancel' };
    expect(shouldNotifyBrowserEvent(evCannot)).toBe(true);
    expect(browserNotificationBody(evCannot)).toBe('⚠️ p/task-cancel xung đột merge lần thứ 1, cần xem: bad.ts');

    // merge.failed with autoFixCreated: false
    expect(shouldNotifyBrowserEvent(event('merge.failed', { autoFixCreated: true }))).toBe(false);

    // merge.failed without autoFixCreated: true
    expect(shouldNotifyBrowserEvent(event('merge.failed', { autoFixCreated: false, environment: true }))).toBe(true);

    // -fix-merge task: false
    expect(shouldNotifyBrowserEvent({ ...event('task.queued'), taskId: 'p/task-fix-merge' })).toBe(false);
  });
});
