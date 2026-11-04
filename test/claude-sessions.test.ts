import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrainRepo, BrainService } from '../src/brain.js';
import { EventRepo, MIGRATIONS, openDatabase } from '../src/db/index.js';
import { ClaudeSessionRepo } from '../src/claude-sessions/repo.js';
import { ClaudeSessionScanner, encodeProjectDir, isClaudeProcessOpen, isClaudeQuotaLimited, isRealClaudeAssistant, redactTranscriptText } from '../src/claude-sessions/scanner.js';
import { ClaudeFailoverState } from '../src/chat/failover.js';
import { attributeTurn, taskRefsFromToolInput } from '../src/claude-sessions/attribution.js';

const fakeClaudeBin = path.resolve(__dirname, 'fixtures', 'fake-claude.mjs');

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function transcript(dir: string, cwd: string, timestamp: string, status = 'allowed') {
  const file = path.join(dir, 'session.jsonl');
  const event = {
    type: 'assistant', sessionId: 'session', cwd, timestamp,
    quotaLimits: { status, resetsAt: Math.floor(Date.now() / 1000) + 3600, rateLimitType: 'five_hour' },
    message: { id: 'message-1', model: 'claude-sonnet', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'text', text: 'SECRET_TRANSCRIPT_CONTENT' }] },
  };
  fs.writeFileSync(file, `${JSON.stringify(event)}\n`);
  return file;
}

function assistantEvent(sessionId: string, cwd: string, id: string, timestamp: string, input = 10, toolInput?: Record<string, unknown>) {
  return {
    type: 'assistant', sessionId, cwd, timestamp,
    message: {
      id, model: 'claude-sonnet',
      usage: { input_tokens: input, output_tokens: 5 },
      content: toolInput ? [{ type: 'tool_use', name: 'Bash', input: toolInput }] : [{ type: 'text', text: 'private transcript' }],
    },
  };
}

function addProjectAndTask(db: ReturnType<typeof openDatabase>, projectDir: string) {
  db.prepare('INSERT INTO projects (id,name,path) VALUES (?,?,?)').run('proj', 'Project', projectDir);
  db.prepare("INSERT INTO tasks (id,projectId,slug,title) VALUES ('proj~alpha','proj','alpha','Alpha')").run();
}

