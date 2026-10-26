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
    type RequestTrace = { endpoint: string; key: string; start: number; end: number; source: 'initial' | 'poll' | 'sse'; sseEventId?: number };
    type Metric = { spy: ReturnType<typeof vi.fn>; getMaxInFlight: () => number };
    type ScenarioResult = {
      totalRequests: number;
      taskRequests: number;
      maxInFlight: number;
      overlapByEndpoint: Record<string, number>;
      overlapByKey: Record<string, number>;
      requestCountByKey: Record<string, number>;
      sseRequestsByKey: Record<string, number>;
      invalidationCountByKey: Record<string, number>;
      renderCommits: number;
      eventRenderCommits: number;
      dashboardEvents: number;
      reconnects: number;
      traceByKey: Record<string, Array<{ source: string; overlap: boolean; sseEventId?: number }>>;
      traceSummaryByKey: Record<string, { requests: number; overlaps: number; sources: Record<string, number>; sseEventIds: number[] }>;
    };

    const runScenario = async (profile: Profile): Promise<ScenarioResult> => {
      const requestTrace: RequestTrace[] = [];
      const invalidationCountByKey: Record<string, number> = {};
      const pendingSseCausesByKey = new Map<string, number[]>();
      const recordSseInvalidation = (key: string, eventId: number) => {
        let causes = pendingSseCausesByKey.get(key);
        if (!causes) {
          causes = [];
          pendingSseCausesByKey.set(key, causes);
        }
        causes.push(eventId);
      };
      const makeTracked = <T,>(value: T): Metric => {
        let inFlight = 0;
        let maxInFlight = 0;
        const spy = vi.fn(() => {
          const call = spy.mock.calls.at(-1) as unknown[] | undefined;
          const endpoint = String((spy as any).__endpoint);
          const params = call?.[0] as { status?: string } | undefined;
          const key = endpoint === 'tasks' ? `${endpoint}:${params?.status || 'all'}` : endpoint;
          const start = Date.now();
          const sseCauses = pendingSseCausesByKey.get(key);
          const sseEventId = sseCauses?.shift();
          const trace: RequestTrace = {
            endpoint,
            key,
            start,
            end: 0,
            source: sseEventId === undefined ? (start === 0 ? 'initial' : 'poll') : 'sse',
            sseEventId,
          };
          requestTrace.push(trace);
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          return new Promise<T>((resolve) => setTimeout(() => {
            inFlight -= 1;
            trace.end = Date.now();
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
      for (const [endpoint, metric] of Object.entries(metrics)) (metric.spy as any).__endpoint = endpoint;
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
      const dashboardEventIds: number[] = [];
      const originalSubscribe = sse.subscribeToEvents;
      vi.spyOn(sse, 'subscribeToEvents').mockImplementation((callback) => originalSubscribe((event) => {
        dashboardEventIds.push(event.id);
        callback(event);
      }));
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const originalInvalidate = queryClient.invalidateQueries.bind(queryClient);
      const onInvalidation = (queryKey: readonly unknown[], eventId: number) => {
        const root = String(queryKey[0]);
        const keys = root === 'tasks' ? ['tasks:review', 'tasks:waiting_quota', 'tasks:queued'] : [root];
        for (const key of keys) {
          invalidationCountByKey[key] = (invalidationCountByKey[key] || 0) + 1;
          recordSseInvalidation(key, eventId);
        }
      };
      vi.spyOn(queryClient, 'invalidateQueries').mockImplementation((filters) => {
        return originalInvalidate(filters);
      });
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
        onInvalidation,
      });

      await act(async () => { await vi.advanceTimersByTimeAsync(responseDelay); });
      const firstSource = BenchmarkEventSource.instances[0];
      expect(firstSource).toBeDefined();
      const rendersBeforeEvents = renderCommits;
      const emitBatch = async (source: BenchmarkEventSource, ids: number[]) => {
        await act(async () => {
          for (const id of ids) {
            source.listeners.get('task.done')!({ lastEventId: String(id), data: JSON.stringify({ type: 'task.done', taskId: `p/t-${id}`, payload: {} }) } as MessageEvent);
          }
          await vi.runAllTicks();
        });
      };
      await emitBatch(firstSource, Array.from({ length: 20 }, (_, index) => index + 1));
      firstSource.onerror!();
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      const secondSource = BenchmarkEventSource.instances[1];
      expect(secondSource).toBeDefined();
      await emitBatch(secondSource, Array.from({ length: 20 }, (_, index) => index + 1));
      const eventRenderCommits = renderCommits - rendersBeforeEvents;
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });

      const metricValues = Object.values(metrics);
      const overlapByEndpoint: Record<string, number> = {};
      const overlapByKey: Record<string, number> = {};
      const requestCountByKey: Record<string, number> = {};
      for (const trace of requestTrace) {
        requestCountByKey[trace.key] = (requestCountByKey[trace.key] || 0) + 1;
        const overlaps = requestTrace.filter((other) => other !== trace
          && other.key === trace.key
          && other.start < trace.end
          && trace.start < other.end).length;
        if (overlaps > 0) {
          overlapByEndpoint[trace.endpoint] = (overlapByEndpoint[trace.endpoint] || 0) + 1;
          overlapByKey[trace.key] = (overlapByKey[trace.key] || 0) + 1;
        }
      }
      const sseRequestsByKey: Record<string, number> = {};
      const traceByKey: Record<string, Array<{ source: string; overlap: boolean; sseEventId?: number }>> = {};
      for (const trace of requestTrace) {
        const overlaps = requestTrace.some((other) => other !== trace
          && other.key === trace.key
          && other.start < trace.end
          && trace.start < other.end);
        (traceByKey[trace.key] ||= []).push({ source: trace.source, overlap: overlaps, sseEventId: trace.sseEventId });
        if (trace.source === 'sse') sseRequestsByKey[trace.key] = (sseRequestsByKey[trace.key] || 0) + 1;
      }
      const traceSummaryByKey: ScenarioResult['traceSummaryByKey'] = {};
      for (const [key, traces] of Object.entries(traceByKey)) {
        traceSummaryByKey[key] = {
          requests: traces.length,
          overlaps: traces.filter((trace) => trace.overlap).length,
          sources: traces.reduce<Record<string, number>>((counts, trace) => {
            counts[trace.source] = (counts[trace.source] || 0) + 1;
            return counts;
          }, {}),
          sseEventIds: traces.flatMap((trace) => trace.sseEventId === undefined ? [] : [trace.sseEventId]),
        };
      }
      const result = {
        totalRequests: metricValues.reduce((sum, metric) => sum + metric.spy.mock.calls.length, 0),
        taskRequests: metrics.tasks.spy.mock.calls.length,
        maxInFlight: Math.max(...metricValues.map((metric) => metric.getMaxInFlight())),
        overlapByEndpoint,
        overlapByKey,
        requestCountByKey,
        sseRequestsByKey,
        invalidationCountByKey,
        renderCommits,
        eventRenderCommits,
        dashboardEvents: dashboardEventIds.length,
        reconnects: BenchmarkEventSource.instances.length - 1,
        traceByKey,
        traceSummaryByKey,
      };
      cleanupSse();
      view.unmount();
      (window as any).EventSource = originalEventSource;
      vi.restoreAllMocks();
      vi.clearAllTimers();
      clearToken();
      return result;
    };

    const baseline = await runScenario('baseline');
    const optimized = await runScenario('optimized');
    console.info('dashboard hot-path benchmark', JSON.stringify({
      baseline: { ...baseline, traceByKey: baseline.traceSummaryByKey },
      optimized: { ...optimized, traceByKey: optimized.traceSummaryByKey },
    }));

    expect(baseline.reconnects).toBe(1);
    expect(optimized.reconnects).toBe(1);
    expect(baseline.dashboardEvents).toBe(40);
    expect(optimized.dashboardEvents).toBe(20);
    expect(optimized.totalRequests).toBeLessThan(baseline.totalRequests);
    expect(optimized.taskRequests).toBeLessThan(baseline.taskRequests);
    expect(optimized.maxInFlight).toBeLessThan(baseline.maxInFlight);
    expect(baseline.overlapByEndpoint.status).toBeGreaterThan(0);
    expect(optimized.overlapByEndpoint.status || 0).toBe(0);
    expect(optimized.overlapByEndpoint.tasks || 0).toBe(0);
    expect(optimized.overlapByEndpoint.eventHistory || 0).toBe(0);
    for (const status of ['review', 'waiting_quota', 'queued']) {
      const key = `tasks:${status}`;
      expect(baseline.requestCountByKey[key]).toBeGreaterThan(optimized.requestCountByKey[key]);
      expect(baseline.requestCountByKey[key]).toBeGreaterThan(1);
    }
    expect(baseline.sseRequestsByKey.status || 0).toBeGreaterThan(0);
    expect(baseline.sseRequestsByKey['tasks:review'] || 0).toBeGreaterThan(0);
    expect(baseline.sseRequestsByKey['tasks:waiting_quota'] || 0).toBeGreaterThan(0);
    expect(baseline.sseRequestsByKey['tasks:queued'] || 0).toBeGreaterThan(0);
    expect(optimized.sseRequestsByKey.status || 0).toBeGreaterThan(0);
    expect(optimized.sseRequestsByKey['tasks:review'] || 0).toBeGreaterThan(0);
    expect(optimized.sseRequestsByKey['tasks:waiting_quota'] || 0).toBeGreaterThan(0);
    expect(optimized.sseRequestsByKey['tasks:queued'] || 0).toBeGreaterThan(0);
    const causalKeys = ['status', 'tasks:review', 'tasks:waiting_quota', 'tasks:queued'];
    const allHotPathKeys = [...causalKeys, 'eventHistory'];
    for (const key of causalKeys) {
      const baselineTrace = baseline.traceSummaryByKey[key];
      const optimizedTrace = optimized.traceSummaryByKey[key];
      expect(baselineTrace.sseEventIds.length).toBe(baseline.sseRequestsByKey[key]);
      expect(optimizedTrace.sseEventIds.length).toBe(optimized.sseRequestsByKey[key]);
      expect(baselineTrace.sseEventIds.every((id) => baseline.dashboardEvents >= id)).toBe(true);
      expect(optimizedTrace.sseEventIds.every((id) => optimized.dashboardEvents >= id)).toBe(true);
    }
    for (const key of allHotPathKeys) {
      expect(optimized.traceByKey[key]?.every((trace) => !trace.overlap)).toBe(true);
      expect(optimized.invalidationCountByKey[key] || 0).toBeGreaterThanOrEqual(optimized.sseRequestsByKey[key] || 0);
    }
    expect(baseline.overlapByKey.status).toBeGreaterThan(0);
    expect(optimized.traceByKey.status.some((trace) => trace.source === 'sse' && trace.sseEventId !== undefined)).toBe(true);
    expect(optimized.traceByKey['tasks:review'].some((trace) => trace.source === 'sse' && trace.sseEventId !== undefined)).toBe(true);
    expect(optimized.traceSummaryByKey.status.sseEventIds).toEqual([20]);
    expect(optimized.traceSummaryByKey['tasks:review'].sseEventIds).toEqual([20]);
    expect(optimized.renderCommits).toBeLessThan(baseline.renderCommits);
    expect(optimized.eventRenderCommits).toBeLessThan(baseline.eventRenderCommits);
  });
});
