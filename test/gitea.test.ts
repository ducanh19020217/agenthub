import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import {
  parseRemote,
  GiteaClient,
  saveGiteaToken,
  readGiteaToken,
  isGiteaTokenConfigured,
  GiteaSyncService,
  GiteaSettingsSchema,
} from '../src/integrations/gitea/index.js';
import {
  DEFAULT_PROJECT_SETTINGS,
  mergeProjectSettings,
} from '../src/projects/settings.js';
import { NotificationService } from '../src/notify.js';
import { TelegramBotService } from '../src/telegram.js';
import { createMcpServer } from '../src/mcp/index.js';
import { AgentHubConfig, loadConfig } from '../src/config.js';
import { EventBus } from '../src/scheduler/index.js';
import type { ProjectRepo, TaskRepo, ProfileRepo, QuotaMarkRepo } from '../src/db/index.js';

const tempDirs: string[] = [];

function makeTempDir(prefix = 'gitea-test-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeTestConfig(hubHome: string): AgentHubConfig {
  const cfg = loadConfig(hubHome);
  cfg.notifications.desktop = true;
  cfg.notifications.desktopLevel = 'all';
  return cfg;
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function initGitRepoFixture() {
  const root = makeTempDir('agenthub-gitea-fixture-');
  const bareDir = path.join(root, 'tester', 'repo.git');
  const repoDir = path.join(root, 'repo');
  const hubHome = path.join(root, 'hubHome');

  fs.mkdirSync(bareDir, { recursive: true });
  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(hubHome, { recursive: true });

  const cleanPath = (process.env.PATH || '')
    .split(path.delimiter)
    .filter((entry) => !entry.includes(`${path.sep}shims${path.sep}worker`))
    .join(path.delimiter);

  const env = {
    ...process.env,
    PATH: cleanPath,
    GIT_AUTHOR_NAME: 'Gitea Tester',
    GIT_AUTHOR_EMAIL: 'tester@example.com',
    GIT_COMMITTER_NAME: 'Gitea Tester',
    GIT_COMMITTER_EMAIL: 'tester@example.com',
  };

  // Bare remote
  execFileSync('git', ['init', '--bare', bareDir], { env });

  // Working repo
  execFileSync('git', ['init'], { cwd: repoDir, env });
  execFileSync('git', ['checkout', '-b', 'target'], { cwd: repoDir, env });
  execFileSync('git', ['config', 'user.email', 'tester@example.com'], { cwd: repoDir, env });
  execFileSync('git', ['config', 'user.name', 'Gitea Tester'], { cwd: repoDir, env });

  fs.writeFileSync(path.join(repoDir, 'README.md'), '# Initial README\n');
  execFileSync('git', ['add', '.'], { cwd: repoDir, env });
  execFileSync('git', ['commit', '-m', 'chore: initial commit on target'], { cwd: repoDir, env });
  execFileSync('git', ['remote', 'add', 'origin', bareDir], { cwd: repoDir, env });
  execFileSync('git', ['push', '-u', 'origin', 'target'], { cwd: repoDir, env });

  // Create source branch from target
  execFileSync('git', ['checkout', '-b', 'source'], { cwd: repoDir, env });
  execFileSync('git', ['push', '-u', 'origin', 'source'], { cwd: repoDir, env });

  return { root, bareDir, repoDir, hubHome, env };
}

describe('Gitea Integration', () => {
  describe('1. parseRemote', () => {
    it('parses https and http URLs with and without .git and ports', () => {
      expect(parseRemote('https://gitea.example.com/owner/repo.git')).toEqual({
        host: 'gitea.example.com',
        owner: 'owner',
        repo: 'repo',
      });
      expect(parseRemote('https://gitea.example.com/owner/repo')).toEqual({
        host: 'gitea.example.com',
        owner: 'owner',
        repo: 'repo',
      });
      expect(parseRemote('http://localhost:3000/my-org/my-project.git')).toEqual({
        host: 'localhost:3000',
        owner: 'my-org',
        repo: 'my-project',
      });
    });

    it('parses SCP-like ssh URLs (git@host:o/r.git)', () => {
      expect(parseRemote('git@gitea.example.com:team/service.git')).toEqual({
        host: 'gitea.example.com',
        owner: 'team',
        repo: 'service',
      });
      expect(parseRemote('git@my-host:ducanh/agenthub')).toEqual({
        host: 'my-host',
        owner: 'ducanh',
        repo: 'agenthub',
      });
    });

    it('parses SSH scheme URLs with and without port (ssh://git@host:port/o/r.git)', () => {
      expect(parseRemote('ssh://git@gitea.example.com:2222/org/repo.git')).toEqual({
        host: 'gitea.example.com:2222',
        owner: 'org',
        repo: 'repo',
      });
      expect(parseRemote('ssh://git@host/org/repo.git')).toEqual({
        host: 'host',
        owner: 'org',
        repo: 'repo',
      });
      expect(parseRemote('ssh://git@host:22/owner/repo')).toEqual({
        host: 'host:22',
        owner: 'owner',
        repo: 'repo',
      });
    });

    it('returns null on invalid or empty inputs', () => {
      expect(parseRemote('')).toBeNull();
      expect(parseRemote(null)).toBeNull();
      expect(parseRemote(undefined)).toBeNull();
      expect(parseRemote('not-a-remote-url')).toBeNull();
    });
  });

  describe('2. Project Settings Schema', () => {
    it('defaults to disabled with default schedule', () => {
      const parsed = GiteaSettingsSchema.parse({});
      expect(parsed.enabled).toBe(false);
      expect(parsed.schedule).toEqual(['12:00', '18:00']);
      expect(parsed.weekdaysOnly).toBe(false);
      expect(parsed.checks).toEqual([]);
      expect(parsed.unionMergeGlobs).toEqual([]);
    });

    it('accepts valid http and https URLs and rejects non-http(s)', () => {
      expect(GiteaSettingsSchema.parse({ url: 'https://gitea.example.com' }).url).toBe('https://gitea.example.com');
      expect(GiteaSettingsSchema.parse({ url: 'http://localhost:3000' }).url).toBe('http://localhost:3000');
      expect(() => GiteaSettingsSchema.parse({ url: 'ftp://gitea.example.com' })).toThrow();
      expect(() => GiteaSettingsSchema.parse({ url: 'not-a-url' })).toThrow();
    });

    it('validates schedule format HH:MM', () => {
      expect(GiteaSettingsSchema.parse({ schedule: ['08:30', '17:00'] }).schedule).toEqual(['08:30', '17:00']);
      expect(() => GiteaSettingsSchema.parse({ schedule: ['25:00'] })).toThrow();
      expect(() => GiteaSettingsSchema.parse({ schedule: ['8:30'] })).toThrow();
    });

    it('supports mergeProjectSettings without breaking DEFAULT_PROJECT_SETTINGS equality', () => {
      const merged = mergeProjectSettings(DEFAULT_PROJECT_SETTINGS, {
        gitea: {
          enabled: true,
          url: 'https://gitea.com',
          sourceBranch: 'main',
          targetBranch: 'integration',
          checks: [['npm', 'test']],
        },
      });
      expect(merged.gitea.enabled).toBe(true);
      expect(merged.gitea.sourceBranch).toBe('main');
      expect(merged.gitea.checks).toEqual([['npm', 'test']]);
    });
  });

  describe('3. Secrets Management', () => {
    it('saves token with mode 0600 and reads it back', () => {
      const hubHome = makeTempDir('hub-home-');
      expect(isGiteaTokenConfigured(hubHome, 'p1')).toBe(false);
      expect(readGiteaToken(hubHome, 'p1')).toBeNull();

      saveGiteaToken(hubHome, 'p1', 'my-secret-token');
      expect(isGiteaTokenConfigured(hubHome, 'p1')).toBe(true);
      expect(readGiteaToken(hubHome, 'p1')).toBe('my-secret-token');

      const tokenFile = path.join(hubHome, 'secrets', 'gitea-p1.token');
      const stat = fs.statSync(tokenFile);
      expect(stat.mode & 0o777).toBe(0o600);
    });
  });

  describe('4. GiteaClient', () => {
    it('findOpenPull paginates up to 5 pages and matches head/base', async () => {
      const requestedUrls: string[] = [];
      const fakeFetch = vi.fn(async (url: string | URL | Request) => {
        const urlStr = String(url);
        requestedUrls.push(urlStr);
        if (urlStr.includes('page=1')) {
          // Page 1: 50 items, no match
          const items = Array.from({ length: 50 }, (_, i) => ({
            number: i + 1,
            head: { ref: `other-${i}` },
            base: { ref: 'target' },
          }));
          return { ok: true, status: 200, json: async () => items } as Response;
        }
        if (urlStr.includes('page=2')) {
          // Page 2: contains matching PR
          const items = [
            {
              number: 99,
              html_url: 'https://gitea.example.com/owner/repo/pulls/99',
              head: { ref: 'source' },
              base: { ref: 'target' },
            },
          ];
          return { ok: true, status: 200, json: async () => items } as Response;
        }
        return { ok: true, status: 200, json: async () => [] } as Response;
      });

      const client = new GiteaClient({
        baseUrl: 'https://gitea.example.com',
        token: 'token-xyz',
        fetchFn: fakeFetch as unknown as typeof fetch,
      });

      const pr = await client.findOpenPull('owner', 'repo', 'source', 'target');
      expect(pr).not.toBeNull();
      expect(pr?.number).toBe(99);
      expect(requestedUrls).toHaveLength(2);
    });

    it('createPull sends correct POST body and headers', async () => {
      let requestBody: unknown = null;
      let requestHeaders: Record<string, string> = {};

      const fakeFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        requestBody = JSON.parse(init?.body as string);
        requestHeaders = init?.headers as Record<string, string>;
        return {
          ok: true,
          status: 201,
          json: async () => ({
            number: 105,
            html_url: 'https://gitea.example.com/owner/repo/pulls/105',
            head: { ref: 'source' },
            base: { ref: 'target' },
          }),
        } as Response;
      });

      const client = new GiteaClient({
        baseUrl: 'https://gitea.example.com',
        token: 'token-123',
        fetchFn: fakeFetch as unknown as typeof fetch,
      });

      const pr = await client.createPull('owner', 'repo', {
        head: 'source',
        base: 'target',
        title: 'Sync source -> target',
      });

      expect(pr.number).toBe(105);
      expect(requestBody).toEqual({
        head: 'source',
        base: 'target',
        title: 'Sync source -> target',
      });
      expect(requestHeaders['Authorization']).toBe('token token-123');
    });

    it('mergePull retries when not mergeable yet and succeeds', async () => {
      let attempts = 0;
      const sleeps: number[] = [];
      const fakeFetch = vi.fn(async () => {
        attempts++;
        if (attempts < 3) {
          // First 2 attempts: 405 Method Not Allowed (checking mergeability)
          return {
            ok: false,
            status: 405,
            statusText: 'Method Not Allowed',
            text: async () => 'Pull request is not mergeable yet',
          } as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ message: 'Merged' }),
        } as Response;
      });

      const client = new GiteaClient({
        baseUrl: 'https://gitea.example.com',
        token: 'token-abc',
        fetchFn: fakeFetch as unknown as typeof fetch,
        retryDelayMs: 50,
        sleepFn: async (ms) => {
          sleeps.push(ms);
        },
      });

      const res = await client.mergePull('owner', 'repo', 42);
      expect(res).toEqual({ message: 'Merged' });
      expect(attempts).toBe(3);
      expect(sleeps).toEqual([50, 50]);
    });

    it('mergePull throws after exceeding max retries', async () => {
      let attempts = 0;
      const fakeFetch = vi.fn(async () => {
        attempts++;
        return {
          ok: false,
          status: 409,
          statusText: 'Conflict',
          text: async () => 'Conflict detected',
        } as Response;
      });

      const client = new GiteaClient({
        baseUrl: 'https://gitea.example.com',
        token: 'token-abc',
        fetchFn: fakeFetch as unknown as typeof fetch,
        retryDelayMs: 1,
        sleepFn: async () => {},
        maxMergeRetries: 3,
      });

      await expect(client.mergePull('owner', 'repo', 42)).rejects.toThrow('Failed to merge pull request #42');
      expect(attempts).toBe(4); // initial + 3 retries
    });
  });

  describe('5. GiteaSyncService Flow Cases', () => {
    it('skips sync when there are no non-merge commits to sync', async () => {
      const f = initGitRepoFixture();
      saveGiteaToken(f.hubHome, 'p1', 'tok-123');

      const events: Array<{ type: string; payload: unknown }> = [];
      const eventBus = {
        emit: (type: string, _id?: string, payload?: unknown) => {
          events.push({ type, payload });
          return true;
        },
      } as unknown as EventBus;

      const projectRepo = {
        get: () => ({
          id: 'p1',
          name: 'Project 1',
          path: f.repoDir,
          settings: JSON.stringify({
            gitea: {
              enabled: true,
              url: 'https://gitea.example.com',
              sourceBranch: 'source',
              targetBranch: 'target',
            },
          }),
        }),
        getAll: () => [],
      } as unknown as ProjectRepo;

      const service = new GiteaSyncService({
        config: makeTestConfig(f.hubHome),
        projectRepo,
        eventBus,
        service: { createTask: vi.fn() as any },
      });

      const result = await service.syncProject('p1');
      expect(result.status).toBe('skipped');
      expect(result.ok).toBe(true);

      expect(events.some((e) => e.type === 'gitea.sync.started')).toBe(true);
      expect(events.some((e) => e.type === 'gitea.sync.skipped')).toBe(true);
    });

    it('merge sạch → push → tạo PR → merge', async () => {
      const f = initGitRepoFixture();
      saveGiteaToken(f.hubHome, 'p1', 'tok-123');

      // Add a commit on source
      fs.writeFileSync(path.join(f.repoDir, 'feature.txt'), 'Feature A\n');
      execFileSync('git', ['add', '.'], { cwd: f.repoDir, env: f.env });
      execFileSync('git', ['commit', '-m', 'feat: add feature A'], { cwd: f.repoDir, env: f.env });
      execFileSync('git', ['push', 'origin', 'source'], { cwd: f.repoDir, env: f.env });

      const events: Array<{ type: string; payload: unknown }> = [];
      const eventBus = {
        emit: (type: string, _id?: string, payload?: unknown) => {
          events.push({ type, payload });
          return true;
        },
      } as unknown as EventBus;

      const fakeFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = String(url);
        if (urlStr.includes('/pulls?state=open')) {
          return { ok: true, status: 200, json: async () => [] } as Response;
        }
        if (urlStr.endsWith('/pulls') && init?.method === 'POST') {
          return {
            ok: true,
            status: 201,
            json: async () => ({
              number: 10,
              html_url: 'https://gitea.example.com/tester/repo/pulls/10',
              head: { ref: 'source' },
              base: { ref: 'target' },
            }),
          } as Response;
        }
        if (urlStr.endsWith('/merge') && init?.method === 'POST') {
          return { ok: true, status: 200, json: async () => ({ merged: true }) } as Response;
        }
        return { ok: false, status: 404 } as Response;
      });

      const projectRepo = {
        get: () => ({
          id: 'p1',
          name: 'Project 1',
          path: f.repoDir,
          settings: JSON.stringify({
            gitea: {
              enabled: true,
              url: 'https://gitea.example.com',
              sourceBranch: 'source',
              targetBranch: 'target',
            },
          }),
        }),
        getAll: () => [],
      } as unknown as ProjectRepo;

      const service = new GiteaSyncService({
        config: makeTestConfig(f.hubHome),
        projectRepo,
        eventBus,
        service: { createTask: vi.fn() as any },
        fetchFn: fakeFetch as unknown as typeof fetch,
      });

      const result = await service.syncProject('p1');
      expect(result.status).toBe('succeeded');
      expect(result.ok).toBe(true);
      expect(result.prNumber).toBe(10);
      expect(result.commit).toBeTruthy();

      const succeededEvent = events.find((e) => e.type === 'gitea.sync.succeeded');
      expect(succeededEvent).toBeDefined();
      expect(succeededEvent?.payload).toMatchObject({ merged: true, pushedCommit: expect.any(String) });
      expect((succeededEvent?.payload as any).prNumber).toBe(10);
      expect((succeededEvent?.payload as any).commit).toBe(result.commit);
    });

    it('đã có PR mở thì dùng lại', async () => {
      const f = initGitRepoFixture();
      saveGiteaToken(f.hubHome, 'p1', 'tok-123');

      // Add a commit on source
      fs.writeFileSync(path.join(f.repoDir, 'update.txt'), 'Update 1\n');
      execFileSync('git', ['add', '.'], { cwd: f.repoDir, env: f.env });
      execFileSync('git', ['commit', '-m', 'feat: update 1'], { cwd: f.repoDir, env: f.env });
      execFileSync('git', ['push', 'origin', 'source'], { cwd: f.repoDir, env: f.env });

      let createdPullCalled = false;
      let mergedPrNumber: number | null = null;

      const fakeFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = String(url);
        if (urlStr.includes('/pulls?state=open')) {
          return {
            ok: true,
            status: 200,
            json: async () => [
              {
                number: 55,
                html_url: 'https://gitea.example.com/tester/repo/pulls/55',
                head: { ref: 'source' },
                base: { ref: 'target' },
              },
            ],
          } as Response;
        }
        if (urlStr.endsWith('/pulls') && init?.method === 'POST') {
          createdPullCalled = true;
          return { ok: true, status: 201, json: async () => ({ number: 999 }) } as Response;
        }
        if (urlStr.includes('/pulls/55/merge')) {
          mergedPrNumber = 55;
          return { ok: true, status: 200, json: async () => ({ merged: true }) } as Response;
        }
        return { ok: false, status: 404 } as Response;
      });

      const projectRepo = {
        get: () => ({
          id: 'p1',
          name: 'Project 1',
          path: f.repoDir,
          settings: JSON.stringify({
            gitea: {
              enabled: true,
              url: 'https://gitea.example.com',
              sourceBranch: 'source',
              targetBranch: 'target',
            },
          }),
        }),
        getAll: () => [],
      } as unknown as ProjectRepo;

      const service = new GiteaSyncService({
        config: makeTestConfig(f.hubHome),
        projectRepo,
        eventBus: { emit: () => true } as unknown as EventBus,
        service: { createTask: vi.fn() as any },
        fetchFn: fakeFetch as unknown as typeof fetch,
      });

      const result = await service.syncProject('p1');
      expect(result.status).toBe('succeeded');
      expect(result.prNumber).toBe(55);
      expect(createdPullCalled).toBe(false);
      expect(mergedPrNumber).toBe(55);
    });

    it('union merge giữ cả hai phía (ours rồi theirs)', async () => {
      const f = initGitRepoFixture();
      saveGiteaToken(f.hubHome, 'p1', 'tok-123');

      // On target branch, write CHANGELOG.md
      execFileSync('git', ['checkout', 'target'], { cwd: f.repoDir, env: f.env });
      fs.writeFileSync(path.join(f.repoDir, 'CHANGELOG.md'), 'Target change 1\nTarget change 2\n');
      execFileSync('git', ['add', '.'], { cwd: f.repoDir, env: f.env });
      execFileSync('git', ['commit', '-m', 'chore: changelog on target'], { cwd: f.repoDir, env: f.env });
      execFileSync('git', ['push', 'origin', 'target'], { cwd: f.repoDir, env: f.env });

      // On source branch, modify CHANGELOG.md differently (causing conflict)
      execFileSync('git', ['checkout', 'source'], { cwd: f.repoDir, env: f.env });
      fs.writeFileSync(path.join(f.repoDir, 'CHANGELOG.md'), 'Source change A\nSource change B\n');
      execFileSync('git', ['add', '.'], { cwd: f.repoDir, env: f.env });
      execFileSync('git', ['commit', '-m', 'chore: changelog on source'], { cwd: f.repoDir, env: f.env });
      execFileSync('git', ['push', 'origin', 'source'], { cwd: f.repoDir, env: f.env });

      const fakeFetch = vi.fn(async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes('/pulls?state=open')) {
          return { ok: true, status: 200, json: async () => [] } as Response;
        }
        if (urlStr.endsWith('/pulls')) {
          return {
            ok: true,
            status: 201,
            json: async () => ({
              number: 77,
              html_url: 'https://gitea.example.com/tester/repo/pulls/77',
              head: { ref: 'source' },
              base: { ref: 'target' },
            }),
          } as Response;
        }
        if (urlStr.endsWith('/merge')) {
          return { ok: true, status: 200, json: async () => ({ merged: true }) } as Response;
        }
        return { ok: false, status: 404 } as Response;
      });

      const projectRepo = {
        get: () => ({
          id: 'p1',
          name: 'Project 1',
          path: f.repoDir,
          settings: JSON.stringify({
            gitea: {
              enabled: true,
              url: 'https://gitea.example.com',
              sourceBranch: 'source',
              targetBranch: 'target',
              unionMergeGlobs: ['CHANGELOG.md', '*.md'],
            },
          }),
        }),
        getAll: () => [],
      } as unknown as ProjectRepo;

      const service = new GiteaSyncService({
        config: makeTestConfig(f.hubHome),
        projectRepo,
        eventBus: { emit: () => true } as unknown as EventBus,
        service: { createTask: vi.fn() as any },
        fetchFn: fakeFetch as unknown as typeof fetch,
      });

      const result = await service.syncProject('p1');
      expect(result.status).toBe('succeeded');
      expect(result.ok).toBe(true);

      // Verify that source branch on origin has the union merged changelog
      execFileSync('git', ['pull', 'origin', 'source'], { cwd: f.repoDir, env: f.env });
      const changelog = fs.readFileSync(path.join(f.repoDir, 'CHANGELOG.md'), 'utf8');
      expect(changelog).toContain('Source change A');
      expect(changelog).toContain('Target change 1');
      // Ours (Source) comes before Theirs (Target)
      expect(changelog.indexOf('Source change A')).toBeLessThan(changelog.indexOf('Target change 1'));
    });

    it('xung đột thường thì abort và tạo task draft', async () => {
      const f = initGitRepoFixture();
      saveGiteaToken(f.hubHome, 'p1', 'tok-123');

      // Conflicting file that does NOT match unionMergeGlobs
      execFileSync('git', ['checkout', 'target'], { cwd: f.repoDir, env: f.env });
      fs.writeFileSync(path.join(f.repoDir, 'index.js'), 'console.log("target version");\n');
      execFileSync('git', ['add', '.'], { cwd: f.repoDir, env: f.env });
      execFileSync('git', ['commit', '-m', 'feat: target index.js'], { cwd: f.repoDir, env: f.env });
      execFileSync('git', ['push', 'origin', 'target'], { cwd: f.repoDir, env: f.env });

      execFileSync('git', ['checkout', 'source'], { cwd: f.repoDir, env: f.env });
      fs.writeFileSync(path.join(f.repoDir, 'index.js'), 'console.log("source version");\n');
      execFileSync('git', ['add', '.'], { cwd: f.repoDir, env: f.env });
      execFileSync('git', ['commit', '-m', 'feat: source index.js'], { cwd: f.repoDir, env: f.env });
      execFileSync('git', ['push', 'origin', 'source'], { cwd: f.repoDir, env: f.env });

      const createTaskMock = vi.fn().mockReturnValue({ id: 'p1/gitea-conflict-task' });
      const events: Array<{ type: string; payload: unknown }> = [];
      const eventBus = {
        emit: (type: string, _id?: string, payload?: unknown) => {
          events.push({ type, payload });
          return true;
        },
      } as unknown as EventBus;

      const projectRepo = {
        get: () => ({
          id: 'p1',
          name: 'Project 1',
          path: f.repoDir,
          settings: JSON.stringify({
            gitea: {
              enabled: true,
              url: 'https://gitea.example.com',
              sourceBranch: 'source',
              targetBranch: 'target',
              unionMergeGlobs: ['*.md'], // index.js does not match
            },
          }),
        }),
        getAll: () => [],
      } as unknown as ProjectRepo;

      const service = new GiteaSyncService({
        config: makeTestConfig(f.hubHome),
        projectRepo,
        eventBus,
        service: { createTask: createTaskMock },
      });

      const result = await service.syncProject('p1');
      expect(result.status).toBe('conflict');
      expect(result.ok).toBe(false);
      expect(result.conflictingFiles).toContain('index.js');

      // Verify draft task was created
      expect(createTaskMock).toHaveBeenCalledTimes(1);
      const taskInput = createTaskMock.mock.calls[0][0];
      expect(taskInput.project).toBe('p1');
      expect(taskInput.start).toBe(false); // draft
      expect(taskInput.title).toBe('Gỡ xung đột source ← target');
      expect(taskInput.body).toContain('index.js');

      expect(events.some((e) => e.type === 'gitea.sync.conflict')).toBe(true);
    });

    it('checks fail thì không push', async () => {
      const f = initGitRepoFixture();
      saveGiteaToken(f.hubHome, 'p1', 'tok-123');

      // Add a commit on source
      fs.writeFileSync(path.join(f.repoDir, 'bad-feature.txt'), 'Failing checks\n');
      execFileSync('git', ['add', '.'], { cwd: f.repoDir, env: f.env });
      execFileSync('git', ['commit', '-m', 'feat: bad commit'], { cwd: f.repoDir, env: f.env });
      execFileSync('git', ['push', 'origin', 'source'], { cwd: f.repoDir, env: f.env });

      const fetchMock = vi.fn();

      const projectRepo = {
        get: () => ({
          id: 'p1',
          name: 'Project 1',
          path: f.repoDir,
          settings: JSON.stringify({
            gitea: {
              enabled: true,
              url: 'https://gitea.example.com',
              sourceBranch: 'source',
              targetBranch: 'target',
              checks: [['node', '-e', 'process.exit(1)']],
            },
          }),
        }),
        getAll: () => [],
      } as unknown as ProjectRepo;

      const events: Array<{ type: string; payload: unknown }> = [];
      const eventBus = {
        emit: (type: string, _id?: string, payload?: unknown) => {
          events.push({ type, payload });
          return true;
        },
      } as unknown as EventBus;

      const service = new GiteaSyncService({
        config: makeTestConfig(f.hubHome),
        projectRepo,
        eventBus,
        service: { createTask: vi.fn() as any },
        fetchFn: fetchMock as unknown as typeof fetch,
      });

      const result = await service.syncProject('p1');
      expect(result.status).toBe('failed');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Check failed: node -e process.exit(1)');

      // Gitea client was never called to create or merge PR
      expect(fetchMock).not.toHaveBeenCalled();
      expect(events.some((e) => e.type === 'gitea.sync.failed')).toBe(true);
    });

    it('lịch chạy đúng một lần mỗi mốc và tuân thủ weekdaysOnly', async () => {
      const syncCalls: string[] = [];

      const projectRepo = {
        getAll: () => [
          {
            id: 'p1',
            settings: JSON.stringify({
              gitea: {
                enabled: true,
                url: 'https://gitea.example.com',
                sourceBranch: 'source',
                targetBranch: 'target',
                schedule: ['12:00', '18:00'],
                weekdaysOnly: true,
              },
            }),
          },
        ],
        get: () => null,
      } as unknown as ProjectRepo;

      let currentTime = new Date('2026-11-02T12:05:00').getTime(); // Monday 12:05
      const hubHome = makeTempDir('sched-test-');
      const service = new GiteaSyncService({
        config: makeTestConfig(hubHome),
        projectRepo,
        eventBus: { emit: () => true } as unknown as EventBus,
        service: { createTask: vi.fn() as any },
        now: () => currentTime,
      });

      // Stub syncProject
      vi.spyOn(service, 'syncProject').mockImplementation(async (id) => {
        syncCalls.push(id);
        return { ok: true, status: 'succeeded' };
      });

      // Check at 12:05 Monday
      await service.checkScheduled(currentTime);
      expect(syncCalls).toHaveLength(1);

      // Check at 12:15 Monday (same milestone today): should skip
      currentTime = new Date('2026-11-02T12:15:00').getTime();
      await service.checkScheduled(currentTime);
      expect(syncCalls).toHaveLength(1);

      // Check at 18:02 Monday (second milestone today): should run
      currentTime = new Date('2026-11-02T18:02:00').getTime();
      await service.checkScheduled(currentTime);
      expect(syncCalls).toHaveLength(2);

      // Check on Saturday (weekdaysOnly = true): should not run
      currentTime = new Date('2026-11-07T12:00:00').getTime(); // Saturday
      await service.checkScheduled(currentTime);
      expect(syncCalls).toHaveLength(2);
    });

    it('chỉ cho phép một lượt sync chạy cùng lúc cho một project', async () => {
      const f = initGitRepoFixture();
      saveGiteaToken(f.hubHome, 'p1', 'tok-123');

      const projectRepo = {
        get: () => ({
          id: 'p1',
          name: 'Project 1',
          path: f.repoDir,
          settings: JSON.stringify({
            gitea: {
              enabled: true,
              url: 'https://gitea.example.com',
              sourceBranch: 'source',
              targetBranch: 'target',
            },
          }),
        }),
        getAll: () => [],
      } as unknown as ProjectRepo;

      const service = new GiteaSyncService({
        config: makeTestConfig(f.hubHome),
        projectRepo,
        eventBus: { emit: () => true } as unknown as EventBus,
        service: { createTask: vi.fn() as any },
      });

      // Mock executeSync to take a while
      let finishFirstSync!: () => void;
      const slowPromise = new Promise<any>((resolve) => {
        finishFirstSync = () => resolve({ ok: true, status: 'succeeded' });
      });
      (service as any).executeSync = vi.fn().mockReturnValue(slowPromise);

      const firstSync = service.syncProject('p1');
      await expect(service.syncProject('p1')).rejects.toThrow('Sync cho project "p1" đang chạy');

      finishFirstSync();
      await firstSync;
    });
  });

  describe('6. HTTP Routes & MCP Tool', () => {
    it('PUT /api/projects/:id/gitea/token and GET /api/projects/:id/gitea/status', async () => {
      const root = makeTempDir('gitea-api-test-');
      const hubHome = path.join(root, 'hub');
      fs.mkdirSync(hubHome, { recursive: true });

      const app: FastifyInstance = Fastify();
      const mockProject = {
        id: 'proj1',
        name: 'Project 1',
        path: root,
        settings: JSON.stringify({
          gitea: {
            enabled: true,
            url: 'https://gitea.example.com',
          },
        }),
      };

      const mockService = {
        getProject: vi.fn().mockReturnValue(mockProject),
        saveGiteaToken: vi.fn((id: string, token: string) => {
          saveGiteaToken(hubHome, id, token);
          return { configured: true };
        }),
        getGiteaStatus: vi.fn((id: string) => ({
          tokenConfigured: isGiteaTokenConfigured(hubHome, id),
        })),
        triggerGiteaSync: vi.fn().mockResolvedValue({ ok: true, status: 'succeeded' }),
      };

      // Register routes
      app.put('/api/projects/:id/gitea/token', async (req) => {
        const { id } = req.params as { id: string };
        const body = req.body as { token?: string };
        return mockService.saveGiteaToken(id, body?.token || '');
      });
      app.get('/api/projects/:id/gitea/status', async (req) => {
        const { id } = req.params as { id: string };
        return mockService.getGiteaStatus(id);
      });
      app.post('/api/projects/:id/gitea/sync', async (req) => {
        const { id } = req.params as { id: string };
        return mockService.triggerGiteaSync(id);
      });

      await app.ready();

      // GET before saving token
      const getRes1 = await app.inject({ method: 'GET', url: '/api/projects/proj1/gitea/status' });
      expect(getRes1.statusCode).toBe(200);
      expect(JSON.parse(getRes1.body)).toEqual({
        tokenConfigured: false,
      });

      // PUT token
      const putRes = await app.inject({
        method: 'PUT',
        url: '/api/projects/proj1/gitea/token',
        payload: { token: 'super-secret-token' },
      });
      expect(putRes.statusCode).toBe(200);
      expect(JSON.parse(putRes.body)).toEqual({ configured: true });

      // GET after saving token (verify token string is NOT returned)
      const getRes2 = await app.inject({ method: 'GET', url: '/api/projects/proj1/gitea/status' });
      expect(getRes2.statusCode).toBe(200);
      const statusBody = JSON.parse(getRes2.body);
      expect(statusBody.tokenConfigured).toBe(true);
      expect(statusBody.token).toBeUndefined();
      expect(getRes2.body).not.toContain('super-secret-token');

      // POST sync
      const postSync = await app.inject({ method: 'POST', url: '/api/projects/proj1/gitea/sync' });
      expect(postSync.statusCode).toBe(200);
      expect(JSON.parse(postSync.body)).toEqual({ ok: true, status: 'succeeded' });

      await app.close();
    });

    it('MCP tool hub_gitea_sync triggers sync via API', async () => {
      const port = 7789;
      const app = Fastify();
      let syncCalled = false;

      app.post('/api/projects/proj1/gitea/sync', async () => {
        syncCalled = true;
        return { ok: true, status: 'succeeded', prNumber: 12 };
      });

      await app.listen({ port, host: '127.0.0.1' });

      try {
        const mcpServer = createMcpServer({
          port,
          token: 'test-token',
          baseUrl: `http://127.0.0.1:${port}`,
          projectId: 'proj1',
        });

        // Test calling the tool through MCP handler
        const tool = (mcpServer as any)._registeredTools?.['hub_gitea_sync'];
        expect(tool).toBeDefined();

        const result = await tool.handler({ projectId: 'proj1' });
        expect(syncCalled).toBe(true);
        expect(result.content[0].text).toContain('"status": "succeeded"');
        expect(result.content[0].text).toContain('"prNumber": 12');
      } finally {
        await app.close();
      }
    });
  });

  describe('7. Notifications & Telegram Events', () => {
    it('NotificationService handles gitea.sync events', () => {
      const hubHome = makeTempDir('notify-test-');
      const config = makeTestConfig(hubHome);
      const notifications: Array<{ msg: string; level: string }> = [];
      const notifier = new NotificationService({
        config,
        eventBus: { emit: () => true, on: () => {} } as unknown as EventBus,
      });
      (notifier as any).notify = (msg: string, level: string) => {
        notifications.push({ msg, level });
      };

      (notifier as any).handleEvent('gitea.sync.started', 'p1', {
        sourceBranch: 'source',
        targetBranch: 'target',
      });
      expect(notifications.some((n) => n.msg.includes('bắt đầu đồng bộ Gitea'))).toBe(true);

      (notifier as any).handleEvent('gitea.sync.succeeded', 'p1', {
        prNumber: 42,
        commit: '1234567890',
      });
      expect(notifications.some((n) => n.msg.includes('PR #42'))).toBe(true);

      (notifier as any).handleEvent('gitea.sync.failed', 'p1', {
        error: 'Merge conflict',
      });
      expect(notifications.some((n) => n.msg.includes('thất bại'))).toBe(true);
    });

    it('TelegramBotService broadcasts gitea.sync events', () => {
      const hubHome = makeTempDir('telegram-test-');
      const baseConfig = makeTestConfig(hubHome);
      const messages: string[] = [];
      const telegram = new TelegramBotService({
        config: {
          ...baseConfig,
          telegram: {
            ...baseConfig.telegram,
            enabled: true,
            botTokenFile: '/tmp/test.token',
            allowedChatIds: [12345],
          },
        },
        eventBus: { on: () => {}, emit: () => true } as unknown as EventBus,
        taskRepo: { get: () => null } as unknown as TaskRepo,
        projectRepo: { get: () => null } as unknown as ProjectRepo,
        departmentRepo: { get: () => null } as any,
        profileRepo: { list: () => [] } as unknown as ProfileRepo,
        quotaMarkRepo: { list: () => [] } as unknown as QuotaMarkRepo,
        chatService: {} as any,
        service: {} as any,
      });

      telegram.broadcastMessage = (text: string) => {
        messages.push(text);
        return Promise.resolve(true);
      };

      telegram.handleEvent('gitea.sync.started', 'p1', {
        sourceBranch: 'source',
        targetBranch: 'target',
      });
      expect(messages.some((m) => m.includes('Bắt đầu đồng bộ Gitea'))).toBe(true);

      telegram.handleEvent('gitea.sync.succeeded', 'p1', {
        prNumber: 99,
        commit: 'abcdef1234',
        url: 'https://gitea.com/pr/99',
      });
      expect(messages.some((m) => m.includes('Đồng bộ Gitea thành công'))).toBe(true);

      telegram.handleEvent('gitea.sync.conflict', 'p1', {
        conflictingFiles: ['fileA.txt', 'fileB.txt'],
      });
      expect(messages.some((m) => m.includes('Xung đột khi đồng bộ Gitea'))).toBe(true);
    });
  });
});
