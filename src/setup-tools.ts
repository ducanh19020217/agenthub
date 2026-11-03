import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { AgentHubConfig } from './config.js';
import { OpenProjectClient } from './integrations/openproject/client.js';
import { readOpenProjectKey } from './integrations/openproject/secrets.js';
import { inspectProject } from './projects/inspect.js';
import { mergeProjectSettings, parseProjectSettings, ProjectSettingsInputSchema } from './projects/settings.js';
import type { EventBus } from './scheduler/index.js';

const SecretKind = z.enum(['openproject-key', 'gitea-token', 'deploy-env', 'telegram-token']);
export type SecretKind = z.infer<typeof SecretKind>;
export const SetupSecretRequestSchema = z.object({ kind: SecretKind, target: z.string().min(1), label: z.string().min(1).max(200) });

function stable(value: unknown): string { return JSON.stringify(value, null, 2); }
function diff(before: unknown, after: unknown): { changed: boolean; before: unknown; after: unknown } {
  return { changed: stable(before) !== stable(after), before, after };
}

interface SetupProjectRow {
  path: string;
  defaultBranch?: string;
  settings?: string | Record<string, unknown> | null;
  checks?: string | unknown[] | null;
  reviewChain?: string | unknown[] | null;
}

const SetupProjectPatchSchema = ProjectSettingsInputSchema.extend({
  checks: z.array(z.object({ name: z.string().min(1), cmd: z.array(z.string()).min(1), timeoutSec: z.number().int().positive().optional() })).nullable().optional(),
  reviewChain: z.array(z.record(z.unknown())).nullable().optional(),
});

