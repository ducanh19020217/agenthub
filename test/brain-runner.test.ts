import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BrainRunner, buildBrainTicketWorkflowInstruction } from '../src/brain/runner.js';
import { BrainTurnRepo, ChatSessionRepo, DepartmentRepo, KnowledgeRepo, ProfileRepo, ProjectRepo, openDatabase } from '../src/db/index.js';
import { EventBus } from '../src/scheduler/index.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function setup(mode: 'suggest' | 'auto' = 'suggest', options: { maxConcurrent?: number; dailyTokenBudget?: number; projectSettings?: Record<string, string>; permissions?: 'standard' | 'trusted' | 'full'; setSessionMode?: (id: string, mode: 'safe' | 'full') => void; failFirstSend?: boolean; departments?: boolean; wakeupEvents?: string[]; batchWindowSec?: number; rotateAtTokens?: number; rotateAfterTurns?: number; compactSession?: (id: string) => Promise<unknown> } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-brain-runner-'));
  dirs.push(dir);
  const db = openDatabase(path.join(dir, 'hub.db'));
  const sessions = new ChatSessionRepo(db);
  const turns = new BrainTurnRepo(db);
  const profiles = new ProfileRepo(db);
  const projects = new ProjectRepo(db);
  const departments = new DepartmentRepo(db);
  const knowledge = new KnowledgeRepo(db);
  for (const id of Object.keys(options.projectSettings || {})) {
    projects.insert({ id, name: id.toUpperCase(), path: dir, defaultBranch: 'main', envTemplate: null, maxParallel: 1, settings: options.projectSettings?.[id] });
  }
  const events = new EventBus({ insert: () => 0 } as never);
  const sent: string[] = [];
  const chat = {
    getOrCreateSession(id: string, body: { title?: string; mode?: 'safe' | 'full'; model?: string; profileName?: string; kind?: 'chat' | 'brain' }) {
      const projectId = id.startsWith('brain:') && !id.startsWith('brain:department:') && id !== 'brain:director' ? id.slice('brain:'.length) : null;
      if (!sessions.get(id)) sessions.insert({ id, title: body.title, mode: body.mode, model: body.model, profileName: body.profileName, kind: body.kind, projectId });
      return sessions.get(id)!;
    },
    setSessionMode: options.setSessionMode,
    compactSession: options.compactSession,
    sendMessage(_id: string, text: string) {
      if (options.failFirstSend) {
        options.failFirstSend = false;
        throw new Error('send failed');
      }
      sent.push(`${_id}: ${text}`); return { userMessageId: 'u', assistantMessageId: 'a' };
    },
  };
  const brainConfig = { fallback: [], policy: [], claudeProfile: 'p', model: 'opus', mode, permissions: options.permissions ?? 'standard', maxConcurrent: options.maxConcurrent ?? 2, maxTurnsPerHour: 20, dailyTokenBudget: options.dailyTokenBudget ?? 0, wakeupEvents: options.wakeupEvents, batchWindowSec: options.batchWindowSec, rotateAtTokens: options.rotateAtTokens, rotateAfterTurns: options.rotateAfterTurns } as const;
  const runner = new BrainRunner({
    config: brainConfig,
    eventBus: events,
    chatService: chat,
    chatSessionRepo: sessions,
    profileRepo: profiles,
    turnRepo: turns,
    debounceMs: 60_000,
    projectRepo: projects,
    departmentRepo: options.departments ? departments : undefined,
    knowledgeRepo: knowledge,
    compactSession: options.compactSession,
  });
  return { db, sessions, turns, profiles, projects, departments, knowledge, events, sent, runner };
}

