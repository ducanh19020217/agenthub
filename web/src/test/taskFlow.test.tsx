import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TasksPage } from '../pages/TasksPage';
import { LocaleProvider } from '../context/LocaleContext';
import {
  FLOW_STATUSES,
  FLOW_ACTIVE_REFETCH_INTERVAL,
  FLOW_IDLE_REFETCH_INTERVAL,
  getFlowRefetchInterval,
} from '../components/TaskFlow';
import { KANBAN_STATUSES } from '../utils/tasks';
import * as client from '../api/client';
import type { Project, Task, TaskStatus } from '../types/api';

const project: Project = { id: 'p1', name: 'Project 1', path: '/path/1', defaultBranch: 'main', maxParallel: 2 };

const makeTask = (slug: string, status: TaskStatus, level: 'easy' | 'hard' = 'easy'): Task => ({
  id: `p1/${slug}`,
  projectId: 'p1',
  slug,
  title: `Title ${slug}`,
  status,
  level,
  dependsOn: [],
  attempt: 1,
  resume: 0,
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
});

const TASKS: Task[] = [
  makeTask('run-a', 'running', 'hard'),
  makeTask('run-b', 'running'),
  makeTask('review-a', 'review'),
  ...Array.from({ length: 25 }, (_, i) => makeTask(`done-${i + 1}`, 'done')),
];

