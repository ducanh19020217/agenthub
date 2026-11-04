import path from 'node:path';
import { hubVersion } from '../version.js';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ServerResponse } from 'node:http';
import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import { AgentHubConfig } from '../config.js';
import { getOrCreateToken, registerSecurityHooks } from '../auth.js';
import { AppService, HttpError } from '../services/index.js';
import { registerSseRoute } from './sse.js';
import { PtyManager, registerPtyRoutes } from './pty.js';
import { registerBrainRoutes } from '../brain.js';
import { registerChatRoutes } from '../chat/service.js';
import { brandingLogoPath, saveBrandingLogo } from '../branding.js';
import { decodeCursor } from '../pagination.js';
import { registerOpenProjectRoutes, type OpenProjectSyncResult } from '../integrations/openproject/routes.js';
import { parseDateNoon } from '../integrations/openproject/daily-report.js';
import { SetupSecretRequestSchema } from '../setup-tools.js';

export function resolveWebDistDir(customDir?: string): string {
  return path.resolve(customDir || resolveWebDir(import.meta.url, process.env));
}

export function resolveWebDir(moduleUrl: string, env: NodeJS.ProcessEnv = {}): string {
  if (env.AGENTHUB_WEB_DIR) return path.resolve(env.AGENTHUB_WEB_DIR);
  if (moduleUrl.includes('/src/')) return fileURLToPath(new URL('../../dist/web', moduleUrl));
  if (moduleUrl.includes('/dist/api/')) return fileURLToPath(new URL('../web', moduleUrl));
  return fileURLToPath(new URL('./web', moduleUrl));
}

