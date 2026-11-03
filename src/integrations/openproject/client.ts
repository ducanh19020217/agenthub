export interface OpenProjectClientOptions { baseUrl: string; apiKey: string; project?: string; fetch?: typeof globalThis.fetch }

export class OpenProjectError extends Error { constructor(public status: number, message: string) { super(message); } }

export class OpenProjectClient {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly userCache = new Map<string, string>();
  constructor(private readonly options: OpenProjectClientOptions) { this.fetcher = options.fetch || globalThis.fetch; }
  private async request<T>(url: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Basic ${Buffer.from(`apikey:${this.options.apiKey}`).toString('base64')}`);
    headers.set('Accept', 'application/hal+json');
    if (init.body) headers.set('Content-Type', 'application/json');
    const response = await this.fetcher(new URL(url, this.options.baseUrl).toString(), { ...init, headers });
    if (!response.ok) throw new OpenProjectError(response.status, `OpenProject request failed (${response.status})`);
    return await response.json() as T;
  }
  async me(): Promise<{ id: number; name: string }> { return this.request('/api/v3/users/me'); }
  async listWatched(statusIds: number[]): Promise<any[]> {
    const out: any[] = []; let offset = 1;
    for (;;) {
      const filters = JSON.stringify([{ assignee: { operator: '=', values: ['me'] } }, { status: { operator: '=', values: statusIds.map(String) } }]);
      if (!this.options.project) throw new Error('OpenProject project is required');
      const page = await this.request<any>(`/api/v3/projects/${encodeURIComponent(this.options.project)}/work_packages?filters=${encodeURIComponent(filters)}&pageSize=100&offset=${offset}&sortBy=${encodeURIComponent('[["id","asc"]]')}`);
      const rows = page?._embedded?.elements || []; out.push(...rows);
      if (!rows.length || out.length >= Number(page.total || 0)) return out;
      offset += rows.length;
    }
  }
  async getWorkPackage(id: number | string): Promise<any> { return this.request(`/api/v3/work_packages/${encodeURIComponent(String(id))}`); }
  async listActivities(id: number | string): Promise<any[]> { return (await this.request<any>(`/api/v3/work_packages/${encodeURIComponent(String(id))}/activities`))._embedded?.elements || []; }
  async getUserName(href: string): Promise<string> { if (!this.userCache.has(href)) this.userCache.set(href, (await this.request<any>(href)).name || ''); return this.userCache.get(href)!; }
  async downloadAttachment(id: number | string): Promise<Response> {
    const headers = { Authorization: `Basic ${Buffer.from(`apikey:${this.options.apiKey}`).toString('base64')}` };
    const response = await this.fetcher(new URL(`/api/v3/attachments/${encodeURIComponent(String(id))}/content`, this.options.baseUrl), { headers });
    if (!response.ok) throw new OpenProjectError(response.status, `OpenProject attachment failed (${response.status})`); return response;
  }
  async addComment(id: number | string, markdown: string): Promise<any> { return this.request(`/api/v3/work_packages/${encodeURIComponent(String(id))}/activities`, { method: 'POST', body: JSON.stringify({ comment: { raw: markdown } }) }); }
  async setStatus(id: number | string, statusId: number | string): Promise<any> {
    for (let attempt = 0; attempt < 3; attempt++) { const wp = await this.getWorkPackage(id); try { return await this.request(`/api/v3/work_packages/${encodeURIComponent(String(id))}`, { method: 'PATCH', body: JSON.stringify({ lockVersion: wp.lockVersion, _links: { status: { href: `/api/v3/statuses/${statusId}` } } }) }); } catch (error) { if (!(error instanceof OpenProjectError) || error.status !== 409 || attempt === 2) throw error; } }
  }
}
