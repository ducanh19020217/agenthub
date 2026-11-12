import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PlansPage } from '../pages/PlansPage';
import { LocaleProvider } from '../context/LocaleContext';
import { ThemeProvider } from '../context/ThemeContext';
import * as client from '../api/client';
import { TaskBatch, Project, Task } from '../types/api';

describe('PlansPage', () => {
  let queryClient: QueryClient;

  const mockProject: Project = {
    id: 'agenthub',
    name: 'AgentHub',
    path: '/path/to/agenthub',
    defaultBranch: 'main',
    maxParallel: 3,
    envTemplate: null,
    checks: null,
  };

  const mockTask1: Task = {
    id: 'agenthub~task-1',
    projectId: 'agenthub',
    slug: 'task-1',
    title: 'Task số 1',
    body: 'Đề bài task 1',
    level: 'easy',
    status: 'draft',
    modelChain: ['agy:claude-sonnet-4-6-thinking'],
    dependsOn: [],
    attempt: 0,
    resume: 0,
    createdAt: '2026-10-20T10:00:00Z',
    updatedAt: '2026-10-20T10:00:00Z',
    batchId: 'b-1',
  };

  const mockTask2: Task = {
    id: 'agenthub~task-2',
    projectId: 'agenthub',
    slug: 'task-2',
    title: 'Task số 2',
    body: 'Đề bài task 2',
    level: 'hard',
    status: 'draft',
    modelChain: ['gemini-3.8-flash-high'],
    dependsOn: ['task-1'],
    attempt: 0,
    resume: 0,
    createdAt: '2026-10-20T10:05:00Z',
    updatedAt: '2026-10-20T10:05:00Z',
    batchId: 'b-1',
  };

  const mockBatch1: TaskBatch & { tasks: Task[] } = {
    id: 'b-1',
    projectId: 'agenthub',
    title: 'Kế hoạch Sprint 1',
    goal: 'Hoàn thiện các tính năng cốt lõi',
    status: 'draft',
    createdBy: 'claude',
    createdAt: '2026-10-20T10:00:00Z',
    tasks: [mockTask1, mockTask2],
  };

  const mockBatch2: TaskBatch & { tasks: Task[] } = {
    id: 'b-2',
    projectId: 'agenthub',
    title: 'Kế hoạch Sprint 2',
    goal: 'Tối ưu hoá hiệu năng',
    status: 'dispatched',
    createdBy: 'user',
    createdAt: '2026-10-19T10:00:00Z',
    tasks: [],
  };

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });

    vi.spyOn(client, 'getProjects').mockResolvedValue([mockProject]);
    vi.spyOn(client, 'getConfig').mockResolvedValue({
      planning: { requireApproval: false, approvalMinTasks: 0 },
    } as any);
    vi.spyOn(client, 'getBatchesPage').mockResolvedValue({ items: [mockBatch1, mockBatch2], total: 2, nextCursor: null });
    vi.spyOn(client, 'getBatch').mockImplementation(async (id: string) => {
      if (id === 'b-1') return mockBatch1;
      if (id === 'b-2') return mockBatch2;
      throw new Error('Not found');
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function renderPlansPage(initialRoute = '/plans/b-1') {
    return render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <LocaleProvider initialLocale="vi">
            <MemoryRouter initialEntries={[initialRoute]}>
              <Routes>
                <Route path="/plans" element={<PlansPage />} />
                <Route path="/plans/:batchId" element={<PlansPage />} />
              </Routes>
            </MemoryRouter>
          </LocaleProvider>
        </ThemeProvider>
      </QueryClientProvider>,
    );
  }

  it('1. Hiển thị danh sách các đợt và thông tin chi tiết đợt được chọn', async () => {
    renderPlansPage();

    // Batch items in left column
    expect(await screen.findByTestId('batch-item-b-1')).toBeInTheDocument();
    expect(screen.getByTestId('batch-item-b-2')).toBeInTheDocument();

    // Detail view of batch 1
    expect(await screen.findByTestId('batch-title')).toHaveTextContent('Kế hoạch Sprint 1');
    expect(screen.getAllByText('Hoàn thiện các tính năng cốt lõi').length).toBeGreaterThanOrEqual(1);

    // DAG container and tasks
    expect(screen.getByTestId('plans-dag-container')).toBeInTheDocument();
    expect(screen.getByTestId('task-row-agenthub~task-1')).toBeInTheDocument();
    expect(screen.getByTestId('task-row-agenthub~task-2')).toBeInTheDocument();
  });

  it('2. Thêm task mới vào đợt nháp thành công', async () => {
    const addTaskSpy = vi.spyOn(client, 'addTaskToBatch').mockResolvedValue({
      id: 'agenthub~task-3',
      projectId: 'agenthub',
      slug: 'task-3',
      title: 'Task số 3 mới',
      body: 'Nội dung mô tả',
      level: 'easy',
      status: 'draft',
      dependsOn: ['task-1'],
      attempt: 0,
      resume: 0,
      createdAt: '2026-10-20T10:10:00Z',
      updatedAt: '2026-10-20T10:10:00Z',
      batchId: 'b-1',
    });

    renderPlansPage();

    const addBtn = await screen.findByTestId('btn-add-task');
    fireEvent.click(addBtn);

    // Fill form
    const slugInput = screen.getByTestId('input-add-slug');
    const titleInput = screen.getByTestId('input-add-title');
    const bodyInput = screen.getByTestId('textarea-add-body');

    fireEvent.change(slugInput, { target: { value: 'task-3' } });
    fireEvent.change(titleInput, { target: { value: 'Task số 3 mới' } });
    fireEvent.change(bodyInput, { target: { value: 'Nội dung mô tả' } });

    // Submit
    const submitBtn = screen.getByTestId('btn-submit-add-task');
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(addTaskSpy).toHaveBeenCalledWith('b-1', expect.objectContaining({
        slug: 'task-3',
        title: 'Task số 3 mới',
        body: 'Nội dung mô tả',
      }));
    });
  });

  it('3. Sửa thông tin task trong đợt nháp', async () => {
    const updateTaskSpy = vi.spyOn(client, 'updateTask').mockResolvedValue({
      ...mockTask1,
      title: 'Task 1 đã cập nhật',
    });

    renderPlansPage();

    const editBtn = await screen.findByTestId('btn-edit-task-agenthub~task-1');
    fireEvent.click(editBtn);

    const titleInput = screen.getByTestId('input-edit-title');
    fireEvent.change(titleInput, { target: { value: 'Task 1 đã cập nhật' } });

    const submitBtn = screen.getByTestId('btn-submit-edit-task');
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(updateTaskSpy).toHaveBeenCalledWith('agenthub~task-1', expect.objectContaining({
        title: 'Task 1 đã cập nhật',
      }));
    });
  });

  it('4. Bỏ task khỏi đợt nháp qua modal xác nhận', async () => {
    const removeSpy = vi.spyOn(client, 'removeTaskFromBatch').mockResolvedValue({ ok: true });

    renderPlansPage();

    const removeBtn = await screen.findByTestId('btn-remove-task-agenthub~task-1');
    fireEvent.click(removeBtn);

    const confirmBtn = await screen.findByTestId('btn-confirm-remove-task');
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(removeSpy).toHaveBeenCalledWith('b-1', 'agenthub~task-1');
    });
  });

  it('5. Giao cả đợt thành công', async () => {
    const dispatchSpy = vi.spyOn(client, 'dispatchBatch').mockResolvedValue({
      ok: true,
      batchId: 'b-1',
      dispatchedCount: 2,
    });

    renderPlansPage();

    const dispatchBtn = await screen.findByTestId('btn-dispatch-batch');
    fireEvent.click(dispatchBtn);

    await waitFor(() => {
      expect(dispatchSpy).toHaveBeenCalledWith('b-1');
    });
  });

  it('6. Hiển thị thông báo lỗi khi giao đợt bị phát hiện vòng phụ thuộc', async () => {
    vi.spyOn(client, 'dispatchBatch').mockRejectedValue({
      response: {
        data: {
          error: 'cycle_detected',
          message: 'Phát hiện vòng phụ thuộc trong đợt: task-1 -> task-2 -> task-1',
        },
      },
    });

    renderPlansPage();

    const dispatchBtn = await screen.findByTestId('btn-dispatch-batch');
    fireEvent.click(dispatchBtn);

    expect(await screen.findByTestId('dispatch-error-alert')).toBeInTheDocument();
    expect(screen.getByText(/Phát hiện vòng phụ thuộc trong đợt/)).toBeInTheDocument();
  });

  it('7. Huỷ đợt nháp qua modal xác nhận', async () => {
    const discardSpy = vi.spyOn(client, 'discardBatch').mockResolvedValue({ ok: true, batchId: 'b-1' });

    renderPlansPage();

    const discardBtn = await screen.findByTestId('btn-discard-batch');
    fireEvent.click(discardBtn);

    const confirmBtn = await screen.findByTestId('btn-confirm-discard');
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(discardSpy).toHaveBeenCalledWith('b-1');
    });
  });

  it('8. Trạng thái trống hiện đúng khối giải thích và câu cài đặt khi requireApproval = false và approvalMinTasks = 0', async () => {
    vi.spyOn(client, 'getBatchesPage').mockResolvedValue({ items: [], total: 0, nextCursor: null });
    vi.spyOn(client, 'getConfig').mockResolvedValue({
      planning: { requireApproval: false, approvalMinTasks: 0 },
    } as any);

    renderPlansPage('/plans');

    expect(await screen.findByTestId('plans-empty-state')).toBeInTheDocument();
    expect(screen.getByText('Kế hoạch sẽ xuất hiện khi nào?')).toBeInTheDocument();
    expect(screen.getByText(/Khi Claude chia một việc thành nhiều task, kế hoạch sẽ hiện ở đây/)).toBeInTheDocument();
    expect(screen.getByText('Cài đặt hiện tại:')).toBeInTheDocument();
    expect(screen.getByText('Claude giao việc ngay, không cần duyệt')).toBeInTheDocument();
    expect(screen.getByTestId('link-to-settings-planning')).toHaveAttribute('href', '/settings');
  });

  it('9. Trạng thái trống hiện đúng câu khi cài đặt theo số task (approvalMinTasks > 0)', async () => {
    vi.spyOn(client, 'getBatchesPage').mockResolvedValue({ items: [], total: 0, nextCursor: null });
    vi.spyOn(client, 'getConfig').mockResolvedValue({
      planning: { requireApproval: false, approvalMinTasks: 4 },
    } as any);

    renderPlansPage('/plans');

    expect(await screen.findByTestId('plans-empty-state')).toBeInTheDocument();
    expect(screen.getByText('Kế hoạch từ 4 task cần duyệt')).toBeInTheDocument();
  });

  it('10. Trạng thái trống hiện đúng câu khi cài đặt duyệt mọi task (requireApproval = true)', async () => {
    vi.spyOn(client, 'getBatchesPage').mockResolvedValue({ items: [], total: 0, nextCursor: null });
    vi.spyOn(client, 'getConfig').mockResolvedValue({
      planning: { requireApproval: true, approvalMinTasks: 0 },
    } as any);

    renderPlansPage('/plans');

    expect(await screen.findByTestId('plans-empty-state')).toBeInTheDocument();
    expect(screen.getByText('Mọi task cần duyệt')).toBeInTheDocument();
  });

  it('11. Khung bên phải khi chưa chọn đợt hiển thị 3 bước ngắn (Chọn đợt → Sửa/bỏ task → Giao cả đợt)', async () => {
    vi.spyOn(client, 'getBatchesPage').mockResolvedValue({ items: [], total: 0, nextCursor: null });
    renderPlansPage('/plans');

    expect(await screen.findByTestId('plans-no-batch-selected')).toBeInTheDocument();
    expect(screen.getByText('Chọn đợt')).toBeInTheDocument();
    expect(screen.getByText('Sửa/bỏ task')).toBeInTheDocument();
    expect(screen.getByText('Giao cả đợt')).toBeInTheDocument();
  });

  it('12. Hiển thị tiêu đề trang "Kế hoạch" và phụ đề hướng dẫn', async () => {
    renderPlansPage('/plans/b-1');

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Kế hoạch');
    expect(screen.getByText(/Xem các đợt task, tiến độ và sơ đồ phụ thuộc của Claude/)).toBeInTheDocument();
  });

  it('13. Tiến độ đợt tính task có trạng thái pushed vào số task hoàn thành', async () => {
    const batchWithPushed: TaskBatch & { tasks: Task[] } = {
      ...mockBatch1,
      id: 'b-pushed',
      status: 'dispatched',
      progress: undefined,
      tasks: [
        { ...mockTask1, id: 'agenthub~task-pushed-1', status: 'pushed' },
        { ...mockTask2, id: 'agenthub~task-done-2', status: 'done' },
      ],
    };
    vi.spyOn(client, 'getBatchesPage').mockResolvedValue({ items: [batchWithPushed], total: 1, nextCursor: null });
    vi.spyOn(client, 'getBatch').mockResolvedValue(batchWithPushed);

    renderPlansPage('/plans/b-pushed');
    expect(await screen.findByText('2/2 xong')).toBeInTheDocument();
  });
});
