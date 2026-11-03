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
import { parseProjectSettings, ProjectSettingsInputSchema } from './projects/settings.js';
import type { EventBus } from './scheduler/index.js';

const SecretKind = z.enum(['openproject-key', 'gitea-token', 'deploy-env', 'telegram-token']);
export type SecretKind = z.infer<typeof SecretKind>;
export const SetupSecretRequestSchema = z.object({ kind: SecretKind, target: z.string().min(1), label: z.string().min(1).max(200) });

function stable(value: unknown): string { return JSON.stringify(value, null, 2); }
function diff(before: unknown, after: unknown): { changed: boolean; before: unknown; after: unknown } {
  return { changed: stable(before) !== stable(after), before, after };
}

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
      getProject(id: string): any;
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
    const before = input.scope === 'global' ? this.service().getConfig() : this.service().getEffectiveConfig(input.scope);
    if (dryRun) return { dryRun: true, diff: diff(before, { preset: input.preset, scope: input.scope }) };
    const result = this.service().applyPreset({ scope: input.scope, preset: input.preset });
    return { dryRun: false, result, diff: diff(before, result) };
  }

  projectSettings(project: string, patch: unknown, dryRun = true) {
    const parsed = ProjectSettingsInputSchema.parse(patch);
    const current = this.service().getProject(project);
    const before = parseProjectSettings(current.settings);
    if (dryRun) return { dryRun: true, diff: diff(before, { ...before, ...parsed }) };
    const result = this.service().updateProject(project, { settings: parsed });
    return { dryRun: false, result, diff: diff(before, result) };
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
    const allowed = /^(brain\.(engine|model|codexProfile|mode|permissions|maxTurnsPerHour|dailyTokenBudget)|reviewer\.(order|fallback|arbiter)|notifications\.[a-zA-Z0-9_.-]+|planning\.[a-zA-Z0-9_.-]+|scheduler\.[a-zA-Z0-9_.-]+|integrations\.openproject\.sources)$/.test(pathName);
    if (!allowed || pathName.includes('..')) throw new Error(`Config path không được phép: ${pathName}`);
    const before = this.service().getConfig();
    const root: Record<string, unknown> = {};
    let cursor = root;
    const parts = pathName.split('.');
    parts.forEach((part, index) => { if (index === parts.length - 1) cursor[part] = value; else cursor = (cursor[part] ||= {}) as Record<string, unknown>; });
    if (dryRun) return { dryRun: true, diff: diff(before, root) };
    const result = this.service().updateConfig(root);
    return { dryRun: false, result, diff: diff(before, result) };
  }

  async discover(kind: 'openproject' | 'gitea' | 'checks', input: { sourceId?: string; url?: string; key?: string; project?: string }) {
    if (kind === 'checks') {
      const project = this.service().getProject(input.project || '');
      const inspected = inspectProject(project.path);
      return inspected.suggestedSettings.checks;
    }
    if (kind === 'gitea') {
      const project = this.service().getProject(input.project || '');
      const remote = execFileSync('git', ['-C', project.path, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
      const match = remote.match(/(?:\/|:)([^/]+)\/([^/]+?)(?:\.git)?$/);
      const branches = execFileSync('git', ['-C', project.path, 'for-each-ref', '--format=%(refname:short)', 'refs/remotes'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
      const names = branches.filter((b) => !b.endsWith('/HEAD')).map((b) => b.replace(/^origin\//, ''));
      const targetBranch = project.defaultBranch || 'main';
      return { url: remote, owner: match?.[1] || null, repo: match?.[2] || null, remoteBranches: names, suggestions: { sourceBranch: names.find((b) => b === 'develop' || b === 'dev') || names.find((b) => b !== targetBranch) || targetBranch, targetBranch } };
    }
    const source = this.config.integrations.openproject.sources.find((item) => item.id === input.sourceId);
    if (!source) throw new Error(`Không tìm thấy OpenProject source "${input.sourceId || ''}"`);
    const key = input.key || readOpenProjectKey(this.config.hubHome, source.id);
    if (!key) throw new Error(`Chưa cấu hình key cho OpenProject source "${source.id}"`);
    const client = new OpenProjectClient({ baseUrl: input.url || source.url, apiKey: key });
    const fetcher = (client as any).options?.fetch;
    const request = async (url: string) => fetcher ? fetcher(url) : fetch(`${input.url || source.url}${url}`, { headers: { Authorization: `Basic ${Buffer.from(`apikey:${key}`).toString('base64')}`, Accept: 'application/hal+json' } }).then((r) => r.json());
    const [me, projects, statuses] = await Promise.all([client.me(), request('/api/v3/projects?pageSize=100'), request('/api/v3/statuses?pageSize=100')]);
    const rows = (statuses?._embedded?.elements || statuses?.elements || []) as Array<{ id: number; name: string; isClosed?: boolean }>;
    const aliases: Record<string, string[]> = { watch: ['new', 'open', 'nieuw', 'mới', 'đang mở'], reopened: ['reopen', 'reopened', 'mở lại', 'mở lại'], resolved: ['resolved', 'closed', 'done', 'đã giải quyết', 'hoàn tất'], review: ['review', 'testing', 'kiểm thử', 'chờ duyệt'], open: ['open', 'new', 'mới', 'đang mở'] };
    const suggestions = Object.fromEntries(Object.entries(aliases).map(([keyName, terms]) => [keyName, rows
      .map((row) => ({ ...row, confidence: terms.some((term) => row.name.toLowerCase().includes(term)) ? 0.9 : 0 }))
      .filter((row: { confidence: number }) => row.confidence > 0)]));
    return { me, projects: projects?._embedded?.elements || projects?.elements || [], statuses: rows, suggestions };
  }

  requestSecret(input: { kind: SecretKind; target: string; label: string }) {
    const id = crypto.randomUUID(); const now = Date.now(); const expiresAt = now + 10 * 60 * 1000;
    this.db.prepare('INSERT INTO secret_requests (id,kind,target,label,status,createdAt,expiresAt) VALUES (?,?,?,?,?,?,?)').run(id, input.kind, input.target, input.label, 'pending', now, expiresAt);
    this.eventBus.emit('secret.requested', undefined, { requestId: id, kind: input.kind, target: input.target, label: input.label });
    return { requestId: id, url: `http://127.0.0.1:${this.config.port}/secrets/${id}`, expiresAt };
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