describe('BrainRunner', () => {
  it('skips routine events and wakes for configured important events', () => {
    const ctx = setup('suggest', { wakeupEvents: ['task.failed'] });
    ctx.runner.start();
    ctx.events.emit('task.done', 'p/done');
    ctx.events.emit('load.high', undefined, { load: 99 });
    expect(ctx.runner.getQueuedEvents()).toHaveLength(0);
    expect(ctx.runner.getUsage(null).eventsSkippedToday).toBe(2);
    ctx.events.emit('task.failed', 'p/failed');
    expect(ctx.runner.getQueuedEvents()).toHaveLength(1);
  });

  it('batches events in one turn and shortens the delay for priority events', () => {
    const ctx = setup('suggest', { wakeupEvents: ['task.failed', 'task.blocked'], batchWindowSec: 300 });
    ctx.runner.start();
    ctx.events.emit('task.failed', 'p/one');
    ctx.events.emit('task.blocked', 'p/two');
    ctx.runner.flush();
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0]).toContain('task.failed');
    expect(ctx.sent[0]).toContain('task.blocked');
    expect(ctx.runner.getUsage(null).eventsBatchedToday).toBe(2);
  });

  it('rotates an overgrown session after a turn and keeps compact as the summary mechanism', async () => {
    const compacted: string[] = [];
    const ctx = setup('suggest', { wakeupEvents: ['task.failed'], rotateAtTokens: 10, compactSession: async (id) => { compacted.push(id); } });
    ctx.runner.start();
    const session = ctx.sessions.get('brain')!;
    ctx.db.prepare('UPDATE chat_sessions SET contextTokens = 11 WHERE id = ?').run(session.id);
    ctx.events.emit('task.failed', 'p/fail');
    ctx.runner.flush();
    ctx.events.emit('chat.done', undefined, { sessionId: 'brain', usage: {} });
    await Promise.resolve();
    expect(compacted).toEqual(['brain']);
    expect(ctx.runner.getUsage(null).rotationsToday).toBe(1);
  });

  it('does not wake for a routine merge conflict but wakes after the fourth conflict', () => {
    const ctx = setup('suggest', { wakeupEvents: ['merge.conflict'] });
    ctx.runner.start();
    ctx.events.emit('merge.conflict', 'p/task', { conflictCount: 3 });
    expect(ctx.runner.getQueuedEvents()).toHaveLength(0);
    ctx.events.emit('merge.conflict', 'p/task', { conflictCount: 4 });
    expect(ctx.runner.getQueuedEvents()).toHaveLength(1);
  });
  it('creates one pinned brain session and aggregates events', () => {
    const ctx = setup();
    ctx.runner.start();
    ctx.events.emit('task.review_ready', 'p/task', { title: 'T' });
    ctx.events.emit('task.done', 'p/other');
    ctx.runner.flush();
    expect(ctx.sessions.get('brain')).toMatchObject({ kind: 'brain', pinned: 1, model: 'opus' });
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0]).toContain('task.review_ready');
    expect(ctx.sent[0]).toContain('Chế độ suggest');
  });

  it('deduplicates quota keys in one brain turn', () => {
    const ctx = setup();
    ctx.runner.start();
    for (let i = 0; i < 30; i += 1) {
      ctx.events.emit('quota.exhausted', `p/task-${i}`, { profile: 'g1', family: 'gemini' });
    }
    ctx.runner.flush();
    const prompt = ctx.sent[0];
    expect(prompt.match(/quota\.exhausted/g)).toHaveLength(1);
  });

  it('injects project knowledge once, repeats it after content change or compact', () => {
    const ctx = setup('suggest', { projectSettings: { p: '{"references":[]}' } });
    ctx.knowledge.insert({ projectId: 'p', taskId: 'manual/p', content: 'Pinned rule', pinned: true });
    ctx.runner.start();
    ctx.events.emit('task.done', 'p/one');
    ctx.runner.flush();
    expect(ctx.sent[0]).toContain('Pinned rule');
    ctx.events.emit('chat.done', undefined, { sessionId: 'brain:p', usage: {} });
    ctx.knowledge.insert({ projectId: 'p', taskId: 'manual/p', content: 'New rule', pinned: true });
    ctx.events.emit('task.done', 'p/two');
    ctx.runner.flush();
    expect(ctx.sent[1]).toContain('New rule');
    ctx.events.emit('chat.done', undefined, { sessionId: 'brain:p', usage: {} });
    ctx.events.emit('chat.compacted', undefined, { sessionId: 'brain:p' });
    ctx.events.emit('task.done', 'p/three');
    ctx.runner.flush();
    expect(ctx.sent[2]).toContain('Pinned rule');
  });

  it('puts the project review checklist in the brain prompt', () => {
    const ctx = setup('suggest', { projectSettings: { p: '{"reviewChecklist":["docs/checklist.md"]}' } });
    ctx.runner.start();
    ctx.events.emit('task.review_ready', 'p/task');
    ctx.runner.flush();
    expect(ctx.sent[0]).toContain('docs/checklist.md');
    expect(ctx.sent[0]).toContain('CHECKLIST KHI DUYỆT');
  });

  it('does not mark knowledge as sent when sending the first turn fails', () => {
    const ctx = setup('suggest', { failFirstSend: true, projectSettings: { p: '{}' } });
    ctx.knowledge.insert({ projectId: 'p', taskId: 'manual/p', content: 'Retry rule', pinned: true });
    ctx.runner.start();
    ctx.events.emit('task.done', 'p/first');
    ctx.runner.flush();
    expect(ctx.sent[0]).toContain('Retry rule');
  });

  it('does not overlap a user turn and preserves events after quota', () => {
    const ctx = setup('auto');
    ctx.runner.start();
    ctx.events.emit('chat.message', undefined, { sessionId: 'brain', role: 'user' });
    ctx.events.emit('task.failed', 'p/task');
    ctx.runner.flush();
    expect(ctx.sent).toHaveLength(0);
    ctx.events.emit('chat.done', undefined, { sessionId: 'brain', usage: { inputTokens: 1, outputTokens: 1 } });
    ctx.runner.flush();
    expect(ctx.sent).toHaveLength(1);
    ctx.events.emit('chat.error', undefined, { sessionId: 'brain', message: 'RESOURCE_EXHAUSTED quota' });
    expect(ctx.runner.getQueuedEvents()).toHaveLength(1);
  });

  it('keeps the legacy Claude system profile for a brain session without explicit config', () => {
    const ctx = setup();
    ctx.profiles.upsert({ name: 'claude-may', engine: 'claude', kind: 'system', home: os.homedir(), email: null, enabled: 1 });
    ctx.runner.start();
    expect(ctx.sessions.get('brain')?.profileName).toBe('claude-may');
  });

  it('routes project events to separate pinned sessions and system incidents to brain', () => {
    const ctx = setup('suggest', { projectSettings: { p1: '{}', p2: '{}' }, maxConcurrent: 3 });
    ctx.runner.start();
    ctx.events.emit('task.done', 'p1/task');
    ctx.events.emit('task.done', 'p2/task');
    ctx.events.emit('disk.low', undefined, { freeGB: 1 });
    ctx.runner.flush();
    expect(ctx.sent).toHaveLength(3);
    expect(ctx.sessions.get('brain:p1')).toMatchObject({ projectId: 'p1', pinned: 1, title: 'Bộ não · P1' });
    expect(ctx.sessions.get('brain:p2')).toMatchObject({ projectId: 'p2', pinned: 1, title: 'Bộ não · P2' });
    expect(ctx.sessions.get('brain')).toMatchObject({ projectId: null, pinned: 1 });
  });

  it('skips off/external projects and inherits the global mode', () => {
    const ctx = setup('auto', { projectSettings: { off: '{"brain":{"mode":"off"}}', external: '{"brain":{"mode":"external"}}', inherited: '{"brain":{"mode":"inherit"}}' }, maxConcurrent: 2 });
    ctx.runner.start();
    ctx.events.emit('task.done', 'off/task');
    ctx.events.emit('task.done', 'external/task');
    ctx.events.emit('task.done', 'inherited/task');
    ctx.runner.flush();
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0]).toContain('brain:inherited');
    expect(ctx.sessions.get('brain:off')).toBeUndefined();
    expect(ctx.sessions.get('brain:external')).toBeUndefined();
  });

  it('uses round-robin scheduling when one project is busy', () => {
    const ctx = setup('suggest', { projectSettings: { p1: '{}', p2: '{}' }, maxConcurrent: 1 });
    ctx.runner.start();
    ctx.sessions.insert({ id: 'brain:p1', projectId: 'p1', title: 'P1', kind: 'brain', busy: 1 });
    ctx.events.emit('task.done', 'p1/first');
    ctx.events.emit('task.done', 'p2/second');
    ctx.runner.flush();
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0]).toContain('task.done (p2/second)');
  });

  it('applies per-project limits while allowing another project to run', () => {
    const ctx = setup('suggest', { projectSettings: { limited: '{"brain":{"maxTurnsPerHour":1}}', free: '{}' }, maxConcurrent: 1 });
    ctx.runner.start();
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    ctx.db.prepare("INSERT INTO brain_turns (id, trigger, input, projectId, status, startedAt) VALUES (?, ?, ?, ?, ?, ?)").run('old', 'event', 'old', 'limited', 'done', old);
    ctx.events.emit('task.done', 'limited/task');
    ctx.events.emit('task.done', 'free/task');
    ctx.runner.flush();
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0]).toContain('free/task');
  });

  it('stops every project when the global token budget is exhausted', () => {
    const ctx = setup('suggest', { projectSettings: { p1: '{}', p2: '{}' }, dailyTokenBudget: 100 });
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    ctx.db.prepare("INSERT INTO brain_turns (id, trigger, input, projectId, status, inputTokens, outputTokens, startedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run('global-budget', 'event', 'old', 'p1', 'done', 60, 40, today.toISOString());
    const limited: unknown[] = [];
    ctx.events.on('brain.limited', (_taskId, payload) => limited.push(payload));
    ctx.runner.start();
    ctx.events.emit('task.done', 'p1/task');
    ctx.events.emit('task.done', 'p2/task');
    ctx.runner.flush();
    expect(ctx.sent).toHaveLength(0);
    expect(limited).toContainEqual({ reason: 'budget', scope: 'global' });
    ctx.runner.stop();
  });

  it('drops an event after three ordinary failures and reports an incident', () => {
    const ctx = setup('auto');
    const incidents: unknown[] = [];
    ctx.events.on('brain.notify', (_taskId, payload) => incidents.push(payload));
    ctx.runner.start();
    ctx.events.emit('task.failed');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      ctx.runner.flush();
      ctx.events.emit('chat.error', undefined, { sessionId: 'brain', message: 'temporary failure' });
    }
    expect(ctx.runner.getQueuedEvents()).toHaveLength(0);
    expect(incidents).toContainEqual(expect.objectContaining({ level: 'incident' }));
    ctx.runner.stop();
  });

  it('keeps an event after quota failure and emits brain.waiting', () => {
    const ctx = setup('auto');
    const waiting: unknown[] = [];
    ctx.events.on('brain.waiting', (_taskId, payload) => waiting.push(payload));
    ctx.runner.start();
    ctx.events.emit('task.failed');
    ctx.runner.flush();
    ctx.events.emit('chat.error', undefined, { sessionId: 'brain', message: 'rate limit reached' });
    expect(ctx.runner.getQueuedEvents()).toHaveLength(1);
    expect(waiting).toContainEqual({ reason: 'quota' });
    ctx.runner.stop();
  });

  it('keeps quota events pending when mode synchronization fails at chat completion', () => {
    let syncAttempts = 0;
    const ctx = setup('auto', {
      permissions: 'full',
      setSessionMode: () => {
        syncAttempts += 1;
        throw new Error('session still running');
      },
    });
    ctx.runner.start();
    ctx.events.emit('task.failed');
    ctx.runner.flush();
    ctx.sessions.updateMode('brain', 'safe');

    expect(() => ctx.events.emit('chat.error', undefined, { sessionId: 'brain', message: 'rate limit reached' })).not.toThrow();
    expect(ctx.runner.getQueuedEvents()).toHaveLength(1);
    expect(syncAttempts).toBe(1);
    ctx.runner.stop();
  });

  it('ensureSession switches idle session to full mode and leaves busy session unchanged', () => {
    const ctx = setup('auto', { projectSettings: { p1: '{"brain":{"permissions":"full"}}', p2: '{"brain":{"permissions":"full"}}' } });
    // p1 has an idle existing session with mode safe
    ctx.sessions.insert({ id: 'brain:p1', projectId: 'p1', title: 'P1', kind: 'brain', mode: 'safe', busy: 0 });
    const s1 = ctx.runner.ensureSession('p1');
    expect(s1.mode).toBe('full');

    // p2 has a busy existing session with mode safe
    ctx.sessions.insert({ id: 'brain:p2', projectId: 'p2', title: 'P2', kind: 'brain', mode: 'safe', busy: 1 });
    const s2 = ctx.runner.ensureSession('p2');
    expect(s2.mode).toBe('safe');
  });

  it('routes projects in one department to one Codex brain with department permissions', () => {
    const ctx = setup('auto', { departments: true, projectSettings: { p1: '{}', p2: '{}' }, maxConcurrent: 2 });
    ctx.departments.insert({ id: 'eng', name: 'Engineering', priority: 0, maxParallel: 2, claudeDailyTokenBudget: 0, telegramTopicId: null, brainEngine: 'codex', brainModel: 'gpt-dept', brainCodexProfile: null, brainMode: 'auto', brainPermissions: 'full', brainDailyTokenBudget: 100, brainMaxTurnsPerHour: 5 });
    ctx.projects.update('p1', { departmentId: 'eng' });
    ctx.projects.update('p2', { departmentId: 'eng' });
    ctx.runner.start();
    ctx.events.emit('task.done', 'p1/one');
    ctx.events.emit('task.failed', 'p2/two');
    ctx.runner.flush();
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0]).toContain('task.done');
    expect(ctx.sent[0]).toContain('task.failed');
    expect(ctx.sessions.get('brain:department:eng')).toMatchObject({ model: 'gpt-dept', mode: 'full', pinned: 1 });
    expect(ctx.turns.latest()?.departmentId).toBe('eng');
  });

  it('creates and uses the department session when a legacy project session already exists', () => {
    const ctx = setup('auto', { departments: true, projectSettings: { p1: '{}' } });
    ctx.departments.insert({ id: 'eng', name: 'Engineering', priority: 0, maxParallel: 2, claudeDailyTokenBudget: 0, telegramTopicId: null, brainEngine: 'claude', brainModel: 'sonnet', brainCodexProfile: null, brainMode: 'auto', brainPermissions: 'full', brainDailyTokenBudget: 0, brainMaxTurnsPerHour: 20 });
    ctx.projects.update('p1', { departmentId: 'eng' });
    ctx.sessions.insert({ id: 'brain:p1', projectId: 'p1', title: 'Legacy project brain', kind: 'brain' });

    ctx.runner.start();
    ctx.events.emit('task.done', 'p1/task');
    ctx.runner.flush();

    expect(ctx.sessions.get('brain:p1')).toBeDefined();
    expect(ctx.sessions.get('brain:department:eng')).toMatchObject({ projectId: null, pinned: 1 });
    expect(ctx.sent[0]).toMatch(/^brain:department:eng:/);
  });

  it('keeps using a legacy project session when the project has no department', () => {
    const ctx = setup('auto', { projectSettings: { p1: '{}' } });
    ctx.sessions.insert({ id: 'brain:p1', projectId: 'p1', title: 'Legacy project brain', kind: 'brain' });

    ctx.runner.start();
    ctx.events.emit('task.done', 'p1/task');
    ctx.runner.flush();

    expect(ctx.sessions.get('brain:department:eng')).toBeUndefined();
    expect(ctx.sent[0]).toMatch(/^brain:p1:/);
  });

  it('uses the optional director session for system events', () => {
    const ctx = setup('auto');
    (ctx.runner as unknown as { opts: { config: { director: unknown } } }).opts.config.director = { enabled: true, engine: 'claude', model: 'opus', permissions: 'standard' };
    ctx.runner.start();
    ctx.events.emit('disk.low', undefined, { freeGB: 1 });
    ctx.runner.flush();
    expect(ctx.sent[0]).toContain('disk.low');
    expect(ctx.sessions.get('brain:director')).toMatchObject({ model: 'opus', title: 'Bộ não Giám đốc' });
  });

  it('reports completed department turns to the director and keeps the shared turn alive when stopping a project', () => {
    const ctx = setup('auto', { departments: true, projectSettings: { p1: '{}', p2: '{}' }, maxConcurrent: 2 });
    ctx.departments.insert({ id: 'eng', name: 'Engineering', priority: 0, maxParallel: 2, claudeDailyTokenBudget: 0, telegramTopicId: null, brainEngine: 'claude', brainModel: 'sonnet', brainCodexProfile: null, brainMode: 'auto', brainPermissions: 'full', brainDailyTokenBudget: 0, brainMaxTurnsPerHour: 20 });
    ctx.projects.update('p1', { departmentId: 'eng' });
    ctx.projects.update('p2', { departmentId: 'eng' });
    (ctx.runner as unknown as { opts: { config: { director: unknown } } }).opts.config.director = { enabled: true, engine: 'claude', model: 'opus', permissions: 'standard' };
    ctx.runner.start();
    ctx.events.emit('task.done', 'p1/one');
    ctx.events.emit('task.done', 'p2/two');
    ctx.runner.flush();
    ctx.runner.stopProject('p1');
    expect(ctx.runner.getQueuedEvents()).toHaveLength(0);
    ctx.events.emit('chat.done', undefined, { sessionId: 'brain:department:eng', message: 'Đã xử lý hai project', usage: {} });
    ctx.runner.flush();
    expect(ctx.sent.some((message) => message.includes('brain.department_summary'))).toBe(true);
    expect(ctx.sessions.get('brain:department:eng')).toBeDefined();
  });

  it('reports usage for a department turn through the project API', () => {
    const ctx = setup('suggest', { departments: true, projectSettings: { p1: '{}' } });
    ctx.departments.insert({ id: 'eng', name: 'Engineering', priority: 0, maxParallel: 2, claudeDailyTokenBudget: 0, telegramTopicId: null, brainEngine: 'claude', brainModel: 'sonnet', brainCodexProfile: null, brainMode: 'suggest', brainPermissions: 'full', brainDailyTokenBudget: 0, brainMaxTurnsPerHour: 20 });
    ctx.projects.update('p1', { departmentId: 'eng' });
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    ctx.db.prepare("INSERT INTO brain_turns (id, trigger, input, projectId, departmentId, status, inputTokens, outputTokens, startedAt) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)")
      .run('dept-turn', 'event', 'summary', 'eng', 'done', 7, 5, today.toISOString());
    expect(ctx.runner.getUsage('p1')).toMatchObject({ tokensToday: 12, lastTurnAt: today.toISOString() });
  });

  it('lets the director transfer an assigned profile between departments', () => {
    const ctx = setup('auto', { departments: true });
    ctx.profiles.upsert({ name: 'g1', engine: 'claude', kind: 'isolated', home: os.tmpdir(), email: null, enabled: 1 });
    for (const id of ['eng', 'sales']) ctx.departments.insert({ id, name: id, priority: 0, maxParallel: 2, claudeDailyTokenBudget: 0, telegramTopicId: null, brainEngine: 'claude', brainModel: 'sonnet', brainCodexProfile: null, brainMode: 'auto', brainPermissions: 'full', brainDailyTokenBudget: 0, brainMaxTurnsPerHour: 20 });
    ctx.departments.setProfiles('eng', [{ profileName: 'g1', share: 40 }]);
    (ctx.runner as unknown as { opts: { config: { director: unknown } } }).opts.config.director = { enabled: true, engine: 'claude', model: 'opus', permissions: 'standard' };
    ctx.runner.start();
    ctx.events.emit('brain.profile_transfer', undefined, { profileName: 'g1', fromDepartmentId: 'eng', toDepartmentId: 'sales' });
    expect(ctx.departments.profiles('eng')).toHaveLength(0);
    expect(ctx.departments.profiles('sales')).toMatchObject([{ profileName: 'g1', share: 40 }]);
  });

  it('includes shared ticket workflow rules in brain turn when OpenProject is enabled', () => {
    const settings = {
      openproject: { enabled: true, sourceId: 'sie', role: 'primary' },
      commitConvention: { defaultRef: 'SIE-19', commitTemplate: '[{ref}] {summary}', branchTemplate: 'agenthub/{slug}' },
    };
    const ctx = setup('suggest', { projectSettings: { p1: JSON.stringify(settings) } });
    ctx.runner.start();
    ctx.events.emit('task.failed', 'p1/task-1');
    ctx.runner.flush();
    const sent = ctx.sent.find((s) => s.includes('p1'));
    expect(sent).toBeDefined();
    expect(sent).toContain('QUY ĐỊNH TICKET OPENPROJECT (BẮT BUỘC)');
    expect(sent).toContain('Mã ref mặc định: `SIE-19`');
    expect(sent).toContain('Nội dung ticket: ## Đã làm + ## Còn lại');

    expect(buildBrainTicketWorkflowInstruction({ openproject: { enabled: false } } as never)).toBe('');
  });
});
