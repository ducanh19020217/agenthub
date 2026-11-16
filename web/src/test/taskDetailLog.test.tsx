import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TaskDetailPage } from '../pages/TaskDetailPage';
import * as client from '../api/client';
import * as sse from '../api/sse';
import { handleRunOutput } from '../api/sse';
import { TaskDetail } from '../types/api';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

describe('TaskDetailPage - Live log of running task', () => {
  let queryClient: QueryClient;
  let runOutputListener: sse.RunOutputCallback | null = null;
  let eventListener: sse.EventCallback | null = null;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: 3000 },
      },
    });

    vi.spyOn(sse, 'subscribeToRunOutput').mockImplementation((cb) => {
      runOutputListener = cb;
      return () => {
        runOutputListener = null;
      };
    });

    vi.spyOn(sse, 'subscribeToEvents').mockImplementation((cb) => {
      eventListener = cb;
      return () => {
        eventListener = null;
      };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches initial log and appends real-time chunks from running slow engine', async () => {
    const mockTask: TaskDetail = {
      id: 'demo/task-slow',
      projectId: 'demo',
      slug: 'task-slow',
      title: 'Tác vụ chạy lâu',
      level: 'easy',
      status: 'running',
      dependsOn: '[]',
      attempt: 0,
      resume: 0,
      createdAt: '2026-10-15T08:00:00Z',
      updatedAt: '2026-10-15T08:00:00Z',
      runs: [
        { id: 'run-0', taskId: 'demo/task-slow', engine: 'codex', model: 'codex:gpt-5.6-luna', profileName: 'p', startedAt: '2026-10-15T08:00:00Z', endedAt: '2026-10-15T08:10:00Z', outcome: 'done', kind: 'worker' },
        { id: 'run-1', taskId: 'demo/task-slow', engine: 'codex', model: 'codex:gpt-5.6-luna', profileName: 'p', startedAt: '2026-10-15T08:11:00Z', endedAt: null, outcome: null, kind: 'worker' },
      ] as unknown as TaskDetail['runs'],
      reviews: [],
    };

    vi.spyOn(client, 'getTask').mockResolvedValue(mockTask);
    const getTaskLogSpy = vi.spyOn(client, 'getTaskLog').mockResolvedValue('Fake agent: starting...\n');

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/tasks/demo~task-slow']}>
          <Routes>
            <Route path="/tasks/:id" element={<TaskDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    // Initial log displayed
    expect(await screen.findByText(/Fake agent: starting\.\.\./)).toBeInTheDocument();
    expect(getTaskLogSpy).toHaveBeenCalledWith('demo~task-slow', { tail: 500, scope: 'all' });
    expect(screen.getByText('Danh sách runs (2)')).toBeInTheDocument();

    // Verify subscriber was registered
    expect(runOutputListener).not.toBeNull();

    // Simulate SSE run.output event from slow mode fake engine
    act(() => {
      runOutputListener!('demo/task-slow', 'Fake agent: working slowly...\n', 'run-1');
      runOutputListener!('demo~task-slow', 'Second-form event\n', 'run-1');
    });

    // Check that terminal has updated and contains the new live log
    expect(screen.getByText(/Fake agent: working slowly\.\.\./)).toBeInTheDocument();
    expect(screen.getByText(/Second-form event/)).toBeInTheDocument();
  });

  it('fetches the stored log even when SSE preseeded a partial task log cache entry', async () => {
    const mockTask: TaskDetail = {
      id: 'demo/task-cache', projectId: 'demo', slug: 'task-cache', title: 'Cached log', level: 'easy', status: 'running',
      dependsOn: '[]', attempt: 0, resume: 0, createdAt: '2026-10-15T08:00:00Z', updatedAt: '2026-10-15T08:00:00Z', runs: [], reviews: [],
    };
    vi.spyOn(client, 'getTask').mockResolvedValue(mockTask);
    const getTaskLogSpy = vi.spyOn(client, 'getTaskLog').mockResolvedValue('Full stored log from worker\n');
    handleRunOutput('demo/task-cache', 'run-cache', 'partial SSE chunk\n', queryClient);
    queryClient.setQueryData(['taskLog', 'demo/task-cache'], 'partial SSE chunk\n');
    expect(queryClient.getQueryData(['taskLog', 'demo/task-cache'])).toBe('partial SSE chunk\n');

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/tasks/demo~task-cache']}>
          <Routes><Route path="/tasks/:id" element={<TaskDetailPage />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText(/Full stored log from worker/)).toBeInTheDocument();
    expect(getTaskLogSpy).toHaveBeenCalledWith('demo~task-cache', { tail: 500, scope: 'all' });
    expect(screen.queryByText(/Chưa có log từ worker/)).not.toBeInTheDocument();
  });

  it('drops pre-refetch run output after a run transition and keeps the log visible during refetch', async () => {
    const mockTask: TaskDetail = {
      id: 'demo/task-sequence', projectId: 'demo', slug: 'task-sequence', title: 'Sequenced log', level: 'easy', status: 'running',
      dependsOn: '[]', attempt: 0, resume: 0, createdAt: '2026-10-15T08:00:00Z', updatedAt: '2026-10-15T08:00:00Z', runs: [], reviews: [],
    };
    const nextSnapshot = deferred<string>();
    vi.spyOn(client, 'getTask').mockResolvedValue(mockTask);
    const getTaskLogSpy = vi.spyOn(client, 'getTaskLog')
      .mockResolvedValueOnce('run1-start\n')
      .mockImplementationOnce(() => nextSnapshot.promise);

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/tasks/demo~task-sequence']}>
          <Routes><Route path="/tasks/:id" element={<TaskDetailPage />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/run1-start/)).toBeInTheDocument();

    act(() => {
      runOutputListener!('demo/task-sequence', 'c1\n', 'run-1');
      runOutputListener!('demo/task-sequence', 'c2\n', 'run-1');
    });
    expect(screen.getByText(/c1/).textContent).toContain('c2');

    act(() => { void queryClient.invalidateQueries({ queryKey: ['taskLog', 'demo~task-sequence'] }); });
    await waitFor(() => expect(getTaskLogSpy).toHaveBeenCalledTimes(2));
    // Background refresh retains the prior snapshot and live output.
    expect(screen.getByText(/c1/).textContent).toContain('run1-start');
    await act(async () => {
      nextSnapshot.resolve('run1-start\nc1\nc2\n\n── Run #2 · worker · codex · 08:01 ──\nd1\n');
      await nextSnapshot.promise;
    });
    expect(await screen.findByText(/d1/)).toBeInTheDocument();
    act(() => runOutputListener!('demo/task-sequence', 'd2\n', 'run-2'));

    const logText = screen.getByText(/c1/).textContent || '';
    for (const chunk of ['c1', 'c2', 'd1', 'd2']) {
      expect(logText.split(chunk).length - 1).toBe(1);
    }
  });

  it('appends a post-fetch chunk that also appeared earlier in the stored log', async () => {
    const mockTask: TaskDetail = {
      id: 'demo/task-repeat', projectId: 'demo', slug: 'task-repeat', title: 'Repeated text', level: 'easy', status: 'running',
      dependsOn: '[]', attempt: 0, resume: 0, createdAt: '2026-10-15T08:00:00Z', updatedAt: '2026-10-15T08:00:00Z', runs: [], reviews: [],
    };
    vi.spyOn(client, 'getTask').mockResolvedValue(mockTask);
    vi.spyOn(client, 'getTaskLog').mockResolvedValue('earlier exec\ncurrent tail\n');
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/tasks/demo~task-repeat']}>
          <Routes><Route path="/tasks/:id" element={<TaskDetailPage />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/current tail/)).toBeInTheDocument();
    act(() => runOutputListener!('demo/task-repeat', 'exec\n', 'run-repeat'));
    const logText = screen.getByText(/earlier exec/).textContent || '';
    expect(logText.split('exec\n').length - 1).toBe(2);
  });

  it('does not duplicate an SSE replay that exactly matches the fetched snapshot tail', async () => {
    const mockTask: TaskDetail = {
      id: 'demo/task-tail', projectId: 'demo', slug: 'task-tail', title: 'Tail replay', level: 'easy', status: 'running',
      dependsOn: '[]', attempt: 0, resume: 0, createdAt: '2026-10-15T08:00:00Z', updatedAt: '2026-10-15T08:00:00Z', runs: [], reviews: [],
    };
    const nextSnapshot = deferred<string>();
    vi.spyOn(client, 'getTask').mockResolvedValue(mockTask);
    const getTaskLogSpy = vi.spyOn(client, 'getTaskLog')
      .mockResolvedValueOnce('initial\n')
      .mockImplementationOnce(() => nextSnapshot.promise);
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/tasks/demo~task-tail']}>
          <Routes><Route path="/tasks/:id" element={<TaskDetailPage />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/initial/)).toBeInTheDocument();
    act(() => { void queryClient.invalidateQueries({ queryKey: ['taskLog', 'demo~task-tail'] }); });
    await waitFor(() => expect(getTaskLogSpy).toHaveBeenCalledTimes(2));
    await act(async () => {
      nextSnapshot.resolve('initial\nreplayed-tail\n');
      await nextSnapshot.promise;
    });
    expect(await screen.findByText(/replayed-tail/)).toBeInTheDocument();
    act(() => runOutputListener!('demo/task-tail', 'replayed-tail\n', 'run-tail'));
    const logText = screen.getByText(/replayed-tail/).textContent || '';
    expect(logText.split('replayed-tail').length - 1).toBe(1);
  });

  it('displays previous run logs via scope=all even when latest run log is empty', async () => {
    const mockTask: TaskDetail = {
      id: 'demo/task-multi',
      projectId: 'demo',
      slug: 'task-multi',
      title: 'Task Multi',
      level: 'easy',
      status: 'review',
      dependsOn: '[]',
      attempt: 0,
      resume: 0,
      createdAt: '2026-10-15T08:00:00Z',
      updatedAt: '2026-10-15T08:00:00Z',
      runs: [
        { id: 'r1', taskId: 'demo/task-multi', engine: 'agy', model: 'gemini', profileName: 'p1', kind: 'worker', startedAt: '2026-10-15T08:00:00Z' },
        { id: 'r2', taskId: 'demo/task-multi', engine: 'claude', model: 'claude:sonnet', profileName: 'claude-may', kind: 'reviewer', startedAt: '2026-10-15T08:30:00Z' },
      ],
      reviews: [],
    };

    const combinedLog = [
      '── Run #1 · worker · agy/p1 · 15:00 ──',
      'Worker finished work cleanly',
      '',
      '── Run #2 · reviewer · claude/claude-may · 15:30 ──',
    ].join('\n');

    vi.spyOn(client, 'getTask').mockResolvedValue(mockTask);
    vi.spyOn(client, 'getTaskLog').mockResolvedValue(combinedLog);

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/tasks/demo~task-multi']}>
          <Routes>
            <Route path="/tasks/:id" element={<TaskDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    expect(await screen.findByText(/Worker finished work cleanly/)).toBeInTheDocument();
    expect(screen.getByText(/Run #1 · worker/)).toBeInTheDocument();
    expect(screen.getByText(/Run #2 · reviewer · claude\/claude-may/)).toBeInTheDocument();
    // Also asserts hint is visible under the last run header
    expect(screen.getByText(/Reviewer claude-may (?:đang duyệt|is reviewing)/)).toBeInTheDocument();
  });

  it('displays reviewer hint when last run has header only even if previous runs have logs', async () => {
    const mockTask: TaskDetail = {
      id: 'demo/task-multi-hint',
      projectId: 'demo',
      slug: 'task-multi-hint',
      title: 'Task Multi Hint',
      level: 'easy',
      status: 'review',
      dependsOn: '[]',
      attempt: 0,
      resume: 0,
      createdAt: '2026-10-15T08:00:00Z',
      updatedAt: '2026-10-15T08:00:00Z',
      runs: [
        { id: 'r1', taskId: 'demo/task-multi-hint', engine: 'agy', model: 'gemini', profileName: 'p1', kind: 'worker', startedAt: '2026-10-15T08:00:00Z' },
        { id: 'r2', taskId: 'demo/task-multi-hint', engine: 'claude', model: 'claude:sonnet', profileName: 'claude-may', kind: 'reviewer', startedAt: '2026-10-15T08:30:00Z' },
      ],
      reviews: [],
    };

    const logWithHeaderOnlyForLastRun = [
      '── Run #1 · worker · agy/p1 · 15:00 ──',
      'Worker finished work cleanly',
      '',
      '── Run #2 · reviewer · claude/claude-may · 15:30 ──',
      '',
    ].join('\n');

    vi.spyOn(client, 'getTask').mockResolvedValue(mockTask);
    vi.spyOn(client, 'getTaskLog').mockResolvedValue(logWithHeaderOnlyForLastRun);

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/tasks/demo~task-multi-hint']}>
          <Routes>
            <Route path="/tasks/:id" element={<TaskDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    expect(await screen.findByText(/Run #2 · reviewer · claude\/claude-may/)).toBeInTheDocument();
    // Hint displayed under the last run header
    expect(screen.getByText(/Reviewer claude-may (?:đang duyệt|is reviewing)/)).toBeInTheDocument();
  });

  it('displays checking hint when task is checking and last run has header only', async () => {
    const mockTask: TaskDetail = {
      id: 'demo/task-chk-header',
      projectId: 'demo',
      slug: 'task-chk-header',
      title: 'Task In Checking With Header',
      level: 'easy',
      status: 'checking',
      dependsOn: '[]',
      attempt: 0,
      resume: 0,
      createdAt: '2026-10-15T08:00:00Z',
      updatedAt: '2026-10-15T08:00:00Z',
      runs: [],
      reviews: [],
    };

    const logWithHeader = '── Run #1 · checker · 15:30 ──\n';

    vi.spyOn(client, 'getTask').mockResolvedValue(mockTask);
    vi.spyOn(client, 'getTaskLog').mockResolvedValue(logWithHeader);

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/tasks/demo~task-chk-header']}>
          <Routes>
            <Route path="/tasks/:id" element={<TaskDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    expect(await screen.findByText(/Run #1 · checker/)).toBeInTheDocument();
    expect(screen.getByText(/Đang chạy kiểm tra|Running checks/i)).toBeInTheDocument();
  });

  it('displays reviewer status when task is in review and log is empty', async () => {
    const mockTask: TaskDetail = {
      id: 'demo/task-rev',
      projectId: 'demo',
      slug: 'task-rev',
      title: 'Task In Review',
      level: 'easy',
      status: 'review',
      dependsOn: '[]',
      attempt: 0,
      resume: 0,
      createdAt: '2026-10-15T08:00:00Z',
      updatedAt: '2026-10-15T08:00:00Z',
      runs: [
        { id: 'r2', taskId: 'demo/task-rev', engine: 'claude', model: 'claude:sonnet', profileName: 'claude-may', kind: 'reviewer', startedAt: '2026-10-15T08:30:00Z' },
      ],
      reviews: [],
    };

    vi.spyOn(client, 'getTask').mockResolvedValue(mockTask);
    vi.spyOn(client, 'getTaskLog').mockResolvedValue('');

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/tasks/demo~task-rev']}>
          <Routes>
            <Route path="/tasks/:id" element={<TaskDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    // Displays contextual reviewer status instead of generic "Chưa có log từ worker..."
    expect(await screen.findByText(/claude-may/)).toBeInTheDocument();
  });

  it('displays checking status when task is in checking and log is empty', async () => {
    const mockTask: TaskDetail = {
      id: 'demo/task-chk',
      projectId: 'demo',
      slug: 'task-chk',
      title: 'Task In Checking',
      level: 'easy',
      status: 'checking',
      dependsOn: '[]',
      attempt: 0,
      resume: 0,
      createdAt: '2026-10-15T08:00:00Z',
      updatedAt: '2026-10-15T08:00:00Z',
      runs: [],
      reviews: [],
    };

    vi.spyOn(client, 'getTask').mockResolvedValue(mockTask);
    vi.spyOn(client, 'getTaskLog').mockResolvedValue('');

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/tasks/demo~task-chk']}>
          <Routes>
            <Route path="/tasks/:id" element={<TaskDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    // Displays checking status
    expect(await screen.findByText(/chạy kiểm tra|running checks/i)).toBeInTheDocument();
  });

  it('appends new run header when SSE review.started arrives instead of clearing log', async () => {
    const mockTask: TaskDetail = {
      id: 'demo/task-sse',
      projectId: 'demo',
      slug: 'task-sse',
      title: 'Task SSE',
      level: 'easy',
      status: 'review',
      dependsOn: '[]',
      attempt: 0,
      resume: 0,
      createdAt: '2026-10-15T08:00:00Z',
      updatedAt: '2026-10-15T08:00:00Z',
      runs: [
        { id: 'r1', taskId: 'demo/task-sse', engine: 'agy', model: 'gemini', profileName: 'p1', kind: 'worker', startedAt: '2026-10-15T08:00:00Z' },
      ],
      reviews: [],
    };

    vi.spyOn(client, 'getTask').mockResolvedValue(mockTask);
    vi.spyOn(client, 'getTaskLog').mockResolvedValue('Worker output finished.\n');

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/tasks/demo~task-sse']}>
          <Routes>
            <Route path="/tasks/:id" element={<TaskDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    expect(await screen.findByText(/Worker output finished\./)).toBeInTheDocument();

    // Emit review.started SSE event
    act(() => {
      eventListener!({
        id: 101,
        type: 'review.started',
        taskId: 'demo/task-sse',
        ts: new Date().toISOString(),
        payload: {
          engine: 'claude',
          profile: 'claude-may',
          model: 'claude:sonnet',
          actor: 'claude-reviewer',
          runId: 'r2',
        },
      });
    });

    // Check that initial worker log remains, and new reviewer run header is appended
    expect(screen.getByText(/Worker output finished\./)).toBeInTheDocument();
    expect(screen.getByText(/reviewer · claude\/claude-may/)).toBeInTheDocument();
  });

  it('calculates correct run number when earlier run headers have been tail-truncated', async () => {
    const mockTask: TaskDetail = {
      id: 'demo/task-truncated',
      projectId: 'demo',
      slug: 'task-truncated',
      title: 'Task Truncated',
      level: 'easy',
      status: 'review',
      dependsOn: '[]',
      attempt: 0,
      resume: 0,
      createdAt: '2026-10-15T08:00:00Z',
      updatedAt: '2026-10-15T08:00:00Z',
      runs: [
        { id: 'r1', taskId: 'demo/task-truncated', engine: 'agy', model: 'gemini', profileName: 'p1', kind: 'worker', startedAt: '2026-10-15T08:00:00Z' },
        { id: 'r2', taskId: 'demo/task-truncated', engine: 'agy', model: 'gemini', profileName: 'p1', kind: 'worker', startedAt: '2026-10-15T09:00:00Z' },
        { id: 'r3', taskId: 'demo/task-truncated', engine: 'agy', model: 'gemini', profileName: 'p1', kind: 'worker', startedAt: '2026-10-15T10:00:00Z' },
        { id: 'r4', taskId: 'demo/task-truncated', engine: 'agy', model: 'gemini', profileName: 'p1', kind: 'worker', startedAt: '2026-10-15T11:00:00Z' },
      ],
      reviews: [],
    };

    // Notice initial log only contains Run #4 because Run 1, 2, 3 were truncated off by tail
    const truncatedLog = '── Run #4 · worker · agy/p1 · 16:00 ──\nLog of run 4\n';

    vi.spyOn(client, 'getTask').mockResolvedValue(mockTask);
    vi.spyOn(client, 'getTaskLog').mockResolvedValue(truncatedLog);

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/tasks/demo~task-truncated']}>
          <Routes>
            <Route path="/tasks/:id" element={<TaskDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    expect(await screen.findByText(/Log of run 4/)).toBeInTheDocument();

    // Emit review.started SSE event for Run #5
    act(() => {
      eventListener!({
        id: 102,
        type: 'review.started',
        taskId: 'demo/task-truncated',
        ts: new Date().toISOString(),
        payload: {
          engine: 'claude',
          profile: 'claude-may',
          model: 'claude:sonnet',
          actor: 'claude-reviewer',
          runId: 'r5',
          runNumber: 5,
        },
      });
    });

    // Run header must be Run #5, NOT Run #2 (which would happen if only counting occurrences of "── Run #" in truncatedLog)
    expect(screen.getByText(/── Run #5 · reviewer · claude\/claude-may/)).toBeInTheDocument();
  });
});
