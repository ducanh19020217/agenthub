import { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AgentHubConfig, OpenProjectSource } from '../../config.js';
import { OpenProjectSourceSchema, saveConfig, updateConfigInMemory } from '../../config.js';
import { HttpError } from '../../errors.js';
import { OpenProjectClient } from './client.js';
import { readOpenProjectKey, saveOpenProjectKey } from './secrets.js';

const idParams = z.object({ id: z.string().regex(/^[a-z0-9-]+$/) });

function sourceOrThrow(config: AgentHubConfig, id: string): OpenProjectSource {
  const source = config.integrations.openproject.sources.find((item) => item.id === id);
  if (!source) throw new HttpError(404, 'not_found', 'Nguồn OpenProject không tồn tại');
  return source;
}

function persist(config: AgentHubConfig, sources: OpenProjectSource[]): void {
  updateConfigInMemory(config, { integrations: { openproject: { sources } } });
  saveConfig(config.hubHome, { integrations: { openproject: { sources } } });
}

export interface RegisterOpenProjectRoutesOptions {
  fetch?: typeof globalThis.fetch;
  sync?: (sourceId: string) => Promise<{ imported: number; comments: number }>;
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

  fastify.post('/api/integrations/openproject/sources/:id/sync', async (req: FastifyRequest) => {
    const { id } = idParams.parse(req.params);
    sourceOrThrow(config, id);
    if (!options.sync) throw new HttpError(503, 'unavailable', 'OpenProject intake chưa sẵn sàng');
    return options.sync(id);
  });
}
