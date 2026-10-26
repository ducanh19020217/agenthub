import { describe, it, expect, vi, afterEach } from 'vitest';
import { Profiler } from 'react';
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
    const getTasksPage = vi.spyOn(client, 'getTasksPage').mockResolvedValue({ items: [], total: 0, nextCursor: null });
    vi.spyOn(client, 'getProfiles').mockResolvedValue([]);
    vi.spyOn(client, 'getClaudeQuota').mockResolvedValue(null as any);
    vi.spyOn(client, 'getClaudeFailover').mockResolvedValue(null as any);
    vi.spyOn(client, 'getBrain').mockResolvedValue(null as any);
    vi.spyOn(client, 'getOrphans').mockResolvedValue([]);
    vi.spyOn(client, 'getProjects').mockResolvedValue([]);
    vi.spyOn(client, 'getPerf').mockResolvedValue(null as any);
    let eventCallback: sse.EventCallback | undefined;
    const subscribe = vi.spyOn(sse, 'subscribeToEvents').mockImplementation((callback) => {
      eventCallback = callback;
      return () => {};
    });
    let renderCommits = 0;

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <Profiler id="dashboard" onRender={() => { renderCommits += 1; }}>
            <DashboardPage />
          </Profiler>
        </BrowserRouter>
      </QueryClientProvider>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText('Tổng quan hệ thống')).toBeInTheDocument();
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(getEventHistoryPage).toHaveBeenCalledTimes(1);
    expect(getTasksPage).toHaveBeenCalledTimes(3);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(eventCallback).toBeDefined();

    const commitsBeforeReplay = renderCommits;
    await act(async () => {
      for (let index = 0; index < 10; index += 1) {
        eventCallback!({ id: 42, ts: '2026-10-26T09:00:00.000Z', type: 'task.done', taskId: 'p/t', payload: {} });
      }
    });
    expect(renderCommits - commitsBeforeReplay).toBe(1);

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
    expect(getTasksPage).toHaveBeenCalledTimes(9);

    const taskRequests = getTasksPage.mock.calls.map(([params]) => params?.status);
    expect(taskRequests).toEqual([
      'review', 'waiting_quota', 'queued',
      'review', 'waiting_quota', 'queued',
      'review', 'waiting_quota', 'queued',
    ]);
  });

  it('benchmarks the complete dashboard hot path against the previous cadence', async () => {
    vi.useFakeTimers();
    const calls = {
      status: vi.spyOn(client, 'getStatus').mockResolvedValue({ tasks: { running: 0 }, running: [] } as any),
      eventHistory: vi.spyOn(client, 'getEventHistoryPage').mockResolvedValue({ items: [], total: 0, nextCursor: null } as any),
      tasks: vi.spyOn(client, 'getTasksPage').mockResolvedValue({ items: [], total: 0, nextCursor: null }),
      profiles: vi.spyOn(client, 'getProfiles').mockResolvedValue([]),
      claudeQuota: vi.spyOn(client, 'getClaudeQuota').mockResolvedValue(null as any),
      brain: vi.spyOn(client, 'getBrain').mockResolvedValue(null as any),
      failover: vi.spyOn(client, 'getClaudeFailover').mockResolvedValue(null as any),
      orphans: vi.spyOn(client, 'getOrphans').mockResolvedValue([]),
      projects: vi.spyOn(client, 'getProjects').mockResolvedValue([]),
      perf: vi.spyOn(client, 'getPerf').mockResolvedValue(null as any),
    };
    let eventCallback: sse.EventCallback | undefined;
    vi.spyOn(sse, 'subscribeToEvents').mockImplementation((callback) => {
      eventCallback = callback;
      return () => {};
    });
    let renderCommits = 0;

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <Profiler id="dashboard-benchmark" onRender={() => { renderCommits += 1; }}>
            <DashboardPage />
          </Profiler>
        </BrowserRouter>
      </QueryClientProvider>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(eventCallback).toBeDefined();

    // Replay the same event stream shape that reconnect uses: each event is
    // delivered once, then once more through Last-Event-ID recovery.
    const commitsBeforeEvents = renderCommits;
    for (let id = 1; id <= 20; id += 1) {
      await act(async () => {
        eventCallback!({ id, ts: '2026-10-26T09:00:00.000Z', type: 'task.done', taskId: `p/t-${id}`, payload: {} });
      });
    }
    for (let id = 1; id <= 20; id += 1) {
      await act(async () => {
        eventCallback!({ id, ts: '2026-10-26T09:00:00.000Z', type: 'task.done', taskId: `p/t-${id}`, payload: {} });
      });
    }
    const eventRenderCommits = renderCommits - commitsBeforeEvents;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    const actualRequests = Object.fromEntries(Object.entries(calls).map(([name, spy]) => [name, spy.mock.calls.length]));
    const previousCadenceRequests = {
      status: 1 + Math.floor(60_000 / 5_000),
      eventHistory: 1 + Math.floor(60_000 / 10_000),
      profiles: 1 + Math.floor(60_000 / 30_000),
      claudeQuota: 1 + Math.floor(60_000 / 30_000),
      brain: 1 + Math.floor(60_000 / 5_000),
      failover: 1 + Math.floor(60_000 / 5_000),
      orphans: 1 + Math.floor(60_000 / 30_000),
      projects: 1 + Math.floor(60_000 / 30_000),
      perf: 1 + Math.floor(60_000 / 30_000),
      tasks: (1 + Math.floor(60_000 / 5_000)) * 3,
    };
    const previousTotal = Object.values(previousCadenceRequests).reduce((sum, count) => sum + count, 0);
    const actualTotal = Object.values(actualRequests).reduce((sum, count) => sum + count, 0);
    const previousEventRenderCommits = 40;

    expect(actualRequests).toEqual({
      status: 5,
      eventHistory: 3,
      profiles: 3,
      claudeQuota: 3,
      brain: 3,
      failover: 3,
      orphans: 3,
      projects: 3,
      perf: 3,
      tasks: 15,
    });
    expect(actualTotal).toBe(44);
    expect(previousTotal).toBe(100);
    expect(actualTotal).toBeLessThan(previousTotal);
    expect(eventRenderCommits).toBeLessThanOrEqual(21);
    expect(eventRenderCommits).toBeLessThan(previousEventRenderCommits);
  });
});
