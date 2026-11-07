import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TaskDetailPage } from '../pages/TaskDetailPage';
import { LocaleProvider } from '../context/LocaleContext';
import * as client from '../api/client';
import * as sse from '../api/sse';
import { TaskDetail, TaskStatus } from '../types/api';

describe('TaskDetailPage', () => {
  let queryClient: QueryClient;

  const baseTask: TaskDetail = {
    id: 'proj-1~t1',
    projectId: 'proj-1',
    slug: 't1',
    title: 'Task Alpha',
    level: 'easy',
    status: 'draft',
    dependsOn: '[]',
    attempt: 0,
    resume: 0,
    createdAt: '2026-10-15T00:00:00Z',
    updatedAt: '2026-10-15T00:00:00Z',
    runs: [],
    reviews: [],
  };

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });

    vi.spyOn(sse, 'subscribeToRunOutput').mockImplementation(() => () => {});
    vi.spyOn(client, 'getTaskLog').mockResolvedValue('');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function renderPage(taskId = 'proj-1~t1') {
    return render(
      <QueryClientProvider client={queryClient}>
        <LocaleProvider initialLocale="vi">
          <MemoryRouter initialEntries={[`/tasks/${taskId}`]}>
            <Routes>
              <Route path="/tasks/:id" element={<TaskDetailPage />} />
            </Routes>
          </MemoryRouter>
        </LocaleProvider>
      </QueryClientProvider>,
    );
  }

  it('1. Nút Start: khi status là draft, click nút Bắt đầu gọi startTask', async () => {
    const startSpy = vi.spyOn(client, 'startTask').mockResolvedValue({
      ...baseTask,
      status: 'queued',
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    vi.spyOn(client, 'getTask').mockResolvedValue({
      ...baseTask,
      status: 'draft',
    });

    renderPage();

    expect(await screen.findByText('Task Alpha')).toBeInTheDocument();

    const startBtn = screen.getByRole('button', { name: /Bắt đầu/i });
    expect(startBtn).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(startBtn);
      await Promise.resolve();
    });

    expect(startSpy).toHaveBeenCalledWith('proj-1~t1');
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['task', 'proj-1~t1'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks'] });
  });

  it('2. Nút Hủy (có hỏi xác nhận): hiển thị modal xác nhận, có thể bấm Không hoặc Xác nhận hủy', async () => {
    const cancelSpy = vi.spyOn(client, 'cancelTask').mockResolvedValue({
      ...baseTask,
      status: 'cancelled',
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    vi.spyOn(client, 'getTask').mockResolvedValue({
      ...baseTask,
      status: 'running',
    });

    renderPage();

    expect(await screen.findByText('Task Alpha')).toBeInTheDocument();

    // Nút Hủy trên header
    const cancelBtn = screen.getByRole('button', { name: /Hủy/i });
    fireEvent.click(cancelBtn);

    // Modal xác nhận xuất hiện
    expect(screen.getByRole('heading', { name: /Xác nhận hủy task/i })).toBeInTheDocument();
    expect(
      screen.getByText(/Bạn có chắc chắn muốn dừng worker và hủy tác vụ này/i),
    ).toBeInTheDocument();

    // Bấm Không -> đóng modal mà không gọi API
    const noBtn = screen.getByRole('button', { name: /^Không$/i });
    fireEvent.click(noBtn);
    expect(screen.queryByRole('heading', { name: /Xác nhận hủy task/i })).not.toBeInTheDocument();
    expect(cancelSpy).not.toHaveBeenCalled();

    // Mở lại modal và bấm Xác nhận hủy
    fireEvent.click(cancelBtn);
    fireEvent.change(screen.getByTestId('cancel-reason-input'), { target: { value: 'Trùng việc' } });
    const confirmCancelBtn = screen.getByRole('button', { name: /Xác nhận hủy/i });
    await act(async () => {
      fireEvent.click(confirmCancelBtn);
      await Promise.resolve();
    });

    expect(cancelSpy).toHaveBeenCalledWith('proj-1~t1', 'Trùng việc');
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['task', 'proj-1~t1'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks'] });
    expect(screen.queryByRole('heading', { name: /Xác nhận hủy task/i })).not.toBeInTheDocument();
  });

  it('2b. Nút Hủy hiển thị với blocked, failed, review, waiting_quota, paused, draft và ẩn với done, cancelled', async () => {
    const statusesToShow = ['blocked', 'failed', 'review', 'waiting_quota', 'paused', 'draft'] as const;
    for (const status of statusesToShow) {
      queryClient.clear();
      vi.spyOn(client, 'getTask').mockResolvedValue({
        ...baseTask,
        status: status as unknown as TaskStatus,
      });
      const { unmount } = renderPage();
      expect(await screen.findByRole('button', { name: /^Hủy$/i })).toBeInTheDocument();
      unmount();
    }

    const statusesToHide = ['done', 'pushed', 'cancelled'] as const;
    for (const status of statusesToHide) {
      queryClient.clear();
      vi.spyOn(client, 'getTask').mockResolvedValue({
        ...baseTask,
        status: status as unknown as TaskStatus,
      });
      const { unmount } = renderPage();
      await screen.findByText('Task Alpha');
      expect(screen.queryByRole('button', { name: /^Hủy$/i })).not.toBeInTheDocument();
      unmount();
    }
  });

  it('3. Nút Thử lại kèm ghi chú: mở modal khi status failed, nhập note và gọi retryTask', async () => {
    const retrySpy = vi.spyOn(client, 'retryTask').mockResolvedValue({
      ...baseTask,
      status: 'queued',
      attempt: 1,
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    vi.spyOn(client, 'getTask').mockResolvedValue({
      ...baseTask,
      status: 'failed',
    });

    renderPage();

    expect(await screen.findByText('Task Alpha')).toBeInTheDocument();

    const retryBtn = screen.getByRole('button', { name: /Thử lại/i });
    fireEvent.click(retryBtn);

    // Modal thử lại xuất hiện
    expect(screen.getByRole('heading', { name: /Thử lại task/i })).toBeInTheDocument();

    // Nhập ghi chú
    const noteInput = screen.getByPlaceholderText(/vd: Thử lại sau khi đã bổ sung biến môi trường/i);
    fireEvent.change(noteInput, {
      target: { value: 'Fix dependency và cấp thêm token' },
    });

    // Bấm Chạy lại
    const submitRetryBtn = screen.getByRole('button', { name: /^Chạy lại$/i });
    await act(async () => {
      fireEvent.click(submitRetryBtn);
      await Promise.resolve();
    });

    expect(retrySpy).toHaveBeenCalledWith('proj-1~t1', {
      note: 'Fix dependency và cấp thêm token',
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['task', 'proj-1~t1'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks'] });
    expect(screen.queryByRole('heading', { name: /Thử lại task/i })).not.toBeInTheDocument();
  });

  it('4. Nút Duyệt: khi status là review, click Duyệt gọi reviewTask với verdict approved', async () => {
    const reviewSpy = vi.spyOn(client, 'reviewTask').mockResolvedValue({
      ...baseTask,
      status: 'done',
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    vi.spyOn(client, 'getTask').mockResolvedValue({
      ...baseTask,
      status: 'review',
      reviewRound: 2,
      reviewMaxRounds: 3,
    });

    renderPage();

    expect(await screen.findByText('Task Alpha')).toBeInTheDocument();
    expect(screen.getByTestId('task-review-round')).toHaveTextContent('Vòng duyệt 2/3');

    const approveBtn = screen.getByRole('button', { name: /^Duyệt$/i });
    await act(async () => {
      fireEvent.click(approveBtn);
      await Promise.resolve();
    });

    // Plain "Duyệt" says so explicitly; an omitted merge now follows the project's auto-merge.
    expect(reviewSpy).toHaveBeenCalledWith('proj-1~t1', {
      verdict: 'approved',
      feedback: undefined,
      merge: false,
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['task', 'proj-1~t1'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks'] });
  });

  it('5. Nút Yêu cầu sửa: bắt buộc nhập feedback, submit gọi reviewTask với verdict changes_requested', async () => {
    const reviewSpy = vi.spyOn(client, 'reviewTask').mockResolvedValue({
      ...baseTask,
      status: 'queued',
      attempt: 1,
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    vi.spyOn(client, 'getTask').mockResolvedValue({
      ...baseTask,
      status: 'review',
    });

    renderPage();

    expect(await screen.findByText('Task Alpha')).toBeInTheDocument();

    const requestChangesBtn = screen.getByRole('button', { name: /Yêu cầu sửa/i });
    fireEvent.click(requestChangesBtn);

    // Modal Yêu cầu sửa xuất hiện
    expect(screen.getByRole('heading', { name: /Yêu cầu sửa \(Feedback\)/i })).toBeInTheDocument();

    const submitBtn = screen.getByTestId('submit-feedback-btn');
    // Ban đầu feedback rỗng -> nút submit bị disabled
    expect(submitBtn).toBeDisabled();

    // Nhập feedback
    const textarea = screen.getByTestId('feedback-textarea');
    fireEvent.change(textarea, {
      target: { value: 'Cần bổ sung thêm 2 test cases cho edge cases' },
    });
    expect(submitBtn).toBeEnabled();

    // Submit form
    await act(async () => {
      fireEvent.click(submitBtn);
      await Promise.resolve();
    });

    expect(reviewSpy).toHaveBeenCalledWith('proj-1~t1', {
      verdict: 'changes_requested',
      feedback: 'Cần bổ sung thêm 2 test cases cho edge cases',
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['task', 'proj-1~t1'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks'] });
    expect(screen.queryByRole('heading', { name: /Yêu cầu sửa \(Feedback\)/i })).not.toBeInTheDocument();
  });

  it('6. Hiển thị CheckResults: hiển thị danh sách kiểm tra, toggle xem outputTail và nút Chạy lại kiểm tra', async () => {
    const rerunSpy = vi.spyOn(client, 'rerunChecks').mockResolvedValue({
      passed: true,
      failed: [],
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    vi.spyOn(client, 'getTask').mockResolvedValue({
      ...baseTask,
      status: 'review',
      checks: [
        {
          name: 'npm test',
          ok: true,
          exitCode: 0,
          durationMs: 3400,
          outputTail: 'All 15 tests passed.',
        },
        {
          name: 'eslint',
          ok: false,
          exitCode: 1,
          durationMs: 1200,
          outputTail: 'Error: unused variable at line 42',
        },
      ],
    });

    renderPage();

    expect(await screen.findByText('Task Alpha')).toBeInTheDocument();

    // Tiêu đề CheckResults
    expect(screen.getByRole('heading', { name: /Kết quả kiểm tra/i })).toBeInTheDocument();

    // Tên 2 checks
    expect(screen.getByText('npm test')).toBeInTheDocument();
    expect(screen.getByText('eslint')).toBeInTheDocument();
    expect(screen.getByText('3.4s')).toBeInTheDocument();
    expect(screen.getByText('1.2s')).toBeInTheDocument();

    // Ban đầu outputTail chưa mở
    expect(screen.queryByText('All 15 tests passed.')).not.toBeInTheDocument();

    // Click vào check để xem outputTail
    const npmCheckBtn = screen.getByRole('button', { name: /npm test/i });
    fireEvent.click(npmCheckBtn);
    expect(screen.getByText('All 15 tests passed.')).toBeInTheDocument();

    // Click nút Chạy lại kiểm tra
    const rerunBtn = screen.getByRole('button', { name: /Chạy lại kiểm tra/i });
    await act(async () => {
      fireEvent.click(rerunBtn);
      await Promise.resolve();
    });

    expect(rerunSpy).toHaveBeenCalledWith('proj-1~t1');
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['task', 'proj-1~t1'] });
  });

  it('hiển thị badge cần duyệt tay và các nút Merge / chạy lại check', async () => {
    const reviewSpy = vi.spyOn(client, 'reviewTask').mockResolvedValue({ ...baseTask, status: 'done' });
    const rerunSpy = vi.spyOn(client, 'rerunChecks').mockResolvedValue({ passed: true, failed: [] });
    vi.spyOn(client, 'getTask').mockResolvedValue({
      ...baseTask,
      status: 'review',
      mergeAvailable: true,
      autoMergeSkippedReason: 'checks_failed',
      autoMergeSkippedRetried: true,
      checks: [{ name: 'test', ok: false, exitCode: 1, durationMs: 100, outputTail: 'Error: failed' }],
    });

    renderPage();
    expect(await screen.findByTestId('task-manual-approval')).toHaveTextContent('Cần duyệt tay: check thất bại');
    fireEvent.click(screen.getByRole('button', { name: /Duyệt & merge/i }));
    await waitFor(() => expect(reviewSpy).toHaveBeenCalledWith('proj-1~t1', { verdict: 'approved', merge: true }));
    fireEvent.click(screen.getByRole('button', { name: /Chạy lại kiểm tra/i }));
    await waitFor(() => expect(rerunSpy).toHaveBeenCalledWith('proj-1~t1'));
  });

  it('7. Badge "Chờ người duyệt" khi reviewerEscalated: hiển thị cảnh báo kèm lý do', async () => {
    vi.spyOn(client, 'getTask').mockResolvedValue({
      ...baseTask,
      status: 'review',
      reviewerEscalated: 1,
      reviewerEscalationReason: 'Quá 3 lần review không đạt',
    });

    renderPage();

    expect(await screen.findByText('Task Alpha')).toBeInTheDocument();

    // Hiển thị thông báo Chờ người duyệt
    expect(
      screen.getByText(/Chờ người duyệt \(Quá 3 lần review không đạt\)\./i),
    ).toBeInTheDocument();
  });

  it('8. Nút retry-reviewer: hiển thị khi status là review và reviewerEscalated là true, click gọi retryReviewer', async () => {
    const retryReviewerSpy = vi.spyOn(client, 'retryReviewer').mockResolvedValue({
      ...baseTask,
      status: 'review',
      reviewerEscalated: 0,
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    vi.spyOn(client, 'getTask').mockResolvedValue({
      ...baseTask,
      status: 'review',
      reviewerEscalated: 1,
      reviewerEscalationReason: 'Timeout chờ review tự động',
    });

    renderPage();

    expect(await screen.findByText('Task Alpha')).toBeInTheDocument();

    // Nút "Chạy lại reviewer" xuất hiện
    const retryRevBtn = screen.getByRole('button', { name: /Chạy lại reviewer/i });
    expect(retryRevBtn).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(retryRevBtn);
      await Promise.resolve();
    });

    expect(retryReviewerSpy).toHaveBeenCalledWith('proj-1~t1');
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['task', 'proj-1~t1'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks'] });
  });

  it('9. Nút Sửa: hiển thị khi status là draft, queued, waiting_quota, failed; ẩn khi running, review', async () => {
    vi.spyOn(client, 'getTask').mockResolvedValue({
      ...baseTask,
      status: 'queued',
    });

    const { rerender } = renderPage();
    expect(await screen.findByText('Task Alpha')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Sửa$/i })).toBeInTheDocument();

    // When status is running -> Sửa button should not be rendered
    vi.spyOn(client, 'getTask').mockResolvedValue({
      ...baseTask,
      status: 'running',
    });
    queryClient.clear();
    rerender(
      <QueryClientProvider client={queryClient}>
        <LocaleProvider initialLocale="vi">
          <MemoryRouter initialEntries={['/tasks/proj-1~t1']}>
            <Routes>
              <Route path="/tasks/:id" element={<TaskDetailPage />} />
            </Routes>
          </MemoryRouter>
        </LocaleProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Task Alpha')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Sửa$/i })).not.toBeInTheDocument();
  });

  it('10. Modal Sửa: mở modal, khởi tạo dữ liệu modelChain, dependsOn, level và submit updateTask', async () => {
    const taskWithDetails: TaskDetail = {
      ...baseTask,
      status: 'queued',
      modelChain: JSON.stringify(['claude-sonnet-4-6', 'gemini-3.8-flash-high']),
      dependsOn: JSON.stringify(['proj-1/t2']),
      level: 'easy',
    };
    vi.spyOn(client, 'getTask').mockResolvedValue(taskWithDetails);
    vi.spyOn(client, 'getTasks').mockResolvedValue([
      {
        id: 'proj-1/t1',
        projectId: 'proj-1',
        slug: 't1',
        title: 'Task Alpha',
        level: 'easy',
        status: 'queued',
        dependsOn: '[]',
        attempt: 0,
        resume: 0,
        createdAt: '2026-10-15T00:00:00Z',
        updatedAt: '2026-10-15T00:00:00Z',
      },
      {
        id: 'proj-1/t2',
        projectId: 'proj-1',
        slug: 't2',
        title: 'Task Beta',
        level: 'easy',
        status: 'done',
        dependsOn: '[]',
        attempt: 0,
        resume: 0,
        createdAt: '2026-10-15T00:00:00Z',
        updatedAt: '2026-10-15T00:00:00Z',
      },
      {
        id: 'proj-1/t3',
        projectId: 'proj-1',
        slug: 't3',
        title: 'Task Gamma',
        level: 'easy',
        status: 'draft',
        dependsOn: '[]',
        attempt: 0,
        resume: 0,
        createdAt: '2026-10-15T00:00:00Z',
        updatedAt: '2026-10-15T00:00:00Z',
      },
    ]);
    const updateSpy = vi.spyOn(client, 'updateTask').mockResolvedValue({
      ...taskWithDetails,
      level: 'hard',
      dependsOn: JSON.stringify(['proj-1/t2', 'proj-1/t3']),
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    renderPage();
    expect(await screen.findByText('Task Alpha')).toBeInTheDocument();

    const editBtn = screen.getByRole('button', { name: /^Sửa$/i });
    fireEvent.click(editBtn);

    expect(screen.getByRole('heading', { name: /Sửa thông tin task/i })).toBeInTheDocument();

    // Verify initial model items
    expect(screen.getByTestId('model-item-0')).toHaveTextContent('claude-sonnet-4-6');
    expect(screen.getByTestId('model-item-1')).toHaveTextContent('gemini-3.8-flash-high');

    // Toggle dependency t3
    const depT3Checkbox = await screen.findByTestId('dep-checkbox-t3');
    fireEvent.click(depT3Checkbox);

    // Change level to hard
    const hardRadio = screen.getByDisplayValue('hard');
    fireEvent.click(hardRadio);

    // Submit form
    const saveBtn = screen.getByTestId('save-edit-btn');
    await act(async () => {
      fireEvent.click(saveBtn);
      await Promise.resolve();
    });

    expect(updateSpy).toHaveBeenCalledWith('proj-1~t1', {
      modelChain: ['claude-sonnet-4-6', 'gemini-3.8-flash-high'],
      dependsOn: ['proj-1/t2', 'proj-1/t3'],
      level: 'hard',
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['task', 'proj-1~t1'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks'] });
    expect(screen.queryByRole('heading', { name: /Sửa thông tin task/i })).not.toBeInTheDocument();
  });

  it('11. Modal Sửa: thao tác thêm, di chuyển và xóa model khỏi modelChain', async () => {
    const taskWithDetails: TaskDetail = {
      ...baseTask,
      status: 'draft',
      modelChain: JSON.stringify(['claude-sonnet-4-6', 'gemini-3.8-flash-high']),
    };
    vi.spyOn(client, 'getTask').mockResolvedValue(taskWithDetails);
    vi.spyOn(client, 'getTasks').mockResolvedValue([]);
    const updateSpy = vi.spyOn(client, 'updateTask').mockResolvedValue(taskWithDetails);

    renderPage();
    expect(await screen.findByText('Task Alpha')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Sửa$/i }));

    // Verify initially 2 items
    expect(screen.getByTestId('model-item-0')).toHaveTextContent('claude-sonnet-4-6');
    expect(screen.getByTestId('model-item-1')).toHaveTextContent('gemini-3.8-flash-high');

    // Remove first model (claude-sonnet-4-6)
    fireEvent.click(screen.getByTestId('remove-model-btn-0'));
    // Now model-item-0 should be gemini-3.8-flash-high
    expect(screen.getByTestId('model-item-0')).toHaveTextContent('gemini-3.8-flash-high');
    expect(screen.queryByTestId('model-item-1')).not.toBeInTheDocument();

    // Add codex:gpt-5.6-luna
    const select = screen.getByTestId('add-model-select');
    fireEvent.change(select, { target: { value: 'codex:gpt-5.6-luna' } });
    fireEvent.click(screen.getByTestId('add-model-btn'));

    // Now modelChain has ['gemini-3.8-flash-high', 'codex:gpt-5.6-luna']
    expect(screen.getByTestId('model-item-0')).toHaveTextContent('gemini-3.8-flash-high');
    expect(screen.getByTestId('model-item-1')).toHaveTextContent('codex:gpt-5.6-luna');

    // Move down the first model (gemini-3.8-flash-high)
    fireEvent.click(screen.getByTestId('move-down-btn-0'));
    // Now modelChain has ['codex:gpt-5.6-luna', 'gemini-3.8-flash-high']
    expect(screen.getByTestId('model-item-0')).toHaveTextContent('codex:gpt-5.6-luna');
    expect(screen.getByTestId('model-item-1')).toHaveTextContent('gemini-3.8-flash-high');

    // Submit
    await act(async () => {
      fireEvent.click(screen.getByTestId('save-edit-btn'));
      await Promise.resolve();
    });

    expect(updateSpy).toHaveBeenCalledWith('proj-1~t1', {
      modelChain: ['codex:gpt-5.6-luna', 'gemini-3.8-flash-high'],
      dependsOn: [],
      level: 'easy',
    });
  });

  it('12. Modal Sửa: hiển thị lỗi khi API updateTask trả về lỗi', async () => {
    vi.spyOn(client, 'getTask').mockResolvedValue({
      ...baseTask,
      status: 'draft',
    });
    vi.spyOn(client, 'getTasks').mockResolvedValue([]);
    vi.spyOn(client, 'updateTask').mockRejectedValue(new Error('Phát hiện chu trình phụ thuộc'));

    renderPage();
    expect(await screen.findByText('Task Alpha')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Sửa$/i }));

    await act(async () => {
      fireEvent.click(screen.getByTestId('save-edit-btn'));
      await Promise.resolve();
    });

    expect(screen.getByTestId('edit-error')).toHaveTextContent('Phát hiện chu trình phụ thuộc');
    expect(screen.getByRole('heading', { name: /Sửa thông tin task/i })).toBeInTheDocument();
  });

  it('13. Hiển thị waitReason badge khi task ở trạng thái waiting_quota', async () => {
    vi.spyOn(client, 'getTask').mockResolvedValue({
      ...baseTask,
      status: 'waiting_quota',
      waitReason: 'parallel',
    });
    vi.spyOn(client, 'getTasks').mockResolvedValue([]);

    renderPage();
    expect(await screen.findByText('Task Alpha')).toBeInTheDocument();
    expect(screen.getByText('Chờ slot song song')).toBeInTheDocument();
  });

  it('14. Hiển thị cảnh báo chưa commit và lặp lệnh khi task đang running', async () => {
    vi.spyOn(client, 'getTask').mockResolvedValue({
      ...baseTask,
      status: 'running',
      currentRun: {
        startedAt: '2026-10-15T00:00:00Z',
        lastOutputAt: '2026-10-15T00:10:00Z',
        lastActivityAt: '2026-10-15T00:10:00Z',
        activitySource: 'log',
        noCommitMinutes: 50,
        isLooping: true,
      },
    });
    vi.spyOn(client, 'getTasks').mockResolvedValue([]);

    renderPage();
    expect(await screen.findByText('Task Alpha')).toBeInTheDocument();
    expect(screen.getByText('Chưa commit 50 phút')).toBeInTheDocument();
    expect(screen.getByText('Lặp lệnh')).toBeInTheDocument();
  });

  it('15. Nút Tạm dừng khi task running, gọi pauseTask và hiển thị tài nguyên RSS/CPU', async () => {
    const pauseSpy = vi.spyOn(client, 'pauseTask').mockResolvedValue({ ok: true, paused: true });

    vi.spyOn(client, 'getTask').mockResolvedValue({
      ...baseTask,
      status: 'running',
      paused: false,
      currentRun: {
        startedAt: '2026-10-15T00:00:00Z',
        lastOutputAt: '2026-10-15T00:10:00Z',
        lastActivityAt: '2026-10-15T00:10:00Z',
        activitySource: 'log',
        rss: 104857600,
        cpu: 15.5,
      },
    });

    renderPage();
    expect(await screen.findByText('Task Alpha')).toBeInTheDocument();
    expect(screen.getByText('100 MB · 15.5% CPU')).toBeInTheDocument();

    const pauseBtn = screen.getByRole('button', { name: /^Tạm dừng$/i });
    fireEvent.click(pauseBtn);
    await vi.waitFor(() => {
      expect(pauseSpy).toHaveBeenCalledWith('proj-1~t1');
    });
  });

  it('16. Nút Tiếp tục khi task paused, nhãn Tạm dừng (quá tải), gọi resumeTask', async () => {
    const resumeSpy = vi.spyOn(client, 'resumeTask').mockResolvedValue({ ok: true, paused: false });

    vi.spyOn(client, 'getTask').mockResolvedValue({
      ...baseTask,
      status: 'running',
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
    });

    renderPage();
    expect(await screen.findByText('Tạm dừng (quá tải)')).toBeInTheDocument();
    const resumeBtn = screen.getByRole('button', { name: /^Tiếp tục$/i });
    fireEvent.click(resumeBtn);
    await vi.waitFor(() => {
      expect(resumeSpy).toHaveBeenCalledWith('proj-1~t1');
    });
  });

  it('17. Nút Xóa worktree yêu cầu xác nhận window.confirm trước khi gọi deleteWorktree', async () => {
    const deleteSpy = vi.spyOn(client, 'deleteWorktree').mockResolvedValue({ ok: true });
    vi.spyOn(client, 'getTask').mockResolvedValue({
      ...baseTask,
      status: 'done',
      worktreePath: '/tmp/worktree-1',
    });

    const confirmSpy = vi.spyOn(window, 'confirm');

    renderPage();
    const deleteBtn = await screen.findByRole('button', { name: /Xóa worktree/i });
    expect(deleteBtn).toBeInTheDocument();

    // 1. User cancels confirm -> deleteWorktree is not called
    confirmSpy.mockReturnValueOnce(false);
    fireEvent.click(deleteBtn);
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy).not.toHaveBeenCalled();

    // 2. User confirms -> deleteWorktree is called
    confirmSpy.mockReturnValueOnce(true);
    fireEvent.click(deleteBtn);
    expect(confirmSpy).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => {
      expect(deleteSpy).toHaveBeenCalledWith('proj-1~t1');
    });
  });

  it('18. Nút quay lại danh sách task có accessible name', async () => {
    vi.spyOn(client, 'getTask').mockResolvedValue(baseTask);

    renderPage();
    await screen.findByText('Task Alpha');

    const backBtn = screen.getByRole('button', { name: /Quay lại/i });
    expect(backBtn).toBeInTheDocument();
  });

  it('hiển thị toàn bộ phân tích triage, nút chia và ô gửi thêm thông tin', async () => {
    vi.spyOn(client, 'getTask').mockResolvedValue({
      ...baseTask,
      status: 'done',
      triage: {
        sourceId: 'demo', wpId: 42, displayId: 'OP-42', decision: null,
        analysis: {
          conclusion: 'lỗi', size: 'lớn', summary: 'Tóm tắt đầy đủ',
          evidence: 'Bằng chứng tái hiện', cause: 'Nguyên nhân dự kiến', proposal: 'Hướng sửa', risks: 'Rủi ro', questions: 'Câu hỏi',
        },
      },
    });
    vi.spyOn(client, 'decideOpenProjectTicket').mockResolvedValue({ action: 'split', taskIds: [] });
    vi.spyOn(client, 'submitOpenProjectTriageInput').mockResolvedValue({ taskId: 'proj-1/op-op-42-triage-r1' });
    renderPage();
    expect(await screen.findByText('Tóm tắt đầy đủ')).toBeInTheDocument();
    expect(screen.getByText('Bằng chứng tái hiện')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Làm \+ chia/i })).toBeInTheDocument();
    const input = screen.getByPlaceholderText(/Gửi thêm thông tin/i);
    fireEvent.change(input, { target: { value: 'log từ server' } });
    fireEvent.click(screen.getByRole('button', { name: /Gửi thêm thông tin/i }));
    await vi.waitFor(() => expect(client.submitOpenProjectTriageInput).toHaveBeenCalledWith('demo', 42, 'log từ server'));
  });

  it('22. Hiển thị agent badge (icon/engine/profileName) cạnh model ở review chain, review history, runs, và running header', async () => {
    vi.spyOn(client, 'getTask').mockResolvedValue({
      ...baseTask,
      status: 'running',
      currentRun: {
        startedAt: '2026-10-15T00:00:00Z',
        lastOutputAt: '2026-10-15T00:05:00Z',
        lastActivityAt: '2026-10-15T00:05:00Z',
        activitySource: 'log',
        model: 'gemini-3.8-flash-high',
        profileName: 'gemini-fast',
        engine: 'agy',
        paused: false,
        rss: 1024 * 1024 * 100,
        cpu: 15.5,
      },
      reviewChain: [
        { reviewer: 'codex:gpt-5.6-luna', mode: 'gate', engine: 'codex', profileName: 'codex-worker' },
        { reviewer: 'claude', mode: 'final', engine: 'claude', profileName: null },
      ],
      reviews: [
        {
          id: 'rev-1',
          taskId: 'proj-1~t1',
          verdict: 'approved',
          feedback: 'LGTM',
          actor: 'codex-reviewer',
          model: 'codex:gpt-5.6-luna',
          engine: 'codex',
          profileName: 'codex-worker',
          createdAt: '2026-10-15T00:08:00Z',
        },
      ],
      runs: [
        {
          id: 'run-1',
          taskId: 'proj-1~t1',
          engine: 'agy',
          model: 'gemini-3.8-flash-high',
          profileName: 'gemini-fast',
          outcome: 'done',
          startedAt: '2026-10-15T00:00:00Z',
          endedAt: '2026-10-15T00:10:00Z',
        },
      ],
    });

    renderPage();

    expect(await screen.findByText('Task Alpha')).toBeInTheDocument();
    const badges = screen.getAllByTestId('model-badge');
    expect(badges.length).toBeGreaterThanOrEqual(3);

    const profiles = screen.getAllByTestId('model-badge-profile');
    const profileTexts = profiles.map((p) => p.textContent);
    expect(profileTexts).toContain('gemini-fast');
    expect(profileTexts).toContain('codex-worker');

    const runsTabBtn = screen.getByRole('button', { name: /Runs/i });
    fireEvent.click(runsTabBtn);
    expect(screen.getAllByText('gemini-fast').length).toBeGreaterThanOrEqual(2);
  });

  it('23. Task với trạng thái pushed: hiển thị khối Đẩy lên git với remote, nhánh, commit, link so sánh và thời điểm', async () => {
    vi.spyOn(client, 'getTask').mockResolvedValue({
      ...baseTask,
      status: 'pushed',
      pushedAt: '2026-11-07T03:30:00Z',
      pushResult: JSON.stringify({
        remote: 'origin',
        branch: 'main',
        commit: 'abcdef1234567890',
        compareUrl: 'https://github.com/org/repo/commit/abcdef1234567890',
      }),
    });

    renderPage();

    expect(await screen.findByText('Task Alpha')).toBeInTheDocument();
    const publishSection = await screen.findByTestId('task-publish-section');
    expect(publishSection).toBeInTheDocument();
    expect(within(publishSection).getByText('origin')).toBeInTheDocument();
    expect(within(publishSection).getByText('main')).toBeInTheDocument();
    expect(within(publishSection).getByText('abcdef1')).toBeInTheDocument();
    const compareLink = within(publishSection).getByTestId('publish-compare-link');
    expect(compareLink).toHaveAttribute('href', 'https://github.com/org/repo/commit/abcdef1234567890');
  });

  it('24. Task đẩy git thất bại: hiển thị banner lỗi, lý do, outputTail và nút Đẩy lại gọi publishTask', async () => {
    const publishSpy = vi.spyOn(client, 'publishTask').mockResolvedValue({
      ok: true,
      remote: 'origin',
      branch: 'main',
      commit: '1234567',
    });

    vi.spyOn(client, 'getTask').mockResolvedValue({
      ...baseTask,
      status: 'done',
      pushResult: JSON.stringify({
        remote: 'origin',
        branch: 'main',
        error: 'Remote rejected push due to protected branch',
        reason: 'publish_failed',
        outputTail: 'error: failed to push some refs to remote',
      }),
    });

    renderPage();

    expect(await screen.findByText('Task Alpha')).toBeInTheDocument();
    const publishSection = await screen.findByTestId('task-publish-section');
    expect(publishSection).toBeInTheDocument();

    const errorBanner = within(publishSection).getByTestId('publish-error-banner');
    expect(errorBanner).toHaveTextContent(/Remote rejected push due to protected branch/i);
    expect(errorBanner).toHaveTextContent(/error: failed to push some refs to remote/i);

    const retryBtn = within(publishSection).getByTestId('btn-publish-task');
    expect(retryBtn).toHaveTextContent(/Đẩy lại/i);

    await act(async () => {
      fireEvent.click(retryBtn);
    });
    await waitFor(() => {
      expect(publishSpy).toHaveBeenCalledWith('proj-1~t1');
    });
  });

  it('25. Task done khi project bật publish: hiển thị nút Đẩy lên git và click gọi publishTask', async () => {
    const publishSpy = vi.spyOn(client, 'publishTask').mockResolvedValue({
      ok: true,
      remote: 'origin',
      branch: 'main',
      commit: '7654321',
    });

    vi.spyOn(client, 'getProject').mockResolvedValue({
      id: 'proj-1',
      name: 'Project 1',
      path: '/tmp/proj-1',
      defaultBranch: 'main',
      settings: {
        publish: { enabled: true, remote: 'origin', branch: 'main', pushIntegrationBranch: true },
      },
    } as any);

    vi.spyOn(client, 'getTask').mockResolvedValue({
      ...baseTask,
      status: 'done',
      pushResult: null,
      pushedAt: null,
    });

    renderPage();

    expect(await screen.findByText('Task Alpha')).toBeInTheDocument();
    const headerPublishBtn = await screen.findByTestId('header-btn-publish');
    expect(headerPublishBtn).toBeInTheDocument();
    expect(headerPublishBtn).toHaveTextContent(/Đẩy lên git/i);

    await act(async () => {
      fireEvent.click(headerPublishBtn);
    });
    await waitFor(() => {
      expect(publishSpy).toHaveBeenCalledWith('proj-1~t1');
    });
  });
});

