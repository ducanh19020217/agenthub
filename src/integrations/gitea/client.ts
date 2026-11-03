export interface ParsedRemote {
  owner: string;
  repo: string;
  host?: string;
}

export function parseRemote(url: string | null | undefined): ParsedRemote | null {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;

  // 1. ssh://[user@]host[:port]/owner/repo[.git]
  const sshSchemeMatch = trimmed.match(/^ssh:\/\/(?:[^@]+@)?([^/:]+(?::\d+)?)\/(.+?)\/([^/]+?)(?:\.git)?\/?$/);
  if (sshSchemeMatch) {
    return {
      host: sshSchemeMatch[1],
      owner: sshSchemeMatch[2],
      repo: sshSchemeMatch[3],
    };
  }

  // 2. [user@]host:owner/repo[.git] (SCP syntax)
  const scpMatch = trimmed.match(/^(?:[^@]+@)?([^/:]+):([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (scpMatch) {
    return {
      host: scpMatch[1],
      owner: scpMatch[2],
      repo: scpMatch[3],
    };
  }

  // 3. http(s)://host[:port]/owner/repo[.git]
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      const pathParts = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/');
      if (pathParts.length >= 2) {
        const owner = pathParts[pathParts.length - 2];
        let repo = pathParts[pathParts.length - 1];
        if (repo.endsWith('.git')) repo = repo.slice(0, -4);
        return {
          host: parsed.host,
          owner,
          repo,
        };
      }
    }
  } catch {
    // not a valid URL
  }

  return null;
}

export interface GiteaPullRef {
  ref: string;
  sha?: string;
}

export interface GiteaPullRequest {
  id: number;
  number: number;
  title: string;
  body?: string;
  state: 'open' | 'closed';
  html_url?: string;
  url?: string;
  mergeable?: boolean;
  head?: GiteaPullRef;
  base?: GiteaPullRef;
  [key: string]: unknown;
}

export interface GiteaCreatePullInput {
  head: string;
  base: string;
  title: string;
  body?: string;
}

export interface GiteaClientOptions {
  baseUrl: string;
  token: string;
  fetchFn?: typeof globalThis.fetch;
  retryDelayMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
  maxMergeRetries?: number;
}

export class GiteaClient {
  private readonly apiBase: string;
  private readonly token: string;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly retryDelayMs: number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly maxMergeRetries: number;

  constructor(opts: GiteaClientOptions) {
    const cleanUrl = (opts.baseUrl || '').replace(/\/+$/, '');
    this.apiBase = cleanUrl.endsWith('/api/v1') ? cleanUrl : `${cleanUrl}/api/v1`;
    this.token = opts.token;
    this.fetchFn = opts.fetchFn || globalThis.fetch;
    this.retryDelayMs = opts.retryDelayMs !== undefined ? opts.retryDelayMs : 10_000;
    this.sleepFn = opts.sleepFn || ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxMergeRetries = opts.maxMergeRetries !== undefined ? opts.maxMergeRetries : 6;
  }

  /**
   * Find an open pull request matching head and base refs.
   * Paginates up to 5 pages (limit 50 per page).
   */
  async findOpenPull(
    owner: string,
    repo: string,
    head: string,
    base: string,
  ): Promise<GiteaPullRequest | null> {
    const maxPages = 5;
    for (let page = 1; page <= maxPages; page++) {
      const url = `${this.apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=open&limit=50&page=${page}`;
      const res = await this.fetchFn(url, {
        method: 'GET',
        headers: {
          Authorization: `token ${this.token}`,
          Accept: 'application/json',
        },
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Gitea API error (${res.status}): ${errText || res.statusText}`);
      }

      const items = (await res.json()) as GiteaPullRequest[];
      if (!Array.isArray(items) || items.length === 0) {
        return null;
      }

      const found = items.find((pr) => {
        const prHead = pr.head?.ref;
        const prBase = pr.base?.ref;
        const matchHead = prHead === head || prHead === `refs/heads/${head}` || prHead?.endsWith(`:${head}`);
        const matchBase = prBase === base || prBase === `refs/heads/${base}`;
        return Boolean(matchHead && matchBase);
      });

      if (found) {
        return found;
      }

      if (items.length < 50) {
        return null;
      }
    }
    return null;
  }

  /**
   * Create a new pull request.
   */
  async createPull(
    owner: string,
    repo: string,
    data: GiteaCreatePullInput,
  ): Promise<GiteaPullRequest> {
    const url = `${this.apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`;
    const res = await this.fetchFn(url, {
      method: 'POST',
      headers: {
        Authorization: `token ${this.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(data),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Failed to create pull request (${res.status}): ${errText || res.statusText}`);
    }

    return (await res.json()) as GiteaPullRequest;
  }

  /**
   * Merge a pull request.
   * Retries up to maxMergeRetries (default 6) times spaced by retryDelayMs (default 10s).
   */
  async mergePull(
    owner: string,
    repo: string,
    index: number,
  ): Promise<unknown> {
    const url = `${this.apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${index}/merge`;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxMergeRetries; attempt++) {
      try {
        const res = await this.fetchFn(url, {
          method: 'POST',
          headers: {
            Authorization: `token ${this.token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ Do: 'merge', delete_branch_after_merge: false }),
        });

        if (res.ok) {
          try {
            return await res.json();
          } catch {
            return { success: true };
          }
        }

        const errText = await res.text().catch(() => '');
        lastError = new Error(`Failed to merge pull request #${index} (${res.status}): ${errText || res.statusText}`);
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }

      if (attempt < this.maxMergeRetries) {
        await this.sleepFn(this.retryDelayMs);
      }
    }

    throw lastError || new Error(`Failed to merge pull request #${index} after ${this.maxMergeRetries} retries`);
  }
}
