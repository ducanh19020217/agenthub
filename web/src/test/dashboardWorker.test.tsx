import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DashboardPage } from '../pages/DashboardPage';
import * as client from '../api/client';
import * as sse from '../api/sse';

describe('DashboardPage - Worker display fallback', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    vi.spyOn(sse, 'subscribeToEvents').mockImplementation(() => () => {});
  });

  it('hiển thị title nếu worker có trường title, và fallback về taskId nếu không có', async () => {
    vi.spyOn(client, 'getStatus').mockResolvedValue({
      tasks: { running: 2 },
      running: [
        {
          taskId: 'XFarm/t-auth',
          projectId: 'XFarm',
          title: 'Tích hợp đăng nhập OAuth2',
          model: 'claude-sonnet-4-6',
          profileName: 'chinh',
          startedAt: new Date(Date.now() - 60000).toISOString(),
        },
        {
          taskId: 'AgentHub~t-backend-fix',
          projectId: 'AgentHub',
          // Không có title
          model: 'gemini-3.8-flash-high',
          profileName: 'g1',
          startedAt: new Date(Date.now() - 30000).toISOString(),
        },
      ],
    } as any);

    render(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <DashboardPage />
        </BrowserRouter>
      </QueryClientProvider>
    );

    // Chờ dữ liệu load
    expect(await screen.findByText('Tích hợp đăng nhập OAuth2')).toBeInTheDocument();
    expect(screen.getByText('AgentHub~t-backend-fix')).toBeInTheDocument();
    expect(screen.getByText('XFarm')).toBeInTheDocument();
    expect(screen.getByText('AgentHub')).toBeInTheDocument();
  });

  it('hiển thị nhãn cảnh báo "Chưa commit 50 phút" và "Lặp lệnh" khi worker bị stall hoặc loop', async () => {
    vi.spyOn(client, 'getStatus').mockResolvedValue({
      tasks: { running: 1 },
      running: [
        {
          taskId: 'xfarm/p7-acceptance',
          projectId: 'xfarm',
          title: 'Playwright spec',
          model: 'gemini-3.8-flash-high',
          profileName: 'g1',
          startedAt: new Date(Date.now() - 50 * 60000).toISOString(),
          noCommitMinutes: 50,
          isLooping: true,
        },
      ],
    } as any);

    render(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <DashboardPage />
        </BrowserRouter>
      </QueryClientProvider>
    );

    expect(await screen.findByText('Chưa commit 50 phút')).toBeInTheDocument();
    expect(screen.getByText('Lặp lệnh')).toBeInTheDocument();
  });

  it('hiển thị nút Tạm dừng và Tiếp tục cho worker, nhãn "Tạm dừng (quá tải)", và thông tin tài nguyên RSS/CPU', async () => {
    const pauseSpy = vi.spyOn(client, 'pauseTask').mockResolvedValue({ ok: true, paused: true });
    const resumeSpy = vi.spyOn(client, 'resumeTask').mockResolvedValue({ ok: true, paused: false });

    vi.spyOn(client, 'getStatus').mockResolvedValue({
      tasks: { running: 2 },
      running: [
        {
          taskId: 'XFarm/t-running',
          projectId: 'XFarm',
          title: 'Worker Active',
          model: 'claude-sonnet-4-6',
          profileName: 'chinh',
          startedAt: new Date(Date.now() - 60000).toISOString(),
          rss: 209715200,
          cpu: 25.4,
          paused: false,
        },
        {
          taskId: 'AgentHub/t-paused',
          projectId: 'AgentHub',
          title: 'Worker Overloaded',
          model: 'gemini-3.8-flash-high',
          profileName: 'g1',
          startedAt: new Date(Date.now() - 30000).toISOString(),
          paused: true,
          pauseReason: 'load',
          rss: 52428800,
          cpu: 0,
        },
      ],
    } as any);

    render(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <DashboardPage />
        </BrowserRouter>
      </QueryClientProvider>
    );

    expect(await screen.findByText('Worker Active')).toBeInTheDocument();
    expect(screen.getByText('200 MB')).toBeInTheDocument();
    expect(screen.getByText('25.4% CPU')).toBeInTheDocument();

    expect(screen.getByText('Worker Overloaded')).toBeInTheDocument();
    expect(screen.getByText('Tạm dừng (quá tải)')).toBeInTheDocument();

    const pauseBtns = screen.getAllByRole('button', { name: /^Tạm dừng$/i });
    fireEvent.click(pauseBtns[0]);
    await vi.waitFor(() => {
      expect(pauseSpy).toHaveBeenCalledWith('XFarm/t-running');
    });

    const resumeBtns = screen.getAllByRole('button', { name: /^Tiếp tục$/i });
    fireEvent.click(resumeBtns[0]);
    await vi.waitFor(() => {
      expect(resumeSpy).toHaveBeenCalledWith('AgentHub/t-paused');
    });
  });
});
