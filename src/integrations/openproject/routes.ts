import { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AgentHubConfig, OpenProjectSource } from '../../config.js';
import { OpenProjectSourceSchema, saveConfig, updateConfigInMemory } from '../../config.js';
import { HttpError } from '../../errors.js';
import { OpenProjectClient, OpenProjectError } from './client.js';
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
  timesheetPreview?: (sourceId: string, date?: string) => Promise<unknown>;
  timesheetRun?: (sourceId: string, date?: string, hours?: number) => Promise<unknown>;
  timesheetDaySet?: (sourceId: string, date: string, hours: number) => Promise<unknown> | unknown;
  timesheetManualAdd?: (input: unknown) => Promise<unknown>;
  timesheetManualUpdate?: (id: string, input: unknown) => Promise<unknown>;
  timesheetManualDelete?: (id: string) => Promise<unknown>;
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

  fastify.get('/api/integrations/openproject/sources/:id/time-entry-activities', async (req: FastifyRequest) => {
    const { id } = idParams.parse(req.params); const source = sourceOrThrow(config, id); const key = readOpenProjectKey(config.hubHome, id);
    if (!key) throw new HttpError(400, 'bad_request', 'Nguồn chưa có API key');
    const client = new OpenProjectClient({ baseUrl: source.url, project: source.project, apiKey: key, fetch: options.fetch });
    try {
      let workPackage: import('./client.js').OpenProjectWorkPackage | undefined;
      try { workPackage = (await client.searchWorkPackages({}))[0]; } catch { /* project link is a valid form input too */ }
      return await client.listTimeEntryActivities(workPackage?.id);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new HttpError(error instanceof OpenProjectError ? error.status : 502, 'openproject_error', `Không thể lấy Activity OpenProject: ${message}`);
    }
  });

  fastify.get('/api/integrations/openproject/sources/:id/timesheet', async (req: FastifyRequest) => {
    const { id } = idParams.parse(req.params); if (!options.timesheetPreview) throw new HttpError(503, 'unavailable', 'Timesheet chưa sẵn sàng');
    const query = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(req.query); return options.timesheetPreview(id, query.date);
  });
  fastify.get('/api/integrations/openproject/sources/:id/work-packages', async (req: FastifyRequest) => {
    const { id } = idParams.parse(req.params);
    const query = z.object({ q: z.string().trim().min(1).max(100) }).parse(req.query);
    const source = config.integrations.openproject.sources.find((item) => item.id === id);
    if (!source) throw new HttpError(404, 'not_found', 'Không tìm thấy nguồn OpenProject');
    const key = readOpenProjectKey(config.hubHome, id);
    if (!key) throw new HttpError(400, 'bad_request', 'Nguồn chưa có API key');
    const client = new OpenProjectClient({ baseUrl: source.url, project: source.project, apiKey: key, fetch: options.fetch });
    return (await client.searchWorkPackages({ query: query.q })).slice(0, 20).map((item) => ({ id: item.id, displayId: item.displayId || String(item.id), subject: item.subject || '' }));
  });
  fastify.post('/api/integrations/openproject/sources/:id/timesheet/run', async (req: FastifyRequest) => {
    const { id } = idParams.parse(req.params); if (!options.timesheetRun) throw new HttpError(503, 'unavailable', 'Timesheet chưa sẵn sàng');
    const body = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), hours: z.number().min(8).refine((value) => Math.abs(value * 4 - Math.round(value * 4)) < 1e-8, 'hours must be a multiple of 0.25').optional() }).parse(req.body || {}); return options.timesheetRun(id, body.date, body.hours);
  });
  const manualBody = z.object({ sourceId: z.string().min(1).optional(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), ticket: z.string().trim().min(1).optional(), wpId: z.number().int().positive().optional(), createTicket: z.object({ subject: z.string().trim().min(1), parent: z.union([z.string().trim().min(1), z.number().int().positive()]).optional() }).optional(), description: z.string().trim().min(1).max(255), activeHours: z.number().min(0).max(24), waitHours: z.number().min(0).max(24).optional(), level: z.enum(['easy', 'hard']).optional(), pinned: z.boolean().optional() }).strict().refine((body) => Boolean(body.ticket || body.wpId || body.createTicket), 'Cần chọn ticket hoặc tạo ticket mới').refine((body) => body.activeHours + (body.waitHours || 0) > 0 && body.activeHours + (body.waitHours || 0) <= 24, 'Tổng giờ phải lớn hơn 0 và không quá 24');
  fastify.get('/api/timesheet', async (req: FastifyRequest) => {
    if (!options.timesheetPreview) throw new HttpError(503, 'unavailable', 'Timesheet chưa sẵn sàng');
    const query = z.object({ sourceId: z.string().min(1).optional(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(req.query);
    const sourceId = query.sourceId || (config.integrations.openproject.sources.length === 1 ? config.integrations.openproject.sources[0].id : undefined);
    if (!sourceId) throw new HttpError(400, 'bad_request', 'Cần sourceId khi có nhiều nguồn OpenProject');
    return options.timesheetPreview(sourceId, query.date);
  });
  fastify.post('/api/timesheet/manual', async (req: FastifyRequest) => {
    if (!options.timesheetManualAdd) throw new HttpError(503, 'unavailable', 'Timesheet thủ công chưa sẵn sàng');
    const body = manualBody.parse(req.body || {}); return options.timesheetManualAdd(body);
  });
  fastify.patch('/api/timesheet/manual/:manualId', async (req: FastifyRequest) => {
    if (!options.timesheetManualUpdate) throw new HttpError(503, 'unavailable', 'Timesheet thủ công chưa sẵn sàng');
    const params = z.object({ manualId: z.string().min(1) }).parse(req.params);
    const body = z.object({ sourceId: z.string().min(1).optional(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), description: z.string().trim().min(1).max(255).optional(), activeHours: z.number().min(0).max(24).optional(), waitHours: z.number().min(0).max(24).optional(), level: z.enum(['easy', 'hard']).optional(), pinned: z.boolean().optional() }).strict().parse(req.body || {});
    return options.timesheetManualUpdate(params.manualId, body);
  });
  fastify.delete('/api/timesheet/manual/:manualId', async (req: FastifyRequest) => {
    if (!options.timesheetManualDelete) throw new HttpError(503, 'unavailable', 'Timesheet thủ công chưa sẵn sàng');
    const params = z.object({ manualId: z.string().min(1) }).parse(req.params); return options.timesheetManualDelete(params.manualId);
  });
  fastify.patch('/api/timesheet/day', async (req: FastifyRequest) => {
    if (!options.timesheetDaySet) throw new HttpError(503, 'unavailable', 'Timesheet chưa sẵn sàng');
    const body = z.object({ sourceId: z.string().min(1), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), hours: z.number().min(8).refine((value) => Math.abs(value * 4 - Math.round(value * 4)) < 1e-8, 'hours must be a multiple of 0.25') }).parse(req.body || {});
    return options.timesheetDaySet(body.sourceId, body.date, body.hours);
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
      let statusId: string | undefined;
      if (query.status?.trim()) {
        const statuses = (await client.listStatuses())._embedded?.elements || [];
        const found = /^\d+$/.test(query.status.trim())
          ? statuses.find((item) => item.id === Number(query.status))
          : statuses.find((item) => item.name.toLowerCase() === query.status!.trim().toLowerCase());
        if (!found) {
          const names = statuses.map((item) => item.name).join(', ');
          throw new HttpError(400, 'bad_request', `Trạng thái "${query.status}" không hợp lệ. Tên hợp lệ: ${names || '(không có)'}`);
        }
        statusId = String(found.id);
      }
      return (await client.searchWorkPackages({ query: query.q, status: statusId, assignee: query.assignee })).map((wp) => workPackageSearchView(source.url, wp));
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
      let statusId: number | undefined;
      if (body.status !== undefined) {
        const statuses = (await client.listStatuses())._embedded?.elements || [];
        const status = typeof body.status === 'number' || /^\d+$/.test(String(body.status).trim())
          ? statuses.find((item) => item.id === Number(body.status))
          : statuses.find((item) => item.name.toLowerCase() === String(body.status).trim().toLowerCase());
        if (!status) {
          const names = statuses.map((item) => item.name).join(', ');
          throw new HttpError(400, 'bad_request', `Trạng thái "${body.status}" không hợp lệ. Tên hợp lệ: ${names || '(không có)'}`);
        }
        statusId = status.id;
      }
      const created = await client.createWorkPackage({ subject: body.subject, descriptionMarkdown: body.description, parentId: parent?.id, typeId: body.type, statusId, assigneeMe: body.assigneeMe });
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

  fastify.post('/api/integrations/openproject/sources/:id/clone', async (req: FastifyRequest) => {
    const { id } = idParams.parse(req.params);
    const source = sourceOrThrow(config, id);
    const body = z.object({ project: z.string().min(1), id: z.string().regex(/^[a-z0-9-]+$/).optional() }).parse(req.body || {});
    const newId = body.id ?? `openproject-${Date.now()}`;
    const newProject = body.project.trim();

    // Validate: new ID must not already exist
    const idExists = config.integrations.openproject.sources.some((s) => s.id === newId);
    if (idExists) throw new HttpError(400, 'duplicate_id', `ID "${newId}" đã tồn tại`);

    // Validate: project must not conflict with another source sharing the same url
    const conflict = config.integrations.openproject.sources.find(
      (s) => s.id !== id && s.url === source.url && s.project === newProject,
    );
    if (conflict) throw new HttpError(400, 'duplicate_project', `Project "${newProject}" đã tồn tại ở nguồn ${conflict.id}`);

    // Clone config: copy all fields, override id and project, disable timesheet/dailyReport
    const cloned = OpenProjectSourceSchema.parse({
      ...source,
      id: newId,
      project: newProject,
      timesheet: { ...source.timesheet, enabled: false },
      dailyReport: source.dailyReport ? { ...source.dailyReport, enabled: false } : { enabled: false, time: '08:00', weekdaysOnly: true, maxItems: 10, telegram: false },
    });

    // Optionally filter type IDs that don't exist in the new project
    const key = readOpenProjectKey(config.hubHome, id);
    if (key) {
      try {
        const client = new OpenProjectClient({ baseUrl: source.url, project: newProject, apiKey: key, fetch: options.fetch });
        const typesCollection = await client.listTypes();
        // Always filter when we get a successful response (even if list is empty)
        const validTypeIds = new Set((typesCollection._embedded?.elements || []).map((t) => t.id));
        if (cloned.createTypeId !== null && !validTypeIds.has(cloned.createTypeId)) {
          (cloned as { createTypeId: number | null }).createTypeId = null;
        }
        cloned.split.typeIds = cloned.split.typeIds.filter((tid) => validTypeIds.has(tid));
      } catch {
        // Network error - keep original type IDs, do not fail
      }
    }

    // Copy API key (server-side only)
    if (key) {
      saveOpenProjectKey(config.hubHome, newId, key);
    }

    persist(config, [...config.integrations.openproject.sources, cloned]);
    return {
      ...cloned,
      keyConfigured: readOpenProjectKey(config.hubHome, newId) !== null,
    };
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