export class SetupTools {
  constructor(
    private readonly config: AgentHubConfig,
    private readonly db: Database.Database,
    private readonly eventBus: EventBus,
    private readonly service: () => {
      getEffectiveConfig(id: string): unknown;
      getPresets(): unknown[];
      listDepartments(): unknown;
      getDepartment(id: string): unknown;
      createDepartment(input: unknown): unknown;
      updateDepartment(id: string, input: unknown): unknown;
      updateDepartmentProjects(id: string, input: unknown): unknown;
      applyPreset(input: unknown): unknown;
      getProject(id: string): SetupProjectRow;
      updateProject(id: string, input: unknown): unknown;
      getConfig(): unknown;
      updateConfig(input: unknown): unknown;
    },
  ) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS secret_requests (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, target TEXT NOT NULL, label TEXT NOT NULL,
      status TEXT NOT NULL, createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL,
      configuredAt INTEGER, UNIQUE(kind, target, status)
    )`);
  }

  effectiveConfig(project: string) { return this.service().getEffectiveConfig(project); }
  presets() { return this.service().getPresets(); }
  departments() { return this.service().listDepartments(); }

  applyPreset(input: { scope: string; preset: string; dryRun?: boolean }) {
    const dryRun = input.dryRun !== false;
    const result = this.service().applyPreset({ scope: input.scope, preset: input.preset, dryRun });
    return { dryRun, ...(result as Record<string, unknown>) };
  }

  projectSettings(project: string, patch: unknown, dryRun = true) {
    const parsed = SetupProjectPatchSchema.parse(patch);
    const current = this.service().getProject(project);
    const before = parseProjectSettings(typeof current.settings === 'string' ? current.settings : current.settings ? JSON.stringify(current.settings) : null);
    const settingsPatch = parsed;
    const { checks, reviewChain, ...settingsOnly } = settingsPatch;
    const nextSettings = mergeProjectSettings(before, settingsOnly);
    const snapshot = (row: SetupProjectRow) => ({
      settings: row.settings && typeof row.settings !== 'string' ? row.settings : parseProjectSettings(row.settings || null),
      checks: row.checks && typeof row.checks !== 'string' ? row.checks : (row.checks ? JSON.parse(row.checks) : null),
      reviewChain: row.reviewChain && typeof row.reviewChain !== 'string' ? row.reviewChain : (row.reviewChain ? JSON.parse(row.reviewChain) : null),
    });
    const after = { settings: nextSettings, checks: checks === undefined ? snapshot(current).checks : checks, reviewChain: reviewChain === undefined ? snapshot(current).reviewChain : reviewChain };
    if (dryRun) return { dryRun: true, diff: diff(snapshot(current), after) };
    const result = this.service().updateProject(project, { settings: settingsOnly, ...(checks !== undefined ? { checks } : {}), ...(reviewChain !== undefined ? { reviewChain } : {}) });
    return { dryRun: false, result, diff: diff(snapshot(current), snapshot(result as SetupProjectRow)) };
  }

  department(id: string | undefined, patch: unknown, assignProjects: string[] | undefined, dryRun = true) {
    const before = id ? this.service().getDepartment(id) : null;
    const after = { id, patch, assignProjects: assignProjects || [] };
    if (dryRun) return { dryRun: true, diff: diff(before, after) };
    const result = id ? this.service().updateDepartment(id, patch) : this.service().createDepartment(patch);
    const resultId = (result as { id?: string }).id || id;
    if (resultId && assignProjects?.length) for (const projectId of assignProjects) this.service().updateDepartmentProjects(resultId, { projectId });
    return { dryRun: false, result: resultId ? this.service().getDepartment(resultId) : result, diff: diff(before, result) };
  }

  configSet(pathName: string, value: unknown, dryRun = true) {
    const allowed = new Set([
      'brain.engine', 'brain.model', 'brain.codexProfile', 'brain.mode', 'brain.permissions', 'brain.maxTurnsPerHour', 'brain.dailyTokenBudget',
      'reviewer.order', 'reviewer.fallback', 'reviewer.arbiter', 'notifications.desktop', 'notifications.desktopLevel',
      'planning.requireApproval', 'planning.approvalMinTasks', 'scheduler.maxRunsPerTask', 'scheduler.maxConsecutiveCrashesPerTask',
      'integrations.openproject.sources',
    ]).has(pathName);
    if (!allowed || pathName.includes('..')) throw new Error(`Config path không được phép: ${pathName}`);
    const before = this.service().getConfig();
    const root: Record<string, unknown> = {};
    let cursor = root;
    const parts = pathName.split('.');
    parts.forEach((part, index) => { if (index === parts.length - 1) cursor[part] = value; else cursor = (cursor[part] ||= {}) as Record<string, unknown>; });
    const merged = JSON.parse(JSON.stringify(before)) as Record<string, unknown>;
    let mergedCursor = merged;
    parts.forEach((part, index) => {
      if (index === parts.length - 1) mergedCursor[part] = value;
      else mergedCursor = (mergedCursor[part] ||= {}) as Record<string, unknown>;
    });
    if (dryRun) return { dryRun: true, diff: diff(before, merged) };
    const result = this.service().updateConfig(root);
    return { dryRun: false, result, diff: diff(before, result) };
  }

  async discover(kind: 'openproject' | 'gitea' | 'checks', input: { sourceId?: string; url?: string; project?: string }) {
    if (kind === 'checks') {
      if (!input.project) throw new Error('Project là bắt buộc khi dò checks');
      const project = this.service().getProject(input.project);
      const inspected = inspectProject(project.path);
      return inspected.suggestedSettings.checks;
    }
    if (kind === 'gitea') {
      if (!input.project) throw new Error('Project là bắt buộc khi dò Gitea');
      const project = this.service().getProject(input.project);
      let remote: string;
      try { remote = execFileSync('git', ['-C', project.path, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim(); }
      catch { throw new Error(`Project "${input.project}" chưa có remote origin`); }
      const match = remote.match(/(?:\/|:)([^/]+)\/([^/]+?)(?:\.git)?$/);
      const branches = execFileSync('git', ['-C', project.path, 'for-each-ref', '--format=%(refname:short)', 'refs/remotes'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
      const names = branches.filter((b) => !b.endsWith('/HEAD')).map((b) => b.replace(/^origin\//, ''));
      const targetBranch = project.defaultBranch || 'main';
      return { url: remote, owner: match?.[1] || null, repo: match?.[2] || null, remoteBranches: names, suggestions: { sourceBranch: names.find((b) => b === 'develop' || b === 'dev') || names.find((b) => b !== targetBranch) || targetBranch, targetBranch } };
    }
    const source = this.config.integrations.openproject.sources.find((item) => item.id === input.sourceId);
    if (!source) throw new Error(`Không tìm thấy OpenProject source "${input.sourceId || ''}"`);
    const key = readOpenProjectKey(this.config.hubHome, source.id);
    if (!key) throw new Error(`Chưa cấu hình key cho OpenProject source "${source.id}"`);
    const client = new OpenProjectClient({ baseUrl: input.url || source.url, apiKey: key });
    const [me, projects, statusCollection] = await Promise.all([client.me(), client.listProjects(), client.listStatuses()]);
    const rows = statusCollection._embedded?.elements || [];
    const terms: Record<string, string[]> = { watch: ['watch', 'new', 'open', 'mới', 'đang mở'], reopened: ['reopen', 'reopened', 'mở lại'], resolved: ['resolved', 'closed', 'done', 'đã giải quyết', 'hoàn tất'], review: ['review', 'testing', 'kiểm thử', 'chờ duyệt'] };
    const suggestions = Object.fromEntries(Object.entries(terms).map(([name, aliases]) => [name, rows.flatMap((row) => {
      const normalized = row.name.toLocaleLowerCase();
      const textMatch = aliases.some((term) => normalized.includes(term));
      const closedMatch = name === 'resolved' ? row.isClosed === true : name === 'watch' || name === 'reopened' ? row.isClosed === false : undefined;
      const confidence = textMatch && closedMatch === true ? 1 : textMatch ? 0.8 : closedMatch === true ? 0.55 : 0;
      return confidence ? [{ ...row, confidence }] : [];
    })]));
    return { me, projects: projects._embedded?.elements || [], statuses: rows, suggestions };
  }

  async requestSecret(input: { kind: SecretKind; target: string; label: string }) {
    const id = crypto.randomUUID(); const now = Date.now(); const expiresAt = now + 10 * 60 * 1000;
    this.db.prepare('INSERT INTO secret_requests (id,kind,target,label,status,createdAt,expiresAt) VALUES (?,?,?,?,?,?,?)').run(id, input.kind, input.target, input.label, 'pending', now, expiresAt);
    this.eventBus.emit('secret.requested', undefined, { requestId: id, kind: input.kind, target: input.target, label: input.label });
    const url = `http://127.0.0.1:${this.config.port}/secrets/${id}`;
    while (Date.now() < expiresAt) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const current = this.getSecretRequest(id);
      if (current?.status === 'configured') return { configured: true, requestId: id };
      if (current?.status === 'expired') return { configured: false, reason: 'expired', url };
    }
    this.expireSecret(id);
    return { configured: false, reason: 'expired', url };
  }

  getSecretRequest(id: string) {
    const request = this.db.prepare('SELECT id,kind,target,label,status,createdAt,expiresAt,configuredAt FROM secret_requests WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (request && request.status === 'pending' && Number(request.expiresAt) < Date.now()) {
      this.db.prepare("UPDATE secret_requests SET status='expired' WHERE id=? AND status='pending'").run(id);
      request.status = 'expired';
    }
    return request;
  }
  saveSecret(id: string, value: string) {
    if (!value.trim()) throw new Error('Giá trị bí mật không được để trống');
    const req = this.getSecretRequest(id); if (!req || req.status !== 'pending') throw new Error('Yêu cầu bí mật không còn chờ xử lý');
    if (Number(req.expiresAt) < Date.now()) { this.db.prepare("UPDATE secret_requests SET status='expired' WHERE id=?").run(id); throw new Error('Yêu cầu bí mật đã hết hạn'); }
    const secretDir = path.join(this.config.hubHome, 'secrets'); fs.mkdirSync(secretDir, { recursive: true, mode: 0o700 });
    const kind = String(req.kind); const target = String(req.target);
    const file = kind === 'openproject-key' ? path.join(secretDir, `openproject-${target}.key`) : kind === 'gitea-token' ? path.join(secretDir, `gitea-${target}.token`) : kind === 'telegram-token' ? path.join(secretDir, 'telegram.token') : path.join(secretDir, `deploy-${target}.env`);
    fs.writeFileSync(file, `${value.trim()}\n`, { mode: 0o600 }); fs.chmodSync(file, 0o600);
    this.db.prepare("UPDATE secret_requests SET status='configured', configuredAt=? WHERE id=?").run(Date.now(), id);
    this.eventBus.emit('secret.configured', undefined, { requestId: id, kind });
    return { configured: true };
  }
  expireSecret(id: string) { this.db.prepare("UPDATE secret_requests SET status='expired' WHERE id=? AND status='pending'").run(id); return { configured: false, reason: 'expired' }; }
}
