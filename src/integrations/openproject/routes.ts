import { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AgentHubConfig, OpenProjectSource } from '../../config.js';
import { OpenProjectSourceSchema, saveConfig, updateConfigInMemory } from '../../config.js';
import { HttpError } from '../../errors.js';
import { OpenProjectClient } from './client.js';
import { readOpenProjectKey, saveOpenProjectKey } from './secrets.js';
import type { OpenProjectSyncResult } from './intake.js';

export type { OpenProjectSyncResult };

const idParams = z.object({ id: z.string().regex(/^[a-z0-9-]+$/) });
const workPackageParams = z.object({ id: z.string().regex(/^[a-z0-9-]+$/), wp: z.string().min(1) });
const ticketUpdateBody = z.object({
  status: z.union([z.number().int().positive(), z.string().trim().min(1)]).optional(),
  parent: z.union([z.number().int().positive(), z.string().trim().min(1)]).nullable().optional(),
  comment: z.string().min(1).optional(),
});
const ticketSearchQuery = z.object({ q: z.string().trim().optional(), status: z.string().trim().optional(), assignee: z.string().trim().optional() });
const ticketCreateBody = z.object({
  subject: z.string().trim().min(1), description: z.string().default(''), parent: z.union([z.number().int().positive(), z.string().trim().min(1)]).optional(),
  status: z.union([z.number().int().positive(), z.string().trim().min(1)]).optional(), type: z.number().int().positive().optional(), assigneeMe: z.boolean().default(true), taskId: z.string().trim().min(1).optional(),
});

function sourceOrThrow(config: AgentHubConfig, id: string): OpenProjectSource {
  const source = config.integrations.openproject.sources.find((item) => item.id === id);
  if (!source) throw new HttpError(404, 'not_found', 'Nguồn OpenProject không tồn tại');
  return source;
}

function persist(config: AgentHubConfig, sources: OpenProjectSource[]): void {
  updateConfigInMemory(config, { integrations: { openproject: { sources } } });
  saveConfig(config.hubHome, { integrations: { openproject: { sources } } });
}

function workPackageView(baseUrl: string, wp: import('./client.js').OpenProjectWorkPackage) {
  const parent = wp._links?.parent;
  const assignee = wp._links?.assignee;
  return {
    subject: wp.subject || '',
    status: wp.status?.title || wp._links?.status?.title || '',
    parent: parent?.title || (parent?.href ? parent.href.split('/').pop() : null) || null,
    assignee: assignee?.title || null,
    url: `${baseUrl.replace(/\/+$/, '')}/work_packages/${wp.id}`,
  };
}

function workPackageUpdateView(baseUrl: string, wp: import('./client.js').OpenProjectWorkPackage) {
  const parent = wp._links?.parent;
  return {
    id: wp.id,
    displayId: wp.displayId || String(wp.id),
    status: wp.status?.title || wp._links?.status?.title || '',
    parent: parent?.title || (parent?.href ? parent.href.split('/').pop() : null) || null,
    url: `${baseUrl.replace(/\/+$/, '')}/work_packages/${wp.id}`,
  };
}

function workPackageSearchView(baseUrl: string, wp: import('./client.js').OpenProjectWorkPackage) {
  const parent = wp._links?.parent;
  return { displayId: wp.displayId || String(wp.id), subject: wp.subject || '', status: wp.status?.title || wp._links?.status?.title || '', parent: parent?.title || (parent?.href ? parent.href.split('/').pop() : null) || null, assignee: wp._links?.assignee?.title || null, url: `${baseUrl.replace(/\/+$/, '')}/work_packages/${wp.id}` };
}

