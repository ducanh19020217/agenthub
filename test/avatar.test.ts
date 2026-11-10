import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/daemon.js';
import { createServer } from '../src/api/server.js';
import { getOrCreateToken } from '../src/auth.js';
import { hashAvatarUrl, isAllowedAvatarUrl, MAX_AVATAR_BYTES } from '../src/avatar.js';

let tmpDir: string;
let config: ReturnType<typeof loadConfig>;
let ctx: ReturnType<typeof createContext>;
let server: Awaited<ReturnType<typeof createServer>>;
let token: string;

function authHeaders() {
  return {
    host: '127.0.0.1:7700',
    authorization: `Bearer ${token}`,
  };
}

describe('Profile Avatar Proxy & Cache', () => {
  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-avatar-test-'));
    process.env.AGENTHUB_HOME = tmpDir;
    config = loadConfig(tmpDir);
    config.hubHome = tmpDir;
    config.port = 7700;
    token = getOrCreateToken(config.tokenPath);

    ctx = createContext(config);
    server = await createServer(ctx.service, config);
    await server.ready();
  });

  afterEach(async () => {
    ctx.scheduler.stop();
    await server.close();
    ctx.db.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    delete process.env.AGENTHUB_HOME;
    vi.restoreAllMocks();
  });

  describe('isAllowedAvatarUrl', () => {
    it('allows googleusercontent.com and its subdomains over https', () => {
      expect(isAllowedAvatarUrl('https://lh3.googleusercontent.com/a/abc=s96-c')).toBe(true);
      expect(isAllowedAvatarUrl('https://lh4.googleusercontent.com/photo.jpg')).toBe(true);
      expect(isAllowedAvatarUrl('https://googleusercontent.com/avatar')).toBe(true);
    });

    it('rejects non-https, invalid URLs, and unauthorized hosts', () => {
      expect(isAllowedAvatarUrl('http://lh3.googleusercontent.com/a/abc')).toBe(false);
      expect(isAllowedAvatarUrl('https://evil.com/avatar.png')).toBe(false);
      expect(isAllowedAvatarUrl('https://not-googleusercontent.com/a')).toBe(false);
      expect(isAllowedAvatarUrl('https://googleusercontent.com.evil.com/a')).toBe(false);
      expect(isAllowedAvatarUrl('file:///etc/passwd')).toBe(false);
      expect(isAllowedAvatarUrl('javascript:alert(1)')).toBe(false);
      expect(isAllowedAvatarUrl('not-a-url')).toBe(false);
    });
  });

  describe('GET /api/profiles/:name/avatar Authentication & Validation', () => {
    it('requires Bearer token authentication (returns 401 when missing)', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/profiles/p1/avatar',
        headers: { host: '127.0.0.1:7700' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('does not allow ?token= query parameter authentication', async () => {
      const res = await server.inject({
        method: 'GET',
        url: `/api/profiles/p1/avatar?token=${token}`,
        headers: { host: '127.0.0.1:7700' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 404 when profile does not exist', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/profiles/non-existent/avatar',
        headers: authHeaders(),
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 404 when profile has no avatarUrl', async () => {
      ctx.profileRepo.upsert({
        name: 'no-avatar',
        engine: 'agy',
        kind: 'isolated',
        enabled: 1,
        avatarUrl: null,
      });

      const res = await server.inject({
        method: 'GET',
        url: '/api/profiles/no-avatar/avatar',
        headers: authHeaders(),
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 404 and does not fetch when avatarUrl host is outside allowlist', async () => {
      ctx.profileRepo.upsert({
        name: 'ssrf-profile',
        engine: 'agy',
        kind: 'isolated',
        enabled: 1,
        avatarUrl: 'https://evil.attacker.com/avatar.png',
      });

      const fetchSpy = vi.fn();
      ctx.service.avatarService.setFetchFn(fetchSpy as unknown as typeof fetch);

      const res = await server.inject({
        method: 'GET',
        url: '/api/profiles/ssrf-profile/avatar',
        headers: authHeaders(),
      });

      expect(res.statusCode).toBe(404);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('Caching, Deduplication & Response Headers', () => {
    const validUrl = 'https://lh3.googleusercontent.com/a/valid-user-123';
    const fakeImageData = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

    beforeEach(() => {
      ctx.profileRepo.upsert({
        name: 'user1',
        engine: 'agy',
        kind: 'isolated',
        enabled: 1,
        avatarUrl: validUrl,
      });
    });

    it('fetches on cache miss, caches file atomically, and returns required headers', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(fakeImageData, {
          status: 200,
          headers: {
            'content-type': 'image/jpeg',
            'content-length': String(fakeImageData.length),
          },
        }),
      );
      ctx.service.avatarService.setFetchFn(mockFetch as unknown as typeof fetch);

      const res = await server.inject({
        method: 'GET',
        url: '/api/profiles/user1/avatar',
        headers: authHeaders(),
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/jpeg');
      expect(res.headers['cache-control']).toBe('private, max-age=86400');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-security-policy']).toBe("default-src 'none'");
      expect(res.rawPayload).toEqual(fakeImageData);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Verify file is saved in <hubHome>/cache/avatars
      const hash = hashAvatarUrl(validUrl);
      const cacheDir = path.join(tmpDir, 'cache', 'avatars');
      const dataFile = path.join(cacheDir, `${hash}.data`);
      const metaFile = path.join(cacheDir, `${hash}.json`);

      expect(fs.existsSync(dataFile)).toBe(true);
      expect(fs.existsSync(metaFile)).toBe(true);
      expect(fs.readFileSync(dataFile)).toEqual(fakeImageData);

      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      expect(meta.contentType).toBe('image/jpeg');
      expect(meta.url).toBe(validUrl);

      // Cache hit: subsequent request should not call fetch
      const res2 = await server.inject({
        method: 'GET',
        url: '/api/profiles/user1/avatar',
        headers: authHeaders(),
      });
      expect(res2.statusCode).toBe(200);
      expect(res2.rawPayload).toEqual(fakeImageData);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('deduplicates concurrent requests for the same URL so upstream is fetched only once', async () => {
      let resolveFetch!: (res: Response) => void;
      const fetchPromise = new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });

      const mockFetch = vi.fn().mockImplementation(() => fetchPromise);
      ctx.service.avatarService.setFetchFn(mockFetch as unknown as typeof fetch);

      // Dispatch 4 concurrent requests
      const req1 = server.inject({ method: 'GET', url: '/api/profiles/user1/avatar', headers: authHeaders() });
      const req2 = server.inject({ method: 'GET', url: '/api/profiles/user1/avatar', headers: authHeaders() });
      const req3 = server.inject({ method: 'GET', url: '/api/profiles/user1/avatar', headers: authHeaders() });
      const req4 = server.inject({ method: 'GET', url: '/api/profiles/user1/avatar', headers: authHeaders() });

      // Resolve the single upstream request
      resolveFetch(
        new Response(fakeImageData, {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
      );

      const [r1, r2, r3, r4] = await Promise.all([req1, req2, req3, req4]);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(r1.statusCode).toBe(200);
      expect(r2.statusCode).toBe(200);
      expect(r3.statusCode).toBe(200);
      expect(r4.statusCode).toBe(200);
      expect(r1.rawPayload).toEqual(fakeImageData);
    });

    it('returns old cache when fetch fails', async () => {
      // First populate cache
      const mockFetch1 = vi.fn().mockResolvedValue(
        new Response(fakeImageData, {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        }),
      );
      ctx.service.avatarService.setFetchFn(mockFetch1 as unknown as typeof fetch);

      const res1 = await server.inject({
        method: 'GET',
        url: '/api/profiles/user1/avatar',
        headers: authHeaders(),
      });
      expect(res1.statusCode).toBe(200);

      // Now force refresh while fetch throws an upstream error (e.g. 503)
      const mockFetchError = vi.fn().mockRejectedValue(new Error('Network error / 503'));
      ctx.service.avatarService.setFetchFn(mockFetchError as unknown as typeof fetch);

      // Calling getProfileAvatar with forceRefresh: true triggers fetch, which fails and returns old cache
      const avatar = await ctx.service.getProfileAvatar('user1', { forceRefresh: true });
      expect(avatar.data).toEqual(fakeImageData);
      expect(avatar.contentType).toBe('image/jpeg');
    });

    it('returns 502 when fetch fails and no cache exists', async () => {
      const mockFetchError = vi.fn().mockRejectedValue(new Error('Connection refused'));
      ctx.service.avatarService.setFetchFn(mockFetchError as unknown as typeof fetch);

      const res = await server.inject({
        method: 'GET',
        url: '/api/profiles/user1/avatar',
        headers: authHeaders(),
      });

      expect(res.statusCode).toBe(502);
      const body = JSON.parse(res.payload);
      expect(body.error).toBe('bad_gateway');
    });

    it('returns 502 when upstream status is not 2xx and no cache exists', async () => {
      const mockFetch429 = vi.fn().mockResolvedValue(
        new Response('Too Many Requests', { status: 429, headers: { 'content-type': 'text/plain' } }),
      );
      ctx.service.avatarService.setFetchFn(mockFetch429 as unknown as typeof fetch);

      const res = await server.inject({
        method: 'GET',
        url: '/api/profiles/user1/avatar',
        headers: authHeaders(),
      });

      expect(res.statusCode).toBe(502);
    });

    it('returns 502 when content-type is not an image', async () => {
      const mockFetchHtml = vi.fn().mockResolvedValue(
        new Response('<html><body>Error</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      );
      ctx.service.avatarService.setFetchFn(mockFetchHtml as unknown as typeof fetch);

      const res = await server.inject({
        method: 'GET',
        url: '/api/profiles/user1/avatar',
        headers: authHeaders(),
      });

      expect(res.statusCode).toBe(502);
      const body = JSON.parse(res.payload);
      expect(body.error).toBe('bad_gateway');
    });

    it('returns 502 when avatar size exceeds 1MB limit', async () => {
      const oversizedData = Buffer.alloc(MAX_AVATAR_BYTES + 10, 0x11);
      const mockFetchBig = vi.fn().mockResolvedValue(
        new Response(oversizedData, {
          status: 200,
          headers: {
            'content-type': 'image/png',
            'content-length': String(oversizedData.length),
          },
        }),
      );
      ctx.service.avatarService.setFetchFn(mockFetchBig as unknown as typeof fetch);

      const res = await server.inject({
        method: 'GET',
        url: '/api/profiles/user1/avatar',
        headers: authHeaders(),
      });

      expect(res.statusCode).toBe(502);
      const body = JSON.parse(res.payload);
      expect(body.error).toBe('bad_gateway');
    });
  });

  describe('cleanupOrphanedAvatars', () => {
    it('deletes orphaned avatar files and leftover temp files while keeping active avatars', () => {
      const cacheDir = path.join(tmpDir, 'cache', 'avatars');
      fs.mkdirSync(cacheDir, { recursive: true });

      const activeUrl = 'https://lh3.googleusercontent.com/a/active-user';
      const orphanedUrl = 'https://lh3.googleusercontent.com/a/deleted-user';

      ctx.profileRepo.upsert({
        name: 'active',
        engine: 'agy',
        kind: 'isolated',
        enabled: 1,
        avatarUrl: activeUrl,
      });

      const activeHash = hashAvatarUrl(activeUrl);
      const orphanedHash = hashAvatarUrl(orphanedUrl);

      // Create active avatar files
      fs.writeFileSync(path.join(cacheDir, `${activeHash}.data`), 'active-img');
      fs.writeFileSync(path.join(cacheDir, `${activeHash}.json`), JSON.stringify({ contentType: 'image/png', url: activeUrl }));

      // Create orphaned avatar files
      fs.writeFileSync(path.join(cacheDir, `${orphanedHash}.data`), 'orphaned-img');
      fs.writeFileSync(path.join(cacheDir, `${orphanedHash}.json`), JSON.stringify({ contentType: 'image/png', url: orphanedUrl }));

      // Create temp file
      fs.writeFileSync(path.join(cacheDir, `${orphanedHash}.tmp.12345.data`), 'tmp-img');

      // Run cleanup
      ctx.service.cleanupAvatarCache();

      // Verify active files remain
      expect(fs.existsSync(path.join(cacheDir, `${activeHash}.data`))).toBe(true);
      expect(fs.existsSync(path.join(cacheDir, `${activeHash}.json`))).toBe(true);

      // Verify orphaned files and temp files were deleted
      expect(fs.existsSync(path.join(cacheDir, `${orphanedHash}.data`))).toBe(false);
      expect(fs.existsSync(path.join(cacheDir, `${orphanedHash}.json`))).toBe(false);
      expect(fs.existsSync(path.join(cacheDir, `${orphanedHash}.tmp.12345.data`))).toBe(false);
    });
  });
});
