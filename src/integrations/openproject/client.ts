export interface OpenProjectHalLink {
  href: string;
  title?: string;
}

export interface OpenProjectUser {
  id: number;
  name: string;
  email?: string;
}

export interface OpenProjectStatus {
  id: number;
  name: string;
  isClosed?: boolean;
  position?: number;
}

export interface OpenProjectType {
  id: number;
  name: string;
  position?: number;
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
  estimatedTime?: string | null;
  updatedAt?: string;
  createdAt?: string;
  _links?: {
    project?: OpenProjectHalLink;
    parent?: OpenProjectHalLink;
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

export interface OpenProjectTimeEntry {
  id: number;
  hours: string;
  spentOn: string;
  comment?: { raw?: string };
  _links?: { workPackage?: OpenProjectHalLink; activity?: OpenProjectHalLink; [key: string]: OpenProjectHalLink | undefined };
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
      let message = `OpenProject request failed (${response.status})`;
      try {
        const payload = await response.json() as { message?: unknown; _embedded?: { errors?: Array<{ message?: unknown }> } };
        const messages = [
          typeof payload.message === 'string' ? payload.message : null,
          ...(payload._embedded?.errors || []).map((item) => typeof item.message === 'string' ? item.message : null),
        ].filter((item): item is string => Boolean(item));
        if (messages.length) message = messages.join('; ');
      } catch {
        // Some OpenProject proxies return an empty/non-JSON error body.
      }
      throw new OpenProjectError(response.status, message);
    }
    return (await response.json()) as T;
  }

  async me(): Promise<OpenProjectUser> {
    return this.request<OpenProjectUser>('/api/v3/users/me');
  }

  async listProjects(): Promise<OpenProjectCollection<Record<string, unknown>>> {
    return this.request<OpenProjectCollection<Record<string, unknown>>>('/api/v3/projects?pageSize=100');
  }

  async listStatuses(): Promise<OpenProjectCollection<OpenProjectStatus>> {
    return this.request<OpenProjectCollection<OpenProjectStatus>>('/api/v3/statuses?pageSize=100');
  }

  async listTypes(): Promise<OpenProjectCollection<OpenProjectType>> {
    if (!this.options.project) throw new Error('OpenProject project is required');
    return this.request<OpenProjectCollection<OpenProjectType>>(`/api/v3/projects/${encodeURIComponent(this.options.project)}/types`);
  }

  private async listWorkPackagesWithFilters(filtersJson: string, sortBy = '[["id","asc"]]'): Promise<OpenProjectWorkPackage[]> {
    const out: OpenProjectWorkPackage[] = [];
    let page = 1;
    for (;;) {
      if (!this.options.project) throw new Error('OpenProject project is required');

      const collection = await this.request<OpenProjectCollection<OpenProjectWorkPackage>>(
        `/api/v3/projects/${encodeURIComponent(this.options.project)}/work_packages?filters=${encodeURIComponent(filtersJson)}&pageSize=100&offset=${page}&sortBy=${encodeURIComponent(sortBy)}`,
      );
      const rows = collection._embedded?.elements || [];
      out.push(...rows);
      if (!rows.length || (collection.total != null && out.length >= Number(collection.total))) {
        return out;
      }
      page += 1;
    }
  }

  async listWatched(statusIds: number[]): Promise<OpenProjectWorkPackage[]> {
    const filters = JSON.stringify([
      { assignee: { operator: '=', values: ['me'] } },
      { status: { operator: '=', values: statusIds.map(String) } },
    ]);
    return this.listWorkPackagesWithFilters(filters, '[["id","asc"]]');
  }

  async listAssignedWorkPackages(statusIds: number[]): Promise<OpenProjectWorkPackage[]> {
    if (!statusIds.length) return [];
    const filters = JSON.stringify([
      { assignee: { operator: '=', values: ['me'] } },
      { status: { operator: '=', values: statusIds.map(String) } },
    ]);
    return this.listWorkPackagesWithFilters(filters, '[["updatedAt","desc"]]');
  }

  async listUpdatedWorkPackages(start: string, end: string): Promise<OpenProjectWorkPackage[]> {
    const filters = JSON.stringify([
      { updatedAt: { operator: '<>d', values: [start, end] } },
    ]);
    return this.listWorkPackagesWithFilters(filters, '[["updatedAt","desc"]]');
  }

  async getWorkPackage(id: number | string): Promise<OpenProjectWorkPackage> {
    return this.request<OpenProjectWorkPackage>(`/api/v3/work_packages/${encodeURIComponent(String(id))}`);
  }

  async findWorkPackage(ref: number | string): Promise<OpenProjectWorkPackage | undefined> {
    if (!this.options.project) throw new Error('OpenProject project is required');
    const value = String(ref).trim();
    if (/^\d+$/.test(value)) {
      let wp: OpenProjectWorkPackage;
      try {
        wp = await this.getWorkPackage(value);
      } catch (error) {
        if (error instanceof OpenProjectError && error.status === 404) return undefined;
        throw error;
      }
      const project = wp._links?.project;
      if (!project) return wp;
      const projectRef = decodeURIComponent(project.href.split('/').pop() || '');
      return projectRef === this.options.project || project.title === this.options.project ? wp : undefined;
    }
    const rows = await this.listWorkPackagesWithFilters('[]');
    return rows.find((item) => item.displayId?.toLowerCase() === value.toLowerCase());
  }

