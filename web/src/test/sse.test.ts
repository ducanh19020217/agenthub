import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import {
  connectSSE,
  subscribeToEvents,
  subscribeToRunOutput,
  getRunLog,
  clearRunLogs,
  getBackoffDelay,
  INITIAL_RECONNECT_DELAY_MS,
  MAX_RECONNECT_DELAY_MS,
} from '../api/sse';
import { setToken, clearToken } from '../api/client';
import { EventItem } from '../types/api';

describe('Web SSE client (web/src/api/sse.ts)', () => {
  let eventListenersMap: Record<string, ((e: any) => void)[]>;
  let mockEventSourceInstances: MockEventSource[];
  let origEventSource: typeof window.EventSource;

  class MockEventSource {
    public onmessage: ((e: any) => void) | null = null;
    public onerror: (() => void) | null = null;
    public onopen: (() => void) | null = null;
    public closed = false;

    constructor(public url: string) {
      mockEventSourceInstances.push(this);
    }

    addEventListener(type: string, listener: any) {
      if (!eventListenersMap[type]) eventListenersMap[type] = [];
      eventListenersMap[type].push(listener);
    }

    close() {
      this.closed = true;
    }
  }

  beforeEach(() => {
    eventListenersMap = {};
    mockEventSourceInstances = [];
    origEventSource = window.EventSource;
    (window as any).EventSource = MockEventSource;
    setToken('test-token-123');
    clearRunLogs();
    vi.useFakeTimers();
  });

  afterEach(() => {
    (window as any).EventSource = origEventSource;
    clearToken();
    clearRunLogs();
    vi.useRealTimers();
  });

  it('calculates exponential backoff delay capped at MAX_RECONNECT_DELAY_MS', () => {
    expect(getBackoffDelay(0)).toBe(INITIAL_RECONNECT_DELAY_MS); // 1000ms
    expect(getBackoffDelay(1)).toBe(2000);
    expect(getBackoffDelay(2)).toBe(4000);
    expect(getBackoffDelay(3)).toBe(8000);
    expect(getBackoffDelay(4)).toBe(16000);
    expect(getBackoffDelay(5)).toBe(MAX_RECONNECT_DELAY_MS); // 30000ms capped
    expect(getBackoffDelay(10)).toBe(MAX_RECONNECT_DELAY_MS);
  });

  it('parses unified envelope for bus events and notifies event subscribers', async () => {
    const received: EventItem[] = [];
    const unsub = subscribeToEvents((ev) => {
      received.push(ev);
    });

    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const cleanup = connectSSE(queryClient);

    const taskListener = eventListenersMap['task.done']?.[0];
    expect(taskListener).toBeDefined();

    const envelope = {
      type: 'task.done',
      ts: '2026-10-15T08:00:00.000Z',
      taskId: 'myproj/task-1',
      payload: { result: 'ok' },
    };

    taskListener({
      lastEventId: '42',
      data: JSON.stringify(envelope),
    });
    await vi.runAllTicks();

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({
      id: 42,
      ts: '2026-10-15T08:00:00.000Z',
      type: 'task.done',
      taskId: 'myproj/task-1',
      payload: { result: 'ok' },
    });

    // Detail keys are updated immediately
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['task', 'myproj/task-1'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['task', 'myproj~task-1'] });

    // List keys are debounced (~500ms)
    vi.advanceTimersByTime(500);

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['status'] });

    const invalidationsBeforeReplay = invalidateSpy.mock.calls.length;
    taskListener({
      lastEventId: '42',
      data: JSON.stringify(envelope),
    });
    expect(received).toHaveLength(1);
    expect(invalidateSpy).toHaveBeenCalledTimes(invalidationsBeforeReplay);

    unsub();
    cleanup();
  });

  it('parses unified envelope for run.output and accumulates chunks into run log', () => {
    let outputReceived: { taskId: string; chunk: string; runId?: string } | null = null;
    const unsub = subscribeToRunOutput((taskId, chunk, runId) => {
      outputReceived = { taskId, chunk, runId };
    });

    const queryClient = new QueryClient();
    const cleanup = connectSSE(queryClient);

    const runOutputListener = eventListenersMap['run.output']?.[0];
    expect(runOutputListener).toBeDefined();

    // Chunk 1
    runOutputListener({
      data: JSON.stringify({
        type: 'run.output',
        ts: '2026-10-15T08:00:01.000Z',
        taskId: 'myproj/task-1',
        payload: {
          runId: 'run-99',
          chunk: 'Line 1\n',
        },
      }),
    });

    expect(outputReceived).toEqual({
      taskId: 'myproj/task-1',
      chunk: 'Line 1\n',
      runId: 'run-99',
    });
    expect(getRunLog('run-99')).toBe('Line 1\n');

    // Chunk 2 for same run
    runOutputListener({
      data: JSON.stringify({
        type: 'run.output',
        ts: '2026-10-15T08:00:02.000Z',
        taskId: 'myproj/task-1',
        payload: {
          runId: 'run-99',
          chunk: 'Line 2\n',
        },
      }),
    });

    expect(outputReceived).toEqual({
      taskId: 'myproj/task-1',
      chunk: 'Line 2\n',
      runId: 'run-99',
    });
    expect(getRunLog('run-99')).toBe('Line 1\nLine 2\n');

    // Query cache should be updated
    expect(queryClient.getQueryData(['runLog', 'run-99'])).toBe('Line 1\nLine 2\n');
    expect(queryClient.getQueryData(['taskLog', 'myproj/task-1'])).toBe('Line 1\nLine 2\n');

    unsub();
    cleanup();
  });

  it('reconnects with backoff and preserves lastEventId on reconnect', () => {
    const queryClient = new QueryClient();
    const cleanup = connectSSE(queryClient);

    expect(mockEventSourceInstances).toHaveLength(1);
    const firstInstance = mockEventSourceInstances[0];
    expect(firstInstance.url).toBe('/api/events?token=test-token-123');

    // Send an event with ID 50
    const profileListener = eventListenersMap['profile.created']?.[0];
    profileListener({
      lastEventId: '50',
      data: JSON.stringify({
        type: 'profile.created',
        ts: '2026-10-15T08:00:00.000Z',
        payload: { name: 'p1' },
      }),
    });

    // Simulate error on first instance (attempt 0 -> 1000ms delay)
    firstInstance.onerror!();
    expect(firstInstance.closed).toBe(true);

    // Fast-forward 500ms -> should not have reconnected yet
    vi.advanceTimersByTime(500);
    expect(mockEventSourceInstances).toHaveLength(1);

    // Fast-forward another 500ms (total 1000ms) -> second instance created with lastEventId=50
    vi.advanceTimersByTime(500);
    expect(mockEventSourceInstances).toHaveLength(2);
    const secondInstance = mockEventSourceInstances[1];
    expect(secondInstance.url).toBe('/api/events?token=test-token-123&lastEventId=50');

    // Second error (attempt 1 -> 2000ms delay)
    secondInstance.onerror!();
    expect(secondInstance.closed).toBe(true);

    vi.advanceTimersByTime(1000);
    expect(mockEventSourceInstances).toHaveLength(2);

    vi.advanceTimersByTime(1000); // total 2000ms
    expect(mockEventSourceInstances).toHaveLength(3);
    const thirdInstance = mockEventSourceInstances[2];
    expect(thirdInstance.url).toBe('/api/events?token=test-token-123&lastEventId=50');

    // On open -> reset reconnect attempts
    thirdInstance.onopen!();

    // Now if error occurs, delay should be back to 1000ms
    thirdInstance.onerror!();
    vi.advanceTimersByTime(1000);
    expect(mockEventSourceInstances).toHaveLength(4);

    cleanup();
  });

  it('coalesces 20 events in 300ms into a single invalidation of tasks while updating detail keys', async () => {
    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const onInvalidationSpy = vi.fn();
    const cleanup = connectSSE(queryClient, {
      onInvalidation: onInvalidationSpy,
    });

    const taskListener = eventListenersMap['task.queued']?.[0];
    expect(taskListener).toBeDefined();

    // Emit 20 events over 300ms (every 15ms)
    for (let i = 1; i <= 20; i++) {
      taskListener({
        lastEventId: String(i),
        data: JSON.stringify({
          type: 'task.queued',
          taskId: 'myproj/task-1',
          payload: { id: 'myproj/task-1' },
        }),
      });
      // Flush microtasks for detail updates and advance 15ms
      await vi.runAllTicks();
      vi.advanceTimersByTime(15);
    }

    // Detail keys should already have been updated
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['task', 'myproj/task-1'] });

    // 'tasks' queryKey has not fired yet during 300ms (since trailing debounce is 500ms)
    const tasksCallsDuringBurst = invalidateSpy.mock.calls.filter(
      (call) => Array.isArray(call[0]?.queryKey) && call[0].queryKey[0] === 'tasks' && call[0].queryKey.length === 1
    );
    expect(tasksCallsDuringBurst).toHaveLength(0);

    // Advance 500ms after the burst ends
    vi.advanceTimersByTime(500);

    // 'tasks' queryKey should now have been invalidated exactly ONCE
    const tasksCallsAfterDebounce = invalidateSpy.mock.calls.filter(
      (call) => Array.isArray(call[0]?.queryKey) && call[0].queryKey[0] === 'tasks' && call[0].queryKey.length === 1
    );
    expect(tasksCallsAfterDebounce).toHaveLength(1);

    // onInvalidation should have been called with the latest eventId (20)
    expect(onInvalidationSpy).toHaveBeenCalledWith(['tasks'], 20);

    cleanup();
  });

  it('defers list invalidations when document.hidden is true until tab becomes visible again', async () => {
    const origHiddenDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden')
      || Object.getOwnPropertyDescriptor(document, 'hidden');
    let isHidden = true;
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => isHidden,
    });

    try {
      const queryClient = new QueryClient();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
      const cleanup = connectSSE(queryClient);

      const taskListener = eventListenersMap['task.done']?.[0];
      expect(taskListener).toBeDefined();

      // Emit events while tab is hidden
      for (let i = 1; i <= 5; i++) {
        taskListener({
          lastEventId: String(i),
          data: JSON.stringify({
            type: 'task.done',
            taskId: 'myproj/task-1',
            payload: {},
          }),
        });
        await vi.runAllTicks();
        vi.advanceTimersByTime(100);
      }

      // Advance beyond debounce time (1000ms)
      vi.advanceTimersByTime(1000);

      // 'tasks' should NOT have been invalidated while tab was hidden
      const tasksCallsWhileHidden = invalidateSpy.mock.calls.filter(
        (call) => Array.isArray(call[0]?.queryKey) && call[0].queryKey[0] === 'tasks' && call[0].queryKey.length === 1
      );
      expect(tasksCallsWhileHidden).toHaveLength(0);

      // Detail keys can still update
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['task', 'myproj/task-1'] });

      // Now tab becomes visible again
      isHidden = false;
      document.dispatchEvent(new Event('visibilitychange'));

      // 'tasks' should now be invalidated once
      const tasksCallsAfterVisible = invalidateSpy.mock.calls.filter(
        (call) => Array.isArray(call[0]?.queryKey) && call[0].queryKey[0] === 'tasks' && call[0].queryKey.length === 1
      );
      expect(tasksCallsAfterVisible).toHaveLength(1);

      // Further visibilitychange without new events does not trigger another refetch
      document.dispatchEvent(new Event('visibilitychange'));
      const tasksCallsAfterSecondVisible = invalidateSpy.mock.calls.filter(
        (call) => Array.isArray(call[0]?.queryKey) && call[0].queryKey[0] === 'tasks' && call[0].queryKey.length === 1
      );
      expect(tasksCallsAfterSecondVisible).toHaveLength(1);

      cleanup();
    } finally {
      if (origHiddenDesc) {
        Object.defineProperty(document, 'hidden', origHiddenDesc);
      } else {
        delete (document as any).hidden;
      }
    }
  });

  it('enforces max-wait ~2s so continuous events flush list invalidations without starving', async () => {
    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const cleanup = connectSSE(queryClient);

    const taskListener = eventListenersMap['task.queued']?.[0];
    expect(taskListener).toBeDefined();

    // Emit an event every 200ms (which is < 500ms trailing debounce) for 2200ms
    // Without maxWait, it would never fire because timer gets reset every 200ms.
    for (let t = 0; t <= 2200; t += 200) {
      taskListener({
        lastEventId: String(t),
        data: JSON.stringify({
          type: 'task.queued',
          taskId: 'myproj/task-1',
          payload: {},
        }),
      });
      await vi.runAllTicks();
      vi.advanceTimersByTime(200);
    }

    // By 2200ms (which exceeds 2000ms max-wait), 'tasks' MUST have been invalidated at least once
    const tasksCalls = invalidateSpy.mock.calls.filter(
      (call) => Array.isArray(call[0]?.queryKey) && call[0].queryKey[0] === 'tasks' && call[0].queryKey.length === 1
    );
    expect(tasksCalls.length).toBeGreaterThanOrEqual(1);

    cleanup();
  });
});
