export interface OpenProjectHalLink {
  href: string;
  title?: string;
}

export interface OpenProjectUser {
  id: number;
  name: string;
  email?: string;
}

export interface OpenProjectWorkPackage {
  id: number;
  displayId?: string;
  subject?: string;
  description?: {
    raw?: string;
    format?: string;
    html?: string;
  };
  lockVersion: number;
  updatedAt?: string;
  createdAt?: string;
  _links?: {
    status?: OpenProjectHalLink;
    priority?: OpenProjectHalLink;
    author?: OpenProjectHalLink;
    user?: OpenProjectHalLink;
    [key: string]: OpenProjectHalLink | undefined;
  };
  priority?: { title?: string };
  author?: { title?: string };
  status?: { title?: string };
}

export interface OpenProjectActivity {
  id: number;
  comment?: {
    raw?: string;
    format?: string;
    html?: string;
  };
  details?: Array<{ raw?: string }>;
  createdAt?: string;
  _links?: {
    user?: OpenProjectHalLink;
    [key: string]: OpenProjectHalLink | undefined;
  };
}

export interface OpenProjectCollection<T> {
  _type?: string;
  total?: number;
  count?: number;
  pageSize?: number;
  offset?: number;
  _embedded?: {
    elements?: T[];
  };
}

export interface OpenProjectClientOptions {
  baseUrl: string;
  apiKey: string;
  project?: string;
  fetch?: typeof globalThis.fetch;
}

export class OpenProjectError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export class OpenProjectClient {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly userCache = new Map<string, string>();

  constructor(private readonly options: OpenProjectClientOptions) {
    this.fetcher = options.fetch || globalThis.fetch;
  }

  private async request<T>(url: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Basic ${Buffer.from(`apikey:${this.options.apiKey}`).toString('base64')}`);
    headers.set('Accept', 'application/hal+json');
    if (init.body) headers.set('Content-Type', 'application/json');

    const targetUrl = new URL(url, this.options.baseUrl).toString();
    const response = await this.fetcher(targetUrl, { ...init, headers });
    if (!response.ok) {
      throw new OpenProjectError(response.status, `OpenProject request failed (${response.status})`);
    }
    return (await response.json()) as T;
  }

  async me(): Promise<OpenProjectUser> {
    return this.request<OpenProjectUser>('/api/v3/users/me');
  }

  async listProjects(): Promise<OpenProjectCollection<Record<string, unknown>>> {
    return this.request<OpenProjectCollection<Record<string, unknown>>>('/api/v3/projects?pageSize=100');
  }

  async listStatuses(): Promise<OpenProjectCollection<{ id: number; name: string; isClosed?: boolean }>> {
    return this.request<OpenProjectCollection<{ id: number; name: string; isClosed?: boolean }>>('/api/v3/statuses?pageSize=100');
  }

  async listWatched(statusIds: number[]): Promise<OpenProjectWorkPackage[]> {
    const out: OpenProjectWorkPackage[] = [];
    let page = 1;
    for (;;) {
      const filters = JSON.stringify([
        { assignee: { operator: '=', values: ['me'] } },
        { status: { operator: '=', values: statusIds.map(String) } },
      ]);
      if (!this.options.project) throw new Error('OpenProject project is required');

      const collection = await this.request<OpenProjectCollection<OpenProjectWorkPackage>>(
        `/api/v3/projects/${encodeURIComponent(this.options.project)}/work_packages?filters=${encodeURIComponent(filters)}&pageSize=100&offset=${page}&sortBy=${encodeURIComponent('[["id","asc"]]')}`,
      );
      const rows = collection._embedded?.elements || [];
      out.push(...rows);
      if (!rows.length || (collection.total != null && out.length >= Number(collection.total))) {
        return out;
      }
      page += 1;
    }
  }

  async getWorkPackage(id: number | string): Promise<OpenProjectWorkPackage> {
    return this.request<OpenProjectWorkPackage>(`/api/v3/work_packages/${encodeURIComponent(String(id))}`);
  }

  async listActivities(id: number | string): Promise<OpenProjectActivity[]> {
    const res = await this.request<OpenProjectCollection<OpenProjectActivity>>(
      `/api/v3/work_packages/${encodeURIComponent(String(id))}/activities`,
    );
    return res._embedded?.elements || [];
  }

  async getUserName(href: string): Promise<string> {
    if (!this.userCache.has(href)) {
      const user = await this.request<OpenProjectUser>(href);
      this.userCache.set(href, user.name || '');
    }
    return this.userCache.get(href)!;
  }

  async downloadAttachment(id: number | string): Promise<Response> {
    const headers = {
      Authorization: `Basic ${Buffer.from(`apikey:${this.options.apiKey}`).toString('base64')}`,
    };
    const response = await this.fetcher(
      new URL(`/api/v3/attachments/${encodeURIComponent(String(id))}/content`, this.options.baseUrl),
      { headers },
    );
    if (!response.ok) {
      throw new OpenProjectError(response.status, `OpenProject attachment failed (${response.status})`);
    }
    return response;
  }

  async addComment(id: number | string, markdown: string): Promise<OpenProjectActivity> {
    return this.request<OpenProjectActivity>(
      `/api/v3/work_packages/${encodeURIComponent(String(id))}/activities`,
      {
        method: 'POST',
        body: JSON.stringify({ comment: { raw: markdown } }),
      },
    );
  }

  async createWorkPackage(input: { project: string; subject: string; description: string }): Promise<OpenProjectWorkPackage> {
    return this.request<OpenProjectWorkPackage>('/api/v3/work_packages', {
      method: 'POST',
      body: JSON.stringify({
        subject: input.subject,
        description: { raw: input.description },
        _links: { project: { href: `/api/v3/projects/${encodeURIComponent(input.project)}` } },
      }),
    });
  }

  async setStatus(id: number | string, statusId: number | string): Promise<OpenProjectWorkPackage> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const wp = await this.getWorkPackage(id);
      try {
        return await this.request<OpenProjectWorkPackage>(
          `/api/v3/work_packages/${encodeURIComponent(String(id))}`,
          {
            method: 'PATCH',
            body: JSON.stringify({
              lockVersion: wp.lockVersion,
              _links: { status: { href: `/api/v3/statuses/${statusId}` } },
            }),
          },
        );
      } catch (error) {
        if (!(error instanceof OpenProjectError) || error.status !== 409 || attempt === 2) {
          throw error;
        }
      }
    }
    throw new Error('Failed to set status after retries');
  }
}