export interface RegisterOpenProjectRoutesOptions {
  fetch?: typeof globalThis.fetch;
  sync?: (sourceId: string) => Promise<OpenProjectSyncResult>;
  dailyReport?: (sourceId: string, date?: string) => Promise<{ path: string; content: string }>;
  decision?: (sourceId: string, wpId: number, action: 'do' | 'split' | 'ask' | 'skip' | 'manual', note?: string) => Promise<{ action: string; taskIds: string[] }>;
  triageInput?: (sourceId: string, wpId: number, content: string) => Promise<{ taskId: string }>;
  linkTicket?: (sourceId: string, wpId: number, displayId: string, taskId: string) => void;
}

export function registerOpenProjectRoutes(
  fastify: FastifyInstance,
  config: AgentHubConfig,
  options: RegisterOpenProjectRoutesOptions = {},
): void {
  fastify.get('/api/integrations/openproject/sources', async () =>
    config.integrations.openproject.sources.map(({ id, url, project, ...source }) => ({
      id,
      url,
      project,
      ...source,
      keyConfigured: readOpenProjectKey(config.hubHome, id) !== null,
    })),
  );

  fastify.put('/api/integrations/openproject/sources/:id', async (req: FastifyRequest) => {
    const { id } = idParams.parse(req.params);
    const parsed = OpenProjectSourceSchema.parse({
      ...((req.body as object) || {}),
      id,
    });
    persist(config, [
      ...config.integrations.openproject.sources.filter((item) => item.id !== id),
      parsed,
    ]);
    return {
      ...parsed,
      keyConfigured: readOpenProjectKey(config.hubHome, id) !== null,
    };
  });

  fastify.delete('/api/integrations/openproject/sources/:id', async (req: FastifyRequest) => {
    const { id } = idParams.parse(req.params);
    sourceOrThrow(config, id);
    persist(
      config,
      config.integrations.openproject.sources.filter((item) => item.id !== id),
    );
    return { ok: true };
  });

  fastify.put('/api/integrations/openproject/sources/:id/key', async (req: FastifyRequest) => {
    const { id } = idParams.parse(req.params);
    sourceOrThrow(config, id);
    const key = z.object({ key: z.string().trim().min(1) }).parse(req.body).key;
    saveOpenProjectKey(config.hubHome, id, key);
    return { configured: true };
  });

  fastify.post('/api/integrations/openproject/sources/:id/test', async (req: FastifyRequest) => {
    const { id } = idParams.parse(req.params);
    const source = sourceOrThrow(config, id);
    const key = readOpenProjectKey(config.hubHome, id);
    if (!key) throw new HttpError(400, 'bad_request', 'Nguồn chưa có API key');
    try {
      const me = await new OpenProjectClient({
        baseUrl: source.url,
        project: source.project,
        apiKey: key,
        fetch: options.fetch,
      }).me();
      return { ok: true, name: me.name };
    } catch {
      throw new HttpError(502, 'openproject_error', 'Không thể kết nối OpenProject');
    }
  });

  fastify.get('/api/integrations/openproject/sources/:id/statuses', async (req: FastifyRequest) => {
    const { id } = idParams.parse(req.params);
    const source = sourceOrThrow(config, id);
    const key = readOpenProjectKey(config.hubHome, id);
    if (!key) throw new HttpError(400, 'bad_request', 'Nguồn chưa có API key');
    try {
      const client = new OpenProjectClient({
        baseUrl: source.url,
        project: source.project,
        apiKey: key,
        fetch: options.fetch,
      });
      const collection = await client.listStatuses();
      const elements = collection._embedded?.elements || [];
      return elements
        .map((item) => ({
          id: item.id,
          name: item.name,
          isClosed: Boolean(item.isClosed),
          position: item.position ?? 0,
        }))
        .sort((a, b) => a.position - b.position || a.id - b.id);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, 'openproject_error', 'Không thể kết nối OpenProject');
    }
  });

  fastify.get('/api/integrations/openproject/sources/:id/types', async (req: FastifyRequest) => {
    const { id } = idParams.parse(req.params);
    const source = sourceOrThrow(config, id);
    const key = readOpenProjectKey(config.hubHome, id);
    if (!key) throw new HttpError(400, 'bad_request', 'Nguồn chưa có API key');
    try {
      const collection = await new OpenProjectClient({ baseUrl: source.url, project: source.project, apiKey: key, fetch: options.fetch }).listTypes();
      return (collection._embedded?.elements || []).map((item) => ({ id: item.id, name: item.name, position: item.position ?? 0 }))
        .sort((a, b) => a.position - b.position || a.id - b.id);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, 'openproject_error', 'Không thể kết nối OpenProject');
    }
  });

  fastify.get('/api/integrations/openproject/sources/:id/work-packages/:wp', async (req: FastifyRequest) => {
    const { id, wp: ref } = workPackageParams.parse(req.params);
    const source = sourceOrThrow(config, id);
    const key = readOpenProjectKey(config.hubHome, id);
    if (!key) throw new HttpError(400, 'bad_request', 'Nguồn chưa có API key');
    const client = new OpenProjectClient({ baseUrl: source.url, project: source.project, apiKey: key, fetch: options.fetch });
    try {
      const found = await client.findWorkPackage(ref);
      if (!found) throw new HttpError(404, 'not_found', 'Không tìm thấy work package trong project của nguồn');
      return workPackageView(source.url, found);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, 'openproject_error', 'Không thể kết nối OpenProject');
    }
  });

  fastify.get('/api/integrations/openproject/sources/:id/tickets', async (req: FastifyRequest) => {
    const { id } = idParams.parse(req.params);
    const query = ticketSearchQuery.parse(req.query || {});
    const source = sourceOrThrow(config, id);
    const key = readOpenProjectKey(config.hubHome, id);
    if (!key) throw new HttpError(400, 'bad_request', 'Nguồn chưa có API key');
    try {
      const client = new OpenProjectClient({ baseUrl: source.url, project: source.project, apiKey: key, fetch: options.fetch });
      return (await client.searchWorkPackages(query)).map((wp) => workPackageSearchView(source.url, wp));
    } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(502, 'openproject_error', 'Không thể kết nối OpenProject'); }
  });

  fastify.post('/api/integrations/openproject/sources/:id/tickets', async (req: FastifyRequest) => {
    const { id } = idParams.parse(req.params);
    const body = ticketCreateBody.parse(req.body || {});
    const source = sourceOrThrow(config, id);
    const key = readOpenProjectKey(config.hubHome, id);
    if (!key) throw new HttpError(400, 'bad_request', 'Nguồn chưa có API key');
    try {
      const client = new OpenProjectClient({ baseUrl: source.url, project: source.project, apiKey: key, fetch: options.fetch });
      const parent = body.parent === undefined ? undefined : await client.findWorkPackage(body.parent);
      if (body.parent !== undefined && !parent) throw new HttpError(403, 'forbidden', 'Work package cha không thuộc project của nguồn');
      const status = body.status === undefined ? undefined : (await client.listStatuses())._embedded?.elements?.find((item) => String(item.id) === String(body.status) || item.name.toLowerCase() === String(body.status).toLowerCase());
      if (body.status !== undefined && !status) throw new HttpError(400, 'bad_request', 'Trạng thái không hợp lệ');
      const created = await client.createWorkPackage({ subject: body.subject, descriptionMarkdown: body.description, parentId: parent?.id, typeId: body.type, statusId: status?.id, assigneeMe: body.assigneeMe });
      if (body.taskId) options.linkTicket?.(id, created.id, created.displayId, body.taskId);
      return { ...created, ...(body.taskId ? { taskId: body.taskId } : {}) };
    } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(502, 'openproject_error', 'Không thể tạo ticket OpenProject'); }
  });

  fastify.post('/api/integrations/openproject/sources/:id/work-packages/:wp/update', async (req: FastifyRequest) => {
    const { id, wp: ref } = workPackageParams.parse(req.params);
    const body = ticketUpdateBody.parse(req.body || {});
    const source = sourceOrThrow(config, id);
    const key = readOpenProjectKey(config.hubHome, id);
    if (!key) throw new HttpError(400, 'bad_request', 'Nguồn chưa có API key');
    const client = new OpenProjectClient({ baseUrl: source.url, project: source.project, apiKey: key, fetch: options.fetch });
    try {
      let current = await client.findWorkPackage(ref);
      if (!current) {
        if (/^\d+$/.test(ref)) {
          try {
            await client.getWorkPackage(ref);
            throw new HttpError(403, 'forbidden', 'Work package không thuộc project của nguồn');
          } catch (error) {
            if (error instanceof HttpError) throw error;
          }
        }
        throw new HttpError(404, 'not_found', 'Không tìm thấy work package trong project của nguồn');
      }

      let parent: import('./client.js').OpenProjectWorkPackage | null | undefined;
      if (body.comment !== undefined) await client.addComment(current.id, body.comment);
      if (body.parent !== undefined) {
        parent = body.parent === null ? null : await client.findWorkPackage(body.parent);
        if (body.parent !== null && !parent) throw new HttpError(403, 'forbidden', 'Work package cha không thuộc project của nguồn');
        current = await client.setParent(current.id, parent?.id ?? null);
      }
      if (body.status !== undefined) {
        const statuses = (await client.listStatuses())._embedded?.elements || [];
        const status = typeof body.status === 'number' || /^\d+$/.test(String(body.status).trim())
          ? statuses.find((item) => item.id === Number(body.status))
          : statuses.find((item) => item.name.toLowerCase() === String(body.status).trim().toLowerCase());
        if (!status) {
          const names = statuses.map((item) => item.name).join(', ');
          throw new HttpError(400, 'bad_request', `Trạng thái không hợp lệ. Tên hợp lệ: ${names || '(không có)'}`);
        }
        current = await client.setStatus(current.id, status.id);
      }
      return workPackageUpdateView(source.url, current);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, 'openproject_error', 'Không thể kết nối OpenProject');
    }
  });

  fastify.post('/api/integrations/openproject/sources/:id/sync', async (req: FastifyRequest) => {
    const { id } = idParams.parse(req.params);
    sourceOrThrow(config, id);
    if (!options.sync) throw new HttpError(503, 'unavailable', 'OpenProject intake chưa sẵn sàng');
    return options.sync(id);
  });

  fastify.post('/api/integrations/openproject/sources/:id/daily-report', async (req: FastifyRequest) => {
    const { id } = idParams.parse(req.params);
    sourceOrThrow(config, id);
    const query = (req.query || {}) as Record<string, unknown>;
    let dateStr: string | undefined;
    if (query.date !== undefined) {
      if (typeof query.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(query.date)) {
        throw new HttpError(400, 'bad_request', 'Tham số date phải có định dạng YYYY-MM-DD');
      }
      dateStr = query.date;
    }
    if (!options.dailyReport) throw new HttpError(503, 'unavailable', 'DailyReportService chưa sẵn sàng');
    const result = await options.dailyReport(id, dateStr);
    return { ok: true, ...result };
  });

  fastify.post('/api/tracker/:sourceId/:wpId/decision', async (req: FastifyRequest) => {
    const params = z.object({ sourceId: z.string().min(1), wpId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z.object({ action: z.enum(['do', 'split', 'ask', 'skip', 'manual']), note: z.string().optional() }).parse(req.body || {});
    if (!options.decision) throw new HttpError(503, 'unavailable', 'OpenProject triage chưa sẵn sàng');
    return options.decision(params.sourceId, params.wpId, body.action, body.note);
  });

  fastify.post('/api/tracker/:sourceId/:wpId/input', async (req: FastifyRequest) => {
    const params = z.object({ sourceId: z.string().min(1), wpId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z.object({ content: z.string().min(1) }).parse(req.body || {});
    if (!options.triageInput) throw new HttpError(503, 'unavailable', 'OpenProject triage chưa sẵn sàng');
    return options.triageInput(params.sourceId, params.wpId, body.content);
  });
}
