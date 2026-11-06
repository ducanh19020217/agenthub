import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SetupPage } from '../pages/SetupPage';
import { LocaleProvider } from '../context/LocaleContext';
import * as client from '../api/client';
import * as sse from '../api/sse';
import { SetupStatus } from '../api/client';

describe('SetupPage', () => {
  let queryClient: QueryClient;
  const sseListeners = new Set<sse.EventCallback>();

  const mockSetupStatus: SetupStatus = {
    node: { version: 'v22.21.1', ok: true },
    git: { version: '2.25.1', installed: true },
    tools: [
      {
        id: 'claude',
        installed: true,
        version: '1.0.0',
        path: '/usr/local/bin/claude',
        manual: false,
        installing: false,
      },
      {
        id: 'codex',
        installed: false,
        version: null,
        path: null,
        manual: false,
        installing: false,
      },
      {
        id: 'agy',
        installed: false,
        version: null,
        path: null,
        manual: true,
        docsUrl: 'https://example.com/agy-docs',
        installing: false,
      },
    ],
    profiles: [
      { name: 'default', engine: 'agy', kind: 'keyring', loggedIn: true, enabled: 1 },
      { name: 'g1', engine: 'agy', kind: 'isolated', loggedIn: false, enabled: 1 },
    ],
    mcpRegistered: false,
    serviceRunning: true,
  };

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });

    sseListeners.clear();
    vi.spyOn(sse, 'subscribeToEvents').mockImplementation((cb) => {
      sseListeners.add(cb);
      return () => {
        sseListeners.delete(cb);
      };
    });

    vi.spyOn(client, 'getSetupStatus').mockResolvedValue(mockSetupStatus);
    vi.spyOn(client, 'getProjects').mockResolvedValue([]);
    vi.spyOn(client, 'installSetupTool').mockResolvedValue({ jobId: 'job-123' });
    vi.spyOn(client, 'installSetupMcp').mockResolvedValue({} as any);
    vi.spyOn(client, 'completeSetup').mockResolvedValue({} as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function renderPage(locale: 'vi' | 'en' = 'vi') {
    return render(
      <QueryClientProvider client={queryClient}>
        <LocaleProvider initialLocale={locale}>
          <BrowserRouter>
            <SetupPage />
          </BrowserRouter>
        </LocaleProvider>
      </QueryClientProvider>,
    );
  }

  function emitSSE(event: any) {
    act(() => {
      for (const listener of Array.from(sseListeners)) {
        listener(event);
      }
    });
  }

  it('1. Hiển thị tiến độ sẵn sàng x/y ở đầu trang', async () => {
    renderPage();

    // 4 ready (node, git, claude, service) out of 8 total checks
    expect(await screen.findByText('4/8')).toBeInTheDocument();
    expect(screen.getByText('4/8 mục đã sẵn sàng')).toBeInTheDocument();
  });

  it('hiển thị đúng nội dung khi chuyển giữa hai cách dùng', async () => {
    renderPage();

    expect(await screen.findByRole('tab', { name: /A — Hub độc lập/ })).toBeInTheDocument();
    expect(screen.getByText(/Để brain.mode là auto hoặc suggest/)).toBeInTheDocument();
    expect(screen.queryByText(/Chạy agenthub mcp-install/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /B — Dùng qua MCP/ }));

    expect(screen.getByText(/Chạy agenthub mcp-install/)).toBeInTheDocument();
    expect(screen.getByText('agenthub mcp-install')).toBeInTheDocument();
    expect(screen.queryByText(/Để brain.mode là auto hoặc suggest/)).not.toBeInTheDocument();
  });

  it('2. Hiển thị trạng thái đạt và cần làm cho từng mục kiểm tra', async () => {
    renderPage();

    // Headers & labels
    expect(await screen.findByText('Bắt đầu với AgentHub')).toBeInTheDocument();
    expect(screen.getByText('Node.js v22.21.1')).toBeInTheDocument();
    expect(screen.getByText('Git (2.25.1)')).toBeInTheDocument();
    expect(screen.getByText('Claude Code')).toBeInTheDocument();
    expect(screen.getByText('Codex CLI')).toBeInTheDocument();
    expect(screen.getByText('Antigravity CLI')).toBeInTheDocument();
    expect(screen.getByText('Service nền')).toBeInTheDocument();
    expect(screen.getByText('Đăng ký MCP với Claude Code')).toBeInTheDocument();
    expect(screen.getByText('Thêm dự án đầu tiên')).toBeInTheDocument();

    // Status badges for completed items (node, git, claude, service)
    const doneBadges = screen.getAllByTestId('status-badge-done');
    // 4 check items + 1 profile
    expect(doneBadges.length).toBeGreaterThanOrEqual(4);

    // Manual guide link for Agy
    const guideLink = screen.getByText('Hướng dẫn').closest('a');
    expect(guideLink).toHaveAttribute('href', 'https://example.com/agy-docs');
    expect(guideLink).toHaveAttribute('target', '_blank');

    // Account profiles card
    expect(screen.getByText('Đăng nhập tài khoản')).toBeInTheDocument();
    expect(screen.getByText('Tài khoản default')).toBeInTheDocument();
    expect(screen.getByText('Tài khoản g1')).toBeInTheDocument();
    const loginLink = screen.getByText('Đăng nhập trong Profiles').closest('a');
    expect(loginLink).toHaveAttribute('href', '/profiles#profile-g1');
  });

  it('3. Bấm "Cài đặt" gọi installSetupTool, hiển thị log stream và kết quả trong chính hàng', async () => {
    const installSpy = vi.spyOn(client, 'installSetupTool');
    renderPage();

    await screen.findByText('Codex CLI');

    // Find the install button for Codex CLI
    const installButtons = screen.getAllByRole('button', { name: /Cài đặt/ });
    // The first one is for Codex CLI (or find within Codex row)
    const codexInstallBtn = installButtons[0];
    expect(codexInstallBtn).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(codexInstallBtn);
    });

    expect(installSpy).toHaveBeenCalledWith('codex');

    // Stream progress log via SSE
    emitSSE({
      type: 'setup.install_progress',
      payload: { tool: 'codex', line: 'Installing codex binary...\n' },
    });

    expect(screen.getByText(/Installing codex binary/)).toBeInTheDocument();
    // Log cần token: tải qua API client (có Bearer) thay vì link trần sẽ bị 401.
    const logSpy = vi.spyOn(client, 'getSetupLog').mockResolvedValue('full npm install log\n');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Xem log/ }));
    });
    expect(logSpy).toHaveBeenCalledWith('codex');
    expect(await screen.findByText(/full npm install log/)).toBeInTheDocument();

    // Complete install via SSE
    emitSSE({
      type: 'setup.install_done',
      payload: { tool: 'codex', ok: true },
    });

    const result = await screen.findByTestId('install-result-codex');
    expect(result).toHaveTextContent('Đã hoàn tất');
  });

  it('4. Bấm "Cài đặt" hiển thị kết quả thất bại nếu install_done trả về ok: false', async () => {
    renderPage();
    await screen.findByText('Codex CLI');

    const installButtons = screen.getAllByRole('button', { name: /Cài đặt/ });
    await act(async () => {
      fireEvent.click(installButtons[0]);
    });

    emitSSE({
      type: 'setup.install_done',
      payload: { tool: 'codex', ok: false },
    });

    const result = await screen.findByTestId('install-result-codex');
    expect(result).toHaveTextContent('Cài đặt thất bại');
  });

  it('hiển thị lỗi khi API cài công cụ từ chối request', async () => {
    vi.spyOn(client, 'installSetupTool').mockRejectedValue(new Error('Forbidden: invalid Origin header'));
    renderPage();
    await screen.findByText('Codex CLI');

    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /Cài đặt/ })[0]);
    });

    expect(await screen.findByText(/Forbidden: invalid Origin header/)).toBeInTheDocument();
    expect(screen.getByTestId('install-result-codex')).toHaveTextContent('Cài đặt thất bại');
  });

  it('hiển thị lỗi khi đăng ký MCP thất bại', async () => {
    vi.spyOn(client, 'installSetupMcp').mockRejectedValue(new Error('Không tìm thấy dist/cli.js'));
    renderPage();
    await screen.findByText('Codex CLI');

    const buttons = screen.getAllByRole('button', { name: /Cài đặt/ });
    await act(async () => {
      fireEvent.click(buttons[buttons.length - 1]);
    });

    expect(await screen.findByText(/Không tìm thấy dist\/cli\.js/)).toBeInTheDocument();
    expect(screen.getByTestId('install-result-mcp')).toHaveTextContent('Cài đặt thất bại');
  });

  it('hiển thị lỗi hậu cài và lệnh cài agy thủ công', async () => {
    renderPage();
    await screen.findByText('Antigravity CLI');
    emitSSE({
      type: 'setup.install_done',
      payload: { tool: 'agy', ok: false, error: 'Chưa tìm thấy agy sau khi cài' },
    });
    expect(await screen.findByText('Chưa tìm thấy agy sau khi cài')).toBeInTheDocument();
    expect(screen.getByText('curl -fsSL https://antigravity.google/cli/install.sh | bash')).toBeInTheDocument();
  });

  it('5. Bấm "Cài tất cả công cụ còn thiếu" gọi installSetupTool cho các công cụ còn thiếu', async () => {
    const installSpy = vi.spyOn(client, 'installSetupTool');
    renderPage();

    const installAllBtn = await screen.findByRole('button', {
      name: /Cài tất cả công cụ còn thiếu/,
    });
    expect(installAllBtn).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(installAllBtn);
      await Promise.resolve();
    });

    expect(installSpy).toHaveBeenCalledWith('codex');

    // Resolve codex installation
    emitSSE({
      type: 'setup.install_done',
      payload: { tool: 'codex', ok: true },
    });
  });

  it('6. Bấm "Hoàn tất" gọi completeSetup(false)', async () => {
    const completeSpy = vi.spyOn(client, 'completeSetup');
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    renderPage();

    const completeBtn = await screen.findByRole('button', { name: /Hoàn tất/ });
    await act(async () => {
      fireEvent.click(completeBtn);
    });

    expect(completeSpy).toHaveBeenCalledWith(false);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['setup-status'] });
  });

  it('7. Bấm "Bỏ qua, làm sau" gọi completeSetup(true)', async () => {
    const completeSpy = vi.spyOn(client, 'completeSetup');
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    renderPage();

    const skipBtn = await screen.findByRole('button', { name: /Bỏ qua, làm sau/ });
    await act(async () => {
      fireEvent.click(skipBtn);
    });

    expect(completeSpy).toHaveBeenCalledWith(true);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['setup-status'] });
  });

  it('8. Bấm "Cài đặt" cho MCP gọi installSetupMcp', async () => {
    const mcpSpy = vi.spyOn(client, 'installSetupMcp');
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    renderPage();

    await screen.findByText('Đăng ký MCP với Claude Code');

    // Find MCP install button
    const installButtons = screen.getAllByRole('button', { name: /Cài đặt/ });
    // In our mock, codex has index 0, MCP has index 1
    const mcpBtn = installButtons[installButtons.length - 1];

    await act(async () => {
      fireEvent.click(mcpBtn);
    });

    expect(mcpSpy).toHaveBeenCalled();
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['setup-status'] });
  });

  it('9. Hiển thị trang chuẩn bằng tiếng Anh khi đổi locale', async () => {
    renderPage('en');

    expect(await screen.findByText('Get started with AgentHub')).toBeInTheDocument();
    expect(screen.getByText('Readiness progress')).toBeInTheDocument();
    expect(screen.getByText('4/8 items ready')).toBeInTheDocument();
    expect(screen.getByText('Add first project')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Complete/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Skip for now/ })).toBeInTheDocument();
  });

  it('10. Bước thêm dự án: chưa đạt khi 0 project (hiện nút dẫn tới /projects?new=1), đạt khi có >=1 project', async () => {
    // 0 project initially
    const { unmount } = renderPage();

    expect(await screen.findByText('Thêm dự án đầu tiên')).toBeInTheDocument();
    const addProjBtn = screen.getByRole('link', { name: /Thêm dự án/i });
    expect(addProjBtn).toBeInTheDocument();
    expect(addProjBtn).toHaveAttribute('href', '/projects?new=1');

    unmount();

    // Re-render with >= 1 project
    queryClient.clear();
    vi.spyOn(client, 'getProjects').mockResolvedValue([
      {
        id: 'p1',
        name: 'Project One',
        path: '/path/p1',
        defaultBranch: 'main',
        maxParallel: 2,
        envTemplate: null,
        checks: null,
      },
    ]);

    renderPage();
    expect(await screen.findByText('5/8')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Thêm dự án/i })).not.toBeInTheDocument();
  });

  it('11. Trạng thái lỗi hiển thị thông báo và nút thử lại gọi refetch', async () => {
    const statusSpy = vi.spyOn(client, 'getSetupStatus').mockRejectedValueOnce(new Error('Network failure'));

    renderPage();

    expect(await screen.findByText('Không thể kiểm tra môi trường thiết lập.')).toBeInTheDocument();
    const retryBtn = screen.getByRole('button', { name: /Thử lại/i });
    expect(retryBtn).toBeInTheDocument();

    statusSpy.mockResolvedValueOnce(mockSetupStatus);
    await act(async () => {
      fireEvent.click(retryBtn);
    });

    expect(await screen.findByText('Bắt đầu với AgentHub')).toBeInTheDocument();
  });
});
