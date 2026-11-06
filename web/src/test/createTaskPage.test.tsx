import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CreateTaskPage } from '../pages/CreateTaskPage';
import { LocaleProvider } from '../context/LocaleContext';
import * as client from '../api/client';
import { Project, Task } from '../types/api';

describe('CreateTaskPage', () => {
  let queryClient: QueryClient;

  const mockProjects: Project[] = [
    {
      id: 'proj-1',
      name: 'AgentHub',
      path: '/home/user/agenthub',
      defaultBranch: 'main',
      maxParallel: 3,
    },
    {
      id: 'proj-2',
      name: 'XFarm',
      path: '/home/user/xfarm',
      defaultBranch: 'main',
      maxParallel: 2,
    },
  ];

  const mockTasks: Task[] = [
    {
      id: 'proj-1/auth',
      projectId: 'proj-1',
      slug: 'auth',
      title: 'Setup Authentication',
      level: 'easy',
      status: 'done',
      dependsOn: '[]',
      attempt: 0,
      resume: 0,
      createdAt: '2026-10-15T00:00:00Z',
      updatedAt: '2026-10-15T00:00:00Z',
    },
    {
      id: 'proj-1/db',
      projectId: 'proj-1',
      slug: 'db',
      title: 'Database Schema Migration',
      level: 'hard',
      status: 'queued',
      dependsOn: '[]',
      attempt: 0,
      resume: 0,
      createdAt: '2026-10-15T00:00:00Z',
      updatedAt: '2026-10-15T00:00:00Z',
    },
  ];

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });

    vi.spyOn(client, 'getProjects').mockResolvedValue(mockProjects);
    vi.spyOn(client, 'getTasks').mockResolvedValue(mockTasks);
    vi.spyOn(client, 'getOpenProjectSources').mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function renderPage() {
    return render(
      <QueryClientProvider client={queryClient}>
        <LocaleProvider initialLocale="vi">
          <MemoryRouter>
            <CreateTaskPage />
          </MemoryRouter>
        </LocaleProvider>
      </QueryClientProvider>,
    );
  }

  it('1. Validate slug: báo lỗi khi để trống slug và không gọi API', async () => {
    const createSpy = vi.spyOn(client, 'createTask');
    renderPage();

    expect(await screen.findByText('Tạo task mới')).toBeInTheDocument();

    // Điền tiêu đề nhưng bỏ trống slug
    fireEvent.change(screen.getByPlaceholderText(/Mô tả tóm tắt mục tiêu/i), {
      target: { value: 'Task không có slug' },
    });

    const submitBtn = screen.getByRole('button', { name: /Tạo Task/i });
    fireEvent.click(submitBtn);

    expect(await screen.findByText(/Vui lòng nhập slug/i)).toBeInTheDocument();
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('2. Validate title: báo lỗi khi để trống tiêu đề và không gọi API', async () => {
    const createSpy = vi.spyOn(client, 'createTask');
    renderPage();

    expect(await screen.findByText('Tạo task mới')).toBeInTheDocument();

    // Điền slug nhưng bỏ trống tiêu đề
    fireEvent.change(screen.getByPlaceholderText('vd: user-auth, bugfix-login'), {
      target: { value: 'my-task-slug' },
    });

    const submitBtn = screen.getByRole('button', { name: /Tạo Task/i });
    fireEvent.click(submitBtn);

    expect(await screen.findByText(/Vui lòng nhập tiêu đề/i)).toBeInTheDocument();
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('3. Chọn và bỏ chọn dependsOn trong danh sách các task phụ thuộc', async () => {
    renderPage();

    expect(await screen.findByText('Setup Authentication')).toBeInTheDocument();
    expect(screen.getByText('Database Schema Migration')).toBeInTheDocument();

    const checkboxes = screen.getAllByRole('checkbox');
    const authCheckbox = checkboxes[0]; // first task checkbox
    const dbCheckbox = checkboxes[1]; // second task checkbox

    // Click chọn auth
    fireEvent.click(authCheckbox);
    expect(authCheckbox).toBeChecked();
    expect(dbCheckbox).not.toBeChecked();

    // Click chọn thêm db
    fireEvent.click(dbCheckbox);
    expect(dbCheckbox).toBeChecked();

    // Bỏ chọn auth
    fireEvent.click(authCheckbox);
    expect(authCheckbox).not.toBeChecked();
    expect(dbCheckbox).toBeChecked();
  });

  it('hiển thị checkbox tạo ticket khi project đã bật OpenProject', async () => {
    vi.mocked(client.getProjects).mockResolvedValueOnce([
      { ...mockProjects[0], settings: { openproject: { enabled: true, sourceId: 'demo', role: 'primary' } } as any },
      mockProjects[1],
    ]);
    vi.mocked(client.getOpenProjectSources).mockResolvedValueOnce([{
      id: 'demo', url: 'https://op.example.test', project: 'demo', pollIntervalSec: 60,
      watchStatusIds: [], reopenedStatusIds: [], resolvedStatusId: null, reviewStatusId: null, openStatusIds: [],
      minTicketNumber: 0, autoStart: true, autoResolve: true, language: 'vi',
    }]);
    renderPage();
    expect(await screen.findByText(/Tạo ticket trên OpenProject/)).toBeInTheDocument();
  });

  it('không hiển thị checkbox tạo ticket khi project chưa bật OpenProject', async () => {
    renderPage();
    await screen.findByText('Tạo task mới');
    expect(screen.queryByText(/Tạo ticket trên OpenProject/)).not.toBeInTheDocument();
  });

  it('4. Xem trước markdown trong tab Preview và quay lại tab Soạn thảo', async () => {
    renderPage();

    expect(await screen.findByText('Tạo task mới')).toBeInTheDocument();

    const editTextarea = screen.getByPlaceholderText(/Nhập yêu cầu, tiêu chí nghiệm thu/i);
    fireEvent.change(editTextarea, {
      target: { value: '# Tiêu đề Heading\n\nNội dung **chữ đậm** và danh sách:\n- việc 1\n- việc 2' },
    });

    // Chuyển sang tab Xem trước
    const previewTabBtn = screen.getByRole('button', { name: /Xem trước/i });
    fireEvent.click(previewTabBtn);

    // Textarea không còn hiển thị
    expect(screen.queryByPlaceholderText(/Nhập yêu cầu, tiêu chí nghiệm thu/i)).not.toBeInTheDocument();

    // Markdown được render
    expect(screen.getByRole('heading', { level: 1, name: 'Tiêu đề Heading' })).toBeInTheDocument();
    expect(screen.getByText('chữ đậm')).toBeInTheDocument();
    expect(screen.getByText('việc 1')).toBeInTheDocument();

    // Chuyển lại tab Soạn thảo
    const editTabBtn = screen.getByRole('button', { name: /Soạn thảo/i });
    fireEvent.click(editTabBtn);

    const restoredTextarea = screen.getByPlaceholderText(/Nhập yêu cầu, tiêu chí nghiệm thu/i);
    expect(restoredTextarea).toHaveValue(
      '# Tiêu đề Heading\n\nNội dung **chữ đậm** và danh sách:\n- việc 1\n- việc 2',
    );
  });

  it('5. Hiển thị thông báo khi xem trước markdown mà chưa có nội dung', async () => {
    renderPage();

    expect(await screen.findByText('Tạo task mới')).toBeInTheDocument();

    // Chuyển thẳng sang tab Xem trước khi body trống
    const previewTabBtn = screen.getByRole('button', { name: /Xem trước/i });
    fireEvent.click(previewTabBtn);

    expect(screen.getByText(/Chưa có nội dung.*xem trước/i)).toBeInTheDocument();
  });

  it('6. Submit thành công gọi createTask với đầy đủ thông tin (level, dependsOn, startImmediately)', async () => {
    const createSpy = vi.spyOn(client, 'createTask').mockResolvedValue({
      id: 'proj-1/new-feature',
      projectId: 'proj-1',
      slug: 'new-feature',
      title: 'Tính năng mới',
      level: 'hard',
      status: 'queued',
      dependsOn: '["proj-1/auth"]',
      attempt: 0,
      resume: 0,
      createdAt: '2026-10-15T00:00:00Z',
      updatedAt: '2026-10-15T00:00:00Z',
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    renderPage();

    expect(await screen.findByText('Tạo task mới')).toBeInTheDocument();

    // Điền slug
    fireEvent.change(screen.getByPlaceholderText('vd: user-auth, bugfix-login'), {
      target: { value: 'new-feature' },
    });

    // Điền title
    fireEvent.change(screen.getByPlaceholderText(/Mô tả tóm tắt mục tiêu/i), {
      target: { value: 'Tính năng mới' },
    });

    // Chọn level Hard (radio)
    const hardRadio = screen.getByDisplayValue('hard');
    fireEvent.click(hardRadio);

    // Nhập body
    fireEvent.change(screen.getByPlaceholderText(/Nhập yêu cầu, tiêu chí nghiệm thu/i), {
      target: { value: 'Nội dung mô tả task' },
    });

    // Chọn dependsOn cho proj-1/auth
    const checkboxes = screen.getAllByRole('checkbox');
    const authCheckbox = checkboxes[0];
    fireEvent.click(authCheckbox);

    // Tích chọn "Bắt đầu ngay sau khi tạo"
    const startCheckbox = screen.getByLabelText(/Bắt đầu ngay/i);
    fireEvent.click(startCheckbox);

    // Submit
    const submitBtn = screen.getByRole('button', { name: /Tạo Task/i });
    await act(async () => {
      fireEvent.click(submitBtn);
      await Promise.resolve();
    });

    expect(createSpy).toHaveBeenCalledWith(
      {
        project: 'proj-1',
        slug: 'new-feature',
        title: 'Tính năng mới',
        level: 'hard',
        body: 'Nội dung mô tả task',
        dependsOn: ['proj-1/auth'],
        start: true,
      },
      expect.anything(),
    );

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['status'] });
  });

  it('7. Hiển thị thông báo lỗi khi API createTask trả về lỗi', async () => {
    vi.spyOn(client, 'createTask').mockRejectedValue(new Error('Slug đã tồn tại'));

    renderPage();

    expect(await screen.findByText('Tạo task mới')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('vd: user-auth, bugfix-login'), {
      target: { value: 'duplicate-slug' },
    });
    fireEvent.change(screen.getByPlaceholderText(/Mô tả tóm tắt mục tiêu/i), {
      target: { value: 'Tiêu đề' },
    });

    const submitBtn = screen.getByRole('button', { name: /Tạo Task/i });
    await act(async () => {
      fireEvent.click(submitBtn);
      await Promise.resolve();
    });

    expect(await screen.findByText('Slug đã tồn tại')).toBeInTheDocument();
  });

  it('hiển thị cảnh báo merge sau khi tạo task nếu API trả về mergeWarning', async () => {
    vi.spyOn(client, 'createTask').mockResolvedValue({
      id: 'proj-1/merge-warning',
      projectId: 'proj-1',
      slug: 'merge-warning',
      title: 'Task cần cảnh báo',
      level: 'easy',
      status: 'draft',
      mergeWarning: 'Project chưa có worktree tích hợp cho nhánh main.',
      dependsOn: '[]',
      attempt: 0,
      resume: 0,
      createdAt: '2026-10-15T00:00:00Z',
      updatedAt: '2026-10-15T00:00:00Z',
    });

    renderPage();
    expect(await screen.findByText('Tạo task mới')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('vd: user-auth, bugfix-login'), { target: { value: 'merge-warning' } });
    fireEvent.change(screen.getByPlaceholderText(/Mô tả tóm tắt mục tiêu/i), { target: { value: 'Task cần cảnh báo' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Tạo Task/i }));
      await Promise.resolve();
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('Project chưa có worktree tích hợp cho nhánh main.');
    expect(screen.getByRole('button', { name: /Mở task vừa tạo/i })).toBeInTheDocument();
  });
});
