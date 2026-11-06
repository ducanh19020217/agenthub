import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TasksPage } from '../pages/TasksPage';
import { LocaleProvider } from '../context/LocaleContext';
import * as client from '../api/client';
import { Task, Project } from '../types/api';

describe('Kanban Waiting Column & Wait Reason Badges', () => {
  let queryClient: QueryClient;

  const mockProject: Project = {
    id: 'p1',
    name: 'Project 1',
    path: '/path/1',
    defaultBranch: 'main',
    maxParallel: 2,
  };

  const waitingTasks: Task[] = [
    {
      id: 'p1~t-quota',
      projectId: 'p1',
      slug: 't-quota',
      title: 'Task chờ quota',
      status: 'waiting_quota',
      waitReason: 'quota',
      level: 'easy',
      dependsOn: [],
      attempt: 1,
      resume: 0,
      createdAt: '2026-10-15T00:00:00Z',
      updatedAt: '2026-10-15T00:00:00Z',
    },
    {
      id: 'p1~t-disk',
      projectId: 'p1',
      slug: 't-disk',
      title: 'Task chờ đĩa',
      status: 'waiting_quota',
      waitReason: 'disk',
      level: 'easy',
      dependsOn: [],
      attempt: 1,
      resume: 0,
      createdAt: '2026-10-15T00:00:00Z',
      updatedAt: '2026-10-15T00:00:00Z',
    },
    {
      id: 'p1~t-slot',
      projectId: 'p1',
      slug: 't-slot',
      title: 'Task chờ slot',
      status: 'waiting_quota',
      waitReason: 'slot',
      level: 'easy',
      dependsOn: [],
      attempt: 1,
      resume: 0,
      createdAt: '2026-10-15T00:00:00Z',
      updatedAt: '2026-10-15T00:00:00Z',
    },
    {
      id: 'p1~t-load',
      projectId: 'p1',
      slug: 't-load',
      title: 'Task chờ tải máy',
      status: 'waiting_quota',
      waitReason: 'load',
      level: 'easy',
      dependsOn: [],
      attempt: 1,
      resume: 0,
      createdAt: '2026-10-15T00:00:00Z',
      updatedAt: '2026-10-15T00:00:00Z',
    },
    {
      id: 'p1~t-dependency',
      projectId: 'p1',
      slug: 't-dependency',
      title: 'Task chờ phụ thuộc',
      status: 'waiting_quota',
      waitReason: 'dependency',
      level: 'easy',
      dependsOn: ['p1~t-quota'],
      attempt: 1,
      resume: 0,
      createdAt: '2026-10-15T00:00:00Z',
      updatedAt: '2026-10-15T00:00:00Z',
    },
  ];

  beforeEach(() => {
    window.localStorage.clear();
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    vi.spyOn(client, 'getProjects').mockResolvedValue([mockProject]);
    vi.spyOn(client, 'getStatus').mockResolvedValue({
      tasks: { waiting_quota: 5, running: 0, queued: 0 },
      running: [],
      disk: { freeGB: 0.5, totalGB: 100, minFreeGB: 3 },
    } as any);
    vi.spyOn(client, 'getTasksPage').mockImplementation(async (params?: client.TaskQuery) => {
      const matching = waitingTasks.filter(
        (task) => !params?.status || params.status === 'all' || task.status === params.status,
      );
      return { items: matching, total: matching.length, nextCursor: null };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders Kanban column title as "Đang chờ" and displays badges for all wait reasons (vi)', async () => {
    render(
      <MemoryRouter initialEntries={['/tasks?view=kanban']}>
        <QueryClientProvider client={queryClient}>
          <LocaleProvider initialLocale="vi">
            <TasksPage />
          </LocaleProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    const waitingCol = await screen.findByTestId('kanban-column-waiting_quota');
    expect(waitingCol).toBeInTheDocument();

    // Column title should be "Đang chờ", not "Chờ quota"
    const colHeaderBadge = waitingCol.querySelector('[data-testid="status-badge-waiting_quota"]');
    expect(colHeaderBadge?.textContent).toBe('Đang chờ');

    // Wait for the cards to render
    await waitFor(() => {
      expect(screen.getByText('Task chờ quota')).toBeInTheDocument();
      expect(screen.getByText('Task chờ đĩa')).toBeInTheDocument();
      expect(screen.getByText('Task chờ slot')).toBeInTheDocument();
      expect(screen.getByText('Task chờ tải máy')).toBeInTheDocument();
      expect(screen.getByText('Task chờ phụ thuộc')).toBeInTheDocument();
    });

    // Check badges for each wait reason
    expect(screen.getByText('Chờ quota model')).toBeInTheDocument();
    expect(screen.getByText('Chờ ổ đĩa (còn 0.5 GB / cần 3 GB)')).toBeInTheDocument();
    expect(screen.getByText('Chờ slot chạy')).toBeInTheDocument();
    expect(screen.getByText('Chờ giảm tải máy')).toBeInTheDocument();
    expect(screen.getByText('Chờ task phụ thuộc')).toBeInTheDocument();
  });

  it('renders Kanban column title as "Waiting" and displays badges for all wait reasons (en)', async () => {
    render(
      <MemoryRouter initialEntries={['/tasks?view=kanban']}>
        <QueryClientProvider client={queryClient}>
          <LocaleProvider initialLocale="en">
            <TasksPage />
          </LocaleProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    const waitingCol = await screen.findByTestId('kanban-column-waiting_quota');
    expect(waitingCol).toBeInTheDocument();

    // Column title should be "Waiting", not "Waiting Quota"
    const colHeaderBadge = waitingCol.querySelector('[data-testid="status-badge-waiting_quota"]');
    expect(colHeaderBadge?.textContent).toBe('Waiting');

    // Wait for the cards to render
    await waitFor(() => {
      expect(screen.getByText('Task chờ quota')).toBeInTheDocument();
      expect(screen.getByText('Task chờ đĩa')).toBeInTheDocument();
      expect(screen.getByText('Task chờ slot')).toBeInTheDocument();
      expect(screen.getByText('Task chờ tải máy')).toBeInTheDocument();
      expect(screen.getByText('Task chờ phụ thuộc')).toBeInTheDocument();
    });

    // Check badges in English
    expect(screen.getByText('Waiting for model quota')).toBeInTheDocument();
    expect(screen.getByText('Waiting for disk (0.5 GB free / 3 GB needed)')).toBeInTheDocument();
    expect(screen.getByText('Waiting for slot')).toBeInTheDocument();
    expect(screen.getByText('Waiting for machine load')).toBeInTheDocument();
    expect(screen.getByText('Waiting for dependency')).toBeInTheDocument();
  });

  it('renders accurate blockingDisk badges per task when multiple tasks have different drives', async () => {
    const multiDiskTasks: Task[] = [
      {
        id: 'p1~t-d1',
        projectId: 'p1',
        slug: 't-d1',
        title: 'Task on drive 1',
        status: 'waiting_quota',
        waitReason: 'disk',
        blockingDisk: {
          path: '/media/drive1',
          label: 'Worktrees (/media/drive1)',
          freeGB: 0.4,
          minFreeGB: 3,
        },
        level: 'easy',
        dependsOn: [],
        attempt: 1,
        resume: 0,
        createdAt: '2026-10-15T00:00:00Z',
        updatedAt: '2026-10-15T00:00:00Z',
      },
      {
        id: 'p2~t-d2',
        projectId: 'p2',
        slug: 't-d2',
        title: 'Task on drive 2',
        status: 'waiting_quota',
        waitReason: 'disk',
        blockingDisk: {
          path: '/media/drive2',
          label: 'Worktrees (/media/drive2)',
          freeGB: 1.1,
          minFreeGB: 3,
        },
        level: 'easy',
        dependsOn: [],
        attempt: 1,
        resume: 0,
        createdAt: '2026-10-15T00:00:00Z',
        updatedAt: '2026-10-15T00:00:00Z',
      },
    ];

    vi.spyOn(client, 'getTasksPage').mockImplementation(async (params?: client.TaskQuery) => {
      const matching = multiDiskTasks.filter(
        (task) => !params?.status || params.status === 'all' || task.status === params.status,
      );
      return { items: matching, total: matching.length, nextCursor: null };
    });

    render(
      <MemoryRouter initialEntries={['/tasks?view=kanban']}>
        <QueryClientProvider client={queryClient}>
          <LocaleProvider initialLocale="vi">
            <TasksPage />
          </LocaleProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Task on drive 1')).toBeInTheDocument();
      expect(screen.getByText('Task on drive 2')).toBeInTheDocument();
    });

    expect(screen.getByText('Chờ Worktrees (/media/drive1) (còn 0.4 GB / cần 3 GB)')).toBeInTheDocument();
    expect(screen.getByText('Chờ Worktrees (/media/drive2) (còn 1.1 GB / cần 3 GB)')).toBeInTheDocument();
  });

  it('renders waitReason badges in Project view and List view for waiting_quota tasks', async () => {
    const sampleTasks: Task[] = [
      {
        id: 'p1~t-waiting-disk',
        projectId: 'p1',
        slug: 't-waiting-disk',
        title: 'Task chờ ổ đĩa trong project/list',
        status: 'waiting_quota',
        waitReason: 'disk',
        blockingDisk: {
          path: '/media/data',
          label: 'Worktrees (/media/data)',
          freeGB: 0.6,
          minFreeGB: 2,
        },
        level: 'easy',
        dependsOn: [],
        attempt: 1,
        resume: 0,
        createdAt: '2026-10-15T00:00:00Z',
        updatedAt: '2026-10-15T00:00:00Z',
      },
    ];

    vi.spyOn(client, 'getTasks').mockResolvedValue(sampleTasks);
    vi.spyOn(client, 'getTasksPage').mockResolvedValue({
      items: sampleTasks,
      total: sampleTasks.length,
      nextCursor: null,
    });

    // 1. Test Project view
    const { unmount } = render(
      <MemoryRouter initialEntries={['/tasks?view=project']}>
        <QueryClientProvider client={queryClient}>
          <LocaleProvider initialLocale="vi">
            <TasksPage />
          </LocaleProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Task chờ ổ đĩa trong project/list')).toBeInTheDocument();
    });
    expect(screen.getByText('Chờ Worktrees (/media/data) (còn 0.6 GB / cần 2 GB)')).toBeInTheDocument();

    unmount();

    // 2. Test List view
    render(
      <MemoryRouter initialEntries={['/tasks?view=list']}>
        <QueryClientProvider client={queryClient}>
          <LocaleProvider initialLocale="vi">
            <TasksPage />
          </LocaleProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Task chờ ổ đĩa trong project/list')).toBeInTheDocument();
    });
    expect(screen.getByText('Chờ Worktrees (/media/data) (còn 0.6 GB / cần 2 GB)')).toBeInTheDocument();
  });
});