describe('TaskFlow (sơ đồ quy trình)', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(client, 'getProjects').mockResolvedValue([project]);
    vi.spyOn(client, 'getTasksPage').mockImplementation(async (params?: client.TaskQuery) => {
      const matching = TASKS.filter((task) => !params?.status || params.status === 'all' || task.status === params.status);
      const limit = params?.limit || 20;
      const offset = params?.cursor ? Number(params.cursor.split(':').at(-1)) : 0;
      return {
        items: matching.slice(offset, offset + limit),
        total: matching.length,
        nextCursor: offset + limit < matching.length ? `cursor:${offset + limit}` : null,
      };
    });
  });

  afterEach(() => vi.restoreAllMocks());

  const renderPage = (entry = '/tasks') => render(
    <QueryClientProvider client={queryClient}>
      <LocaleProvider initialLocale="vi">
        <MemoryRouter initialEntries={[entry]}>
          <TasksPage />
        </MemoryRouter>
      </LocaleProvider>
    </QueryClientProvider>,
  );

  it('covers every Kanban status with exactly one node', () => {
    expect([...FLOW_STATUSES].sort()).toEqual([...KANBAN_STATUSES].sort());
  });

  it('switches to the workflow view and shows the task count of each status', async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId('view-toggle-flow'));

    expect(await screen.findByTestId('flow-view-wrapper')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('flow-node-running')).toHaveAttribute('data-count', '2'));
    expect(screen.getByTestId('flow-node-review')).toHaveAttribute('data-count', '1');
    expect(screen.getByTestId('flow-node-done')).toHaveAttribute('data-count', '25');
    expect(screen.getByTestId('flow-node-failed')).toHaveAttribute('data-count', '0');
    expect(screen.getByTestId('flow-node-running')).toHaveAccessibleName('Đang chạy: 2 task. Bấm để xem danh sách');
    // Bộ lọc trạng thái của sơ đồ DAG không hiện ở view quy trình.
    expect(screen.queryByLabelText('Lọc trạng thái')).not.toBeInTheDocument();
  });

  it('opens a popup listing the tasks of the clicked status', async () => {
    renderPage('/tasks?view=flow');
    const node = await screen.findByTestId('flow-node-running');
    await waitFor(() => expect(node).toHaveAttribute('data-count', '2'));
    fireEvent.click(node);

    const dialog = await screen.findByRole('dialog');
    const list = await within(dialog).findByTestId('flow-task-list');
    expect(within(list).getAllByRole('link')).toHaveLength(2);
    expect(within(list).getByText('Title run-a').closest('a')).toHaveAttribute('href', '/tasks/p1~run-a');
    expect(within(list).getByText('Khó')).toBeInTheDocument();
    expect(within(dialog).getByText('2 task')).toBeInTheDocument();
  });

  it('pages long lists and shows an empty state for empty statuses', async () => {
    renderPage('/tasks?view=flow');
    const doneNode = await screen.findByTestId('flow-node-done');
    await waitFor(() => expect(doneNode).toHaveAttribute('data-count', '25'));
    fireEvent.keyDown(doneNode, { key: 'Enter' });

    const dialog = await screen.findByRole('dialog');
    const list = await within(dialog).findByTestId('flow-task-list');
    expect(within(list).getAllByRole('link')).toHaveLength(20);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Xem thêm 5 task' }));
    await waitFor(() => expect(within(list).getAllByRole('link')).toHaveLength(25));

    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    fireEvent.click(screen.getByTestId('flow-node-failed'));
    expect(await screen.findByText('Không có task nào ở trạng thái này.')).toBeInTheDocument();
  });

  it('(a) active node and animated edges when 1 task is running', async () => {
    const singleRunningTask = [makeTask('run-single', 'running')];
    vi.spyOn(client, 'getTasksPage').mockImplementation(async (params?: client.TaskQuery) => {
      const matching = singleRunningTask.filter((task) => !params?.status || params.status === 'all' || task.status === params.status);
      const limit = params?.limit || 20;
      return {
        items: matching.slice(0, limit),
        total: matching.length,
        nextCursor: null,
      };
    });

    renderPage('/tasks?view=flow');
    const runningNode = await screen.findByTestId('flow-node-running');
    await waitFor(() => expect(runningNode).toHaveAttribute('data-count', '1'));

    // (a) ô flow-node-running có data-active="true"
    expect(runningNode).toHaveAttribute('data-active', 'true');

    // ô queued không có data-active
    expect(screen.getByTestId('flow-node-queued')).not.toHaveAttribute('data-active');
    expect(screen.getByTestId('flow-node-done')).not.toHaveAttribute('data-active');

    // cạnh vào/ra nó có data-animated="true"
    const edgesGroup = screen.getByTestId('flow-edges');
    const animatedEdges = edgesGroup.querySelectorAll('[data-animated="true"]');
    // 3 edges: queued -> running (vào), running -> checking (ra), running -> waiting_quota (ra)
    expect(animatedEdges.length).toBe(3);
  });

  it('(b) no active nodes or animated edges when no tasks are running', async () => {
    vi.spyOn(client, 'getTasksPage').mockResolvedValue({
      items: [],
      total: 0,
      nextCursor: null,
    });

    renderPage('/tasks?view=flow');
    await waitFor(() => expect(screen.getByTestId('flow-node-running')).toHaveAttribute('data-count', '0'));

    // không phần tử nào có data-active
    const activeNodes = document.querySelectorAll('[data-active="true"]');
    expect(activeNodes.length).toBe(0);

    // không phần tử nào có data-animated
    const animatedEdges = document.querySelectorAll('[data-animated="true"]');
    expect(animatedEdges.length).toBe(0);
  });

  it('(c) bounce class appears and disappears when count changes between renders', async () => {
    let count = 1;
    vi.spyOn(client, 'getTasksPage').mockImplementation(async () => ({
      items: count > 0 ? [makeTask('run-a', 'running')] : [],
      total: count,
      nextCursor: null,
    }));

    renderPage('/tasks?view=flow');
    const runningNode = await screen.findByTestId('flow-node-running');
    await waitFor(() => expect(runningNode).toHaveAttribute('data-count', '1'));

    // Initially before count change, bounce class is not present
    expect(runningNode.querySelector('.flow-count-bounce')).toBeNull();

    // Trigger count change between fetches
    count = 2;
    queryClient.invalidateQueries({ queryKey: ['tasks-kanban'] });

    await waitFor(() => {
      const bounceEl = runningNode.querySelector('.flow-count-bounce');
      expect(bounceEl).not.toBeNull();
      // Ensure bounce class is on an SVG <text> graphics element rather than <tspan> so transforms apply
      expect(bounceEl?.tagName.toLowerCase()).toBe('text');
    });

    // After bounce duration, class disappears
    await waitFor(
      () => {
        expect(runningNode.querySelector('.flow-count-bounce')).toBeNull();
      },
      { timeout: 1500 },
    );
  });

  it('(d) refetchInterval is 5s when tasks are running and 30s when idle', () => {
    expect(FLOW_ACTIVE_REFETCH_INTERVAL).toBe(5_000);
    expect(FLOW_IDLE_REFETCH_INTERVAL).toBe(30_000);
    expect(getFlowRefetchInterval(1)).toBe(5_000);
    expect(getFlowRefetchInterval(3)).toBe(5_000);
    expect(getFlowRefetchInterval(0)).toBe(30_000);
  });

  it('(e) displays preview of running tasks with project name, slug, and +N more when > 2', async () => {
    const threeRunning = [
      makeTask('slug-alpha', 'running'),
      makeTask('slug-beta', 'running'),
      makeTask('slug-gamma', 'running'),
    ];
    vi.spyOn(client, 'getTasksPage').mockImplementation(async (params?: client.TaskQuery) => {
      const matching = threeRunning.filter((t) => !params?.status || params.status === 'all' || t.status === params.status);
      const limit = params?.limit || 20;
      return {
        items: matching.slice(0, limit),
        total: matching.length,
        nextCursor: null,
      };
    });

    renderPage('/tasks?view=flow');
    const runningNode = await screen.findByTestId('flow-node-running');
    await waitFor(() => expect(runningNode).toHaveAttribute('data-count', '3'));

    const previewGroup = within(runningNode).getByTestId('flow-running-tasks');
    expect(previewGroup).toBeInTheDocument();
    expect(within(previewGroup).getByText('slug-alpha')).toBeInTheDocument();
    expect(within(previewGroup).getByText('slug-beta')).toBeInTheDocument();
    expect(within(previewGroup).getByText('+1 nữa')).toBeInTheDocument();

    const dots = previewGroup.querySelectorAll('.flow-dot-pulse');
    expect(dots.length).toBeGreaterThanOrEqual(1);
  });

  it('(f) does not display +N more placeholder before runningTasks data finishes loading', async () => {
    let resolveRunningTasks: ((value: client.PageResponse<Task>) => void) | null = null;
    vi.spyOn(client, 'getTasksPage').mockImplementation(async (params?: client.TaskQuery) => {
      if (params?.limit === 3 && params?.status === 'running') {
        // Delay runningTasks query
        return new Promise((resolve) => {
          resolveRunningTasks = resolve;
        });
      }
      // Status query returns total = 3
      return {
        items: [],
        total: 3,
        nextCursor: null,
      };
    });

    renderPage('/tasks?view=flow');
    const runningNode = await screen.findByTestId('flow-node-running');
    await waitFor(() => expect(runningNode).toHaveAttribute('data-count', '3'));

    const previewGroup = within(runningNode).getByTestId('flow-running-tasks');
    // While runningTasks is loading, no +N more label should be visible
    expect(within(previewGroup).queryByText(/\+.*nữa/)).toBeNull();

    // Now resolve the running tasks query
    resolveRunningTasks!({
      items: [makeTask('run-1', 'running'), makeTask('run-2', 'running')],
      total: 3,
      nextCursor: null,
    });

    // After loading completes, +1 nữa is rendered
    await waitFor(() => {
      expect(within(previewGroup).getByText('+1 nữa')).toBeInTheDocument();
    });
  });
});
