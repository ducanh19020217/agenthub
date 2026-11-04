import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TasksPage } from '../pages/TasksPage';
import { LocaleProvider } from '../context/LocaleContext';
import * as client from '../api/client';
import { Task, Project } from '../types/api';

describe('TasksPage & Kanban Long Lists', () => {
  let queryClient: QueryClient;

  const mockProject: Project = {
    id: 'p1',
    name: 'Project 1',
    path: '/path/1',
    defaultBranch: 'main',
    maxParallel: 2,
  };

  const createDoneTasks = (count: number): Task[] => {
    return Array.from({ length: count }, (_, i) => ({
      id: `p1~task-${i + 1}`,
      projectId: 'p1',
      slug: `slug-${i + 1}`,
      title: `Task Title ${i + 1}`,
      status: 'done' as const,
      level: 'easy' as const,
      dependsOn: [],
      attempt: 1,
      resume: 0,
      createdAt: '2026-10-15T00:00:00Z',
      updatedAt: new Date(Date.now() - (count - i) * 1000).toISOString(),
    }));
  };

  const mockKanbanTasks = (tasks: Task[]) => {
    vi.spyOn(client, 'getTasksPage').mockImplementation(async (params?: client.TaskQuery) => {
      const normalize = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, (c) => c === 'đ' ? 'd' : 'D').toLowerCase();
      const query = normalize(params?.search || '');
      const matching = tasks.filter((task) => (!params?.status || params.status === 'all' || task.status === params.status) && (!query || normalize(`${task.slug} ${task.title}`).includes(query)));
      const limit = params?.limit || 20;
      const offset = params?.cursor ? Number(params.cursor.split(':').at(-1)) : 0;
      const items = matching.slice(offset, offset + limit);
      return { items, total: matching.length, nextCursor: offset + limit < matching.length ? `cursor:${params?.status}:${offset + limit}` : null };
    });
  };

  beforeEach(() => {
    window.localStorage.clear();
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    vi.spyOn(client, 'getProjects').mockResolvedValue([mockProject]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function renderPage(initialEntry = '/tasks') {
    return render(
      <QueryClientProvider client={queryClient}>
        <LocaleProvider initialLocale="vi">
          <MemoryRouter initialEntries={[initialEntry]}>
            <TasksPage />
          </MemoryRouter>
        </LocaleProvider>
      </QueryClientProvider>,
    );
  }

  it('view danh sách chỉ hiển thị trang hiện tại và gửi cursor khi chuyển trang', async () => {
    const firstPage = createDoneTasks(2);
    const secondPage = createDoneTasks(1).map((task) => ({ ...task, slug: 'page-two' }));
    const getTasks = vi.spyOn(client, 'getTasksPage').mockImplementation(async (params?: client.TaskQuery) => {
      if (params?.limit) {
        return params.cursor
          ? { items: secondPage, total: 3, nextCursor: null }
          : { items: firstPage, total: 3, nextCursor: 'cursor-page-2' };
      }
      return { items: [], total: 0, nextCursor: null };
    });

    renderPage('/tasks?view=list&pageSize=1&search=needle');

    expect(await screen.findByText('slug-1')).toBeInTheDocument();
    expect(screen.queryByText('page-two')).not.toBeInTheDocument();
    expect(screen.queryByText('slug-3')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /trang sau/i }));
    expect(await screen.findByText('page-two')).toBeInTheDocument();
    expect(getTasks).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 1, cursor: 'cursor-page-2', search: 'needle' }));
  });

  it('khôi phục filter từ URL và reset về trang đầu khi filter đổi', async () => {
    const getTasks = vi.spyOn(client, 'getTasksPage').mockImplementation(async (params?: client.TaskQuery) =>
      params?.limit ? { items: createDoneTasks(1), total: 1, nextCursor: null } : { items: [], total: 0, nextCursor: null },
    );

    renderPage('/tasks?view=list&page=3&status=review&search=alpha');

    const search = await screen.findByDisplayValue('alpha');
    expect(screen.getByRole('combobox', { name: /lọc theo trạng thái/i })).toHaveValue('review');
    expect(getTasks).toHaveBeenCalledWith(expect.objectContaining({ status: 'review', search: 'alpha', limit: 20, offset: 40 }));
    fireEvent.change(search, { target: { value: 'beta' } });
    await screen.findByText('slug-1');
    expect(getTasks).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'review', search: 'beta', limit: 20, offset: 0 }));
  });

  it('khôi phục deep-link page và tiếp tục bằng cursor của trang đó', async () => {
    const getTasks = vi.spyOn(client, 'getTasksPage').mockImplementation(async (params?: client.TaskQuery) => ({
      items: createDoneTasks(1).map((task) => ({ ...task, slug: `page-${params?.offset ? params.offset / 20 + 1 : 1}` })),
      total: 80,
      nextCursor: params?.offset === 40 ? 'cursor-page-4' : null,
    }));

    renderPage('/tasks?view=list&page=3');
    expect(await screen.findByText('page-3')).toBeInTheDocument();
    expect(getTasks).toHaveBeenCalledWith(expect.objectContaining({ offset: 40 }));

    fireEvent.click(screen.getByRole('button', { name: /trang sau/i }));
    await waitFor(() => expect(getTasks).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'cursor-page-4', offset: undefined })));
  });

  it('cột 131 task chỉ render 10 thẻ done + nút Xem thêm, bấm thì thêm đúng step', async () => {
    const tasks = createDoneTasks(131);
    mockKanbanTasks(tasks);

    renderPage();

    const doneCol = await screen.findByTestId('kanban-column-done');
    await waitFor(() => expect(doneCol).toHaveTextContent('131'));

    // Mặc định cột done chỉ render 10 thẻ
    const linksBefore = doneCol.querySelectorAll('a[href^="/tasks/"]');
    expect(linksBefore.length).toBe(10);

    // Có nút Xem thêm 10 (còn 121)
    const showMoreBtn = screen.getByRole('button', {
      name: /xem thêm 10 \(còn 121\)/i,
    });
    expect(showMoreBtn).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /thu gọn/i })).not.toBeInTheDocument();

    // Bấm xem thêm
    fireEvent.click(showMoreBtn);

    // Trang tiếp theo thêm 10 thẻ
    await waitFor(() => expect(doneCol.querySelectorAll('a[href^="/tasks/"]')).toHaveLength(20));

    expect(screen.getByRole('button', { name: /xem thêm 10 \(còn 111\)/i })).toBeInTheDocument();
  });

  it('cột khác mặc định hiển thị 20 thẻ', async () => {
    const queuedTasks: Task[] = Array.from({ length: 25 }, (_, i) => ({
      id: `p1~queued-${i + 1}`,
      projectId: 'p1',
      slug: `queued-${i + 1}`,
      title: `Queued Task ${i + 1}`,
      status: 'queued' as const,
      level: 'easy' as const,
      dependsOn: [],
      attempt: 0,
      resume: 0,
      createdAt: '2026-10-15T00:00:00Z',
      updatedAt: new Date(Date.now() - (25 - i) * 1000).toISOString(),
    }));
    mockKanbanTasks(queuedTasks);

    renderPage();

    const queuedCol = await screen.findByTestId('kanban-column-queued');
    await waitFor(() => expect(queuedCol).toHaveTextContent('25'));

    // Mặc định cột queued hiện 20 thẻ
    const links = queuedCol.querySelectorAll('a[href^="/tasks/"]');
    expect(links.length).toBe(20);

    expect(screen.getByRole('button', { name: /xem thêm 5 \(còn 5\)/i })).toBeInTheDocument();
  });

  it('lọc nhanh theo slug và tiêu đề không dấu tiếng Việt', async () => {
    const tasks: Task[] = [
      {
        id: 'p1~viet-slug',
        projectId: 'p1',
        slug: 'viet-slug',
        title: 'Xử lý đăng nhập tài khoản',
        status: 'done' as const,
        level: 'easy' as const,
        dependsOn: [],
        attempt: 1,
        resume: 0,
        createdAt: '2026-10-15T00:00:00Z',
        updatedAt: '2026-10-16T00:00:00Z',
      },
      {
        id: 'p1~other-slug',
        projectId: 'p1',
        slug: 'other-slug',
        title: 'Cập nhật giao diện người dùng',
        status: 'done' as const,
        level: 'easy' as const,
        dependsOn: [],
        attempt: 1,
        resume: 0,
        createdAt: '2026-10-15T00:00:00Z',
        updatedAt: '2026-10-15T00:00:00Z',
      },
    ];
    mockKanbanTasks(tasks);

    renderPage();

    await waitFor(() => expect(screen.getByText('Xử lý đăng nhập tài khoản')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('Cập nhật giao diện người dùng')).toBeInTheDocument());

    const filterInput = screen.getByPlaceholderText(/lọc slug \/ tiêu đề/i);

    // Lọc không dấu: "dang nhap" khớp với "đăng nhập"
    fireEvent.change(filterInput, { target: { value: 'dang nhap' } });
    await waitFor(() => expect(screen.getByText('Xử lý đăng nhập tài khoản')).toBeInTheDocument());
    expect(screen.queryByText('Cập nhật giao diện người dùng')).not.toBeInTheDocument();

    // Lọc theo slug
    fireEvent.change(filterInput, { target: { value: 'other-slug' } });
    await waitFor(() => expect(screen.queryByText('Xử lý đăng nhập tài khoản')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('Cập nhật giao diện người dùng')).toBeInTheDocument());
  });

  it('giữ nguyên badge reviewerEscalated khi có task cần duyệt', async () => {
    const escalatedTask: Task = {
      id: 'p1~t-review',
      projectId: 'p1',
      slug: 't-review',
      title: 'Task Alpha Escalated',
      status: 'review' as const,
      level: 'hard' as const,
      dependsOn: [],
      attempt: 1,
      resume: 0,
      reviewerEscalated: 1,
      createdAt: '2026-10-15T00:00:00Z',
      updatedAt: '2026-10-16T00:00:00Z',
    };
    mockKanbanTasks([escalatedTask]);

    renderPage();

    await screen.findByTestId('kanban-column-review');
    expect(screen.getByText(/chờ duyệt/i)).toBeInTheDocument();
  });

  it('hiển thị số vòng duyệt trên Kanban card cho task trạng thái review', async () => {
    const reviewTask: Task = {
      id: 'p1~t-review-round',
      projectId: 'p1',
      slug: 't-review-round',
      title: 'Task Alpha Review Round',
      status: 'review' as const,
      level: 'easy' as const,
      dependsOn: [],
      attempt: 1,
      resume: 0,
      reviewRound: 2,
      reviewMaxRounds: 3,
      createdAt: '2026-10-15T00:00:00Z',
      updatedAt: '2026-10-16T00:00:00Z',
    };
    mockKanbanTasks([reviewTask]);

    renderPage();

    await screen.findByTestId('kanban-column-review');
    const badge = await screen.findByTestId('task-review-round-p1~t-review-round');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent('Vòng duyệt 2/3');
  });

  it('sắp xếp ổn định theo createdAt giảm dần', async () => {
    const tasks: Task[] = [
      {
        id: 'p1~t-old',
        projectId: 'p1',
        slug: 't-old',
        title: 'Task Cũ',
        status: 'draft' as const,
        level: 'easy' as const,
        dependsOn: [],
        attempt: 0,
        resume: 0,
        createdAt: '2026-10-10T00:00:00Z',
        updatedAt: '2026-10-10T00:00:00Z',
      },
      {
        id: 'p1~t-new',
        projectId: 'p1',
        slug: 't-new',
        title: 'Task Mới',
        status: 'draft' as const,
        level: 'easy' as const,
        dependsOn: [],
        attempt: 0,
        resume: 0,
        createdAt: '2026-10-18T00:00:00Z',
        updatedAt: '2026-10-18T00:00:00Z',
      },
    ];
    mockKanbanTasks(tasks);

    renderPage();

    const draftCol = await screen.findByTestId('kanban-column-draft');
    await waitFor(() => expect(draftCol.querySelectorAll('h3')).toHaveLength(2));
    const titles = Array.from(draftCol.querySelectorAll('h3')).map((el) => el.textContent);
    expect(titles).toEqual(['Task Cũ', 'Task Mới']);
  });

  it('ghi nhớ trạng thái mở rộng trong localStorage', async () => {
    const tasks = createDoneTasks(35);
    mockKanbanTasks(tasks);

    renderPage();

    const doneCol = await screen.findByTestId('kanban-column-done');
    await waitFor(() => expect(doneCol.querySelectorAll('a[href^="/tasks/"]')).toHaveLength(10));
    const links = doneCol.querySelectorAll('a[href^="/tasks/"]');
    expect(links.length).toBe(10);
    expect(screen.getByRole('button', { name: /xem thêm 10/i })).toBeInTheDocument();
  });

  it('hiển thị badge "Tạm dừng (quá tải)" và nút "Tiếp tục" khi task running bị tạm dừng do tải, không hiện im lặng', async () => {
    const resumeSpy = vi.spyOn(client, 'resumeTask').mockResolvedValue({ ok: true, paused: false });
    const tasks: Task[] = [
      {
        id: 'p1~t-paused-load',
        projectId: 'p1',
        slug: 't-paused-load',
        title: 'Task Tạm Dừng Quá Tải',
        status: 'running',
        level: 'easy',
        dependsOn: [],
        attempt: 1,
        resume: 0,
        paused: true,
        pauseReason: 'load',
        currentRun: {
          startedAt: '2026-10-15T00:00:00Z',
          lastOutputAt: '2026-10-15T00:10:00Z',
          lastActivityAt: '2026-10-15T00:10:00Z',
          activitySource: 'log',
          paused: true,
          pauseReason: 'load',
        },
        createdAt: '2026-10-15T00:00:00Z',
        updatedAt: '2026-10-15T00:10:00Z',
      },
    ];
    mockKanbanTasks(tasks);

    renderPage();

    expect(await screen.findByText('Task Tạm Dừng Quá Tải')).toBeInTheDocument();
    expect(screen.getByText('Tạm dừng (quá tải)')).toBeInTheDocument();
    expect(screen.queryByText(/im lặng/i)).not.toBeInTheDocument();

    const resumeBtn = screen.getByRole('button', { name: /^Tiếp tục$/i });
    expect(resumeBtn).toBeInTheDocument();
    fireEvent.click(resumeBtn);

    await waitFor(() => {
      expect(resumeSpy).toHaveBeenCalledWith('p1~t-paused-load');
    });
  });

  it('hiển thị badge "Tạm dừng (thủ công)" khi task running bị tạm dừng thủ công', async () => {
    const tasks: Task[] = [
      {
        id: 'p1~t-paused-manual',
        projectId: 'p1',
        slug: 't-paused-manual',
        title: 'Task Tạm Dừng Thủ Công',
        status: 'running',
        level: 'easy',
        dependsOn: [],
        attempt: 1,
        resume: 0,
        paused: true,
        pauseReason: 'manual',
        currentRun: {
          startedAt: '2026-10-15T00:00:00Z',
          lastOutputAt: '2026-10-15T00:10:00Z',
          lastActivityAt: '2026-10-15T00:10:00Z',
          activitySource: 'log',
          paused: true,
          pauseReason: 'manual',
        },
        createdAt: '2026-10-15T00:00:00Z',
        updatedAt: '2026-10-15T00:10:00Z',
      },
    ];
    mockKanbanTasks(tasks);

    renderPage();

    expect(await screen.findByText('Task Tạm Dừng Thủ Công')).toBeInTheDocument();
    expect(screen.getByText('Tạm dừng (thủ công)')).toBeInTheDocument();
    expect(screen.queryByText(/im lặng/i)).not.toBeInTheDocument();
  });

  it('hiển thị khu vực Chờ bạn quyết định cho triage đã phân tích', async () => {
    const triageTask: Task = {
      id: 'p1~op-op-42-triage', projectId: 'p1', slug: 'op-op-42-triage', title: '[OP-42] Lỗi export',
      status: 'done', level: 'easy', dependsOn: [], attempt: 1, resume: 0,
      createdAt: '2026-10-15T00:00:00Z', updatedAt: '2026-10-15T00:00:00Z',
      triage: { sourceId: 'demo', wpId: 42, displayId: 'OP-42', analysis: { conclusion: 'lỗi', size: 'vừa', summary: 'Tóm tắt' }, decision: null },
    };
    vi.spyOn(client, 'getTasks').mockResolvedValue([triageTask]);
    vi.spyOn(client, 'getTasksPage').mockResolvedValue({ items: [], total: 0, nextCursor: null });
    renderPage();
    expect(await screen.findByTestId('triage-pending-section')).toBeInTheDocument();
    expect(screen.getByText('OP-42')).toBeInTheDocument();
    expect(screen.getByText('lỗi · vừa')).toBeInTheDocument();
  });
});
