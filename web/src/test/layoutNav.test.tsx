import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Layout } from '../components/Layout';
import { LocaleProvider } from '../context/LocaleContext';
import { ThemeProvider } from '../context/ThemeContext';
import * as client from '../api/client';

function renderLayout(initialEntry = '/') {
  return render(
    <LocaleProvider initialLocale="vi">
      <ThemeProvider>
        <MemoryRouter initialEntries={[initialEntry]}>
          <Layout />
        </MemoryRouter>
      </ThemeProvider>
    </LocaleProvider>,
  );
}

describe('Layout Navigation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it('does not include "Phiên Claude" in the navigation sidebar', () => {
    renderLayout('/');

    // Check that Claude Sessions nav link is not in the sidebar navigation
    const nav = screen.getByRole('navigation');
    expect(nav).toBeInTheDocument();

    const claudeLink = screen.queryByRole('link', { name: /Phiên Claude/i });
    expect(claudeLink).toBeNull();

    // Verify other main links exist
    expect(screen.getByRole('link', { name: /Tổng quan/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Chat/i })).toBeNull();
    expect(screen.getByRole('link', { name: /Tài khoản/i })).toBeInTheDocument();
  });

  it('keeps page title when visiting /claude-sessions directly', () => {
    renderLayout('/claude-sessions');

    // Header title displays page title for /claude-sessions
    const headerTitle = screen.getByRole('heading', { level: 1 });
    expect(headerTitle).toHaveTextContent('Phiên Claude');
  });

  it('renders menu item as "Kế hoạch" and shows badge with number of draft batches', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    vi.spyOn(client, 'getBatches').mockResolvedValue([
      { id: 'b-1', status: 'draft' } as any,
      { id: 'b-2', status: 'draft' } as any,
    ]);

    render(
      <QueryClientProvider client={queryClient}>
        <LocaleProvider initialLocale="vi">
          <ThemeProvider>
            <MemoryRouter initialEntries={['/']}>
              <Layout />
            </MemoryRouter>
          </ThemeProvider>
        </LocaleProvider>
      </QueryClientProvider>,
    );

    const plansLink = screen.getByRole('link', { name: /Kế hoạch/i });
    expect(plansLink).toBeInTheDocument();
    expect(plansLink).toHaveAttribute('href', '/plans');

    // Badge shows 2 draft batches
    const badge = await screen.findByTestId('plans-sidebar-badge');
    expect(badge).toHaveTextContent('2');
  });

  it('hides badge when there are 0 draft batches', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    vi.spyOn(client, 'getBatches').mockResolvedValue([
      { id: 'b-1', status: 'dispatched' } as any,
    ]);

    render(
      <QueryClientProvider client={queryClient}>
        <LocaleProvider initialLocale="vi">
          <ThemeProvider>
            <MemoryRouter initialEntries={['/']}>
              <Layout />
            </MemoryRouter>
          </ThemeProvider>
        </LocaleProvider>
      </QueryClientProvider>,
    );

    const plansLink = screen.getByRole('link', { name: /Kế hoạch/i });
    expect(plansLink).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.queryByTestId('plans-sidebar-badge')).toBeNull();
    });
  });

  it('renders menu item as "Plans" in en locale', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    vi.spyOn(client, 'getBatches').mockResolvedValue([]);

    render(
      <QueryClientProvider client={queryClient}>
        <LocaleProvider initialLocale="en">
          <ThemeProvider>
            <MemoryRouter initialEntries={['/']}>
              <Layout />
            </MemoryRouter>
          </ThemeProvider>
        </LocaleProvider>
      </QueryClientProvider>,
    );

    const plansLink = screen.getByRole('link', { name: /Plans/i });
    expect(plansLink).toBeInTheDocument();
  });
});
