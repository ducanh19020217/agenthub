import { QueryClient } from '@tanstack/react-query';
import { getToken } from './client';
import { EventItem } from '../types/api';
import { notifyBrowserEvent, shouldNotifyBrowserEvent } from '../notifications';
import type { BrowserNotificationOptions, BrowserQuotaProfile } from '../notifications';

export type EventCallback = (event: EventItem) => void;
export type RunOutputCallback = (taskId: string, chunk: string, runId?: string) => void;

const eventListeners = new Set<EventCallback>();
const runOutputListeners = new Set<RunOutputCallback>();
const connectionListeners = new Set<(connected: boolean) => void>();
const runLogs = new Map<string, string>(); // runId -> accumulated log
let isConnected = false;

function patchTaskCaches(queryClient: QueryClient, taskId: string, payload: unknown): boolean {
  const task = payload && typeof payload === 'object' && 'task' in payload
    ? (payload as { task?: unknown }).task
    : payload;
  if (!task || typeof task !== 'object' || !('id' in task)) return false;
  let patched = false;
  const patchPage = (current: { items: Array<{ id: string }>; total: number; nextCursor: string | null } | undefined) => {
      if (!current || !Array.isArray(current.items)) return current;
      const index = current.items.findIndex((item) => item.id === taskId || item.id === (task as { id: string }).id);
      if (index < 0) return current;
      patched = true;
      const items = [...current.items];
      items[index] = { ...items[index], ...(task as object) };
      return { ...current, items };
  };
  queryClient.setQueriesData<{ items: Array<{ id: string }>; total: number; nextCursor: string | null }>({ queryKey: ['tasks'] }, patchPage);
  queryClient.setQueriesData<{ items: Array<{ id: string }>; total: number; nextCursor: string | null }>({ queryKey: ['tasks-kanban'] }, patchPage);
  return patched;
}

function patchChatSessionCaches(queryClient: QueryClient, sessionId: string, payload: unknown): boolean {
  if (!sessionId) return false;
  const data = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  let patched = false;
  queryClient.setQueriesData<Array<Record<string, unknown>> | { items: Array<Record<string, unknown>> }>({ queryKey: ['chatSessions'] }, (current) => {
    if (Array.isArray(current)) {
      const index = current.findIndex((item) => item && typeof item === 'object' && (item as { id?: string }).id === sessionId);
      if (index < 0) return current;
      patched = true;
      const next = [...current];
      next[index] = { ...(next[index] as object), ...(data.state ? { state: data.state } : {}), ...(data.busy !== undefined ? { busy: data.busy } : {}) };
      return next;
    }
    if (!current || typeof current !== 'object' || !Array.isArray((current as { items?: unknown[] }).items)) return current;
    const page = current as { items: Array<{ id?: string }>; [key: string]: unknown };
    const index = page.items.findIndex((item) => item.id === sessionId);
    if (index < 0) return current;
    patched = true;
    const items = [...page.items];
    items[index] = { ...items[index], ...(data.state ? { state: data.state } : {}), ...(data.busy !== undefined ? { busy: data.busy } : {}) };
    return { ...page, items };
  });
  queryClient.setQueriesData<{ pages: Array<{ items: Array<Record<string, unknown>> }>; pageParams: unknown[] }>({ queryKey: ['chatSessions'] }, (current) => {
    if (!current || !Array.isArray(current.pages)) return current;
    let changed = false;
    const pages = current.pages.map((page) => {
      if (!page || !Array.isArray(page.items)) return page;
      const index = page.items.findIndex((item) => item?.id === sessionId);
      if (index < 0) return page;
      changed = true;
      patched = true;
      const items = [...page.items];
      items[index] = { ...items[index], ...(data.state ? { state: data.state } : {}), ...(data.busy !== undefined ? { busy: data.busy } : {}) };
      return { ...page, items };
    });
    return changed ? { ...current, pages } : current;
  });
  return patched;
}

export function isSSEConnected(): boolean {
  return isConnected;
}

export function subscribeConnectionState(callback: (connected: boolean) => void): () => void {
  connectionListeners.add(callback);
  callback(isConnected);
  return () => {
    connectionListeners.delete(callback);
  };
}

export function getRunLog(runId: string): string {
  return runLogs.get(runId) || '';
}

export function clearRunLogs(): void {
  runLogs.clear();
}

export function subscribeToEvents(callback: EventCallback): () => void {
  eventListeners.add(callback);
  return () => {
    eventListeners.delete(callback);
  };
}

export function subscribeToRunOutput(callback: RunOutputCallback): () => void {
  runOutputListeners.add(callback);
  return () => {
    runOutputListeners.delete(callback);
  };
}

export const INITIAL_RECONNECT_DELAY_MS = 1000;
export const MAX_RECONNECT_DELAY_MS = 30000;

export function getBackoffDelay(attempt: number): number {
  const delay = INITIAL_RECONNECT_DELAY_MS * Math.pow(2, attempt);
  return Math.min(delay, MAX_RECONNECT_DELAY_MS);
}

