import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HttpError } from './errors.js';
import type { ProfileRepo } from './db/index.js';

export const MAX_AVATAR_BYTES = 1024 * 1024; // 1MB
export const AVATAR_FETCH_TIMEOUT_MS = 10_000; // 10s

export interface AvatarResult {
  data: Buffer;
  contentType: string;
}

export function isAllowedAvatarUrl(urlStr: string): boolean {
  if (!urlStr || typeof urlStr !== 'string') return false;
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== 'https:') return false;
    const hostname = parsed.hostname.toLowerCase();
    return hostname === 'googleusercontent.com' || hostname.endsWith('.googleusercontent.com');
  } catch {
    return false;
  }
}

export function hashAvatarUrl(url: string): string {
  return crypto.createHash('sha256').update(url).digest('hex');
}

export class AvatarService {
  private cacheDir: string;
  private pendingFetches = new Map<string, Promise<AvatarResult>>();
  private fetchFn: typeof fetch;

  constructor(
    hubHome: string,
    private profileRepo: ProfileRepo,
    fetchFn?: typeof fetch,
  ) {
    this.cacheDir = path.join(hubHome, 'cache', 'avatars');
    this.fetchFn = fetchFn || globalThis.fetch;
  }

  setFetchFn(fn: typeof fetch): void {
    this.fetchFn = fn;
  }

  getCacheDir(): string {
    return this.cacheDir;
  }

  getAvatarFilePath(avatarUrl: string): { dataPath: string; metaPath: string } {
    const hash = hashAvatarUrl(avatarUrl);
    return {
      dataPath: path.join(this.cacheDir, `${hash}.data`),
      metaPath: path.join(this.cacheDir, `${hash}.json`),
    };
  }

  readCache(avatarUrl: string): AvatarResult | null {
    try {
      const { dataPath, metaPath } = this.getAvatarFilePath(avatarUrl);
      if (!fs.existsSync(dataPath) || !fs.existsSync(metaPath)) {
        return null;
      }
      const metaRaw = fs.readFileSync(metaPath, 'utf8');
      const meta = JSON.parse(metaRaw);
      const data = fs.readFileSync(dataPath);
      if (meta?.contentType && typeof meta.contentType === 'string' && meta.contentType.startsWith('image/') && data.length > 0) {
        return { data, contentType: meta.contentType };
      }
      return null;
    } catch {
      return null;
    }
  }

  private writeCache(avatarUrl: string, data: Buffer, contentType: string): void {
    fs.mkdirSync(this.cacheDir, { recursive: true, mode: 0o700 });
    const hash = hashAvatarUrl(avatarUrl);
    const tmpData = path.join(this.cacheDir, `${hash}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}.data`);
    const tmpMeta = `${tmpData}.json`;
    const targetData = path.join(this.cacheDir, `${hash}.data`);
    const targetMeta = path.join(this.cacheDir, `${hash}.json`);

    try {
      fs.writeFileSync(tmpData, data);
      fs.writeFileSync(tmpMeta, JSON.stringify({ contentType, url: avatarUrl, savedAt: Date.now() }), 'utf8');
      fs.renameSync(tmpData, targetData);
      fs.renameSync(tmpMeta, targetMeta);
    } catch (err) {
      try { if (fs.existsSync(tmpData)) fs.unlinkSync(tmpData); } catch { /* ignore */ }
      try { if (fs.existsSync(tmpMeta)) fs.unlinkSync(tmpMeta); } catch { /* ignore */ }
      throw err;
    }
  }

  private async fetchAndSave(avatarUrl: string): Promise<AvatarResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Avatar fetch timeout')), AVATAR_FETCH_TIMEOUT_MS);

