import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TasksPage } from '../pages/TasksPage';
import { LocaleProvider } from '../context/LocaleContext';
import { FLOW_STATUSES } from '../components/TaskFlow';
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
});
