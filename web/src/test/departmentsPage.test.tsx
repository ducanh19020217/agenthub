import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DepartmentsPage } from '../pages/DepartmentsPage';
import { LocaleProvider } from '../context/LocaleContext';
import * as client from '../api/client';

describe('DepartmentsPage', () => {
  let queryClient: QueryClient;
  const department = {
    id: 'engineering', name: 'Engineering', priority: 1, maxParallel: 2,
    claudeDailyTokenBudget: 0, telegramTopicId: null, brainEngine: 'claude' as const,
    brainModel: 'sonnet', brainCodexProfile: 'old-profile', brainMode: 'auto' as const,
    brainPermissions: 'trusted' as const, brainDailyTokenBudget: 100, brainMaxTurnsPerHour: 2,
    profiles: [], projects: [], createdAt: '2026-01-01T00:00:00Z',
  };

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(client, 'getDepartments').mockResolvedValue([department]);
    vi.spyOn(client, 'getProfiles').mockResolvedValue([{ name: 'worker-1' }] as any);
    vi.spyOn(client, 'getModelOptions').mockResolvedValue({ suggestions: ['codex:gpt-5.6-luna'], configured: [] });
  });

  afterEach(() => vi.restoreAllMocks());

  function renderPage() {
    return render(
      <QueryClientProvider client={queryClient}>
        <LocaleProvider initialLocale="vi"><DepartmentsPage /></LocaleProvider>
      </QueryClientProvider>,
    );
  }

  it('gửi inherit thật khi bỏ kế thừa mode và permissions', async () => {
    const updateSpy = vi.spyOn(client, 'updateDepartment').mockResolvedValue(department);
    renderPage();
    await screen.findByText('Engineering');
    fireEvent.click(screen.getByText('Cấu hình Brain'));

    fireEvent.change(screen.getByLabelText('Chế độ Brain'), { target: { value: 'inherit' } });
    fireEvent.change(screen.getByLabelText('Quyền'), { target: { value: 'inherit' } });

    await waitFor(() => expect(updateSpy).toHaveBeenCalledWith('engineering', { brainMode: 'inherit' }));
    expect(updateSpy).toHaveBeenCalledWith('engineering', { brainPermissions: 'inherit' });
  });

  it('hiện profile Codex ngay khi đổi engine và gửi null khi xoá profile', async () => {
    const updateSpy = vi.spyOn(client, 'updateDepartment').mockResolvedValue(department);
    renderPage();
    await screen.findByText('Engineering');
    fireEvent.click(screen.getByText('Cấu hình Brain'));
    fireEvent.change(screen.getByLabelText('Engine Brain'), { target: { value: 'codex' } });
    const profile = await screen.findByLabelText('Profile Codex');
    fireEvent.change(profile, { target: { value: '' } });

    await waitFor(() => expect(updateSpy).toHaveBeenCalledWith('engineering', { brainCodexProfile: null }));
  });

  it('chọn model Brain từ danh sách hợp lệ và ẩn các giới hạn theo giờ', async () => {
    const updateSpy = vi.spyOn(client, 'updateDepartment').mockResolvedValue(department);
    renderPage();
    await screen.findByText('Engineering');
    fireEvent.click(screen.getByText('Cấu hình Brain'));

    const model = screen.getByLabelText('Model Brain');
    expect(model.tagName).toBe('SELECT');
    expect(screen.getByRole('option', { name: 'sonnet' })).toBeInTheDocument();
    expect(screen.queryByText('Ngân sách token/ngày')).toBeNull();
    expect(screen.queryByText('Lượt tối đa/giờ')).toBeNull();
    fireEvent.change(model, { target: { value: 'opus' } });
    await waitFor(() => expect(updateSpy).toHaveBeenCalledWith('engineering', { brainModel: 'opus' }));
  });

  it('gán và bỏ gán profile bằng checkbox', async () => {
    const updateProfilesSpy = vi.spyOn(client, 'updateDepartmentProfiles').mockResolvedValue(department);
    renderPage();
    await screen.findByText('Engineering');
    fireEvent.click(screen.getByLabelText('worker-1'));

    await waitFor(() => expect(updateProfilesSpy).toHaveBeenCalledWith('engineering', [{ profileName: 'worker-1', share: null }]));
  });

  it('hiển thị cảnh báo khi phòng có dự án nhưng không có tài khoản nào dùng được', async () => {
    const otherDept = {
      ...department,
      id: 'other-dept',
      name: 'Phòng Khác',
      projects: [],
      profiles: [{ profileName: 'worker-1', departmentId: 'other-dept', share: null }],
    };
    const deptWithProjectsNoProfiles = {
      ...department,
      id: 'no-profile-dept',
      name: 'Phòng Thiếu Profile',
      projects: [{ id: 'p1', name: 'Project 1' }] as any,
      profiles: [],
    };
    vi.spyOn(client, 'getDepartments').mockResolvedValue([otherDept, deptWithProjectsNoProfiles]);
    renderPage();
    await screen.findByText('Phòng Thiếu Profile');
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Phòng này có project nhưng chưa có tài khoản được gán.');
  });

  it('không hiển thị cảnh báo khi phòng có dự án và có profile toàn cục chưa gán phòng', async () => {
    const deptWithProjectsNoProfiles = {
      ...department,
      id: 'global-profile-dept',
      name: 'Phòng Dùng Profile Toàn Cục',
      projects: [{ id: 'p1', name: 'Project 1' }] as any,
      profiles: [],
    };
    // worker-1 is global (not assigned to any department)
    vi.spyOn(client, 'getDepartments').mockResolvedValue([deptWithProjectsNoProfiles]);
    renderPage();
    await screen.findByText('Phòng Dùng Profile Toàn Cục');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('không hiển thị cảnh báo khi phòng có tài khoản được gán', async () => {
    const deptWithProjectsAndProfiles = {
      ...department,
      id: 'healthy-dept',
      name: 'Phòng Đầy Đủ',
      projects: [{ id: 'p1', name: 'Project 1' }] as any,
      profiles: [{ profileName: 'worker-1', departmentId: 'healthy-dept', share: null }],
    };
    vi.spyOn(client, 'getDepartments').mockResolvedValue([deptWithProjectsAndProfiles]);
    renderPage();
    await screen.findByText('Phòng Đầy Đủ');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('hiển thị cảnh báo khi phòng có dự án nhưng hệ thống không có tài khoản nào', async () => {
    const deptWithProjectsNoProfiles = {
      ...department,
      id: 'no-profile-dept',
      name: 'Phòng Thiếu Profile',
      projects: [{ id: 'p1', name: 'Project 1' }] as any,
      profiles: [],
    };
    vi.spyOn(client, 'getDepartments').mockResolvedValue([deptWithProjectsNoProfiles]);
    vi.spyOn(client, 'getProfiles').mockResolvedValue([]);
    renderPage();
    await screen.findByText('Phòng Thiếu Profile');
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Phòng này có project nhưng chưa có tài khoản được gán.');
  });

  it('hiển thị cảnh báo khi phòng có assignment trỏ tới profile không tồn tại (stale assignment)', async () => {
    const otherDept = {
      ...department,
      id: 'other-dept',
      name: 'Phòng Khác',
      projects: [],
      profiles: [{ profileName: 'real-worker', departmentId: 'other-dept', share: null }],
    };
    const deptWithStaleProfile = {
      ...department,
      id: 'stale-dept',
      name: 'Phòng Có Stale Profile',
      projects: [{ id: 'p1', name: 'Project 1' }] as any,
      profiles: [{ profileName: 'deleted-worker', departmentId: 'stale-dept', share: null }],
    };
    vi.spyOn(client, 'getDepartments').mockResolvedValue([otherDept, deptWithStaleProfile]);
    vi.spyOn(client, 'getProfiles').mockResolvedValue([{ name: 'real-worker' }] as any);
    renderPage();
    await screen.findByText('Phòng Có Stale Profile');
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Phòng này có project nhưng chưa có tài khoản được gán.');
  });

  it('không hiển thị cảnh báo sai khi danh sách profile đang tải', async () => {
    let resolveProfiles!: (val: any) => void;
    const profilesPromise = new Promise((resolve) => {
      resolveProfiles = resolve;
    });
    const deptWithProjects = {
      ...department,
      id: 'dept-loading',
      name: 'Phòng Đang Tải',
      projects: [{ id: 'p1', name: 'Project 1' }] as any,
      profiles: [],
    };
    vi.spyOn(client, 'getDepartments').mockResolvedValue([deptWithProjects]);
    vi.spyOn(client, 'getProfiles').mockReturnValue(profilesPromise as any);
    renderPage();
    expect(screen.getByText('Đang tải...')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    resolveProfiles([]);
    await screen.findByText('Phòng Đang Tải');
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});