export function handleRunOutput(
  taskId: string,
  runId: string,
  chunk: string,
  queryClient?: QueryClient,
): void {
  if (runId && chunk) {
    const existing = runLogs.get(runId) || '';
    runLogs.set(runId, existing + chunk);
    if (queryClient) {
      queryClient.setQueryData<string>(['runLog', runId], (prev = '') => prev + chunk);
    }
  }

  if (taskId && chunk && queryClient) {
    queryClient.setQueryData<string>(['taskLog', taskId], (prev = '') => (prev ? prev + chunk : chunk));
    const altTaskId = taskId.includes('/') ? taskId.replace('/', '~') : taskId.replace('~', '/');
    queryClient.setQueryData<string>(['taskLog', altTaskId], (prev = '') => (prev ? prev + chunk : chunk));
  }

  if (taskId && chunk) {
    for (const listener of runOutputListeners) {
      try {
        listener(taskId, chunk, runId);
      } catch {
        // ignore
      }
    }
  }
}

export interface SSEConnectionOptions {
  deduplicateEvents?: boolean;
  coalesceInvalidations?: boolean;
}

export function connectSSE(queryClient: QueryClient, options: SSEConnectionOptions = {}): () => void {
  const deduplicateEvents = options.deduplicateEvents !== false;
  const coalesceInvalidations = options.coalesceInvalidations !== false;
  let eventSource: EventSource | null = null;
  let isClosed = false;
  let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempts = 0;
  let lastEventId: string | null = null;
  const seenEventIds = new Set<string>();
  const pendingInvalidations = new Map<string, readonly unknown[]>();
  let invalidationFlushScheduled = false;

  function invalidateQueries(queryKey: readonly unknown[]): void {
    if (!coalesceInvalidations) {
      queryClient.invalidateQueries({ queryKey });
      return;
    }
    pendingInvalidations.set(JSON.stringify(queryKey), queryKey);
    if (invalidationFlushScheduled) return;
    invalidationFlushScheduled = true;
    queueMicrotask(() => {
      invalidationFlushScheduled = false;
      for (const key of pendingInvalidations.values()) queryClient.invalidateQueries({ queryKey: key });
      pendingInvalidations.clear();
    });
  }

  function initSSE() {
    if (isClosed) return;

    const token = getToken();
    if (!token) return;

    let sseUrl = `/api/events?token=${encodeURIComponent(token)}`;
    if (lastEventId) {
      sseUrl += `&lastEventId=${encodeURIComponent(lastEventId)}`;
    }
    eventSource = new EventSource(sseUrl);

    eventSource.onopen = () => {
      reconnectAttempts = 0;
      isConnected = true;
      for (const listener of connectionListeners) {
        try {
          listener(true);
        } catch {}
      }
    };

    const handleEventData = (eventName: string, rawData: string, rawLastEventId?: string) => {
      try {
        const parsed = JSON.parse(rawData);
        const type = parsed.type || eventName;
        const taskId = parsed.taskId;

        if (rawLastEventId) {
          lastEventId = rawLastEventId;
        } else if (parsed.id) {
          lastEventId = String(parsed.id);
        }

        // Handle run.output separately for real-time live logs
        if (type === 'run.output' || eventName === 'run.output') {
          const payload = parsed.payload;
          const runId = payload?.runId || parsed.runId || '';
          const chunk = payload?.chunk ?? parsed.data ?? payload?.output ?? '';
          handleRunOutput(taskId || parsed.taskId || '', runId, chunk, queryClient);
          return;
        }

        const rawId = rawLastEventId ? Number(rawLastEventId) : parsed.id;
        const eventId = typeof rawId === 'number' && !isNaN(rawId) ? rawId : Date.now();

        // The server replays events after Last-Event-ID reconnects. Ignore a
        // replay before notifying the UI or invalidating query caches; the
        // Dashboard already de-duplicates its rendered list, but cache
        // invalidation here would still start duplicate requests.
        if (deduplicateEvents && (rawLastEventId || parsed.id)) {
          const eventKey = String(eventId);
          if (seenEventIds.has(eventKey)) return;
          seenEventIds.add(eventKey);
          if (seenEventIds.size > 256) {
            const oldest = seenEventIds.values().next().value;
            if (oldest !== undefined) seenEventIds.delete(oldest);
          }
        }

        const eventItem: EventItem = {
          id: eventId,
          ts: parsed.ts || new Date().toISOString(),
          type,
          taskId: parsed.taskId || null,
          payload: parsed.payload !== undefined ? parsed.payload : parsed,
        };

        const appConfig = queryClient.getQueryData<{ brain?: { mode?: BrowserNotificationOptions['brainMode'] }; notifications?: { desktop?: boolean; desktopLevel?: 'all' | 'important' | 'critical' | 'off'; quietHours?: BrowserNotificationOptions['quietHours'] } }>(['config']);
        const notificationConfig = appConfig?.notifications;
        const notificationLevel = notificationConfig?.desktopLevel || 'important';
        const profilesData = queryClient.getQueryData<unknown>(['profiles']);
        const profiles = Array.isArray(profilesData)
          ? profilesData
          : profilesData && typeof profilesData === 'object' && Array.isArray((profilesData as { profiles?: unknown }).profiles)
          ? (profilesData as { profiles: unknown[] }).profiles
          : [];
        const notificationOptions: BrowserNotificationOptions = {
          quietHours: notificationConfig?.quietHours,
          brainMode: appConfig?.brain?.mode,
        };
        if (notificationConfig?.desktop !== false && shouldNotifyBrowserEvent(eventItem, notificationLevel, profiles as BrowserQuotaProfile[], notificationOptions)) {
          notifyBrowserEvent(eventItem, notificationLevel, profiles as BrowserQuotaProfile[], notificationOptions);
        }

        // Notify raw event listeners
        for (const listener of eventListeners) {
          try {
            listener(eventItem);
          } catch {
            // ignore listener error
          }
        }

        // Cache invalidation based on event type
        if (type.startsWith('task.')) {
          const patched = patchTaskCaches(queryClient, taskId || '', eventItem.payload);
          if (!patched) {
            invalidateQueries(['tasks']);
            invalidateQueries(['tasks-kanban']);
          } else if (['task.queued', 'task.running', 'task.review_ready', 'task.done', 'task.blocked', 'task.failed', 'task.cancelled', 'task.waiting_quota'].includes(type)) {
            // A status transition can move a card between columns; refresh only then.
            invalidateQueries(['tasks-kanban']);
          }
          invalidateQueries(['status']);
          if (taskId) {
            invalidateQueries(['task', taskId]);
            invalidateQueries(['task', taskId.replace('/', '~')]);
            if (type === 'task.running') {
              invalidateQueries(['taskLog', taskId]);
              invalidateQueries(['taskLog', taskId.replace('/', '~')]);
            }
          }
        } else if (type.startsWith('run.')) {
          invalidateQueries(['tasks']);
          invalidateQueries(['tasks-kanban']);
          invalidateQueries(['status']);
          if (taskId) {
            invalidateQueries(['task', taskId]);
            invalidateQueries(['task', taskId.replace('/', '~')]);
            if (type !== 'run.output') {
              invalidateQueries(['taskLog', taskId]);
              invalidateQueries(['taskLog', taskId.replace('/', '~')]);
            }
          }
        } else if (type.startsWith('profile.')) {
          invalidateQueries(['profiles']);
          invalidateQueries(['status']);
        } else if (type.startsWith('quota.')) {
          invalidateQueries(['profiles']);
          invalidateQueries(['status']);
        } else if (type.startsWith('config.')) {
          invalidateQueries(['config']);
        } else if (type === 'brain.status' || type === 'brain.updated') {
          invalidateQueries(['status']);
          invalidateQueries(['brain']);
        } else if (type.startsWith('chat.')) {
          const sessionId = typeof eventItem.payload === 'object' && eventItem.payload
            ? String((eventItem.payload as { sessionId?: string }).sessionId || '')
            : '';
          if (!patchChatSessionCaches(queryClient, sessionId, eventItem.payload)) {
            invalidateQueries(['chatSessions']);
          }
        } else if (type.startsWith('batch.')) {
          invalidateQueries(['batches']);
        }
      } catch (err) {
        console.error('Failed to parse SSE event:', err);
      }
    };

    eventSource.onmessage = (messageEvent) => {
      handleEventData('message', messageEvent.data, messageEvent.lastEventId);
    };

    const SSE_EVENTS = [
      'run.output',
      'task.queued',
      'task.running',
      'task.checking',
      'task.review_ready',
      'task.blocked',
      'task.waiting_quota',
      'task.done',
      'task.failed',
      'task.cancelled',
      'task.timeout',
      'run.crashed',
      'profile.created',
      'profile.updated',
      'profile.check',
      'quota.exhausted',
      'disk.low',
      'disk.ok',
      'disk.docker_low',
      'brain.notify',
      'ci.failed',
      'review.escalated',
      'quota.cleared',
      'config.updated',
      'brain.status',
      'brain.updated',
      'chat.delta',
      'chat.tool',
      'chat.done',
      'chat.error',
      'chat.permission_request',
      'chat.permission_resolved',
    ];

    for (const evtName of SSE_EVENTS) {
      eventSource.addEventListener(evtName, ((e: MessageEvent) => {
        handleEventData(evtName, e.data, e.lastEventId);
      }) as EventListener);
    }

    eventSource.onerror = () => {
      isConnected = false;
      for (const listener of connectionListeners) {
        try {
          listener(false);
        } catch {}
      }
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
      if (!isClosed) {
        const delay = getBackoffDelay(reconnectAttempts);
        reconnectAttempts++;
        reconnectTimeout = setTimeout(initSSE, delay);
      }
    };
  }

  initSSE();

  return () => {
    isClosed = true;
    isConnected = false;
    for (const listener of connectionListeners) {
      try {
        listener(false);
      } catch {}
    }
    if (reconnectTimeout) clearTimeout(reconnectTimeout);
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
  };
}