    try {
      const res = await this.fetchFn(avatarUrl, {
        signal: controller.signal,
        headers: {
          'Accept': 'image/*',
          'User-Agent': 'AgentHub-AvatarProxy/1.0',
        },
      });

      if (!res.ok) {
        throw new HttpError(502, 'bad_gateway', `Upstream avatar request failed with status ${res.status}`);
      }

      const rawContentType = res.headers.get('content-type') || '';
      const contentType = rawContentType.split(';')[0].trim().toLowerCase();
      if (!contentType.startsWith('image/')) {
        throw new HttpError(502, 'bad_gateway', `Upstream content-type is not an image: ${rawContentType || 'empty'}`);
      }

      const contentLength = res.headers.get('content-length');
      if (contentLength) {
        const parsedLength = parseInt(contentLength, 10);
        if (!isNaN(parsedLength) && parsedLength > MAX_AVATAR_BYTES) {
          throw new HttpError(502, 'bad_gateway', 'Avatar image exceeds 1MB limit');
        }
      }

      let data: Buffer;
      if (res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            total += value.byteLength;
            if (total > MAX_AVATAR_BYTES) {
              await reader.cancel();
              throw new HttpError(502, 'bad_gateway', 'Avatar image exceeds 1MB limit');
            }
            chunks.push(value);
          }
        }
        data = Buffer.concat(chunks);
      } else {
        const arrayBuffer = await res.arrayBuffer();
        if (arrayBuffer.byteLength > MAX_AVATAR_BYTES) {
          throw new HttpError(502, 'bad_gateway', 'Avatar image exceeds 1MB limit');
        }
        data = Buffer.from(arrayBuffer);
      }

      if (data.length === 0) {
        throw new HttpError(502, 'bad_gateway', 'Avatar image is empty');
      }

      this.writeCache(avatarUrl, data, contentType);
      return { data, contentType };
    } finally {
      clearTimeout(timeout);
    }
  }

  async getAvatarByUrl(avatarUrl: string, options?: { forceRefresh?: boolean }): Promise<AvatarResult> {
    if (!options?.forceRefresh) {
      const cached = this.readCache(avatarUrl);
      if (cached) {
        return cached;
      }
    }

    const hash = hashAvatarUrl(avatarUrl);
    const existingPromise = this.pendingFetches.get(hash);
    if (existingPromise) {
      return await existingPromise;
    }

    const fetchPromise = (async () => {
      try {
        return await this.fetchAndSave(avatarUrl);
      } catch (err) {
        const oldCache = this.readCache(avatarUrl);
        if (oldCache) {
          return oldCache;
        }
        if (err instanceof HttpError) {
          throw err;
        }
        throw new HttpError(502, 'bad_gateway', `Failed to fetch avatar: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();

    this.pendingFetches.set(hash, fetchPromise);
    try {
      return await fetchPromise;
    } finally {
      this.pendingFetches.delete(hash);
    }
  }

  async getProfileAvatar(name: string, options?: { forceRefresh?: boolean }): Promise<AvatarResult> {
    const profile = this.profileRepo.get(name);
    if (!profile || !profile.avatarUrl) {
      throw new HttpError(404, 'not_found', `Profile or avatar not found for "${name}"`);
    }
    if (!isAllowedAvatarUrl(profile.avatarUrl)) {
      throw new HttpError(404, 'not_found', 'Avatar URL host not allowed');
    }
    return await this.getAvatarByUrl(profile.avatarUrl, options);
  }

  cleanupOrphanedAvatars(): void {
    try {
      if (!fs.existsSync(this.cacheDir)) return;
      const profiles = this.profileRepo.getAll(true);
      const validHashes = new Set<string>();
      for (const p of profiles) {
        if (p.avatarUrl && isAllowedAvatarUrl(p.avatarUrl)) {
          validHashes.add(hashAvatarUrl(p.avatarUrl));
        }
      }

      const entries = fs.readdirSync(this.cacheDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const fileName = entry.name;
        if (fileName.includes('.tmp.')) {
          try { fs.unlinkSync(path.join(this.cacheDir, fileName)); } catch { /* ignore */ }
          continue;
        }
        const match = fileName.match(/^([a-f0-9]{64})\.(data|json)$/);
        if (match) {
          const hash = match[1];
          if (!validHashes.has(hash)) {
            try { fs.unlinkSync(path.join(this.cacheDir, fileName)); } catch { /* ignore */ }
          }
        }
      }
    } catch {
      // Best effort cleanup
    }
  }
}