export async function createServer(
  service: AppService,
  config: AgentHubConfig,
  options?: {
    webDir?: string;
    onShutdown?: (disable: boolean) => void;
    openProjectSync?: (sourceId: string) => Promise<OpenProjectSyncResult>;
    openProjectDailyReport?: (sourceId: string, date?: string) => Promise<{ path: string; content: string }>;
  },
): Promise<FastifyInstance> {
  const fastify = Fastify({ logger: false, forceCloseConnections: true });

  // Track active SSE response streams to end them cleanly on close
  const sseClients = new Set<ServerResponse>();
  fastify.addHook('onRequest', async (req, reply) => {
    const rawPath = (req.raw.url || req.url || '').split('?')[0];
    if (rawPath === '/api/events') {
      sseClients.add(reply.raw);
      req.raw.on('close', () => {
        sseClients.delete(reply.raw);
      });
    }
  });

  // Close all WebSocket clients with code 1001 (Going Away) on shutdown
  const closeWebSockets = () => {
    if (fastify.websocketServer?.clients) {
      for (const client of fastify.websocketServer.clients) {
        try {
          if (client.readyState === 1 /* OPEN */) {
            client.close(1001, 'Going Away');
          } else if (client.readyState === 0 /* CONNECTING */) {
            client.terminate();
          }
        } catch {
          // ignore
        }
      }
    }
  };

  fastify.addHook('preClose', (done) => {
    closeWebSockets();
    done();
  });

  // Get or create authentication token
  const token = getOrCreateToken(config.tokenPath);

  // Register security hooks (Host check, Origin check, token auth)
  const getPort = (): number => {
    const addr = fastify.server.address();
    if (addr && typeof addr === 'object') return addr.port;
    return config.port;
  };
  registerSecurityHooks(fastify, token, getPort, config.allowedHosts);

  // Register WebSocket support
  await fastify.register(fastifyWebsocket);

  // Global error handler
  fastify.setErrorHandler((error: Error & { statusCode?: number; error?: string }, _req, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: 'bad_request',
        message: error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
      });
    }
    if (error instanceof HttpError) {
      return reply.status(error.statusCode).send({
        error: error.error,
        message: error.message,
      });
    }
    if (error.statusCode) {
      return reply.status(error.statusCode).send({
        error: error.error || 'error',
        message: error.message,
      });
    }
    return reply.status(500).send({
      error: 'internal_server_error',
      message: error.message || 'Internal server error',
    });
  });

  // Health check (no token required)
  fastify.get('/health', async () => {
    return { ok: true, version: hubVersion() };
  });

  fastify.get('/api/version', async () => {
    const indexPath = path.join(resolveWebDistDir(options?.webDir), 'index.html');
    let webBuildId: number | null = null;
    try { webBuildId = fs.statSync(indexPath).mtimeMs; } catch { /* no web build */ }
    return { version: '0.1.0', webBuildId };
  });

  // --- Status API ---
  fastify.get('/api/status', async () => {
    return service.getStatus();
  });
  // --- Setup wizard / MCP configuration API ---
  fastify.get('/api/setup/effective-config/:id', async (req) => service.getSetupTools().effectiveConfig((req.params as { id: string }).id));
  fastify.get('/api/setup/presets', async () => service.getSetupTools().presets());
  fastify.get('/api/setup/departments', async () => service.getSetupTools().departments());
  fastify.post('/api/setup/preset-apply', async (req) => {
    const body = (req.body || {}) as { scope: string; preset: string; dryRun?: boolean };
    return service.getSetupTools().applyPreset(body);
  });
  fastify.post('/api/setup/project-settings/:id', async (req) => {
    const body = (req.body || {}) as { patch: unknown; dryRun?: boolean };
    return service.getSetupTools().projectSettings((req.params as { id: string }).id, body.patch, body.dryRun !== false);
  });
  fastify.post('/api/setup/department', async (req) => {
    const body = (req.body || {}) as { id?: string; patch: unknown; assignProjects?: string[]; dryRun?: boolean };
    return service.getSetupTools().department(body.id, body.patch, body.assignProjects, body.dryRun !== false);
  });
  fastify.post('/api/setup/config-set', async (req) => {
    const body = (req.body || {}) as { path: string; value: unknown; dryRun?: boolean };
    return service.getSetupTools().configSet(body.path, body.value, body.dryRun !== false);
  });
  fastify.post('/api/setup/integration-discover', async (req) => {
    const body = (req.body || {}) as { kind: 'openproject' | 'gitea' | 'checks'; sourceId?: string; url?: string; project?: string };
    return service.getSetupTools().discover(body.kind, body);
  });
  fastify.get('/api/setup/export', async () => service.getSetupTools().exportSetup());
  fastify.post('/api/setup/import', async (req) => {
    const body = (req.body || {}) as { file?: unknown; dryRun?: unknown };
    if (typeof body.file !== 'string' || !body.file.trim()) throw new HttpError(400, 'bad_request', 'File setup là bắt buộc');
    try {
      const filePath = path.resolve(body.file);
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error('File setup không hợp lệ hoặc quá lớn');
      const imported = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
      return service.getSetupTools().importSetup(imported, body.dryRun !== false);
    } catch (error) {
      throw new HttpError(400, 'bad_request', `Không thể đọc file setup: ${error instanceof Error ? error.message : 'dữ liệu không hợp lệ'}`);
    }
  });
  fastify.post('/api/secrets/requests', async (req) => service.getSetupTools().requestSecret(SetupSecretRequestSchema.parse(req.body)));
  fastify.get('/api/secrets/requests/:id', async (req) => service.getSetupTools().getSecretRequest((req.params as { id: string }).id) || { configured: false, reason: 'not_found' });
  fastify.post('/api/secrets/requests/:id/value', async (req) => service.getSetupTools().saveSecret((req.params as { id: string }).id, String((req.body as { value?: unknown })?.value || '')));
  fastify.get('/secrets/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const request = service.getSetupTools().getSecretRequest(id);
    if (!request) return reply.status(404).type('text/plain').send('Không tìm thấy yêu cầu');
    return reply.type('text/html; charset=utf-8').send(`<!doctype html><meta charset="utf-8"><title>Nhập bí mật AgentHub</title><h1>${String(request.label)}</h1><form id="secret"><input id="value" type="password" autofocus required><button>Lưu</button></form><p id="status"></p><script>document.getElementById('secret').onsubmit=async(e)=>{e.preventDefault();const value=document.getElementById('value').value;const r=await fetch('/api/secrets/requests/${encodeURIComponent(id)}/value',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({value})});document.getElementById('status').textContent=r.ok?'Đã lưu an toàn. Bạn có thể đóng trang này.':'Không thể lưu yêu cầu.';document.getElementById('value').value='';};</script>`);
  });
  registerOpenProjectRoutes(fastify, config, {
    sync: options?.openProjectSync,
    dailyReport: options?.openProjectDailyReport || (service.dailyReportService ? (sourceId, date) => service.dailyReportService!.generateReport(sourceId, date ? parseDateNoon(date) : undefined, { overwrite: true }) : undefined),
    decision: (sourceId, wpId, action, note) => service.decideOpenProjectTicket(sourceId, wpId, action, note),
    triageInput: (sourceId, wpId, content) => service.submitOpenProjectTriageInput(sourceId, wpId, content),
  });

  fastify.post('/api/hub/shutdown', async (req) => {
    const body = (req.body || {}) as { disable?: unknown };
    const disable = body.disable === true;
    const result = service.shutdownForUser();
    options?.onShutdown?.(disable);
    return { ok: true, daemonPid: process.pid, ...result };
  });

  fastify.get('/api/perf', async () => service.getPerf());

  fastify.get('/api/setup/status', async () => service.getSetupStatus());
  fastify.post('/api/setup/install/:tool', async (req, reply) => {
    const { tool } = req.params as { tool: string };
    return reply.status(202).send(await service.installSetupTool(tool));
  });
  fastify.get('/api/setup/log/:tool', async (req, reply) => {
    const { tool } = req.params as { tool: string };
    const logPath = service.getSetupLogPath(tool);
    if (!logPath) throw new HttpError(404, 'not_found', 'Setup log không tồn tại');
    return reply.type('text/plain; charset=utf-8').send(fs.createReadStream(logPath));
  });
  fastify.post('/api/setup/complete', async () => service.completeSetup(false));
  fastify.post('/api/setup/skip', async () => service.completeSetup(true));
  fastify.post('/api/setup/mcp', async () => {
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const cliPath = path.join(projectRoot, 'dist', 'cli.js');
    const { execFile } = await import('node:child_process');
    return new Promise((resolve, reject) => {
      execFile('claude', ['mcp', 'add', '--scope', 'user', 'agenthub', '--', process.execPath, cliPath, 'mcp'], { timeout: 60_000 }, (error, stdout, stderr) => {
        if (error) return reject(new HttpError(500, 'mcp_install_failed', stderr || error.message));
        resolve({ ok: true, output: `${stdout}${stderr}` });
      });
    });
  });

  fastify.post('/api/scheduler/pause', async () => service.pauseScheduler());
  fastify.post('/api/scheduler/resume', async () => service.resumeScheduler());
  fastify.get('/api/focus', async () => service.getFocus());
  fastify.put('/api/focus', async (req) => service.setFocus(req.body));

  // --- Telegram API ---
  fastify.get('/api/telegram/pairing-code', async (req) => {
    const query = req.query as { refresh?: string } | undefined;
    const refresh = query?.refresh === '1' || query?.refresh === 'true';
    return service.getTelegramPairingCode(refresh);
  });
  fastify.post('/api/telegram/pairing-code/refresh', async () => {
    return service.getTelegramPairingCode(true);
  });
  fastify.post('/api/telegram/pair-code', async () => service.getTelegramPairingCode(true));
  fastify.put('/api/telegram/token', async (req) => {
    const body = req.body as { token?: unknown; botToken?: unknown };
    const token = typeof body?.token === 'string' ? body.token : body?.botToken;
    if (typeof token !== 'string') throw new HttpError(400, 'bad_request', 'token phải là chuỗi');
    return service.saveTelegramToken(token);
  });
  fastify.post('/api/telegram/test', async () => service.testTelegram());
  fastify.delete('/api/telegram/chats/:id', async (req) => {
    const { id } = req.params as { id: string };
    const chatId = Number(id);
    if (!Number.isSafeInteger(chatId)) throw new HttpError(400, 'bad_request', 'chat id không hợp lệ');
    return service.removeTelegramChat(chatId);
  });
  fastify.get('/api/telegram/status', async () => {
    return service.getTelegramStatus();
  });
  fastify.post('/api/telegram/topics/setup', async (req) => {
    const body = req.body as { mode?: 'project' | 'department' } | undefined;
    return service.setupTelegramTopics(body?.mode);
  });
  fastify.post('/api/telegram/projects/:id/topic', async (req) => {
    const { id } = req.params as { id: string };
    return service.createTelegramProjectTopic(id);
  });
  fastify.post('/api/telegram/departments/:id/topic', async (req) => {
    const { id } = req.params as { id: string };
    return service.createTelegramDepartmentTopic(id);
  });
  fastify.put('/api/telegram/projects/:id/chat', async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as { chatId?: unknown };
    if (typeof body?.chatId !== 'number' || !Number.isSafeInteger(body.chatId)) {
      throw new HttpError(400, 'bad_request', 'chatId không hợp lệ');
    }
    return service.attachTelegramProjectChat(id, body.chatId);
  });

  fastify.get('/api/system/orphans', async () => service.getOrphans());
  fastify.post('/api/system/orphans/reap', async () => service.reapOrphans());

  // --- Brain API ---
  if (service.brainService) {
    registerBrainRoutes(fastify, service.brainService, service);
  }

  // --- Departments API ---
  fastify.get('/api/departments', async () => service.listDepartments());
  fastify.get('/api/departments/:id', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return service.getDepartment(id);
  });
  fastify.post('/api/departments', async (req: FastifyRequest, reply: FastifyReply) => {
    return reply.status(201).send(service.createDepartment(req.body));
  });
  fastify.patch('/api/departments/:id', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return service.updateDepartment(id, req.body);
  });
  fastify.delete('/api/departments/:id', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return service.deleteDepartment(id);
  });
  fastify.put('/api/departments/:id/profiles', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return service.updateDepartmentProfiles(id, req.body);
  });
  fastify.put('/api/departments/:id/projects', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return service.updateDepartmentProjects(id, req.body);
  });
  fastify.post('/api/departments/:id/projects', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return service.updateDepartmentProjects(id, req.body);
  });

  // --- Projects API ---
  fastify.get('/api/projects', async (req: FastifyRequest) => {
    const query = req.query as { archived?: string | boolean };
    const includeArchived = query?.archived === true || query?.archived === 'true' || query?.archived === '1';
    return service.listProjects(includeArchived);
  });

  fastify.post('/api/projects/inspect', async (req: FastifyRequest) => service.inspectProject(req.body));

  fastify.post('/api/projects/:id/guidance', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return service.writeProjectGuidance(id, req.body);
  });

  fastify.post('/api/projects/:id/summarize-context', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return service.summarizeProjectContext(id, req.body);
  });

  fastify.get('/api/projects/:id/summarize-context/:taskId', async (req: FastifyRequest) => {
    const { id, taskId } = req.params as { id: string; taskId: string };
    return service.getProjectContextSummary(id, taskId);
  });

  // Creating a repository is intentionally separate from registering an existing one.
  // Keep both spellings for clients that adopted the early wizard contract.
  for (const route of ['/api/projects/new', '/api/projects/create']) {
    fastify.post(route, async (req: FastifyRequest, reply: FastifyReply) => reply.status(201).send(service.createNewProject(req.body)));
  }

  fastify.get('/api/projects/:id', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return service.getProject(id);
  });

  fastify.get('/api/projects/:id/effective-config', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return service.getEffectiveConfig(id);
  });

  fastify.get('/api/projects/:id/deploy', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return service.getDeployStatus(id);
  });

  fastify.post('/api/projects/:id/deploy', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as { pushNow?: boolean };
    if (body.pushNow === true) {
      const result = await service.pushDeployNow(id);
      return reply.status(result.status === 'failed' ? 500 : 200).send(result);
    }
    return reply.status(202).send(service.rerunDeploy(id));
  });

  fastify.put('/api/projects/:id/gitea/token', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as { token?: string };
    if (!body.token || typeof body.token !== 'string' || !body.token.trim()) {
      throw new HttpError(400, 'bad_request', 'Token không được để trống');
    }
    return service.saveGiteaToken(id, body.token);
  });

  fastify.get('/api/projects/:id/gitea/status', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return service.getGiteaStatus(id);
  });

  fastify.post('/api/projects/:id/gitea/sync', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return service.triggerGiteaSync(id);
  });

  fastify.put('/api/projects/:id/remote-deploy/env', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return service.saveRemoteDeployEnv(id, req.body);
  });

  fastify.post('/api/projects/:id/remote-deploy', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as { commit?: string };
    const status = service.triggerRemoteDeploy(id, { trigger: 'manual', commit: body.commit });
    return reply.status(202).send(status);
  });

  fastify.get('/api/projects/:id/remote-deploy/status', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return service.getRemoteDeployStatus(id) ?? { projectId: id, status: 'idle' };
  });

  fastify.get('/api/projects/:id/remote-deploy', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return service.getRemoteDeployStatus(id) ?? { projectId: id, status: 'idle' };
  });

  fastify.post('/api/projects', async (req: FastifyRequest, reply: FastifyReply) => {
    const project = service.createProject(req.body);
    return reply.status(201).send(project);
  });

  fastify.patch('/api/projects/:id', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    const body = (req.body || {}) as { settings?: { brain?: { permissions?: string } }; confirm?: boolean };
    if (body.settings?.brain?.permissions === 'full' && body.confirm !== true) {
      throw new HttpError(409, 'confirmation_required', 'Cấp Toàn quyền cần confirm: true vì cho phép Claude chạy mọi lệnh');
    }
    const result = service.updateProject(id, req.body);
    if (body.settings?.brain?.permissions) {
      service.scheduler.getEventBus().emit('brain.trust_changed', undefined, { projectId: id, permissions: body.settings.brain.permissions });
    }
    return result;
  });

  fastify.delete('/api/projects/:id', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    const query = req.query as { purge?: string | boolean; confirm?: string };
    const purge = query?.purge === true || query?.purge === 'true' || query?.purge === '1';
    return service.deleteProject(id, { purge, confirm: query?.confirm });
  });

  fastify.post('/api/projects/:id/restore', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return service.restoreProject(id);
  });

  fastify.get('/api/projects/:id/knowledge', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    const query = req.query as { limit?: string; cursor?: string; offset?: string };
    if (query.cursor && !decodeCursor(query.cursor)) throw new HttpError(400, 'bad_request', 'Invalid pagination cursor');
    return query.limit === undefined ? service.listKnowledge(id) : service.pageKnowledge(id, query);
  });

  fastify.get('/api/projects/:id/ci/runs', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    const query = req.query as { limit?: string; cursor?: string; offset?: string };
    if (query.cursor && !decodeCursor(query.cursor)) throw new HttpError(400, 'bad_request', 'Invalid pagination cursor');
    if (query.limit === undefined) return service.ciRepo?.listByProject(id) || [];
    return service.pageCiRuns(id, query);
  });

  fastify.get('/api/events/history', async (req: FastifyRequest) => {
    const query = req.query as { taskId?: string; limit?: string; cursor?: string; offset?: string };
    if (query.cursor && !decodeCursor(query.cursor)) throw new HttpError(400, 'bad_request', 'Invalid pagination cursor');
    if (query.limit === undefined) return query.taskId ? service.eventRepo.getByTask(query.taskId) : service.eventRepo.getRecent(50);
    return service.pageEvents(query);
  });

  fastify.get('/api/projects/:id/review-checklist/preview', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return service.reviewChecklistPreview(id);
  });

  fastify.post('/api/projects/:id/knowledge', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    return reply.status(201).send(service.addKnowledge(id, req.body));
  });

  fastify.patch('/api/projects/:id/knowledge', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    const body = (req.body || {}) as { id?: number };
    return service.updateKnowledge(id, String(body.id), body);
  });

  fastify.delete('/api/projects/:id/knowledge', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    const body = (req.body || {}) as { id?: number };
    return service.deleteKnowledge(id, String(body.id));
  });

  fastify.patch('/api/projects/:id/knowledge/:entryId', async (req: FastifyRequest) => {
    const { id, entryId } = req.params as { id: string; entryId: string };
    return service.updateKnowledge(id, entryId, req.body);
  });

  fastify.delete('/api/projects/:id/knowledge/:entryId', async (req: FastifyRequest) => {
    const { id, entryId } = req.params as { id: string; entryId: string };
    return service.deleteKnowledge(id, entryId);
  });

  fastify.get('/api/projects/:id/notes', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    const query = req.query as { since?: string; runningOnly?: string; taskId?: string };
    return service.getProjectNotes(id, query);
  });

  // --- Profiles API ---
  fastify.get('/api/profiles', async () => {
    return service.listProfiles();
  });

  fastify.post('/api/profiles/:name/usage/refresh', async (req: FastifyRequest) => {
    const { name } = req.params as { name: string };
    return service.refreshUsage(name);
  });

  fastify.delete('/api/profiles/:name', async (req: FastifyRequest) => {
    const { name } = req.params as { name: string };
    const query = req.query as { purgeHome?: string | boolean };
    const purgeHome = query?.purgeHome === '1' || query?.purgeHome === 'true' || query?.purgeHome === true;
    return service.deleteProfile(name, purgeHome);
  });

  fastify.post('/api/profiles/:name/rename', async (req: FastifyRequest) => {
    const { name } = req.params as { name: string };
    return service.renameProfile(name, req.body);
  });

  fastify.post('/api/profiles', async (req: FastifyRequest, reply: FastifyReply) => {
    const profile = service.createProfile(req.body);
    return reply.status(201).send(profile);
  });

  fastify.post('/api/profiles/import-tokens', async (req: FastifyRequest, reply: FastifyReply) => {
    const result = await service.importAgyTokens(req.body);
    return reply.status(200).send(result);
  });

  fastify.post('/api/profiles/:name/check', async (req: FastifyRequest, reply: FastifyReply) => {
    const { name } = req.params as { name: string };
    return reply.status(202).send(service.startProfileCheck(name));
  });

  fastify.patch('/api/profiles/:name', async (req: FastifyRequest) => {
    const { name } = req.params as { name: string };
    return service.updateProfile(name, req.body);
  });

  fastify.post('/api/profiles/:name/quota', async (req: FastifyRequest) => {
    const { name } = req.params as { name: string };
    return service.markQuota(name, req.body);
  });

  fastify.delete('/api/profiles/:name/quota', async (req: FastifyRequest) => {
    const { name } = req.params as { name: string };
    const query = req.query as { family?: string };
    const body = req.body as { family?: string } | undefined;
    const family = query?.family || body?.family;
    if (!family) {
      throw new HttpError(400, 'bad_request', 'Missing family parameter');
    }
    return service.clearQuota(name, family);
  });

  // --- Tasks API ---
  fastify.get('/api/tasks', async (req: FastifyRequest) => {
    const query = req.query as { project?: string; status?: string; search?: string; q?: string; limit?: string; cursor?: string; offset?: string; sort?: string; order?: string };
    if (query.cursor && !decodeCursor(query.cursor)) {
      throw new HttpError(400, 'bad_request', 'Invalid pagination cursor');
    }
    if (query.limit === undefined) return service.listTasks(query);
    return service.listTasksPage({ ...query, search: query.search ?? query.q });
  });

  fastify.get('/api/tasks/graph', async (req: FastifyRequest) => {
    const query = req.query as { project?: string; includeDone?: string };
    return service.getTasksGraph(query);
  });

  fastify.post('/api/tasks', async (req: FastifyRequest, reply: FastifyReply) => {
    const task = (req.body && typeof req.body === 'object' && 'createTicket' in req.body)
      ? await service.createTaskWithTicket(req.body)
      : service.createTask(req.body);
    return reply.status(201).send(task);
  });

  fastify.post('/api/tasks/from-error', async (req: FastifyRequest, reply: FastifyReply) => {
    const task = service.captureTask(req.body);
    return reply.status(201).send(task);
  });

  fastify.get('/api/tasks/:id', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return service.getTask(id);
  });

  fastify.patch('/api/tasks/:id', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return service.updateTask(id, req.body);
  });

  fastify.post('/api/tasks/:id/start', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return service.startTask(id);
  });

  fastify.post('/api/tasks/:id/cancel', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return service.cancelTask(id);
  });

  fastify.post('/api/tasks/:id/pause', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    const body = (req.body || {}) as { reason?: 'manual' | 'load' | 'brain_load' };
    return service.pauseTask(id, body.reason);
  });

  fastify.post('/api/tasks/:id/resume', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return service.resumeTask(id);
  });

  fastify.post('/api/tasks/:id/review', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return service.reviewTask(id, req.body);
  });

  fastify.post('/api/tasks/:id/retry', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return service.retryTask(id, req.body);
  });

  fastify.post('/api/tasks/:id/review/retry-reviewer', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return service.retryReviewer(id);
  });

  fastify.delete('/api/tasks/:id/worktree', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return service.deleteWorktree(id);
  });

  fastify.get('/api/tasks/:id/log', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const query = req.query as { run?: string; tail?: string };
    const log = service.getTaskLog(id, query);
    return reply.type('text/plain; charset=utf-8').send(log);
  });

  fastify.post('/api/tasks/:id/checks/rerun', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return service.rerunChecks(id);
  });

  fastify.post('/api/tasks/:id/notes', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const note = service.createTaskNote(id, req.body);
    return reply.status(201).send(note);
  });

  fastify.get('/api/tasks/:id/notes', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return service.getTaskNotes(id);
  });

  fastify.get('/api/tasks/:id/runs', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    const query = req.query as { limit?: string; cursor?: string; offset?: string };
    if (query.cursor && !decodeCursor(query.cursor)) throw new HttpError(400, 'bad_request', 'Invalid pagination cursor');
    if (query.limit === undefined) return service.runRepo.getByTask(id.replace('~', '/'));
    return service.pageTaskRuns(id, query);
  });

  fastify.delete('/api/tasks/:id', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return service.deleteTask(id);
  });

  // --- Batches API ---
  fastify.get('/api/batches', async (req: FastifyRequest) => {
    const query = req.query as { project?: string; status?: string; limit?: string; cursor?: string; offset?: string };
    if (query.cursor && !decodeCursor(query.cursor)) throw new HttpError(400, 'bad_request', 'Invalid pagination cursor');
    if (query.limit !== undefined) return service.pageBatches(query);
    return service.listBatches(query);
  });

  fastify.get('/api/batches/:id', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return service.getBatch(id);
  });

  fastify.post('/api/batches', async (req: FastifyRequest, reply: FastifyReply) => {
    const batch = service.createBatch(req.body);
    return reply.status(201).send(batch);
  });

  fastify.post('/api/batches/:id/dispatch', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return service.dispatchBatch(id);
  });

  fastify.post('/api/batches/:id/discard', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return service.discardBatch(id);
  });

  fastify.post('/api/batches/:id/tasks', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const task = service.addTaskToBatch(id, req.body);
    return reply.status(201).send(task);
  });

  fastify.delete('/api/batches/:id/tasks/:taskId', async (req: FastifyRequest) => {
    const { id, taskId } = req.params as { id: string; taskId: string };
    return service.removeTaskFromBatch(id, taskId);
  });

  // --- Config API ---
  fastify.get('/api/presets', async () => service.getPresets());
  fastify.post('/api/presets/apply', async (req: FastifyRequest) => service.applyPreset(req.body));

  fastify.get('/api/config', async () => {
    return service.getConfig();
  });

  fastify.get('/api/branding/logo', async (_req, reply) => {
    const logoPath = brandingLogoPath(config.hubHome);
    if (!logoPath) return reply.status(404).send({ error: 'not_found', message: 'Chưa cấu hình logo' });
    const mime = logoPath.endsWith('.svg') ? 'image/svg+xml' : 'image/png';
    return reply
      .header('Cache-Control', 'public, max-age=300')
      .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:")
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Disposition', `inline; filename="logo${mime === 'image/svg+xml' ? '.svg' : '.png'}"`)
      .type(mime)
      .send(fs.createReadStream(logoPath));
  });

  fastify.put('/api/branding/logo', async (req: FastifyRequest) => {
    const body = (req.body || {}) as { mimeType?: unknown; data?: unknown };
    if (typeof body.mimeType !== 'string' || typeof body.data !== 'string') {
      throw new HttpError(400, 'bad_request', 'Logo cần mimeType và data base64');
    }
    let data: Buffer;
    try { data = Buffer.from(body.data, 'base64'); } catch { throw new HttpError(400, 'bad_request', 'Logo base64 không hợp lệ'); }
    try {
      const logo = saveBrandingLogo(config.hubHome, body.mimeType, data);
      service.updateConfig({ branding: { logo } });
      return { ok: true, logo };
    } catch (error) {
      throw new HttpError(400, 'invalid_logo', error instanceof Error ? error.message : 'Logo không hợp lệ');
    }
  });

  fastify.put('/api/config', async (req: FastifyRequest) => {
    const body = (req.body || {}) as { brain?: { permissions?: string }; confirm?: boolean };
    if (body.brain?.permissions === 'full' && body.confirm !== true) {
      throw new HttpError(409, 'confirmation_required', 'Cấp Toàn quyền mặc định cần confirm: true');
    }
    const result = service.updateConfig(req.body);
    if (body.brain?.permissions) {
      service.scheduler.getEventBus().emit('brain.trust_changed', undefined, { projectId: null, permissions: body.brain.permissions });
    }
    return result;
  });
  fastify.get('/api/models', async () => service.getModelOptions());

  // --- Savings API ---
  fastify.get('/api/savings', async (req: FastifyRequest) => {
    const query = req.query as { project?: string; since?: string; limit?: string; offset?: string; cursor?: string };
    if (query.cursor && !decodeCursor(query.cursor)) throw new HttpError(400, 'bad_request', 'Invalid pagination cursor');
    return service.getSavings(query);
  });

  // --- Daily Usage API ---
  fastify.get('/api/usage/daily', async (req: FastifyRequest) => {
    const query = req.query as { days?: string };
    const days = query?.days ? parseInt(query.days, 10) : 7;
    return service.getDailyUsage(Number.isNaN(days) ? 7 : days);
  });

  fastify.get('/api/claude/sessions', async (req: FastifyRequest) => {
    const query = (req.query as { activeWithinMin?: string; limit?: string; offset?: string; cursor?: string; sort?: string; order?: string } | undefined) || {};
    const activeWithinMin = query.activeWithinMin ? Number(query.activeWithinMin) : undefined;
    if (query.limit === undefined) return service.listClaudeSessions(activeWithinMin);
    if (query.cursor && !decodeCursor(query.cursor)) throw new HttpError(400, 'bad_request', 'Invalid pagination cursor');
    return service.pageClaudeSessions({ activeWithinMin, limit: query.limit, offset: query.offset, cursor: query.cursor, sort: query.sort, order: query.order });
  });
  fastify.get('/api/claude/sessions/:id', async (req: FastifyRequest) => {
    const raw = (req.query as { activeWithinMin?: string } | undefined)?.activeWithinMin;
    return service.getClaudeSession((req.params as { id: string }).id, raw ? Number(raw) : undefined);
  });
  fastify.patch('/api/claude/sessions/:id/auto-resume', async (req: FastifyRequest) => {
    const body = req.body as { enabled?: unknown };
    if (typeof body?.enabled !== 'boolean') throw new HttpError(400, 'bad_request', 'enabled phải là boolean');
    return service.setClaudeAutoResume((req.params as { id: string }).id, body.enabled);
  });
  fastify.post('/api/claude/sessions/:id/dismiss-limit', async (req: FastifyRequest) => {
    return service.dismissClaudeSessionLimit((req.params as { id: string }).id);
  });
  fastify.delete('/api/claude/sessions/:id/limit', async (req: FastifyRequest) => {
    return service.dismissClaudeSessionLimit((req.params as { id: string }).id);
  });
  fastify.post('/api/claude/sessions/clean-reset', async () => {
    return service.cleanResetClaudeSessions();
  });
  fastify.post('/api/claude/sessions/rescan', async () => service.rescanClaudeSessions());
  fastify.get('/api/claude/quota', async () => service.getClaudeQuota());
  fastify.get('/api/claude/failover', async () => service.getClaudeFailover());
  fastify.post('/api/claude/failover/clear', async () => service.clearClaudeFailover());
  fastify.get('/api/claude/api-key', async () => service.getClaudeApiKeyStatus());
  fastify.put('/api/claude/api-key', async (req: FastifyRequest) => {
    const body = req.body as { apiKey?: unknown };
    if (typeof body?.apiKey !== 'string') throw new HttpError(400, 'bad_request', 'apiKey là bắt buộc');
    return service.setClaudeApiKey(body.apiKey);
  });
  fastify.get('/api/claude/usage/today', async () => service.getClaudeToday());

  // --- SSE Route ---
  registerSseRoute(fastify, service);

  // --- PTY Routes ---
  const ptyManager = new PtyManager(service);
  registerPtyRoutes(fastify, service, ptyManager);

  // --- Chat API ---
  if (service.chatService) {
    registerChatRoutes(fastify, service.chatService);
  }

  // --- Graceful Close Hook ---
  fastify.addHook('onClose', async () => {
    closeWebSockets();
    for (const res of sseClients) {
      try {
        if (!res.writableEnded) {
          res.end();
        }
      } catch {
        // ignore
      }
    }
    sseClients.clear();
    ptyManager.stop();
  });

  // --- Web Static Files & Fallback ---
  const webDistDir = resolveWebDistDir(options?.webDir);

  try {
    if (!fs.existsSync(webDistDir)) {
      fs.mkdirSync(webDistDir, { recursive: true });
    }
  } catch {
    // ignore
  }

  await fastify.register(fastifyStatic, {
    root: webDistDir,
    wildcard: true,
    allowedPath(pathname) {
      // Prevent path traversal
      if (pathname.includes('..') || pathname.includes('\\')) {
        return false;
      }
      const resolved = path.resolve(webDistDir, '.' + pathname);
      if (!resolved.startsWith(webDistDir + path.sep) && resolved !== webDistDir) {
        return false;
      }

      // Do not serve anything under /api
      const cleanPath = pathname.replace(/\/+/g, '/').toLowerCase();
      if (cleanPath === '/api' || cleanPath.startsWith('/api/')) {
        return false;
      }

      return true;
    },
  });

  fastify.setNotFoundHandler((req, reply) => {
    const rawUrl = req.raw.url || req.url || '/';
    const rawPath = rawUrl.split('?')[0].split('#')[0];
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(rawPath);
    } catch {
      decodedPath = rawPath;
    }
    const normalizedPath = decodedPath.replace(/\/+/g, '/').toLowerCase();
    const isApi = normalizedPath === '/api' || normalizedPath.startsWith('/api/');

    if (isApi) {
      return reply.status(404).send({
        error: 'not_found',
        message: `Route ${req.method} ${decodedPath} không tồn tại`,
      });
    }

    const isRoot = decodedPath === '/' || decodedPath === '';
    const isGetOrHead = req.method === 'GET' || req.method === 'HEAD';
    const acceptHeader = req.headers.accept || '';
    const acceptsHtml = typeof acceptHeader === 'string' && acceptHeader.includes('text/html');

    if (isGetOrHead && (isRoot || acceptsHtml)) {
      const indexPath = path.join(webDistDir, 'index.html');
      if (fs.existsSync(indexPath)) {
        return reply.sendFile('index.html');
      }
      return reply
        .status(200)
        .type('text/html; charset=utf-8')
        .send('<!DOCTYPE html><html><body>chưa build web</body></html>');
    }

    return reply.status(404).send({
      error: 'not_found',
      message: `Route ${req.method} ${decodedPath} không tồn tại`,
    });
  });

  return fastify;
}
