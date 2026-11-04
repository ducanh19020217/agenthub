import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DashboardPage } from '../pages/DashboardPage';
import * as client from '../api/client';
import * as sse from '../api/sse';

describe('DashboardPage - Disk status display', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    vi.spyOn(sse, 'subscribeToEvents').mockImplementation(() => () => {});
  });

  it('hiển thị dung lượng trống và đổi màu khi còn dưới 5GB', async () => {
    vi.spyOn(client, 'getStatus').mockResolvedValue({
      tasks: { running: 0 },
      running: [],
      disk: {
        freeGB: 3.2,
        totalGB: 73.0,
      },
    } as any);

    render(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <DashboardPage />
        </BrowserRouter>
      </QueryClientProvider>
    );

    const diskBadge = await screen.findByTestId('disk-status');
    expect(diskBadge).toBeInTheDocument();
    expect(diskBadge).toHaveTextContent('Ổ đĩa: 3.2 / 73 GB trống');
    expect(diskBadge.className).toContain('text-[var(--t-warn)]');
  });

  it('dùng màu bình thường khi dung lượng trống >= 5GB', async () => {
    vi.spyOn(client, 'getStatus').mockResolvedValue({
      tasks: { running: 0 },
      running: [],
      disk: {
        freeGB: 15.0,
        totalGB: 73.0,
      },
    } as any);

    render(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <DashboardPage />
        </BrowserRouter>
      </QueryClientProvider>
    );

    const diskBadge = await screen.findByTestId('disk-status');
    expect(diskBadge).toBeInTheDocument();
    expect(diskBadge).toHaveTextContent('Ổ đĩa: 15 / 73 GB trống');
    expect(diskBadge.className).not.toContain('text-[var(--t-warn)]');
  });

  it('hiển thị ngưỡng minFreeGB khi có trường minFreeGB', async () => {
    vi.spyOn(client, 'getStatus').mockResolvedValue({
      tasks: { running: 0 },
      running: [],
      disk: {
        freeGB: 2.1,
        totalGB: 73.0,
        minFreeGB: 5.0,
      },
    } as any);

    render(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <DashboardPage />
        </BrowserRouter>
      </QueryClientProvider>
    );

    const diskBadge = await screen.findByTestId('disk-status');
    expect(diskBadge).toBeInTheDocument();
    expect(diskBadge).toHaveTextContent('Ổ đĩa: 2.1 / 73 GB trống (ngưỡng 5 GB)');
    expect(diskBadge.className).toContain('text-[var(--t-warn)]');
  });

  it('hiển thị banner cảnh báo đầu trang khi có task đang chờ vì đĩa', async () => {
    vi.spyOn(client, 'getStatus').mockResolvedValue({
      tasks: { running: 0, waiting_quota: 2 },
      waitingReasons: { disk: 2 },
      running: [],
      disk: { freeGB: 1.2, totalGB: 50.0, minFreeGB: 3.0 },
      disks: [
        { path: '/worktrees', label: 'Worktrees', freeGB: 1.2, totalGB: 50.0, minFreeGB: 3.0, low: true, source: 'worktrees' },
      ],
    } as any);

    render(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <DashboardPage />
        </BrowserRouter>
      </QueryClientProvider>
    );

    const banner = await screen.findByTestId('disk-blocking-banner');
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent('Tạm dừng dispatch: Hết dung lượng ổ đĩa');
    expect(banner).toHaveTextContent('2 task đang phải chờ vì hết dung lượng (Worktrees (1.2 GB / 3 GB))');
  });

  it('hiển thị banner cảnh báo đầu trang khi ổ hub home dưới ngưỡng', async () => {
    vi.spyOn(client, 'getStatus').mockResolvedValue({
      tasks: { running: 0 },
      waitingReasons: {},
      running: [],
      disk: { freeGB: 10.0, totalGB: 50.0, minFreeGB: 3.0 },
      disks: [
        { path: '/home/user/.agenthub', label: 'Dữ liệu hub (~/.agenthub)', freeGB: 0.4, totalGB: 20.0, minFreeGB: 1.0, low: true, source: 'hub_home' },
      ],
    } as any);

    render(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <DashboardPage />
        </BrowserRouter>
      </QueryClientProvider>
    );

    const banner = await screen.findByTestId('disk-blocking-banner');
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent('Tạm dừng dispatch: Hết dung lượng ổ đĩa');
    expect(banner).toHaveTextContent('Ổ chứa dữ liệu hub (~/.agenthub) sắp đầy. Toàn bộ dispatch bị tạm dừng.');
  });

  it('không hiển thị banner cảnh báo khi không bị chặn vì đĩa', async () => {
    vi.spyOn(client, 'getStatus').mockResolvedValue({
      tasks: { running: 0 },
      waitingReasons: {},
      running: [],
      disk: { freeGB: 10.0, totalGB: 50.0, minFreeGB: 3.0 },
      disks: [
        { path: '/worktrees', label: 'Worktrees', freeGB: 10.0, totalGB: 50.0, minFreeGB: 3.0, low: false, source: 'worktrees' },
      ],
    } as any);

    render(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <DashboardPage />
        </BrowserRouter>
      </QueryClientProvider>
    );

    await screen.findByTestId('disk-status');
    expect(screen.queryByTestId('disk-blocking-banner')).toBeNull();
  });
});
