import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearToken, setToken } from '../api/client';
import { Layout } from '../components/Layout';
import { Branding, BrandingProvider } from '../context/BrandingContext';
import { LocaleProvider } from '../context/LocaleContext';
import { ThemeProvider } from '../context/ThemeContext';

function renderLayoutWithBranding(branding: Partial<Branding> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <LocaleProvider initialLocale="vi">
        <ThemeProvider>
          <BrandingProvider branding={branding}>
            <MemoryRouter initialEntries={['/']}>
              <Layout />
            </MemoryRouter>
          </BrandingProvider>
        </ThemeProvider>
      </LocaleProvider>
    </QueryClientProvider>,
  );
}

describe('Branding Logo Component in Layout', () => {
  const originalFetch = window.fetch;
  let createObjectURLSpy: any;
  let revokeObjectURLSpy: any;
  let urlCounter = 0;

  beforeEach(() => {
    sessionStorage.clear();
    setToken('auth_token_for_logo');
    urlCounter = 0;

    createObjectURLSpy = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
      urlCounter += 1;
      return `blob:http://localhost/logo-blob-${urlCounter}`;
    });
    revokeObjectURLSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  });

  afterEach(() => {
    window.fetch = originalFetch;
    createObjectURLSpy?.mockRestore();
    revokeObjectURLSpy?.mockRestore();
    clearToken();
    vi.restoreAllMocks();
  });

  it('gọi /api/branding/logo qua fetch có Authorization header và render <img src="blob:...">', async () => {
    let capturedUrl = '';
    let capturedHeaders: Headers | undefined;

    window.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedHeaders = new Headers(init?.headers);
      return new Response(new Blob(['<svg><circle r="10"/></svg>'], { type: 'image/svg+xml' }), {
        status: 200,
        headers: { 'Content-Type': 'image/svg+xml' },
      });
    });

    renderLayoutWithBranding({
      name: 'Custom Brand',
      shortName: 'CB',
      logo: 'logo.svg',
      logoVersion: 42,
    });

    // Chờ img với blob: URL xuất hiện
    await waitFor(() => {
      const img = screen.getByTestId('branding-logo');
      expect(img).toBeInTheDocument();
      expect(img).toHaveAttribute('src', 'blob:http://localhost/logo-blob-1');
    });

    expect(capturedUrl).toContain('/api/branding/logo?v=42');
    expect(capturedHeaders?.get('Authorization')).toBe('Bearer auth_token_for_logo');
  });

  it('khi fetch lỗi (401/500/mạng) thì fallback về icon Bot và không render thẻ img vỡ', async () => {
    window.fetch = vi.fn().mockImplementation(async () => {
      return new Response(JSON.stringify({ error: 'unauthorized', message: 'Token không hợp lệ' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const { container } = renderLayoutWithBranding({
      name: 'Broken Brand',
      shortName: 'BB',
      logo: 'logo.png',
      logoVersion: 1,
    });

    // Đợi fetch lỗi hoàn tất
    await waitFor(() => {
      expect(screen.queryByTestId('branding-logo')).not.toBeInTheDocument();
    });

    // Thẻ Bot icon (lucide-bot svg) được hiển thị
    const botIcon = container.querySelector('svg.lucide-bot');
    expect(botIcon).toBeInTheDocument();
  });

  it('khi chưa cấu hình logo thì hiển thị icon Bot mặc định mà không gọi /api/branding/logo', () => {
    const fetchSpy = vi.fn().mockImplementation(async () => {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    window.fetch = fetchSpy;

    const { container } = renderLayoutWithBranding({
      name: 'AgentHub',
      shortName: 'AH',
      logo: undefined,
    });

    expect(screen.queryByTestId('branding-logo')).not.toBeInTheDocument();
    const botIcon = container.querySelector('svg.lucide-bot');
    expect(botIcon).toBeInTheDocument();

    const logoCalls = fetchSpy.mock.calls.filter((call) => String(call[0]).includes('/api/branding/logo'));
    expect(logoCalls).toHaveLength(0);
  });

  it('thu hồi URL cũ khi logo hoặc logoVersion được cập nhật', async () => {
    window.fetch = vi.fn().mockImplementation(async () => {
      return new Response(new Blob(['logo-data'], { type: 'image/png' }), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      });
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <LocaleProvider initialLocale="vi">
          <ThemeProvider>
            <BrandingProvider branding={{ name: 'App', shortName: 'A', logo: 'logo.png', logoVersion: 1 }}>
              <MemoryRouter initialEntries={['/']}>
                <Layout />
              </MemoryRouter>
            </BrandingProvider>
          </ThemeProvider>
        </LocaleProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('branding-logo')).toHaveAttribute('src', 'blob:http://localhost/logo-blob-1');
    });

    // Rerender với logoVersion mới (sau khi upload)
    rerender(
      <QueryClientProvider client={queryClient}>
        <LocaleProvider initialLocale="vi">
          <ThemeProvider>
            <BrandingProvider branding={{ name: 'App', shortName: 'A', logo: 'logo.png', logoVersion: 2 }}>
              <MemoryRouter initialEntries={['/']}>
                <Layout />
              </MemoryRouter>
            </BrandingProvider>
          </ThemeProvider>
        </LocaleProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('branding-logo')).toHaveAttribute('src', 'blob:http://localhost/logo-blob-2');
    });

    expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:http://localhost/logo-blob-1');
  });
});
