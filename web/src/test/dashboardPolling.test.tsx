import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DashboardPage } from '../pages/DashboardPage';
import * as client from '../api/client';
import * as sse from '../api/sse';

describe('Dashboard polling and SSE recovery', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not duplicate status requests and keeps the recovery poll at 15s', async () => {
    vi.useFakeTimers();
    const getStatus = vi.spyOn(client, 'getStatus').mockResolvedValue({ tasks: { running: 0 }, running: [] } as any);
    const getEventHistoryPage = vi.spyOn(client, 'getEventHistoryPage').mockResolvedValue({ items: [], total: 0, nextCursor: null } as any);
    vi.spyOn(client, 'getProfiles').mockResolvedValue([]);
    vi.spyOn(client, 'getClaudeQuota').mockResolvedValue(null as any);
    vi.spyOn(client, 'getClaudeFailover').mockResolvedValue(null as any);
    vi.spyOn(client, 'getBrain').mockResolvedValue(null as any);
    vi.spyOn(client, 'getOrphans').mockResolvedValue([]);
    vi.spyOn(client, 'getProjects').mockResolvedValue([]);
    vi.spyOn(client, 'getPerf').mockResolvedValue(null as any);
    const subscribe = vi.spyOn(sse, 'subscribeToEvents').mockImplementation(() => () => {});

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <DashboardPage />
        </BrowserRouter>
      </QueryClientProvider>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText('Tổng quan hệ thống')).toBeInTheDocument();
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(getEventHistoryPage).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(14_999);
    });
    expect(getStatus).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(getStatus).toHaveBeenCalledTimes(2);
    expect(getEventHistoryPage).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(getStatus).toHaveBeenCalledTimes(3);
    expect(getEventHistoryPage).toHaveBeenCalledTimes(2);
  });
});
