import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { apiFetch, API_REQUEST_TIMEOUT_MS, AuthError, clearToken, getTasksPage, setToken } from '../api/client';

describe('API Client', () => {
  const originalFetch = window.fetch;

  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    window.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('gắn header Authorization: Bearer <token> và Content-Type khi gửi request', async () => {
    setToken('valid_agent_token_999');

    let capturedHeaders: Headers | undefined;
    window.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const res = await apiFetch<{ ok: boolean }>('/api/test', {
      method: 'POST',
      body: JSON.stringify({ hello: 'world' }),
    });

    expect(res).toEqual({ ok: true });
    expect(capturedHeaders?.get('Authorization')).toBe('Bearer valid_agent_token_999');
    expect(capturedHeaders?.get('Content-Type')).toBe('application/json');
  });

  it('báo lỗi AuthError ngay lập tức khi thiếu token', async () => {
    clearToken();

    await expect(apiFetch('/api/test')).rejects.toThrow(AuthError);
  });

  it('xử lý 401: xóa token và throw AuthError khi API trả về 401 Unauthorized', async () => {
    setToken('expired_token_123');

    window.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(apiFetch('/api/protected')).rejects.toThrow(AuthError);
    expect(sessionStorage.getItem('agenthub_token')).toBeNull();
  });

  it('hủy request bị treo sau timeout để query không loading vô hạn', async () => {
    setToken('slow_token');
    vi.useFakeTimers();
    const fetchSpy = vi.fn((_url: URL | RequestInfo, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError')), { once: true });
    }));
    window.fetch = fetchSpy;

    const request = apiFetch('/api/slow').then(
      () => null,
      (error) => error,
    );
    await vi.advanceTimersByTimeAsync(API_REQUEST_TIMEOUT_MS);
    await expect(request).resolves.toMatchObject({ name: 'AbortError' });
    expect(fetchSpy).toHaveBeenCalledWith('/api/slow', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    vi.useRealTimers();
  });

  it('bọc phản hồi mảng cũ của /api/tasks thành một trang', async () => {
    setToken('legacy_token');
    window.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify([{ id: 'p/t', title: 'Legacy' }]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await expect(getTasksPage({ limit: 20 })).resolves.toEqual({
      items: [{ id: 'p/t', title: 'Legacy' }],
      total: 1,
      nextCursor: null,
    });
  });

  it('translates API error payload { error: "conflict", message: "..." } with code fallback when unmapped in EN', async () => {
    setToken('valid_token');

    // 1. Unmapped Vietnamese message with conflict code in EN
    localStorage.setItem('agenthub_locale', 'en');
    window.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'conflict', message: 'Xung đột phiên bản dữ liệu chưa có regex' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    let caughtErr: any;
    try {
      await apiFetch('/api/test-conflict');
    } catch (err) {
      caughtErr = err;
    }

    expect(caughtErr).toBeDefined();
    expect(caughtErr.message).toBe('Resource conflict');
    expect(caughtErr.code).toBe('conflict');
    expect(caughtErr.rawMessage).toBe('Xung đột phiên bản dữ liệu chưa có regex');

    // 2. Exact patterned merge message in EN
    window.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'conflict', message: 'Merge bị xung đột' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await expect(apiFetch('/api/test-conflict')).rejects.toThrow('Merge conflict');

    // 3. Same payload in VI retains Vietnamese message
    localStorage.setItem('agenthub_locale', 'vi');
    window.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'conflict', message: 'Xung đột phiên bản dữ liệu chưa có regex' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await expect(apiFetch('/api/test-conflict')).rejects.toThrow('Xung đột phiên bản dữ liệu chưa có regex');

    // 4. Raw error code payload without message translates in both locales
    localStorage.setItem('agenthub_locale', 'vi');
    window.fetch = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({ error: 'conflict' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await expect(apiFetch('/api/test-conflict')).rejects.toThrow('Xung đột dữ liệu');

    localStorage.setItem('agenthub_locale', 'en');
    await expect(apiFetch('/api/test-conflict')).rejects.toThrow('Resource conflict');

    // 5. Realistic payload with unaccented non-code message { error: "conflict", message: "Conflict occurred" }
    // translates according to error code in both EN and VI while preserving rawMessage
    localStorage.setItem('agenthub_locale', 'en');
    window.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'conflict', message: 'Conflict occurred' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    let caughtUnaccentedEn: any;
    try {
      await apiFetch('/api/test-conflict');
    } catch (err) {
      caughtUnaccentedEn = err;
    }
    expect(caughtUnaccentedEn?.message).toBe('Resource conflict');
    expect(caughtUnaccentedEn?.code).toBe('conflict');
    expect(caughtUnaccentedEn?.rawMessage).toBe('Conflict occurred');

    localStorage.setItem('agenthub_locale', 'vi');
    window.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'conflict', message: 'Conflict occurred' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    let caughtUnaccentedVi: any;
    try {
      await apiFetch('/api/test-conflict');
    } catch (err) {
      caughtUnaccentedVi = err;
    }
    expect(caughtUnaccentedVi?.message).toBe('Xung đột dữ liệu');
    expect(caughtUnaccentedVi?.code).toBe('conflict');
    expect(caughtUnaccentedVi?.rawMessage).toBe('Conflict occurred');
  });
});
