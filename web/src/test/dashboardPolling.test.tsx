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

  it('benchmarks baseline and optimized dashboard hot paths with the same delayed SSE scenario', async () => {
    vi.useFakeTimers();
    const responseDelay = 6_000;
    type Profile = 'baseline' | 'optimized';
    type Metric = { spy: ReturnType<typeof vi.fn>; getMaxInFlight: () => number };
    type ScenarioResult = {
      totalRequests: number;
      taskRequests: number;
      maxInFlight: number;
      renderCommits: number;
      eventRenderCommits: number;
      acceptedSseEvents: number;
      reconnects: number;
    };

    const runScenario = async (profile: Profile): Promise<ScenarioResult> => {
      const makeTracked = <T,>(value: T): Metric => {
        let inFlight = 0;
        let maxInFlight = 0;
        const spy = vi.fn(() => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          return new Promise<T>((resolve) => setTimeout(() => {
            inFlight -= 1;
            resolve(value);
          }, responseDelay));
        });
        return { spy, getMaxInFlight: () => maxInFlight };
      };

      const metrics = {
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
      vi.spyOn(client, 'getStatus').mockImplementation(metrics.status.spy as any);
      vi.spyOn(client, 'getEventHistoryPage').mockImplementation(metrics.eventHistory.spy as any);
      vi.spyOn(client, 'getTasksPage').mockImplementation(metrics.tasks.spy as any);
      vi.spyOn(client, 'getProfiles').mockImplementation(metrics.profiles.spy as any);
      vi.spyOn(client, 'getClaudeQuota').mockImplementation(metrics.claudeQuota.spy as any);
      vi.spyOn(client, 'getBrain').mockImplementation(metrics.brain.spy as any);
      vi.spyOn(client, 'getClaudeFailover').mockImplementation(metrics.failover.spy as any);
      vi.spyOn(client, 'getOrphans').mockImplementation(metrics.orphans.spy as any);
      vi.spyOn(client, 'getProjects').mockImplementation(metrics.projects.spy as any);
      vi.spyOn(client, 'getPerf').mockImplementation(metrics.perf.spy as any);

      class BenchmarkEventSource {
        static instances: BenchmarkEventSource[] = [];
        onerror: (() => void) | null = null;
        onopen: (() => void) | null = null;
        listeners = new Map<string, (event: MessageEvent) => void>();
        constructor(public url: string) { BenchmarkEventSource.instances.push(this); }
        addEventListener(name: string, listener: EventListener) { this.listeners.set(name, listener as (event: MessageEvent) => void); }
        close() {}
      }
      const originalEventSource = window.EventSource;
      (window as any).EventSource = BenchmarkEventSource;
      setToken('benchmark-token');
      let renderCommits = 0;
      let acceptedSseEvents = 0;
      const unsubscribeTrace = sse.subscribeToEvents(() => { acceptedSseEvents += 1; });
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const view = render(
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <Profiler id={`dashboard-${profile}`} onRender={() => { renderCommits += 1; }}>
              <DashboardPage pollingProfile={profile} />
            </Profiler>
          </BrowserRouter>
        </QueryClientProvider>,
      );
      const cleanupSse = sse.connectSSE(queryClient, {
        deduplicateEvents: profile === 'optimized',
        coalesceInvalidations: profile === 'optimized',
      });

      await act(async () => { await vi.advanceTimersByTimeAsync(responseDelay); });
      const firstSource = BenchmarkEventSource.instances[0];
      expect(firstSource).toBeDefined();
      const rendersBeforeEvents = renderCommits;
      await act(async () => {
        for (let id = 1; id <= 20; id += 1) {
          firstSource.listeners.get('task.done')!({ lastEventId: String(id), data: JSON.stringify({ type: 'task.done', taskId: `p/t-${id}`, payload: {} }) } as MessageEvent);
        }
      });
      firstSource.onerror!();
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      const secondSource = BenchmarkEventSource.instances[1];
      expect(secondSource).toBeDefined();
      await act(async () => {
        for (let id = 1; id <= 20; id += 1) {
          secondSource.listeners.get('task.done')!({ lastEventId: String(id), data: JSON.stringify({ type: 'task.done', taskId: `p/t-${id}`, payload: {} }) } as MessageEvent);
        }
      });
      const eventRenderCommits = renderCommits - rendersBeforeEvents;
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });

      const metricValues = Object.values(metrics);
      const result = {
        totalRequests: metricValues.reduce((sum, metric) => sum + metric.spy.mock.calls.length, 0),
        taskRequests: metrics.tasks.spy.mock.calls.length,
        maxInFlight: Math.max(...metricValues.map((metric) => metric.getMaxInFlight())),
        renderCommits,
        eventRenderCommits,
        acceptedSseEvents,
        reconnects: BenchmarkEventSource.instances.length - 1,
      };
      cleanupSse();
      unsubscribeTrace();
      view.unmount();
      (window as any).EventSource = originalEventSource;
      vi.restoreAllMocks();
      vi.clearAllTimers();
      clearToken();
      return result;
    };

    const baseline = await runScenario('baseline');
    const optimized = await runScenario('optimized');
    console.info('dashboard hot-path benchmark', { baseline, optimized });

    expect(baseline.reconnects).toBe(1);
    expect(optimized.reconnects).toBe(1);
    expect(baseline.acceptedSseEvents).toBe(40);
    expect(optimized.acceptedSseEvents).toBe(20);
    expect(optimized.totalRequests).toBeLessThan(baseline.totalRequests);
    expect(optimized.taskRequests).toBeLessThan(baseline.taskRequests);
    expect(optimized.maxInFlight).toBeLessThan(baseline.maxInFlight);
    expect(optimized.renderCommits).toBeLessThan(baseline.renderCommits);
    expect(optimized.eventRenderCommits).toBeLessThan(baseline.eventRenderCommits);
  });
});
