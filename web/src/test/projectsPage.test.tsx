import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProjectsPage } from '../pages/ProjectsPage';
import { LocaleProvider } from '../context/LocaleContext';
import * as client from '../api/client';
import { Project } from '../types/api';

describe('ProjectsPage', () => {
  let queryClient: QueryClient;

  const mockProject: Project = {
    id: 'proj-1',
    name: 'XFarm',
    path: '/home/user/projects/xfarm',
    defaultBranch: 'main',
    maxParallel: 3,
    envTemplate: null,
    checks: null,
  };

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    vi.spyOn(client, 'getProjects').mockResolvedValue([mockProject]);
    vi.spyOn(client, 'getDepartments').mockResolvedValue([
      { id: 'chung', name: 'Chung', priority: 0, maxParallel: 0, claudeDailyTokenBudget: 0, telegramTopicId: null, profiles: [], projects: [], createdAt: '2026-01-01T00:00:00Z' },
      { id: 'engineering', name: 'Engineering', priority: 1, maxParallel: 2, claudeDailyTokenBudget: 0, telegramTopicId: null, profiles: [], projects: [], createdAt: '2026-01-01T00:00:00Z' },
    ]);
    vi.spyOn(client, 'getConfig').mockResolvedValue({
      modelChainHard: ['codex:gpt-5.6-luna'],
      modelChainEasy: ['gemini-3.8-flash-high'],
      defaultTimeout: 10800,
      brain: {
        dailyTokenBudget: 10000000,
        maxTurnsPerHour: 20,
      },
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function renderPage(initialEntries = ['/projects']) {
    return render(
      <QueryClientProvider client={queryClient}>
        <LocaleProvider initialLocale="vi">
          <MemoryRouter initialEntries={initialEntries}>
            <Routes>
              <Route path="/projects" element={<ProjectsPage />} />
              <Route path="/projects/:id/settings" element={<ProjectsPage />} />
            </Routes>
          </MemoryRouter>
        </LocaleProvider>
      </QueryClientProvider>,
    );
  }

  it('1. Đăng ký project thành công và gọi createProject với các giá trị hợp lệ', async () => {
    const createSpy = vi.spyOn(client, 'createProject').mockResolvedValue({
      id: 'proj-2',
      name: 'AgentHub',
      path: '/home/user/projects/agenthub',
      defaultBranch: 'main',
      maxParallel: 3,
      envTemplate: null,
      checks: null,
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    renderPage();

    // Chờ danh sách load
    expect(await screen.findByText('XFarm')).toBeInTheDocument();

    // Mở form đăng ký
    const registerBtn = screen.getByRole('button', { name: /Đăng ký Project/i });
    fireEvent.click(registerBtn);

    expect(
      screen.getByRole('heading', { name: /Đăng ký Project mới/i }),
    ).toBeInTheDocument();

    // Điền thông tin
    fireEvent.change(screen.getByPlaceholderText('vd: XFarm, AgentHub'), {
      target: { value: 'AgentHub' },
    });
    fireEvent.change(
      screen.getByPlaceholderText('vd: /home/user/projects/xfarm'),
      {
        target: { value: '/home/user/projects/agenthub' },
      },
    );

    // Submit form
    const saveBtn = screen.getByRole('button', { name: /Lưu Project/i });
    await act(async () => {
      fireEvent.click(saveBtn);
      await Promise.resolve();
    });

    expect(createSpy).toHaveBeenCalledWith(
      {
        name: 'AgentHub',
        path: '/home/user/projects/agenthub',
        defaultBranch: 'main',
        maxParallel: 3,
        envTemplate: null,
        checks: null,
      },
      expect.anything(),
    );

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['projects'] });
    // Form đóng lại
    expect(
      screen.queryByRole('heading', { name: /Đăng ký Project mới/i }),
    ).not.toBeInTheDocument();
  });

  it('2. envTemplate JSON sai cú pháp thì hiện lỗi validation và vô hiệu hóa nút submit', async () => {
    renderPage();

    expect(await screen.findByText('XFarm')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Đăng ký Project/i }));

    const envTextarea = screen.getByTestId('env-template-textarea');
    const saveBtn = screen.getByRole('button', { name: /Lưu Project/i });

    // Nhập JSON không hợp lệ
    fireEvent.change(envTextarea, {
      target: { value: '{"PORT": 3000, }' },
    });

    const errorMsg = screen.getByTestId('json-error-msg');
    expect(errorMsg).toBeInTheDocument();
    expect(errorMsg).toHaveTextContent(/JSON không hợp lệ/i);
    expect(saveBtn).toBeDisabled();

    // Nhập lại JSON hợp lệ
    fireEvent.change(envTextarea, {
      target: { value: '{"PORT": 3000}' },
    });

    expect(screen.queryByTestId('json-error-msg')).not.toBeInTheDocument();
    expect(screen.getByText(/JSON hợp lệ/i)).toBeInTheDocument();
    expect(saveBtn).toBeEnabled();
  });

  it('3. Sửa maxParallel trong form đăng ký project và submit giá trị mới', async () => {
    const createSpy = vi.spyOn(client, 'createProject').mockResolvedValue({
      id: 'proj-3',
      name: 'HighConcurrency',
      path: '/path/parallel',
      defaultBranch: 'main',
      maxParallel: 6,
      envTemplate: null,
      checks: null,
    });

    renderPage();

    expect(await screen.findByText('XFarm')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Đăng ký Project/i }));

    fireEvent.change(screen.getByPlaceholderText('vd: XFarm, AgentHub'), {
      target: { value: 'HighConcurrency' },
    });
    fireEvent.change(
      screen.getByPlaceholderText('vd: /home/user/projects/xfarm'),
      {
        target: { value: '/path/parallel' },
      },
    );

    // Thay đổi maxParallel sang 6
    const maxParallelInput = screen.getByRole('spinbutton');
    fireEvent.change(maxParallelInput, { target: { value: '6' } });

    const saveBtn = screen.getByRole('button', { name: /Lưu Project/i });
    await act(async () => {
      fireEvent.click(saveBtn);
      await Promise.resolve();
    });

    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'HighConcurrency',
        maxParallel: 6,
      }),
      expect.anything(),
    );
  });

  it('3b. Gán department khi đăng ký project', async () => {
    const createSpy = vi.spyOn(client, 'createProject').mockResolvedValue({ ...mockProject, id: 'proj-2', departmentId: 'engineering' });

    renderPage();
    await screen.findByText('XFarm');
    fireEvent.click(screen.getByRole('button', { name: /Đăng ký Project/i }));
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'engineering' } });
    fireEvent.change(screen.getByPlaceholderText('vd: XFarm, AgentHub'), { target: { value: 'AgentHub' } });
    fireEvent.change(screen.getByPlaceholderText('vd: /home/user/projects/xfarm'), { target: { value: '/tmp/agenthub' } });
    fireEvent.click(screen.getByRole('button', { name: /Lưu Project/i }));

    await waitFor(() => expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ departmentId: 'engineering' }), expect.anything()));
  });

  it('4. Bấm nút xóa project có xác nhận window.confirm và gọi deleteProject', async () => {
    const deleteSpy = vi.spyOn(client, 'deleteProject').mockResolvedValue({
      ok: true,
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    renderPage();

    expect(await screen.findByText('XFarm')).toBeInTheDocument();

    const deleteBtn = screen.getByTitle(/Xóa project/i);
    await act(async () => {
      fireEvent.click(deleteBtn);
      await Promise.resolve();
    });

    expect(window.confirm).toHaveBeenCalled();
    expect(deleteSpy).toHaveBeenCalledWith('proj-1', expect.anything());
  });

  it('4b. Hộp xác nhận cho phép purge bằng cách gõ đúng id', async () => {
    const deleteSpy = vi.spyOn(client, 'deleteProject').mockResolvedValue({ ok: true });
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    vi.spyOn(window, 'prompt').mockReturnValue('proj-1');

    renderPage();
    expect(await screen.findByText('XFarm')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle(/Xóa project/i));

    await waitFor(() => expect(deleteSpy).toHaveBeenCalledWith('proj-1', { purge: true, confirm: 'proj-1' }));
  });

  it('4c. Hiển thị dự án đã ẩn và gọi restore', async () => {
    const archivedProject = { ...mockProject, id: 'old-proj', name: 'Old Project' };
    vi.spyOn(client, 'getArchivedProjects').mockResolvedValue([archivedProject]);
    const restoreSpy = vi.spyOn(client, 'restoreProject').mockResolvedValue(archivedProject);

    renderPage();
    expect(await screen.findByText('XFarm')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Dự án đã ẩn/i }));
    expect(await screen.findByText('Old Project')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Khôi phục/i }));

    await waitFor(() => expect(restoreSpy).toHaveBeenCalledWith('old-proj', expect.anything()));
  });

  it('5. Sửa checks tùy chỉnh trong drawer chi tiết và lưu thành công bằng 1 nút Lưu', async () => {
    const updateSpy = vi.spyOn(client, 'updateProject').mockResolvedValue({
      ...mockProject,
      checks: [{ name: 'lint', cmd: ['npm', 'run', 'lint'] }],
    });

    renderPage();

    expect(await screen.findByText('XFarm')).toBeInTheDocument();

    // Mở drawer chi tiết cài đặt
    fireEvent.click(screen.getByRole('button', { name: 'Cài đặt' }));
    expect(await screen.findByTestId('project-settings-drawer')).toBeInTheDocument();

    // Mở mục Kiểm tra & review (Nâng cao)
    const advancedSection = screen.getByTestId('advanced-settings-section');
    fireEvent.click(advancedSection.querySelector('summary')!);

    const checksTextarea = screen.getByTestId('checks-json-textarea');
    fireEvent.change(checksTextarea, {
      target: { value: '[{"name":"lint","cmd":["npm","run","lint"]}]' },
    });

    // Thanh unsaved changes xuất hiện với duy nhất 1 nút Lưu
    expect(screen.getByTestId('unsaved-changes-bar')).toBeInTheDocument();
    const saveBtn = screen.getByRole('button', { name: 'Lưu' });

    await act(async () => {
      fireEvent.click(saveBtn);
      await Promise.resolve();
    });

    expect(updateSpy).toHaveBeenCalledWith('proj-1', {
      checks: [{ name: 'lint', cmd: ['npm', 'run', 'lint'] }],
    });
  });

  it('6. Sửa hooks trong mục Nâng cao và lưu thành công', async () => {
    const updateSpy = vi.spyOn(client, 'updateProject').mockResolvedValue({
      ...mockProject,
      hooks: {
        onWorktreeRemoved: [
          'docker exec xfarm_postgres psql -U xfarm -d postgres -c "DROP DATABASE IF EXISTS xfarm_t_1"',
        ],
      },
    });

    renderPage();

    expect(await screen.findByText('XFarm')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cài đặt' }));
    expect(await screen.findByTestId('project-settings-drawer')).toBeInTheDocument();

    const advancedSection = screen.getByTestId('advanced-settings-section');
    fireEvent.click(advancedSection.querySelector('summary')!);

    const hooksTextarea = screen.getByTestId('hooks-textarea');
    fireEvent.change(hooksTextarea, {
      target: {
        value: 'docker exec xfarm_postgres psql -U xfarm -d postgres -c "DROP DATABASE IF EXISTS xfarm_t_1"',
      },
    });

    const saveBtn = screen.getByRole('button', { name: 'Lưu' });
    await act(async () => {
      fireEvent.click(saveBtn);
      await Promise.resolve();
    });

    expect(updateSpy).toHaveBeenCalledWith('proj-1', {
      hooks: {
        onWorktreeRemoved: [
          'docker exec xfarm_postgres psql -U xfarm -d postgres -c "DROP DATABASE IF EXISTS xfarm_t_1"',
        ],
      },
    });
  });

  it('7. Trang Project trống: hiển thị khối hướng dẫn với 3 bước và nút mở form', async () => {
    vi.spyOn(client, 'getProjects').mockResolvedValue([]);

    renderPage();

    expect(await screen.findByTestId('projects-empty-guide')).toBeInTheDocument();
    expect(screen.getByText('Bắt đầu với Project đầu tiên')).toBeInTheDocument();
    expect(
      screen.getByText(/Project là một repo git trên máy này/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Clone repo về máy/)).toBeInTheDocument();
    expect(screen.getByText(/Bấm "Đăng ký Project"/)).toBeInTheDocument();
    expect(screen.getByText(/Giao việc bằng \/newtask/)).toBeInTheDocument();

    const firstRegBtn = screen.getByRole('button', {
      name: /Đăng ký project đầu tiên/i,
    });
    expect(firstRegBtn).toBeInTheDocument();

    fireEvent.click(firstRegBtn);
    expect(
      screen.getByRole('heading', { name: /Đăng ký Project mới/i }),
    ).toBeInTheDocument();
  });

  it('8. URL param ?new=1 tự động mở form đăng ký', async () => {
    renderPage(['/projects?new=1']);

    expect(
      await screen.findByRole('heading', { name: /Đăng ký Project mới/i }),
    ).toBeInTheDocument();
  });

  it('9. Form đăng ký có các gợi ý trường và mục Nâng cao thu gọn mặc định', async () => {
    renderPage(['/projects?new=1']);

    expect(
      await screen.findByRole('heading', { name: /Đăng ký Project mới/i }),
    ).toBeInTheDocument();

    expect(
      screen.getByText('Tên hiển thị, hệ thống sẽ tự động tạo ID dự án'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Thư mục gốc repo git, đường dẫn tuyệt đối'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Nhánh worker tách ra và merge về'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Số lượng task tối đa chạy song song trên project này'),
    ).toBeInTheDocument();

    const advancedDetails = screen.getByTestId('advanced-section');
    expect(advancedDetails).toBeInTheDocument();
    expect(advancedDetails).not.toHaveAttribute('open');

    const summary = advancedDetails.querySelector('summary')!;
    expect(summary).toHaveTextContent('Nâng cao');
    fireEvent.click(summary);

    expect(
      screen.getByText(/Tuỳ chọn, ví dụ cổng\/DB riêng cho mỗi worktree/),
    ).toBeInTheDocument();
  });

  it('10. Form đăng ký hiển thị lỗi trả về từ server khi thất bại', async () => {
    vi.spyOn(client, 'createProject').mockRejectedValue(
      new Error('Đường dẫn repo phải là đường dẫn tuyệt đối: relative/path'),
    );

    renderPage(['/projects?new=1']);

    await screen.findByRole('heading', { name: /Đăng ký Project mới/i });

    fireEvent.change(screen.getByPlaceholderText('vd: XFarm, AgentHub'), {
      target: { value: 'MyProject' },
    });
    fireEvent.change(
      screen.getByPlaceholderText('vd: /home/user/projects/xfarm'),
      {
        target: { value: 'relative/path' },
      },
    );

    const saveBtn = screen.getByRole('button', { name: /Lưu Project/i });
    await act(async () => {
      fireEvent.click(saveBtn);
      await Promise.resolve();
    });

    const formError = await screen.findByTestId('form-error-msg');
    expect(formError).toBeInTheDocument();
    expect(formError).toHaveTextContent(
      'Đường dẫn repo phải là đường dẫn tuyệt đối: relative/path',
    );
  });

  it('11. Lưu settings project gửi đúng section thay đổi', async () => {
    const updateSpy = vi.spyOn(client, 'updateProject').mockResolvedValue(mockProject);
    renderPage();
    await screen.findByText('XFarm');
    fireEvent.click(screen.getByRole('button', { name: 'Cài đặt' }));

    expect(await screen.findByTestId('project-settings-drawer')).toBeInTheDocument();
    const externalRadio = screen.getByRole('radio', {
      name: /Claude ngoài \(VS Code\) điều phối/i,
    });
    fireEvent.click(externalRadio);

    const saveBtn = screen.getByRole('button', { name: 'Lưu' });
    fireEvent.click(saveBtn);

    await waitFor(() =>
      expect(updateSpy).toHaveBeenCalledWith('proj-1', {
        settings: { brain: { mode: 'external' } },
      }),
    );
  });

  it('12. Lưu settings lỗi 400 thì hiện message và xoá thông báo khi sửa form hoặc lưu thành công', async () => {
    const error: any = new Error('Tên nhánh tích hợp trùng với nhánh mặc định: main');
    error.status = 400;
    const updateSpy = vi.spyOn(client, 'updateProject').mockRejectedValue(error);

    renderPage();
    await screen.findByText('XFarm');
    fireEvent.click(screen.getByRole('button', { name: 'Cài đặt' }));

    const autoRadio = screen.getByDisplayValue('auto');
    fireEvent.click(autoRadio);

    const saveBtn = screen.getByRole('button', { name: 'Lưu' });
    fireEvent.click(saveBtn);

    const errorMsg = await screen.findByTestId('settings-error-msg');
    expect(errorMsg).toBeInTheDocument();
    expect(errorMsg).toHaveTextContent(
      'Tên nhánh tích hợp trùng với nhánh mặc định: main',
    );

    // Sửa form thì thông báo lỗi biến mất
    const suggestRadio = screen.getByDisplayValue('suggest');
    fireEvent.click(suggestRadio);
    expect(screen.queryByTestId('settings-error-msg')).not.toBeInTheDocument();

    // Submit lại và lỗi lại hiện
    fireEvent.click(screen.getByRole('button', { name: 'Lưu' }));
    expect(await screen.findByTestId('settings-error-msg')).toHaveTextContent(
      'Tên nhánh tích hợp trùng với nhánh mặc định: main',
    );

    // Lưu thành công thì xoá thông báo lỗi
    updateSpy.mockResolvedValueOnce(mockProject);
    fireEvent.click(screen.getByRole('button', { name: 'Lưu' }));
    await waitFor(() =>
      expect(screen.queryByTestId('settings-error-msg')).not.toBeInTheDocument(),
    );
  });

  it('13. Nhập "abc" vào ngân sách token thì payload không chứa NaN', async () => {
    const updateSpy = vi.spyOn(client, 'updateProject').mockResolvedValue(mockProject);
    renderPage();
    await screen.findByText('XFarm');
    fireEvent.click(screen.getByRole('button', { name: 'Cài đặt' }));

    const tokenBudgetInput = screen.getByLabelText(/Ngân sách token\/ngày/i);
    fireEvent.change(tokenBudgetInput, { target: { value: 'abc' } });

    // Thay đổi mode để section brain được gửi
    const suggestRadio = screen.getByDisplayValue('suggest');
    fireEvent.click(suggestRadio);

    fireEvent.click(screen.getByRole('button', { name: 'Lưu' }));

    await waitFor(() => expect(updateSpy).toHaveBeenCalled());
    const payload = updateSpy.mock.calls[0][1];
    expect(payload.settings?.brain?.dailyTokenBudget).toBeUndefined();
    expect(Number.isNaN(payload.settings?.brain?.dailyTokenBudget)).toBe(false);
    expect(JSON.stringify(payload)).not.toContain('NaN');

    // Nhập số nguyên dương hợp lệ thì được cập nhật
    fireEvent.change(tokenBudgetInput, { target: { value: '5000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lưu' }));
    await waitFor(() => {
      expect(updateSpy).toHaveBeenLastCalledWith('proj-1', {
        settings: { brain: { mode: 'suggest', dailyTokenBudget: 5000 } },
      });
    });
  });

  it('14. JSON sai cú pháp trong checks / review / envTemplate báo lỗi và chặn lưu', async () => {
    renderPage();
    await screen.findByText('XFarm');
    fireEvent.click(screen.getByRole('button', { name: 'Cài đặt' }));

    const advancedSection = screen.getByTestId('advanced-settings-section');
    fireEvent.click(advancedSection.querySelector('summary')!);

    const checksTextarea = screen.getByTestId('checks-json-textarea');
    fireEvent.change(checksTextarea, {
      target: { value: '{"broken": json}' },
    });

    const checksError = await screen.findByTestId('checks-error-msg');
    expect(checksError).toBeInTheDocument();

    // Nút Lưu bị vô hiệu hoá
    const saveBtn = screen.getByRole('button', { name: 'Lưu' });
    expect(saveBtn).toBeDisabled();

    // Sửa lại hợp lệ
    fireEvent.change(checksTextarea, {
      target: { value: '[{"name":"lint","cmd":["npm","run","lint"]}]' },
    });
    expect(screen.queryByTestId('checks-error-msg')).not.toBeInTheDocument();
    expect(saveBtn).toBeEnabled();
  });

  it('15. Toàn quyền (full) yêu cầu xác nhận window.confirm và gửi confirm: true', async () => {
    const updateSpy = vi.spyOn(client, 'updateProject').mockResolvedValue(mockProject);
    const confirmSpy = vi.spyOn(window, 'confirm');

    renderPage();
    await screen.findByText('XFarm');
    fireEvent.click(screen.getByRole('button', { name: 'Cài đặt' }));

    // User huỷ confirm khi click Toàn quyền
    confirmSpy.mockReturnValueOnce(false);
    const fullRadio = screen.getByRole('radio', { name: /Toàn quyền/i });
    fireEvent.click(fullRadio);
    expect(confirmSpy).toHaveBeenCalled();
    expect(fullRadio).not.toBeChecked();

    // User đồng ý confirm
    confirmSpy.mockReturnValueOnce(true);
    fireEvent.click(fullRadio);
    expect(fullRadio).toBeChecked();

    // Cảnh báo đỏ xuất hiện
    expect(screen.getByRole('alert')).toHaveTextContent(/Toàn quyền cho phép Claude chạy mọi lệnh/i);

    const saveBtn = screen.getByRole('button', { name: 'Lưu' });
    fireEvent.click(saveBtn);

    await waitFor(() =>
      expect(updateSpy).toHaveBeenCalledWith('proj-1', {
        settings: { brain: { mode: 'inherit', permissions: 'full' } },
        confirm: true,
      }),
    );
  });

  it('16. Tham chiếu chỉ đọc: thêm, xoá và validate tên hợp lệ', async () => {
    renderPage();
    await screen.findByText('XFarm');
    fireEvent.click(screen.getByRole('button', { name: 'Cài đặt' }));

    // Thêm tham chiếu
    const addRefBtn = screen.getByRole('button', { name: /Thêm/i });
    fireEvent.click(addRefBtn);

    const nameInput = screen.getByPlaceholderText('vd: docs-api, schema');
    expect(nameInput).toBeInTheDocument();

    // Nhập tên không hợp lệ có dấu cách
    fireEvent.change(nameInput, { target: { value: 'invalid name with space' } });
    expect(
      screen.getByText(/Tên chỉ gồm chữ cái, số, gạch ngang/i),
    ).toBeInTheDocument();

    // Sửa tên thành hợp lệ
    fireEvent.change(nameInput, { target: { value: 'docs-api' } });
    expect(
      screen.queryByText(/Tên chỉ gồm chữ cái, số, gạch ngang/i),
    ).not.toBeInTheDocument();

    // Xoá tham chiếu
    const deleteRefBtn = screen.getByTitle('Xoá dòng');
    fireEvent.click(deleteRefBtn);
    expect(screen.queryByPlaceholderText('vd: docs-api, schema')).not.toBeInTheDocument();
  });

  it('17. Hiển thị integrationStatus dạng StatTile khi project có dữ liệu', async () => {
    vi.spyOn(client, 'getProjects').mockResolvedValue([
      {
        ...mockProject,
        settings: {
          brain: { mode: 'auto' },
          worktree: { install: 'auto', gitHooks: 'run' },
          integration: { enabled: true, branch: 'integration', baseRef: 'main' },
          ci: {},
          references: [],
          notifications: { telegramContent: 'full' },
        },
        integrationStatus: {
          path: '/home/user/projects/xfarm/.git/worktrees/integration',
          branch: 'integration',
          exists: true,
          currentBranch: 'integration',
          dirty: false,
          ahead: 2,
          behind: 0,
        },
      },
    ]);

    renderPage();
    await screen.findByText('XFarm');
    fireEvent.click(screen.getByRole('button', { name: 'Cài đặt' }));

    const tiles = await screen.findByTestId('integration-status-tiles');
    expect(tiles).toBeInTheDocument();
    expect(screen.getByText('/home/user/projects/xfarm/.git/worktrees/integration')).toBeInTheDocument();
    expect(screen.getByText('+2 / -0')).toBeInTheDocument();
    expect(screen.getByText('Sạch (Clean)')).toBeInTheDocument();
  });

  it('18. Nút Huỷ trong thanh thay đổi hoàn tác các giá trị đã sửa về ban đầu', async () => {
    renderPage();
    await screen.findByText('XFarm');
    fireEvent.click(screen.getByRole('button', { name: 'Cài đặt' }));

    const offRadio = screen.getByDisplayValue('off');
    fireEvent.click(offRadio);

    expect(screen.getByTestId('unsaved-changes-bar')).toBeInTheDocument();

    // Bấm nút Huỷ
    const cancelBtn = screen.getByRole('button', { name: 'Huỷ' });
    fireEvent.click(cancelBtn);

    // Thanh thay đổi biến mất và mode quay lại ban đầu
    expect(screen.queryByTestId('unsaved-changes-bar')).not.toBeInTheDocument();
    expect(offRadio).not.toBeChecked();
  });

  it('19. Chỉ đếm task đang chạy hoặc chờ (running, queued, waiting_quota) trong thẻ tóm tắt task của project', async () => {
    vi.spyOn(client, 'getTasks').mockResolvedValue([
      { id: 'proj-1~t1', projectId: 'proj-1', slug: 't1', title: 'Running', status: 'running' } as any,
      { id: 'proj-1~t2', projectId: 'proj-1', slug: 't2', title: 'Queued', status: 'queued' } as any,
      { id: 'proj-1~t3', projectId: 'proj-1', slug: 't3', title: 'Quota', status: 'waiting_quota' } as any,
      { id: 'proj-1~t4', projectId: 'proj-1', slug: 't4', title: 'Review', status: 'review' } as any,
      { id: 'proj-1~t5', projectId: 'proj-1', slug: 't5', title: 'Checking', status: 'checking' } as any,
      { id: 'proj-1~t6', projectId: 'proj-1', slug: 't6', title: 'Blocked', status: 'blocked' } as any,
      { id: 'proj-1~t7', projectId: 'proj-1', slug: 't7', title: 'Done', status: 'done' } as any,
      { id: 'other~t8', projectId: 'other', slug: 't8', title: 'Other running', status: 'running' } as any,
    ]);

    renderPage();
    await screen.findByText('XFarm');

    const summaryLink = await screen.findByTestId('project-task-summary-proj-1');
    expect(summaryLink).toBeInTheDocument();
    expect(summaryLink).toHaveAttribute('href', '/tasks?project=proj-1');
    expect(summaryLink).toHaveTextContent('3 · Xem task');
  });

  it('20. Lỗi tải danh sách project hiển thị thông báo và nút thử lại', async () => {
    const getProjectsSpy = vi.spyOn(client, 'getProjects').mockRejectedValueOnce(new Error('Failed to load'));

    renderPage();

    expect(await screen.findByText('Không thể tải danh sách project.')).toBeInTheDocument();
    const retryBtn = screen.getByRole('button', { name: /Thử lại/i });
    expect(retryBtn).toBeInTheDocument();

    getProjectsSpy.mockResolvedValueOnce([mockProject]);
    await act(async () => {
      fireEvent.click(retryBtn);
    });

    expect(await screen.findByText('XFarm')).toBeInTheDocument();
  });

  it('21. Cho phép chọn chế độ cài phụ thuộc "Worker tự cài" và lưu cài đặt', async () => {
    const updateSpy = vi.spyOn(client, 'updateProject').mockResolvedValue(mockProject);
    renderPage();
    await screen.findByText('XFarm');
    fireEvent.click(screen.getByRole('button', { name: 'Cài đặt' }));

    expect(await screen.findByTestId('project-settings-drawer')).toBeInTheDocument();
    const workerBtn = screen.getByRole('button', { name: 'Worker tự cài' });
    expect(workerBtn).toBeInTheDocument();
    fireEvent.click(workerBtn);

    const saveBtn = screen.getByRole('button', { name: 'Lưu' });
    fireEvent.click(saveBtn);

    await waitFor(() =>
      expect(updateSpy).toHaveBeenCalledWith(
        'proj-1',
        expect.objectContaining({
          settings: expect.objectContaining({
            worktree: expect.objectContaining({ install: 'worker' }),
          }),
        }),
      ),
    );
  });
});