describe('Claude session privacy and quota handling', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-23T10:00:00+07:00'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('only treats a real assistant response as successful quota evidence', () => {
    expect(isRealClaudeAssistant({ type: 'assistant', isApiErrorMessage: true, message: { model: 'claude-sonnet', usage: { output_tokens: 5 } } })).toBe(false);
    expect(isRealClaudeAssistant({ type: 'assistant', message: { model: '<synthetic>', usage: { output_tokens: 5 } } })).toBe(false);
    expect(isRealClaudeAssistant({ type: 'assistant', message: { model: 'claude-sonnet', usage: { output_tokens: 0 } } })).toBe(false);
    expect(isRealClaudeAssistant({ type: 'assistant', message: { model: 'claude-sonnet', usage: { output_tokens: 5 } } })).toBe(true);
  });

  it('auto-resumes only a stable stopped session into a real chat session', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-claude-')); dirs.push(root);
    const transcriptDir = path.join(root, 'projects', encodeProjectDir(path.join(root, 'project'))); const projectDir = path.join(root, 'project');
    fs.mkdirSync(transcriptDir, { recursive: true }); fs.mkdirSync(projectDir);
    const db = openDatabase(path.join(root, 'hub.db'));
    db.prepare('INSERT INTO projects (id,name,path) VALUES (?,?,?)').run('p', 'Project', projectDir);
    const hitAt = new Date(Date.now() - 20 * 60_000);
    const file = path.join(transcriptDir, 'session.jsonl');
    fs.writeFileSync(file, `${JSON.stringify({
      type: 'assistant', sessionId: 'session', cwd: projectDir, timestamp: hitAt.toISOString(),
      quotaLimits: { status: 'rejected', resetsAt: Math.floor(hitAt.getTime() / 1000) + 60, rateLimitType: 'five_hour' },
      message: { id: 'limited', model: 'claude-sonnet', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: 'stopped' }] },
    })}\n`);
    fs.utimesSync(file, hitAt, hitAt);
    const scanner = new ClaudeSessionScanner(db, {
      dir: path.join(root, 'projects'),
      hubHome: root,
      autoResume: { enabled: true, prompt: 'resume safely', claudeBin: fakeClaudeBin, profileName: 'claude-test' },
    });
    await scanner.scan();
    db.prepare('UPDATE claude_sessions SET autoResumeEnabled=1 WHERE sessionId=?').run('session');
    await scanner.scan();
    await vi.waitFor(() => {
      expect(db.prepare("SELECT COUNT(*) count FROM chat_sessions WHERE title LIKE 'Tự tiếp tục:%' AND state = 'idle'").get()).toEqual({ count: 1 });
    }, { timeout: 5000 });
    const chat = db.prepare("SELECT id,projectId,claudeSessionId,title,state FROM chat_sessions WHERE title LIKE 'Tự tiếp tục:%'").get() as { id: string; projectId: string; claudeSessionId: string; title: string; state: string };
    expect(chat).toMatchObject({ projectId: 'p', claudeSessionId: 'session', state: 'idle' });
    expect(chat.title).toContain('session');
    expect(db.prepare('SELECT role,content FROM chat_messages WHERE sessionId=?').all(chat.id)).toEqual(expect.arrayContaining([
      { role: 'user', content: 'resume safely' },
      expect.objectContaining({ role: 'assistant' }),
    ]));
    expect(db.prepare('SELECT limitResetAt FROM claude_sessions WHERE sessionId=?').get('session')).toEqual({ limitResetAt: null });
    db.close();
  });

  it('does not auto-resume when transcript cwd is missing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-claude-')); dirs.push(root);
    const transcriptDir = path.join(root, 'projects', encodeProjectDir(path.join(root, 'project'))); fs.mkdirSync(transcriptDir, { recursive: true });
    const db = openDatabase(path.join(root, 'hub.db')); const file = path.join(transcriptDir, 'session.jsonl');
    const hitAt = new Date(Date.now() - 20 * 60_000);
    fs.writeFileSync(file, `${JSON.stringify({ type: 'assistant', sessionId: 'session', timestamp: hitAt.toISOString(), quotaLimits: { status: 'rejected', resetsAt: Math.floor(hitAt.getTime() / 1000) - 60 }, message: { id: 'limited', content: [] } })}\n`);
    fs.utimesSync(file, hitAt, hitAt);
    const scanner = new ClaudeSessionScanner(db, { dir: path.join(root, 'projects'), autoResume: { enabled: true, prompt: 'resume', claudeBin: fakeClaudeBin } });
    await scanner.scan();
    db.prepare('UPDATE claude_sessions SET autoResumeEnabled=1 WHERE sessionId=?').run('session');
    await scanner.scan();
    expect(db.prepare('SELECT COUNT(*) count FROM chat_sessions').get()).toEqual({ count: 0 });
    db.close();
  });

  it('deduplicates message ids and reads only appended transcript bytes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-claude-')); dirs.push(root);
    const transcriptDir = path.join(root, 'projects', encodeProjectDir(path.join(root, 'project'))); fs.mkdirSync(transcriptDir, { recursive: true });
    const projectDir = path.join(root, 'project'); fs.mkdirSync(projectDir);
    const db = openDatabase(path.join(root, 'hub.db'));
    db.prepare('INSERT INTO projects (id,name,path) VALUES (?,?,?)').run('p', 'Project', projectDir);
    const file = transcript(transcriptDir, projectDir, new Date().toISOString());
    const scanner = new ClaudeSessionScanner(db, { dir: path.join(root, 'projects') });
    await scanner.scan();
    expect(db.prepare('SELECT COUNT(*) count FROM claude_usage').get()).toEqual({ count: 1 });
    fs.appendFileSync(file, `${JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), message: { ...JSON.parse(fs.readFileSync(file, 'utf8')).message, id: 'message-2' } })}\n`);
    await scanner.scan();
    expect(db.prepare('SELECT COUNT(*) count FROM claude_usage').get()).toEqual({ count: 2 });
    await scanner.scan();
    expect(db.prepare('SELECT COUNT(*) count FROM claude_usage').get()).toEqual({ count: 2 });
    db.close();
  });

  it('splits a referenced turn evenly and supports every task reference shape', () => {
    const tasks = [{ id: 'proj~alpha', slug: 'alpha' }, { id: 'proj~beta', slug: 'beta' }];
    expect(taskRefsFromToolInput({ command: 'proj~alpha' }, tasks)).toEqual(['proj~alpha']);
    expect(taskRefsFromToolInput({ file_path: 'proj/beta' }, tasks)).toEqual(['proj~beta']);
    expect(taskRefsFromToolInput({ url: '/worktrees/proj/alpha' }, tasks)).toEqual(['proj~alpha']);
    expect(taskRefsFromToolInput({ prompt: 'docs/tasks/beta' }, tasks)).toEqual(['proj~beta']);
    expect(taskRefsFromToolInput({ body: '{"slug":"alpha"}' }, tasks)).toEqual(['proj~alpha']);
    expect(attributeTurn(100, ['proj~alpha', 'proj~beta'])).toEqual([
      { taskId: 'proj~alpha', effectiveTokens: 50 }, { taskId: 'proj~beta', effectiveTokens: 50 },
    ]);
    expect(attributeTurn(100, [])).toEqual([{ taskId: '_general', effectiveTokens: 100 }]);
  });

  it('recognizes rejected/limited/exhausted quota states but allows allowed variants', () => {
    expect(isClaudeQuotaLimited('rejected')).toBe(true);
    expect(isClaudeQuotaLimited('limited')).toBe(true);
    expect(isClaudeQuotaLimited('exhausted')).toBe(true);
    expect(isClaudeQuotaLimited('allowed')).toBe(false);
    expect(isClaudeQuotaLimited('allowed_overage')).toBe(false);
    expect(isClaudeQuotaLimited('')).toBe(false);
    expect(isClaudeQuotaLimited(undefined)).toBe(false);
  });

  it('keeps Claude quota observations per profile and accepts newer successful evidence', () => {
    const db = openDatabase(':memory:');
    const repo = new ClaudeSessionRepo(db);
    repo.setQuota({ profileName: 'claude-may', status: 'rejected', resetsAt: 1_900_000_000, rateLimitType: 'five_hour', isUsingOverage: false, observedAt: '2026-10-21T08:00:00.000Z' });
    repo.setQuota({ profileName: 'claude-other', status: 'rejected', resetsAt: 1_900_000_000, rateLimitType: 'five_hour', isUsingOverage: false, observedAt: '2026-10-21T08:01:00.000Z' });
    expect(repo.markAllowedAfter('claude-may', '2026-10-21T08:05:00.000Z')).toBe(true);
    expect(repo.quota('claude-may')).toMatchObject({ status: 'allowed', observedAt: '2026-10-21T08:05:00.000Z' });
    expect(repo.quota('claude-other')).toMatchObject({ status: 'rejected' });
    expect(repo.markAllowedAfter('claude-may', '2026-10-21T08:04:00.000Z')).toBe(false);
    expect(repo.markAllowedAfter('claude-may', '2026-10-21T08:06:00.000Z')).toBe(false);
    db.close();
  });

  it('does not clear rejected quota from a synthetic API error assistant event', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-claude-')); dirs.push(root);
    const transcriptDir = path.join(root, 'projects', encodeProjectDir(path.join(root, 'project'))); const projectDir = path.join(root, 'project');
    fs.mkdirSync(transcriptDir, { recursive: true }); fs.mkdirSync(projectDir);
    const db = openDatabase(path.join(root, 'hub.db'));
    db.prepare('INSERT INTO projects (id,name,path) VALUES (?,?,?)').run('p', 'Project', projectDir);
    db.prepare("INSERT INTO chat_sessions (id,claudeSessionId,title,model,profileName) VALUES ('chat','session','Session','sonnet','claude-may')").run();
    const base = Date.parse('2026-10-21T08:00:00.000Z');
    const event = (timestamp: string, message: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ type: 'assistant', sessionId: 'session', cwd: projectDir, timestamp, ...extra, message });
    const file = path.join(transcriptDir, 'session.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify(event(new Date(base).toISOString(), { id: 'limited', model: 'claude-sonnet', usage: { input_tokens: 1, output_tokens: 1 }, content: [] }, { quotaLimits: { status: 'rejected', resetsAt: 1_900_000_000, rateLimitType: 'five_hour' } })),
      JSON.stringify(event(new Date(base + 60_000).toISOString(), { id: 'synthetic', model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 }, content: [] }, { isApiErrorMessage: true })),
    ].join('\n') + '\n');
    await new ClaudeSessionScanner(db, { dir: path.join(root, 'projects') }).scan();
    expect(db.prepare('SELECT status FROM claude_quota_profiles WHERE profileName=?').get('claude-may')).toEqual({ status: 'rejected' });
    fs.appendFileSync(file, `${JSON.stringify(event(new Date(base + 120_000).toISOString(), { id: 'real', model: 'claude-sonnet', usage: { input_tokens: 2, output_tokens: 3 }, content: [] }))}\n`);
    await new ClaudeSessionScanner(db, { dir: path.join(root, 'projects') }).scan();
    expect(db.prepare('SELECT status FROM claude_quota_profiles WHERE profileName=?').get('claude-may')).toEqual({ status: 'allowed' });
    db.close();
  });

  it('redacts transcript metadata without hiding ordinary file paths', () => {
    const text = redactTranscriptText('Contact dev.user+test@example.com; token=abc123456789; sk-abcdefghijklmnopqrstuvwxyz; /home/user/project/src/file.ts', 200);
    expect(text).toContain('[email]');
    expect(text).toContain('[secret]');
    expect(text).toContain('/home/user/project/src/file.ts');
    expect(text).not.toContain('example.com');
    expect(text).not.toContain('abc123456789');
    expect(text).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
  });

  it('derives working, waiting, and inactive states from transcript fixture events', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-claude-brain-')); dirs.push(root);
    const transcriptDir = path.join(root, 'projects'); const projectDir = path.join(root, 'project');
    fs.mkdirSync(path.join(transcriptDir, encodeProjectDir(path.join(root, 'project'))), { recursive: true }); fs.mkdirSync(projectDir);
    const db = openDatabase(path.join(root, 'hub.db'));
    db.prepare('INSERT INTO projects (id,name,path) VALUES (?,?,?)').run('p', 'Project', projectDir);
    const now = Date.now();
    const write = (id: string, timestamp: string, content: unknown) => {
      fs.writeFileSync(path.join(transcriptDir, encodeProjectDir(path.join(root, 'project')), `${id}.jsonl`), `${JSON.stringify({
        type: 'assistant', sessionId: id, cwd: projectDir, timestamp,
        message: { id: `${id}-message`, model: 'claude-sonnet', usage: { input_tokens: 10, output_tokens: 5 }, content },
      })}\n`);
    };
    write('working', new Date(now).toISOString(), [{ type: 'tool_use', name: 'Bash', input: { command: 'git status --short' } }]);
    write('waiting', new Date(now - 6 * 60_000).toISOString(), [{ type: 'text', text: 'Done, please review.' }]);
    write('inactive', new Date(now - 11 * 60_000).toISOString(), [{ type: 'text', text: 'Old response.' }]);
    await new ClaudeSessionScanner(db, { dir: transcriptDir }).scan();
    const status = new BrainService(new BrainRepo(db), new EventRepo(db), undefined, new ClaudeSessionRepo(db), db).getStatus(now);
    expect(status.state).toBe('working');
    expect(status.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: 'working', state: 'working', lastTool: { name: 'Bash', summary: 'Bash: git status --short' } }),
      expect.objectContaining({ sessionId: 'waiting', state: 'waiting' }),
    ]));
    expect(status.sessions.some((session) => session.sessionId === 'inactive')).toBe(false);
    db.close();
  });

  it('preserves manual brain status while it is fresh and never overwrites cwd with an empty scan value', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-claude-manual-')); dirs.push(root);
    const transcriptDir = path.join(root, 'projects', encodeProjectDir(path.join(root, 'project'))); const projectDir = path.join(root, 'project');
    fs.mkdirSync(transcriptDir, { recursive: true }); fs.mkdirSync(projectDir);
    const db = openDatabase(path.join(root, 'hub.db'));
    db.prepare('INSERT INTO projects (id,name,path) VALUES (?,?,?)').run('p', 'Project', projectDir);
    const sessionRepo = new ClaudeSessionRepo(db);
    sessionRepo.upsert({ sessionId: 'manual-session', cwd: projectDir, lastAt: new Date().toISOString(), lastEventKind: 'tool_use' });
    const scanner = new ClaudeSessionScanner(db, { dir: path.join(root, 'projects') });
    const file = path.join(transcriptDir, 'manual-session.jsonl');
    fs.writeFileSync(file, `${JSON.stringify({ type: 'user', sessionId: 'manual-session', cwd: projectDir, timestamp: new Date().toISOString(), message: { content: 'continue' } })}\n`);
    await scanner.scan();
    expect(db.prepare('SELECT cwd FROM claude_sessions WHERE sessionId=?').get('manual-session')).toEqual({ cwd: projectDir });
    const brain = new BrainService(new BrainRepo(db), new EventRepo(db), undefined, sessionRepo, db);
    const now = Date.now();
    new BrainRepo(db).upsert('talking', 'Manual update', null, new Date(now - 60_000).toISOString());
    expect(brain.getStatus(now)).toMatchObject({ source: 'manual', activity: 'talking', detail: 'Manual update' });
    db.close();
  });

  it('persists rate_limit_info events from stream-json transcripts', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-claude-')); dirs.push(root);
    const transcriptDir = path.join(root, 'projects', encodeProjectDir(path.join(root, 'project'))); fs.mkdirSync(transcriptDir, { recursive: true });
    const projectDir = path.join(root, 'project'); fs.mkdirSync(projectDir);
    const db = openDatabase(path.join(root, 'hub.db'));
    db.prepare('INSERT INTO projects (id,name,path) VALUES (?,?,?)').run('p', 'Project', projectDir);
    fs.writeFileSync(path.join(transcriptDir, 'session.jsonl'), `${JSON.stringify({
      type: 'rate_limit_info', cwd: projectDir, timestamp: new Date().toISOString(),
      rate_limit_info: { status: 'allowed_warning', resetsAt: 1_900_000_000, rateLimitType: 'five_hour' },
    })}\n`);
    await new ClaudeSessionScanner(db, { dir: path.join(root, 'projects') }).scan();
    expect(db.prepare('SELECT status,resetsAt,rateLimitType FROM claude_quota WHERE id=1').get()).toEqual({
      status: 'allowed_warning', resetsAt: 1_900_000_000, rateLimitType: 'five_hour',
    });
    db.close();
  });

  it('does not persist an out-of-scope transcript or its title/content', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-claude-')); dirs.push(root);
    const transcriptDir = path.join(root, 'projects'); fs.mkdirSync(transcriptDir); fs.mkdirSync(path.join(transcriptDir, encodeProjectDir(path.join(root, 'project'))));
    const db = openDatabase(path.join(root, 'hub.db'));
    transcript(path.join(transcriptDir, encodeProjectDir(path.join(root, 'project'))), '/unregistered/project', new Date().toISOString());
    await new ClaudeSessionScanner(db, { dir: transcriptDir, hubHome: path.join(root, 'hub-home'), worktreesDir: path.join(root, 'worktrees') }).scan();
    expect(db.prepare('SELECT COUNT(*) count FROM claude_sessions').get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE sql LIKE '%SECRET_TRANSCRIPT_CONTENT%'").get()).toEqual({ count: 0 });
    db.close();
  });

  it('never opens or records transcripts of Claude projects the hub does not manage', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-claude-')); dirs.push(root);
    const transcriptDir = path.join(root, 'projects'); const projectDir = path.join(root, 'project'); fs.mkdirSync(projectDir);
    const companyDir = path.join(transcriptDir, encodeProjectDir('/media/vault/unmanaged-project')); fs.mkdirSync(companyDir, { recursive: true });
    // Similar prefix but a different project: must not match by name prefix alone.
    const siblingDir = path.join(transcriptDir, `${encodeProjectDir(projectDir)}x`); fs.mkdirSync(siblingDir);
    const db = openDatabase(path.join(root, 'hub.db'));
    db.prepare('INSERT INTO projects (id,name,path) VALUES (?,?,?)').run('p', 'Project', projectDir);
    // Even a transcript that later moves into a managed project stays unread when its folder belongs elsewhere.
    transcript(companyDir, projectDir, new Date().toISOString());
    transcript(siblingDir, projectDir, new Date().toISOString());
    const readSpy = vi.spyOn(fs, 'createReadStream');
    await new ClaudeSessionScanner(db, { dir: transcriptDir }).scan();
    expect(readSpy).not.toHaveBeenCalled();
    readSpy.mockRestore();
    expect(db.prepare('SELECT COUNT(*) count FROM claude_scan_state').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) count FROM claude_sessions').get()).toEqual({ count: 0 });
    db.close();
  });

  it('allows transcripts from a project worktree root configured outside hubHome', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-claude-configured-root-')); dirs.push(root);
    const transcriptDir = path.join(root, 'projects');
    const projectDir = path.join(root, 'project');
    const configuredRoot = path.join(root, 'encrypted-worktrees');
    fs.mkdirSync(path.join(transcriptDir, encodeProjectDir(configuredRoot)), { recursive: true });
    fs.mkdirSync(projectDir); fs.mkdirSync(configuredRoot);
    const db = openDatabase(path.join(root, 'hub.db'));
    db.prepare('INSERT INTO projects (id,name,path,settings) VALUES (?,?,?,?)').run('p', 'Project', projectDir, JSON.stringify({ worktree: { root: configuredRoot } }));
    transcript(path.join(transcriptDir, encodeProjectDir(configuredRoot)), configuredRoot, new Date().toISOString());
    await new ClaudeSessionScanner(db, { dir: transcriptDir, hubHome: path.join(root, 'hub-home'), worktreesDir: path.join(root, 'worktrees') }).scan();
    expect(db.prepare('SELECT COUNT(*) count FROM claude_sessions').get()).toEqual({ count: 1 });
    db.close();
  });

  it('migration forgets previously recorded paths of unmanaged transcripts', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-claude-')); dirs.push(root);
    const db = openDatabase(path.join(root, 'hub.db'));
    const insert = db.prepare('INSERT INTO claude_scan_state (path,inode,size,offset,mtime,turnId,turnTasks,eligible) VALUES (?,?,?,?,?,?,?,?)');
    insert.run('/x/-media-other-project/a.jsonl', 1, 1, 1, 1, 't', '[]', 0);
    insert.run('/x/-home-me-project/b.jsonl', 2, 1, 1, 1, 't', '[]', 1);
    db.exec(MIGRATIONS.find((sql) => sql.includes('DELETE FROM claude_scan_state WHERE eligible = 0'))!);
    expect(db.prepare('SELECT path FROM claude_scan_state').all()).toEqual([{ path: '/x/-home-me-project/b.jsonl' }]);
    db.close();
  });

  it('accepts a registered project and only activates failover for fresh quota observations', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-claude-')); dirs.push(root);
    const transcriptDir = path.join(root, 'projects'); const projectDir = path.join(root, 'project'); fs.mkdirSync(transcriptDir); fs.mkdirSync(projectDir); fs.mkdirSync(path.join(transcriptDir, encodeProjectDir(path.join(root, 'project'))));
    const db = openDatabase(path.join(root, 'hub.db'));
    db.prepare('INSERT INTO projects (id,name,path) VALUES (?,?,?)').run('p', 'Project', projectDir);
    const state = new ClaudeFailoverState(path.join(root, 'failover.json'));
    transcript(path.join(transcriptDir, encodeProjectDir(path.join(root, 'project'))), projectDir, new Date(Date.now() - 60 * 60_000).toISOString(), 'rejected');
    await new ClaudeSessionScanner(db, { dir: transcriptDir, failoverState: state }).scan();
    expect(db.prepare('SELECT COUNT(*) count FROM claude_sessions').get()).toEqual({ count: 1 });
    expect(state.snapshot().active).toBe(false);
    const fresh = path.join(transcriptDir, encodeProjectDir(path.join(projectDir, 'fresh'))); fs.mkdirSync(fresh);
    transcript(fresh, projectDir, new Date().toISOString(), 'rejected');
    await new ClaudeSessionScanner(db, { dir: transcriptDir, failoverState: state }).scan();
    expect(state.snapshot().active).toBe(true);
    expect(state.snapshot().evidence?.file).toContain('-fresh/session.jsonl');
    expect(state.snapshot().evidence?.line).toBe(1);
    db.close();
  });

  it('clears failover when Claude writes a later activity record', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-claude-')); dirs.push(root);
    const transcriptDir = path.join(root, 'projects', encodeProjectDir(path.join(root, 'project'))); const projectDir = path.join(root, 'project');
    fs.mkdirSync(transcriptDir, { recursive: true }); fs.mkdirSync(projectDir);
    const db = openDatabase(path.join(root, 'hub.db'));
    db.prepare('INSERT INTO projects (id,name,path) VALUES (?,?,?)').run('p', 'Project', projectDir);
    const state = new ClaudeFailoverState(path.join(root, 'failover.json'));
    const file = transcript(transcriptDir, projectDir, new Date().toISOString(), 'rejected');
    await new ClaudeSessionScanner(db, { dir: path.join(root, 'projects'), failoverState: state }).scan();
    expect(state.snapshot().active).toBe(true);
    vi.advanceTimersByTime(1000);
    const activity = assistantEvent('session', projectDir, 'message-2', new Date().toISOString());
    fs.appendFileSync(file, `${JSON.stringify(activity)}\n`);
    await new ClaudeSessionScanner(db, { dir: path.join(root, 'projects'), failoverState: state }).scan();
    expect(state.snapshot().active).toBe(false);
    expect(state.snapshot().lastActivityAt).toBe(activity.timestamp);
    db.close();
  });

  it('attributes the complete total of a three-message turn, including after a split scan', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-claude-')); dirs.push(root);
    const transcriptDir = path.join(root, 'projects', encodeProjectDir(path.join(root, 'project'))); const projectDir = path.join(root, 'project');
    fs.mkdirSync(transcriptDir, { recursive: true }); fs.mkdirSync(projectDir);
    const db = openDatabase(path.join(root, 'hub.db')); addProjectAndTask(db, projectDir);
    const now = new Date().toISOString();
    const lines = [
      { type: 'user', sessionId: 'split', cwd: projectDir, uuid: 'turn-1', message: { content: 'do the task' } },
      assistantEvent('split', projectDir, 'one', now),
      assistantEvent('split', projectDir, 'two', now, 20, { command: 'proj~alpha' }),
      assistantEvent('split', projectDir, 'three', now, 30),
    ];
    const file = path.join(transcriptDir, 'split.jsonl');
    fs.writeFileSync(file, `${lines.slice(0, 3).map((line) => JSON.stringify(line)).join('\n')}\n`);
    const scanner = new ClaudeSessionScanner(db, { dir: path.join(root, 'projects') });
    await scanner.scan();
    fs.appendFileSync(file, `${JSON.stringify(lines[3])}\n`);
    await scanner.scan();
    expect(db.prepare('SELECT SUM(effectiveTokens) effective FROM claude_task_usage WHERE taskId=?').get('proj~alpha')).toEqual({ effective: 75 });
    expect(db.prepare("SELECT COUNT(*) count FROM claude_task_usage WHERE turnId LIKE '%:initial'").get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) count FROM claude_usage').get()).toEqual({ count: 3 });
    db.close();
  });

  it('scans 3000 assistant messages in a valid project without quadratic work', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-claude-')); dirs.push(root);
    const transcriptDir = path.join(root, 'projects', encodeProjectDir(path.join(root, 'project'))); const projectDir = path.join(root, 'project');
    fs.mkdirSync(transcriptDir, { recursive: true }); fs.mkdirSync(projectDir);
    const db = openDatabase(path.join(root, 'hub.db')); db.prepare('INSERT INTO projects (id,name,path) VALUES (?,?,?)').run('proj', 'Project', projectDir);
    const now = new Date().toISOString();
    const file = path.join(transcriptDir, 'large.jsonl');
    fs.writeFileSync(file, `${Array.from({ length: 3000 }, (_, index) => JSON.stringify(assistantEvent('large', projectDir, `message-${index}`, now))).join('\n')}\n`);
    const started = performance.now();
    await new ClaudeSessionScanner(db, { dir: path.join(root, 'projects') }).scan();
    expect(performance.now() - started).toBeLessThan(2000);
    expect(db.prepare('SELECT messages FROM claude_sessions WHERE sessionId=?').get('large')).toEqual({ messages: 3000 });
    db.close();
  });

  it('stores an out-of-scope scan offset and reads only appended bytes later', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-claude-')); dirs.push(root);
    const transcriptDir = path.join(root, 'projects', encodeProjectDir(path.join(root, 'project'))); fs.mkdirSync(transcriptDir, { recursive: true });
    const db = openDatabase(path.join(root, 'hub.db')); const file = path.join(transcriptDir, 'outside.jsonl');
    // The folder belongs to a managed project, but the session's cwd is outside it.
    db.prepare('INSERT INTO projects (id,name,path) VALUES (?,?,?)').run('p', 'Project', path.join(root, 'project'));
    const first = JSON.stringify(assistantEvent('outside', '/not-registered', 'one', new Date().toISOString()));
    fs.writeFileSync(file, `${first}\n`);
    const scanner = new ClaudeSessionScanner(db, { dir: path.join(root, 'projects') });
    await scanner.scan();
    const initial = db.prepare('SELECT offset,eligible FROM claude_scan_state WHERE path=?').get(file) as { offset: number; eligible: number };
    expect(initial).toEqual({ offset: Buffer.byteLength(`${first}\n`), eligible: 0 });
    const second = JSON.stringify(assistantEvent('outside', '/not-registered', 'two', new Date().toISOString()));
    fs.appendFileSync(file, `${second}\n`);
    await scanner.scan();
    expect(db.prepare('SELECT offset,eligible FROM claude_scan_state WHERE path=?').get(file)).toEqual({ offset: Buffer.byteLength(`${first}\n${second}\n`), eligible: 0 });
    expect(db.prepare('SELECT COUNT(*) count FROM claude_sessions').get()).toEqual({ count: 0 });
    db.close();
  });

  it('sets session title from first user message up to 80 characters when ai-title is missing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-claude-')); dirs.push(root);
    const transcriptDir = path.join(root, 'projects', encodeProjectDir(path.join(root, 'project'))); const projectDir = path.join(root, 'project');
    fs.mkdirSync(transcriptDir, { recursive: true }); fs.mkdirSync(projectDir);
    const db = openDatabase(path.join(root, 'hub.db')); addProjectAndTask(db, projectDir);
    const file = path.join(transcriptDir, 'sess-title.jsonl');
    const longPrompt = 'This is a very long user prompt that exceeds eighty characters and needs to be truncated appropriately';
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'user', sessionId: 'sess-title', cwd: projectDir, message: { content: [{ type: 'text', text: longPrompt }] } }),
      JSON.stringify(assistantEvent('sess-title', projectDir, 'msg-1', new Date().toISOString())),
    ].join('\n') + '\n');
    const scanner = new ClaudeSessionScanner(db, { dir: path.join(root, 'projects') });
    await scanner.scan();
    const row = db.prepare('SELECT title FROM claude_sessions WHERE sessionId=?').get('sess-title') as { title: string };
    expect(row.title).toBe(longPrompt.slice(0, 80));
    expect(row.title.length).toBe(80);
    db.close();
  });

  it('prefers ai-title over first user message', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-claude-')); dirs.push(root);
    const transcriptDir = path.join(root, 'projects', encodeProjectDir(path.join(root, 'project'))); const projectDir = path.join(root, 'project');
    fs.mkdirSync(transcriptDir, { recursive: true }); fs.mkdirSync(projectDir);
    const db = openDatabase(path.join(root, 'hub.db')); addProjectAndTask(db, projectDir);
    const file = path.join(transcriptDir, 'sess-ai.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'user', sessionId: 'sess-ai', cwd: projectDir, message: { content: 'user said something' } }),
      JSON.stringify(assistantEvent('sess-ai', projectDir, 'msg-1', new Date().toISOString())),
      JSON.stringify({ type: 'ai-title', sessionId: 'sess-ai', cwd: projectDir, aiTitle: 'AI Generated Title' }),
    ].join('\n') + '\n');
    const scanner = new ClaudeSessionScanner(db, { dir: path.join(root, 'projects') });
    await scanner.scan();
    const row = db.prepare('SELECT title FROM claude_sessions WHERE sessionId=?').get('sess-ai') as { title: string };
    expect(row.title).toBe('AI Generated Title');
    db.close();
  });

  it('detects running claude process via isClaudeProcessOpen', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-proc-')); dirs.push(root);
    const fakeProc = path.join(root, 'proc');
    const targetCwd = path.join(root, 'my-project');
    const otherCwd = path.join(root, 'other-project');
    fs.mkdirSync(fakeProc, { recursive: true });
    fs.mkdirSync(targetCwd, { recursive: true });
    fs.mkdirSync(otherCwd, { recursive: true });

    // Process 123: running claude in targetCwd
    const proc123 = path.join(fakeProc, '123');
    fs.mkdirSync(proc123);
    fs.writeFileSync(path.join(proc123, 'cmdline'), 'node\0/usr/bin/claude\0--resume\0');
    fs.symlinkSync(targetCwd, path.join(proc123, 'cwd'));

    // Process 456: running something else in targetCwd
    const proc456 = path.join(fakeProc, '456');
    fs.mkdirSync(proc456);
    fs.writeFileSync(path.join(proc456, 'cmdline'), 'bash\0-i\0');
    fs.symlinkSync(targetCwd, path.join(proc456, 'cwd'));

    expect(isClaudeProcessOpen(targetCwd, fakeProc)).toBe(true);
    expect(isClaudeProcessOpen(otherCwd, fakeProc)).toBe(false);
    expect(isClaudeProcessOpen('', fakeProc)).toBe(false);
  });

  it('computes active status and falls back to shortened sessionId for title', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-claude-')); dirs.push(root);
    const db = openDatabase(path.join(root, 'hub.db'));
    const repo = new ClaudeSessionRepo(db);
    const recentTime = new Date(Date.now() - 3 * 60_000).toISOString();
    const oldTime = new Date(Date.now() - 30 * 60_000).toISOString();

    repo.upsert({ sessionId: '12345678-abcd-ef01-2345-6789abcdef01', cwd: '/work/active', lastAt: recentTime, title: null });
    repo.upsert({ sessionId: '87654321-dcba-10fe-5432-10fedcba9876', cwd: '/work/idle', lastAt: oldTime, title: null });

    const { AppService } = await import('../src/services/index.js');
    const service = Object.create(AppService.prototype);
    Object.assign(service, {
      claudeSessionRepo: repo,
      config: { claudeSessions: { activeWithinMin: 10 } },
      scheduler: { getDatabase: () => db },
    });

    const list = service.listClaudeSessions();
    const activeSession = list.find((s: { sessionId: string }) => s.sessionId === '12345678-abcd-ef01-2345-6789abcdef01');
    const idleSession = list.find((s: { sessionId: string }) => s.sessionId === '87654321-dcba-10fe-5432-10fedcba9876');

    expect(activeSession?.active).toBe(true);
    expect(activeSession?.title).toBe('12345678');

    expect(idleSession?.active).toBe(false);
    expect(idleSession?.title).toBe('87654321');

    const detail = service.getClaudeSession('12345678-abcd-ef01-2345-6789abcdef01');
    expect(detail.active).toBe(true);
    expect(detail.title).toBe('12345678');
    db.close();
  });

  it('uses the selected sort value when continuing a cursor', () => {
    const db = openDatabase(':memory:');
    const repo = new ClaudeSessionRepo(db);
    repo.upsert({ sessionId: 'session-a', cwd: '/work/a', title: 'A', messages: 1 });
    repo.upsert({ sessionId: 'session-b', cwd: '/work/b', title: 'B', messages: 2 });
    repo.upsert({ sessionId: 'session-c', cwd: '/work/c', title: 'C', messages: 3 });
    const first = repo.page(1, 0, undefined, 'messages', 'desc');
    expect(first.items.map((session) => session.sessionId)).toEqual(['session-c']);
    db.prepare("INSERT INTO claude_sessions (sessionId, cwd, title, messages) VALUES ('session-z', '/work/z', 'Z', 99)").run();
    const second = repo.page(1, 0, first.nextCursor!, 'messages', 'desc');
    expect(second.items.map((session) => session.sessionId)).toEqual(['session-b']);
    db.close();
  });
});