  async listActivities(id: number | string): Promise<OpenProjectActivity[]> {
    const res = await this.request<OpenProjectCollection<OpenProjectActivity>>(
      `/api/v3/work_packages/${encodeURIComponent(String(id))}/activities`,
    );
    return res._embedded?.elements || [];
  }

  async listTimeEntryActivities(): Promise<Array<{ id: number; name: string }>> {
    const result = await this.request<OpenProjectCollection<{ id: number; name: string }>>('/api/v3/time_entries/activities?pageSize=100');
    return (result._embedded?.elements || []).map((item) => ({ id: item.id, name: item.name }));
  }

  async createTimeEntry(input: { hours: string; spentOn: string; comment: string; workPackageId: number; activityId: number }): Promise<OpenProjectTimeEntry> {
    return this.request<OpenProjectTimeEntry>('/api/v3/time_entries', { method: 'POST', body: JSON.stringify({
      hours: input.hours, spentOn: input.spentOn, comment: { raw: input.comment },
      _links: { workPackage: { href: `/api/v3/work_packages/${input.workPackageId}` }, activity: { href: `/api/v3/time_entries/activities/${input.activityId}` } },
    }) });
  }

  async updateTimeEntry(id: number, input: { hours: string; spentOn: string; comment: string; workPackageId: number; activityId: number }): Promise<OpenProjectTimeEntry> {
    return this.request<OpenProjectTimeEntry>(`/api/v3/time_entries/${id}`, { method: 'PATCH', body: JSON.stringify({
      hours: input.hours, spentOn: input.spentOn, comment: { raw: input.comment },
      _links: { workPackage: { href: `/api/v3/work_packages/${input.workPackageId}` }, activity: { href: `/api/v3/time_entries/activities/${input.activityId}` } },
    }) });
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

  async setParent(id: number | string, parentId: number | string | null): Promise<OpenProjectWorkPackage> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const wp = await this.getWorkPackage(id);
      try {
        return await this.request<OpenProjectWorkPackage>(
          `/api/v3/work_packages/${encodeURIComponent(String(id))}`,
          {
            method: 'PATCH',
            body: JSON.stringify({
              lockVersion: wp.lockVersion,
              _links: { parent: parentId === null ? null : { href: `/api/v3/work_packages/${parentId}` } },
            }),
          },
        );
      } catch (error) {
        if (!(error instanceof OpenProjectError) || error.status !== 409 || attempt === 2) throw error;
      }
    }
    throw new Error('Failed to set parent after retries');
  }

  async createWorkPackage(input: {
    subject: string;
    descriptionMarkdown: string;
    typeId?: number;
    parentId?: number;
    assigneeMe?: boolean;
    statusId?: number;
  }): Promise<{ id: number; displayId: string; url: string }> {
    if (!this.options.project) throw new Error('OpenProject project is required');
    const links: Record<string, { href: string }> = {};
    if (input.typeId !== undefined) links.type = { href: `/api/v3/types/${input.typeId}` };
    if (input.assigneeMe !== false) {
      const me = await this.me();
      links.assignee = { href: `/api/v3/users/${me.id}` };
    }
    if (input.parentId !== undefined) links.parent = { href: `/api/v3/work_packages/${input.parentId}` };
    if (input.statusId !== undefined) links.status = { href: `/api/v3/statuses/${input.statusId}` };
    const created = await this.request<OpenProjectWorkPackage>('/api/v3/projects/' + encodeURIComponent(this.options.project) + '/work_packages', {
      method: 'POST',
      body: JSON.stringify({
        subject: input.subject,
        description: { format: 'markdown', raw: input.descriptionMarkdown },
        _links: links,
      }),
    });
    return {
      id: created.id,
      displayId: created.displayId || String(created.id),
      url: `${this.options.baseUrl.replace(/\/+$/, '')}/work_packages/${created.id}`,
    };
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

  /**
   * Ghi estimatedTime lên work package. Retry tối đa 3 lần khi gặp 409.
   * Trả về work package mới nhất (có estimatedTime thực tế từ server).
   * Ném lỗi nếu 422 hoặc lỗi khác.
   */
  async setEstimate(id: number | string, isoDuration: string): Promise<OpenProjectWorkPackage> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const wp = await this.getWorkPackage(id);
      try {
        return await this.request<OpenProjectWorkPackage>(
          `/api/v3/work_packages/${encodeURIComponent(String(id))}`,
          {
            method: 'PATCH',
            body: JSON.stringify({ lockVersion: wp.lockVersion, estimatedTime: isoDuration }),
          },
        );
      } catch (error) {
        if (!(error instanceof OpenProjectError) || error.status !== 409 || attempt === 2) throw error;
      }
    }
    throw new Error('Failed to set estimate after retries');
  }
}
