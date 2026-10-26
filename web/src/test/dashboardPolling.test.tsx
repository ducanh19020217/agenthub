import { describe, it, expect, vi, afterEach } from 'vitest';
import { Profiler } from 'react';
import { act, render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DashboardPage } from '../pages/DashboardPage';
import * as client from '../api/client';
import * as sse from '../api/sse';
import { clearToken, setToken } from '../api/client';

describe('Dashboard polling and SSE recovery', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    clearToken();
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
    const responseDelay = 100;
    const makeTracked = <T,>(value: T) => {
      let inFlight = 0;
      let maxInFlight = 0;
      const spy = vi.fn((..._args: unknown[]) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise<T>((resolve) => {
          setTimeout(() => {
            inFlight -= 1;
            resolve(value);
          }, responseDelay);
        });
      });
      return { spy, getMaxInFlight: () => maxInFlight };
    };

    const baseline = {
      status: makeTracked({ tasks: { running: 0 }, running: [] }),
      eventHistory: makeTracked({ items: [], total: 0, nextCursor: null }),
      tasks: makeTracked({ items: [], total: 0, nextCursor: null }),
      profiles: makeTracked([]),
      claudeQuota: makeTracked(null),
      brain: makeTracked(null),
      failover: makeTracked(null),
      orphans: makeTracked([]),
      projects: makeTracked([]),
      perf: makeTracked(null),
    };
    vi.spyOn(client, 'getStatus').mockImplementation(baseline.status.spy as any);
    vi.spyOn(client, 'getEventHistoryPage').mockImplementation(baseline.eventHistory.spy as any);
    vi.spyOn(client, 'getTasksPage').mockImplementation(baseline.tasks.spy as any);
    vi.spyOn(client, 'getProfiles').mockImplementation(baseline.profiles.spy as any);
    vi.spyOn(client, 'getClaudeQuota').mockImplementation(baseline.claudeQuota.spy as any);
    vi.spyOn(client, 'getBrain').mockImplementation(baseline.brain.spy as any);
    vi.spyOn(client, 'getClaudeFailover').mockImplementation(baseline.failover.spy as any);
    vi.spyOn(client, 'getOrphans').mockImplementation(baseline.orphans.spy as any);
    vi.spyOn(client, 'getProjects').mockImplementation(baseline.projects.spy as any);
    vi.spyOn(client, 'getPerf').mockImplementation(baseline.perf.spy as any);

    const baselineIntervals = [
      [baseline.status.spy, 5_000], [baseline.eventHistory.spy, 10_000],
      [baseline.profiles.spy, 30_000], [baseline.claudeQuota.spy, 30_000],
      [baseline.brain.spy, 5_000], [baseline.failover.spy, 5_000],
      [baseline.orphans.spy, 30_000], [baseline.projects.spy, 30_000],
      [baseline.perf.spy, 30_000],
    ] as const;
    const baselineTimers = baselineIntervals.map(([fn, interval]) => {
      fn();
      return setInterval(fn, interval);
    });
    for (const interval of [5_000, 15_000]) {
      for (const status of ['review', 'waiting_quota', 'queued']) {
        const timer = setInterval(() => baseline.tasks.spy({ status }), interval);
        baselineTimers.push(timer as any);
        baseline.tasks.spy({ status });
      }
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    const baselineRequests = {
      total: Object.values(baseline).reduce((sum, metric) => sum + metric.spy.mock.calls.length, 0),
      duplicates: baseline.tasks.spy.mock.calls.length - new Set(baseline.tasks.spy.mock.calls.map(([params]) => JSON.stringify(params))).size,
      maxInFlight: Math.max(...Object.values(baseline).map((metric) => metric.getMaxInFlight())),
    };
    baselineTimers.forEach(clearInterval);

    vi.clearAllMocks();
    const optimized = {
      status: makeTracked({ tasks: { running: 0 }, running: [] }),
      eventHistory: makeTracked({ items: [], total: 0, nextCursor: null }),
      tasks: makeTracked({ items: [], total: 0, nextCursor: null }),
      profiles: makeTracked([]),
      claudeQuota: makeTracked(null),
      brain: makeTracked(null),
      failover: makeTracked(null),
      orphans: makeTracked([]),
      projects: makeTracked([]),
      perf: makeTracked(null),
    };
    vi.mocked(client.getStatus).mockImplementation(optimized.status.spy as any);
    vi.mocked(client.getEventHistoryPage).mockImplementation(optimized.eventHistory.spy as any);
    vi.mocked(client.getTasksPage).mockImplementation(optimized.tasks.spy as any);
    vi.mocked(client.getProfiles).mockImplementation(optimized.profiles.spy as any);
    vi.mocked(client.getClaudeQuota).mockImplementation(optimized.claudeQuota.spy as any);
    vi.mocked(client.getBrain).mockImplementation(optimized.brain.spy as any);
    vi.mocked(client.getClaudeFailover).mockImplementation(optimized.failover.spy as any);
    vi.mocked(client.getOrphans).mockImplementation(optimized.orphans.spy as any);
    vi.mocked(client.getProjects).mockImplementation(optimized.projects.spy as any);
    vi.mocked(client.getPerf).mockImplementation(optimized.perf.spy as any);

    class BenchmarkEventSource {
      static instances: BenchmarkEventSource[] = [];
      onerror: (() => void) | null = null;
      onopen: (() => void) | null = null;
      listeners = new Map<string, (event: MessageEvent) => void>();
      closed = false;
      constructor(public url: string) { BenchmarkEventSource.instances.push(this); }
      addEventListener(name: string, listener: EventListener) { this.listeners.set(name, listener as (event: MessageEvent) => void); }
      close() { this.closed = true; }
    }
    const originalEventSource = window.EventSource;
    (window as any).EventSource = BenchmarkEventSource;
    setToken('benchmark-token');
    let renderCommits = 0;
    const receivedEvents: number[] = [];
    const unsubscribeTrace = sse.subscribeToEvents((event) => receivedEvents.push(event.id));

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <Profiler id="dashboard-benchmark" onRender={() => { renderCommits += 1; }}>
            <DashboardPage />
          </Profiler>
        </BrowserRouter>
      </QueryClientProvider>,
    );
    const cleanupSse = sse.connectSSE(queryClient);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(responseDelay);
    });
    const firstSource = BenchmarkEventSource.instances[0];
    expect(firstSource).toBeDefined();
    const rendersBeforeEvents = renderCommits;
    await act(async () => {
      for (let id = 1; id <= 20; id += 1) {
        firstSource.listeners.get('task.done')!({ lastEventId: String(id), data: JSON.stringify({ type: 'task.done', taskId: `p/t-${id}`, payload: {} }) } as MessageEvent);
      }
    });
    const eventRenderCommits = renderCommits - rendersBeforeEvents;
    firstSource.onerror!();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    const secondSource = BenchmarkEventSource.instances[1];
    await act(async () => {
      for (let id = 1; id <= 20; id += 1) {
        secondSource.listeners.get('task.done')!({ lastEventId: String(id), data: JSON.stringify({ type: 'task.done', taskId: `p/t-${id}`, payload: {} }) } as MessageEvent);
      }
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    const optimizedRequests = {
      total: Object.values(optimized).reduce((sum, metric) => sum + metric.spy.mock.calls.length, 0),
      duplicates: optimized.tasks.spy.mock.calls.length - new Set(optimized.tasks.spy.mock.calls.map(([params]) => JSON.stringify(params))).size,
      maxInFlight: Math.max(...Object.values(optimized).map((metric) => metric.getMaxInFlight())),
      renders: renderCommits,
      eventRenders: eventRenderCommits,
      acceptedSseEvents: receivedEvents.length,
    };
    console.info('dashboard hot-path benchmark', { baselineRequests, optimizedRequests });
    expect(optimizedRequests.total).toBeLessThan(baselineRequests.total);
    expect(optimizedRequests.duplicates).toBeLessThan(baselineRequests.duplicates);
    expect(optimizedRequests.maxInFlight).toBeLessThanOrEqual(baselineRequests.maxInFlight);
    expect(optimizedRequests.renders).toBeGreaterThan(0);
    expect(optimizedRequests.acceptedSseEvents).toBe(20);
    expect(optimizedRequests.eventRenders).toBeLessThanOrEqual(1);
    cleanupSse();
    unsubscribeTrace();
    view.unmount();
    (window as any).EventSource = originalEventSource;
  });
});