describe('ClaudeSessionRepo giữ dữ liệu khi cập nhật thiếu trường', () => {
  it('lastAt rỗng không xoá lastAt cũ; cập nhật hoạt động không đặt lại bộ đếm', async () => {
    const { openDatabase } = await import('../src/db/index.js');
    const { ClaudeSessionRepo } = await import('../src/claude-sessions/repo.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-session-repo-'));
    const db = openDatabase(path.join(dir, 'hub.db'));
    const repo = new ClaudeSessionRepo(db);
    repo.upsert({ sessionId: 's1', cwd: '/w', lastAt: '2026-10-21T01:00:00.000Z', messages: 12, effectiveTokens: 500 });
    repo.upsert({ sessionId: 's1', cwd: '', lastAt: null, messages: 12, effectiveTokens: 500 });
    expect(repo.get('s1')).toMatchObject({ cwd: '/w', lastAt: '2026-10-21T01:00:00.000Z' });
    repo.updateActivity('s1', { lastAt: '2026-10-21T02:00:00.000Z', lastUserRequest: 'hỏi', lastToolName: 'Bash', lastToolSummary: 'Bash: git status', lastEventKind: 'tool_use', fiveHourTokens: null });
    expect(repo.get('s1')).toMatchObject({ lastAt: '2026-10-21T02:00:00.000Z', messages: 12, effectiveTokens: 500, lastEventKind: 'tool_use' });
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('Claude limited sessions accurate filtering and auto-cleanup (h-limited-sessions-accurate)', () => {
  it('filters limited sessions according to reset time, autoResume, and hub origin', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-claude-test-'));
    dirs.push(root);
    const db = openDatabase(path.join(root, 'hub.db'));
    const repo = new ClaudeSessionRepo(db);
    const worktreesDir = path.join(root, 'worktrees');
    fs.mkdirSync(worktreesDir, { recursive: true });

    const { AppService } = await import('../src/services/index.js');
    const service = Object.create(AppService.prototype);
    Object.assign(service, {
      claudeSessionRepo: repo,
      config: { hubHome: root, worktreesDir },
      scheduler: { getDatabase: () => db },
      projectRepo: { getAll: () => [] },
    });

    const now = Math.floor(Date.now() / 1000);
    const profile: ProfileRow = {
      name: 'claude-system',
      engine: 'claude',
      kind: 'system',
      enabled: 1,
      home: null,
      accountType: 'personal',
      email: 'user@example.com',
      loggedIn: 1,
      createdAt: '2026-01-01',
    };

    // 1. Phiên có reset trong tương lai: HIỆN
    repo.upsert({ sessionId: 's-future', cwd: '/work/user-proj', limitResetAt: now + 3600, autoResumeEnabled: 0 });

    // 2. Phiên đã reset, không bật autoResume: KHÔNG HIỆN
    repo.upsert({ sessionId: 's-past-no-auto', cwd: '/work/user-proj', limitResetAt: now - 3600, autoResumeEnabled: 0 });

    // 3. Phiên bật autoResume chưa chạy lại: VẪN HIỆN
    repo.upsert({ sessionId: 's-past-auto', cwd: '/work/user-proj', limitResetAt: now - 600, autoResumeEnabled: 1 });

    // 4. Phiên reviewer/worker của hub (cwd nằm trong worktreesDir): KHÔNG HIỆN
    repo.upsert({ sessionId: 's-worker-wt', cwd: path.join(worktreesDir, 'proj', 'task-1'), limitResetAt: now + 3600, autoResumeEnabled: 0 });

    // 5. Phiên hub chat: KHÔNG HIỆN
    repo.upsert({ sessionId: 's-hub-chat', cwd: '/work/user-proj', isHubChat: 1, limitResetAt: now + 3600 });

    // 6. Phiên brain/chat có bản ghi trong chat_sessions: KHÔNG HIỆN
    db.prepare("INSERT INTO chat_sessions (id, title, claudeSessionId, mode) VALUES ('cs-1', 'Bộ não', 's-brain', 'safe')").run();
    repo.upsert({ sessionId: 's-brain', cwd: '/work/user-proj', limitResetAt: now + 3600 });

    // 7. Phiên có bản ghi trong claude_task_usage: KHÔNG HIỆN
    db.prepare("INSERT INTO claude_task_usage (taskId, sessionId, turnId, effectiveTokens) VALUES ('t1', 's-task-usage', 'turn-1', 100)").run();
    repo.upsert({ sessionId: 's-task-usage', cwd: '/work/user-proj', limitResetAt: now + 3600 });

    // 8. Phiên reviewer theo tiêu đề: KHÔNG HIỆN
    repo.upsert({ sessionId: 's-reviewer-prompt', cwd: '/work/other', title: 'Bạn là reviewer dự phòng…', limitResetAt: now + 3600 });

    const limited = service.getClaudeProfileLimitedSessions(profile);
    const ids = limited.map((s: { sessionId: string }) => s.sessionId);

    expect(ids).toContain('s-future');
    expect(ids).toContain('s-past-auto');
    expect(ids).not.toContain('s-past-no-auto');
    expect(ids).not.toContain('s-worker-wt');
    expect(ids).not.toContain('s-hub-chat');
    expect(ids).not.toContain('s-brain');
    expect(ids).not.toContain('s-task-usage');
    expect(ids).not.toContain('s-reviewer-prompt');

    // 9. Nút "Bỏ qua" gọi dismissClaudeSessionLimit: gỡ cờ phiên
    const dismissRes = service.dismissClaudeSessionLimit('s-future');
    expect(dismissRes).toEqual({ ok: true, sessionId: 's-future' });
    expect(repo.get('s-future')?.limitResetAt).toBeNull();
    expect(repo.get('s-future')?.limitHitAt).toBeNull();

    // 10. Nút "Dọn" gọi cleanResetClaudeSessions: dọn các phiên đã reset trong quá khứ
    const cleanRes = service.cleanResetClaudeSessions();
    expect(cleanRes.ok).toBe(true);
    expect(cleanRes.cleared).toBeGreaterThanOrEqual(1);
    expect(repo.get('s-past-auto')?.limitResetAt).toBeNull();

    db.close();
  });

  it('automatically clears flags for sessions where reset is older than 24 hours', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-claude-test-'));
    dirs.push(root);
    const db = openDatabase(path.join(root, 'hub.db'));
    const repo = new ClaudeSessionRepo(db);

    const now = Math.floor(Date.now() / 1000);
    // Quá 24 giờ (25 giờ trước)
    repo.upsert({
      sessionId: 's-expired-24h',
      cwd: '/work/user-proj',
      limitResetAt: now - 25 * 3600,
      limitHitAt: new Date(Date.now() - 26 * 3600_000).toISOString(),
    });
    // Chưa quá 24 giờ (10 giờ trước)
    repo.upsert({
      sessionId: 's-recent-10h',
      cwd: '/work/user-proj',
      limitResetAt: now - 10 * 3600,
      limitHitAt: new Date(Date.now() - 11 * 3600_000).toISOString(),
    });

    const scanner = new ClaudeSessionScanner(db, {
      dir: path.join(root, 'projects'),
      hubHome: root,
    });

    scanner.cleanExpiredLimits();

    expect(repo.get('s-expired-24h')?.limitResetAt).toBeNull();
    expect(repo.get('s-expired-24h')?.limitHitAt).toBeNull();
    expect(repo.get('s-recent-10h')?.limitResetAt).toBe(now - 10 * 3600);

    db.close();
  });
});
