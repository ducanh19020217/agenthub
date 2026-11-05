import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LocaleProvider } from '../context/LocaleContext';
import { ThemeProvider } from '../context/ThemeContext';
import type { Locale } from '../locales';
import { ProjectSettingsDrawer, parseArgv, parseDeployEnv } from '../components/ProjectSettingsDrawer';
import { OpenProjectSettings, parseIdList, matchStatusIds } from '../components/OpenProjectSettings';
import { TasksPage } from '../pages/TasksPage';
import { TaskDetailPage } from '../pages/TaskDetailPage';
import * as client from '../api/client';
import * as sse from '../api/sse';
import type { Project, Task, TaskDetail, OpenProjectSource, OpenProjectStatusDto } from '../types/api';

const mockProject: Project = {
  id: 'proj-1',
  name: 'Test Integration Project',
  path: '/tmp/test-proj',
  defaultBranch: 'main',
  maxParallel: 2,
  settings: {
    brain: { mode: 'inherit' },
    worktree: { install: 'auto', gitHooks: 'run' },
    integration: { enabled: false },
    ci: {},
    references: [],
    notifications: { telegramContent: 'full' },
    openproject: { enabled: false, sourceId: null, role: 'primary' },
    gitea: { enabled: false, schedule: ['12:00', '18:00'], weekdaysOnly: false, checks: [], unionMergeGlobs: [] },
    remoteDeploy: { enabled: false, trigger: 'manual', steps: [], healthChecks: [], waitMinutes: 15 },
  },
};

const mockSources: OpenProjectSource[] = [
  {
    id: 'op-corp',
    url: 'https://openproject.example.com',
    project: 'demo-proj',
    pollIntervalSec: 120,
    watchStatusIds: [1, 2],
    reopenedStatusIds: [3],
    resolvedStatusId: 7,
    reviewStatusId: 8,
    openStatusIds: [1, 2, 3],
    minTicketNumber: 100,
    autoStart: true,
    autoResolve: true,
    language: 'vi',
    keyConfigured: true,
  },
  {
    id: 'op-client',
    url: 'https://op-client.example.com',
    project: 'client-proj',
    pollIntervalSec: 300,
    watchStatusIds: [],
    reopenedStatusIds: [],
    resolvedStatusId: null,
    reviewStatusId: null,
    openStatusIds: [],
    minTicketNumber: 0,
    autoStart: false,
    autoResolve: false,
    language: 'en',
    keyConfigured: false,
  },
];

const mockStatuses: OpenProjectStatusDto[] = [
  { id: 1, name: 'New', isClosed: false, position: 1 },
  { id: 2, name: 'In progress', isClosed: false, position: 2 },
  { id: 3, name: 'Resolved', isClosed: true, position: 3 },
  { id: 4, name: 'Reopened', isClosed: false, position: 4 },
  { id: 5, name: 'Closed', isClosed: true, position: 5 },
];

function renderWithProviders(ui: React.ReactElement, initialLocale: Locale = 'vi') {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <LocaleProvider initialLocale={initialLocale}>
          <MemoryRouter>{ui}</MemoryRouter>
        </LocaleProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

describe('Integrations UI Suite', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(client, 'getOpenProjectSources').mockResolvedValue(mockSources);
    vi.spyOn(client, 'getOpenProjectStatuses').mockResolvedValue(mockStatuses);
    vi.spyOn(client, 'getGiteaStatus').mockResolvedValue({ projectId: 'proj-1', status: 'ok', finishedAt: '2026-11-03T10:00:00Z' });
    vi.spyOn(client, 'getRemoteDeployStatus').mockResolvedValue({ projectId: 'proj-1', status: 'succeeded', finishedAt: '2026-11-03T11:00:00Z' });
    vi.spyOn(client, 'getEffectiveConfig').mockResolvedValue({} as any);
    vi.spyOn(client, 'getProjectGitStatus').mockResolvedValue({ path: mockProject.path, currentBranch: 'main', defaultBranch: 'main', dirty: { changed: true, files: 2 }, remote: 'https://example.com/team/repo.git', localBranches: ['main'], remoteBranches: ['main', 'dev-ss'], aheadBehind: { ahead: 1, behind: 2 } });
    vi.spyOn(client, 'getTasks').mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('1. parseArgv & parseDeployEnv', () => {
    it('splits standard commands with multiple arguments without shell', () => {
      expect(parseArgv('npm test -- --run')).toEqual(['npm', 'test', '--', '--run']);
      expect(parseArgv('docker run -d -p 8080:80 nginx')).toEqual(['docker', 'run', '-d', '-p', '8080:80', 'nginx']);
    });

    it('handles double quoted strings with whitespace and preserves content', () => {
      expect(parseArgv('git commit -m "feat: initial commit"')).toEqual([
        'git',
        'commit',
        '-m',
        'feat: initial commit',
      ]);
    });

    it('handles single quoted strings', () => {
      expect(parseArgv("echo 'hello world'")).toEqual(['echo', 'hello world']);
    });

    it('handles nested quotes of different types', () => {
      expect(parseArgv('echo "it\'s great"')).toEqual(['echo', "it's great"]);
      expect(parseArgv('echo \'say "hello"\'')).toEqual(['echo', 'say "hello"']);
    });

    it('handles empty quotes as empty string argument', () => {
      expect(parseArgv('cmd "" arg')).toEqual(['cmd', '', 'arg']);
      expect(parseArgv("cmd '' arg")).toEqual(['cmd', '', 'arg']);
    });

    it('handles backslash-escaped characters', () => {
      expect(parseArgv('echo hello\\ world')).toEqual(['echo', 'hello world']);
      expect(parseArgv('echo "escaped \\"quote\\""')).toEqual(['echo', 'escaped "quote"']);
    });

    it('returns empty array for empty or whitespace strings', () => {
      expect(parseArgv('')).toEqual([]);
      expect(parseArgv('   ')).toEqual([]);
    });

    it('parseDeployEnv correctly preserves equal signs in values like base64 or URLs', () => {
      const parsed = parseDeployEnv(`
        TOKEN=abc=def
        BASE64=YmVzdD1zZWNyZXQ=
        URL=https://example.com/api?a=1&b=2
        # comment line
        EMPTY=
      `);
      expect(parsed).toEqual({
        TOKEN: 'abc=def',
        BASE64: 'YmVzdD1zZWNyZXQ=',
        URL: 'https://example.com/api?a=1&b=2',
        EMPTY: '',
      });
    });
  });

  describe('2. ProjectSettingsDrawer Integrations Sections', () => {
    it('renders Git status, warns for remote-only branch and saves the default branch', async () => {
      const updateSpy = vi.spyOn(client, 'updateProject').mockResolvedValue({ ...mockProject, defaultBranch: 'dev-ss' });
      renderWithProviders(<ProjectSettingsDrawer project={mockProject} isOpen={true} onClose={vi.fn()} />);

      const gitSection = await screen.findByTestId('project-git-section');
      await waitFor(() => expect(within(gitSection).getByText(/2 file chưa commit/i)).toBeInTheDocument());
      fireEvent.change(within(gitSection).getByTestId('project-git-default-branch'), { target: { value: 'dev-ss' } });
      expect(within(gitSection).getByText(/chưa có ở máy/i)).toBeInTheDocument();
      fireEvent.click(screen.getByTestId('save-changes-button'));

      await waitFor(() => expect(updateSpy).toHaveBeenCalledWith('proj-1', expect.objectContaining({ defaultBranch: 'dev-ss' })));
    });

    it('renders OpenProject section and saves changes via updateProject', async () => {
      const updateSpy = vi.spyOn(client, 'updateProject').mockResolvedValue(mockProject);

      renderWithProviders(
        <ProjectSettingsDrawer
          project={mockProject}
          isOpen={true}
          onClose={vi.fn()}
        />,
      );

      await waitFor(() => {
        expect(screen.getByTestId('project-openproject-section')).toBeInTheDocument();
      });

      // Initially no unsaved changes bar
      expect(screen.queryByTestId('unsaved-changes-bar')).not.toBeInTheDocument();

      // Enable OpenProject
      const openprojectSection = screen.getByTestId('project-openproject-section');
      const enableCheckbox = openprojectSection.querySelector('input[type="checkbox"]')!;
      fireEvent.click(enableCheckbox);

      // Dirty tracking should activate
      await waitFor(() => {
        expect(screen.getByTestId('unsaved-changes-bar')).toBeInTheDocument();
      });

      // Select source
      const sourceSelect = openprojectSection.querySelector('select')!;
      fireEvent.change(sourceSelect, { target: { value: 'op-corp' } });

      // Click Save
      const saveBtn = screen.getByTestId('save-changes-button');
      fireEvent.click(saveBtn);

      await waitFor(() => {
        expect(updateSpy).toHaveBeenCalledWith(
          'proj-1',
          expect.objectContaining({
            settings: expect.objectContaining({
              openproject: expect.objectContaining({
                enabled: true,
                sourceId: 'op-corp',
              }),
            }),
          }),
        );
      });
    });

    it('supports multi-slot HH:MM Gitea schedule, adds/removes slots and saves', async () => {
      const updateSpy = vi.spyOn(client, 'updateProject').mockResolvedValue(mockProject);

      renderWithProviders(
        <ProjectSettingsDrawer
          project={mockProject}
          isOpen={true}
          onClose={vi.fn()}
        />,
      );

      await waitFor(() => {
        expect(screen.getByTestId('project-gitea-section')).toBeInTheDocument();
      });

      const giteaSection = screen.getByTestId('project-gitea-section');
      expect(screen.getByTestId('gitea-schedule-section')).toBeInTheDocument();

      // Check initial 2 time slots: 12:00, 18:00
      const initialSlots = screen.getAllByLabelText(/Lịch \(HH:MM\)/);
      expect(initialSlots).toHaveLength(2);
      expect(initialSlots[0]).toHaveValue('12:00');
      expect(initialSlots[1]).toHaveValue('18:00');

      // Add a third slot
      const addSlotBtn = screen.getByTestId('add-gitea-schedule-slot');
      fireEvent.click(addSlotBtn);

      const slotsAfterAdd = screen.getAllByLabelText(/Lịch \(HH:MM\)/);
      expect(slotsAfterAdd).toHaveLength(3);

      // Modify the third slot
      fireEvent.change(slotsAfterAdd[2], { target: { value: '20:30' } });

      // Enable Gitea
      const enableGitea = giteaSection.querySelector('input[type="checkbox"]')!;
      fireEvent.click(enableGitea);

      await waitFor(() => {
        expect(screen.getByTestId('unsaved-changes-bar')).toBeInTheDocument();
      });

      // Save
      fireEvent.click(screen.getByTestId('save-changes-button'));

      await waitFor(() => {
        expect(updateSpy).toHaveBeenCalledWith(
          'proj-1',
          expect.objectContaining({
            settings: expect.objectContaining({
              gitea: expect.objectContaining({
                enabled: true,
                schedule: ['12:00', '18:00', '20:30'],
              }),
            }),
          }),
        );
      });
    });

    it('does not render Gitea token, deploy env secrets, and saves them securely', async () => {
      const saveTokenSpy = vi.spyOn(client, 'saveGiteaToken').mockResolvedValue({} as any);
      const saveEnvSpy = vi.spyOn(client, 'saveRemoteDeployEnv').mockResolvedValue({ keys: ['TOKEN'] });

      renderWithProviders(
        <ProjectSettingsDrawer
          project={mockProject}
          isOpen={true}
          onClose={vi.fn()}
        />,
      );

      await waitFor(() => {
        expect(screen.getByTestId('project-gitea-section')).toBeInTheDocument();
        expect(screen.getByTestId('project-remote-deploy-section')).toBeInTheDocument();
      });

      // Check Gitea token input is type=password and empty initially
      const tokenInput = screen.getByLabelText('Token Gitea') as HTMLInputElement;
      expect(tokenInput.type).toBe('password');
      expect(tokenInput.value).toBe('');

      // Enter token and save
      fireEvent.change(tokenInput, { target: { value: 'secret-token-123' } });
      const saveTokenBtn = screen.getByTestId('save-gitea-token-button');
      expect(saveTokenBtn).toHaveTextContent('Lưu token');
      fireEvent.click(saveTokenBtn);

      await waitFor(() => {
        expect(saveTokenSpy).toHaveBeenCalledWith('proj-1', 'secret-token-123');
      });

      // Check Deploy env input is type=password and empty initially
      const envInput = screen.getByLabelText('Bí mật env') as HTMLInputElement;
      expect(envInput.type).toBe('password');
      expect(envInput.value).toBe('');
      expect(envInput.placeholder).toBe('KEY=VALUE');

      // Enter deploy secrets with '=' inside value
      fireEvent.change(envInput, { target: { value: 'TOKEN=secret=with=equals' } });
      const saveEnvBtn = screen.getByTestId('save-deploy-env-button');
      expect(saveEnvBtn).toHaveTextContent('Lưu biến bí mật');
      fireEvent.click(saveEnvBtn);

      await waitFor(() => {
        expect(saveEnvSpy).toHaveBeenCalledWith('proj-1', {
          TOKEN: 'secret=with=equals',
        });
      });

      // Verify that after saving, only key names are shown
      await waitFor(() => {
        expect(screen.getByTestId('saved-deploy-keys')).toHaveTextContent('Key bí mật đã lưu: TOKEN');
      });
      // The secret value is never in the DOM
      expect(screen.queryByText('secret=with=equals')).not.toBeInTheDocument();
    });

    it('saves Remote Deploy settings via updateProject with dirty tracking', async () => {
      const updateSpy = vi.spyOn(client, 'updateProject').mockResolvedValue(mockProject);

      renderWithProviders(
        <ProjectSettingsDrawer
          project={mockProject}
          isOpen={true}
          onClose={vi.fn()}
        />,
      );

      await waitFor(() => {
        expect(screen.getByTestId('project-remote-deploy-section')).toBeInTheDocument();
      });

      const deploySection = screen.getByTestId('project-remote-deploy-section');
      const enableDeploy = deploySection.querySelector('input[type="checkbox"]')!;
      fireEvent.click(enableDeploy);

      // Select trigger after-gitea-sync
      const triggerSelect = deploySection.querySelector('select')!;
      fireEvent.change(triggerSelect, { target: { value: 'after-gitea-sync' } });

      await waitFor(() => {
        expect(screen.getByTestId('unsaved-changes-bar')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('save-changes-button'));

      await waitFor(() => {
        expect(updateSpy).toHaveBeenCalledWith(
          'proj-1',
          expect.objectContaining({
            settings: expect.objectContaining({
              remoteDeploy: expect.objectContaining({
                enabled: true,
                trigger: 'after-gitea-sync',
              }),
            }),
          }),
        );
      });
    });

    it('supports getByLabelText for integration fields: Nhánh nguồn, Nhánh đích, URL Gitea, Token Gitea, Trigger, Steps', async () => {
      renderWithProviders(
        <ProjectSettingsDrawer
          project={mockProject}
          isOpen={true}
          onClose={vi.fn()}
        />,
      );

      await waitFor(() => {
        expect(screen.getByTestId('project-gitea-section')).toBeInTheDocument();
        expect(screen.getByTestId('project-remote-deploy-section')).toBeInTheDocument();
      });

      expect(screen.getByLabelText('Nhánh nguồn')).toBeInTheDocument();
      expect(screen.getByLabelText('Nhánh đích')).toBeInTheDocument();
      expect(screen.getByLabelText('URL Gitea')).toBeInTheDocument();
      expect(screen.getByLabelText('Token Gitea')).toBeInTheDocument();
      expect(screen.getByLabelText('Trigger')).toBeInTheDocument();
      expect(screen.getByLabelText('Steps')).toBeInTheDocument();
    });

    it('renders link to /settings when no OpenProject sources are configured', async () => {
      vi.spyOn(client, 'getOpenProjectSources').mockResolvedValue([]);

      renderWithProviders(
        <ProjectSettingsDrawer
          project={mockProject}
          isOpen={true}
          onClose={vi.fn()}
        />,
      );

      await waitFor(() => {
        expect(screen.getByTestId('project-openproject-section')).toBeInTheDocument();
      });

      const settingsLink = screen.getByRole('link', { name: /Cài đặt/ });
      expect(settingsLink).toHaveAttribute('href', '/settings');
    });

    it('changes token badge according to tokenConfigured', async () => {
      // Case 1: tokenConfigured: false
      vi.spyOn(client, 'getGiteaStatus').mockResolvedValue({
        tokenConfigured: false,
      });

      const { unmount } = renderWithProviders(
        <ProjectSettingsDrawer
          project={mockProject}
          isOpen={true}
          onClose={vi.fn()}
        />,
      );

      await waitFor(() => {
        expect(screen.getByTestId('gitea-token-badge')).toHaveTextContent('Chưa có token');
      });

      unmount();

      // Case 2: tokenConfigured: true
      vi.spyOn(client, 'getGiteaStatus').mockResolvedValue({
        tokenConfigured: true,
      });

      renderWithProviders(
        <ProjectSettingsDrawer
          project={mockProject}
          isOpen={true}
          onClose={vi.fn()}
        />,
      );

      await waitFor(() => {
        expect(screen.getByTestId('gitea-token-badge')).toHaveTextContent('Đã cấu hình');
      });
    });

    it('renders Repo line when status returns remote and hides when null', async () => {
      // When remote exists
      vi.spyOn(client, 'getGiteaStatus').mockResolvedValue({
        tokenConfigured: true,
        remote: {
          host: 'git.example.com',
          owner: 'acme',
          repo: 'core-api',
        },
      });

      const { unmount } = renderWithProviders(
        <ProjectSettingsDrawer
          project={mockProject}
          isOpen={true}
          onClose={vi.fn()}
        />,
      );

      await waitFor(() => {
        const repoInfo = screen.getByTestId('gitea-repo-info');
        expect(repoInfo).toBeInTheDocument();
        expect(repoInfo).toHaveTextContent('Repo: acme/core-api (đọc từ git remote origin)');
      });

      unmount();

      // When remote is null
      vi.spyOn(client, 'getGiteaStatus').mockResolvedValue({
        tokenConfigured: false,
        remote: null,
      });

      renderWithProviders(
        <ProjectSettingsDrawer
          project={mockProject}
          isOpen={true}
          onClose={vi.fn()}
        />,
      );

      await waitFor(() => {
        expect(screen.getByTestId('project-gitea-section')).toBeInTheDocument();
      });

      expect(screen.queryByTestId('gitea-repo-info')).not.toBeInTheDocument();
    });

    it('polls a running Gitea sync every 3 seconds, then shows the last result and PR link', async () => {
      const getStatus = vi.mocked(client.getGiteaStatus);
      getStatus.mockReset();
      let statusCalls = 0;
      getStatus.mockImplementation(async () => {
        statusCalls += 1;
        if (statusCalls <= 2) return { tokenConfigured: true, running: true, startedAt: '2026-11-04T10:00:00Z', step: 'fetch' };
        return {
          tokenConfigured: true,
          running: false,
          last: {
            status: 'succeeded',
            finishedAt: '2026-11-04T10:00:05Z',
            reason: 'Đã đồng bộ',
            prNumber: 42,
            url: 'https://gitea.example.com/acme/repo/pulls/42',
          },
        };
      });

      renderWithProviders(
        <ProjectSettingsDrawer project={mockProject} isOpen={true} onClose={vi.fn()} />,
      );

      await waitFor(() => {
        const button = screen.getByTestId('sync-gitea-button');
        expect(button).toBeDisabled();
        expect(button).toHaveTextContent('Đang đồng bộ… (fetch)');
        return button;
      });

      await new Promise((resolve) => setTimeout(resolve, 6_200));
      await waitFor(() => {
        expect(screen.getByTestId('gitea-last-sync')).toHaveTextContent('thành công');
        expect(screen.getByTestId('gitea-last-sync')).toHaveTextContent('Đã đồng bộ');
      });
      const prLink = screen.getByRole('link', { name: 'PR #42' });
      expect(prLink).toHaveAttribute('href', 'https://gitea.example.com/acme/repo/pulls/42');
      expect(getStatus).toHaveBeenCalledTimes(3);

      await new Promise((resolve) => setTimeout(resolve, 3_100));
      expect(getStatus).toHaveBeenCalledTimes(3);
    }, 15_000);

    it('shows loading state for Remote Deploy deploy-now and save secrets', async () => {
      let resolveDeploy: (val: any) => void = () => {};
      const deployPromise = new Promise((resolve) => {
        resolveDeploy = resolve;
      });
      vi.spyOn(client, 'triggerRemoteDeploy').mockImplementation(() => deployPromise as any);

      let resolveSaveSecrets: (val: any) => void = () => {};
      const saveSecretsPromise = new Promise((resolve) => {
        resolveSaveSecrets = resolve;
      });
      vi.spyOn(client, 'saveRemoteDeployEnv').mockImplementation(() => saveSecretsPromise as any);

      renderWithProviders(
        <ProjectSettingsDrawer project={mockProject} isOpen={true} onClose={vi.fn()} />,
      );

      await waitFor(() => {
        expect(screen.getByTestId('project-remote-deploy-section')).toBeInTheDocument();
      });

      // Click deploy now
      const deployNowBtn = screen.getByTestId('deploy-now-button');
      fireEvent.click(deployNowBtn);

      await waitFor(() => {
        expect(deployNowBtn).toBeDisabled();
        expect(deployNowBtn).toHaveAttribute('aria-busy', 'true');
        expect(deployNowBtn).toHaveTextContent('Đang deploy…');
        expect(deployNowBtn.querySelector('.animate-spin')).toBeInTheDocument();
      });

      await act(async () => {
        resolveDeploy({ ok: true });
      });

      await waitFor(() => {
        expect(deployNowBtn).not.toBeDisabled();
        expect(deployNowBtn).toHaveTextContent('Deploy ngay');
        expect(screen.getByTestId('deploy-status-message')).toHaveTextContent('Đã kích hoạt deploy');
        expect(screen.getByTestId('deploy-status-message')).toHaveClass('text-[var(--t-ok)]');
      });

      // Enter secret env and click save
      const secretsInput = screen.getByPlaceholderText('KEY=VALUE');
      fireEvent.change(secretsInput, { target: { value: 'API_KEY=123' } });

      const saveSecretsBtn = screen.getByTestId('save-deploy-env-button');
      fireEvent.click(saveSecretsBtn);

      await waitFor(() => {
        expect(saveSecretsBtn).toBeDisabled();
        expect(saveSecretsBtn).toHaveAttribute('aria-busy', 'true');
        expect(saveSecretsBtn).toHaveTextContent('Đang lưu…');
        expect(saveSecretsBtn.querySelector('.animate-spin')).toBeInTheDocument();
      });

      await act(async () => {
        resolveSaveSecrets(['API_KEY']);
      });

      await waitFor(() => {
        expect(screen.getByTestId('deploy-status-message')).toHaveTextContent('Đã lưu biến môi trường bí mật');
        expect(screen.getByTestId('deploy-status-message')).toHaveClass('text-[var(--t-ok)]');
      });
    });

    it('shows loading state and error message for Gitea save token', async () => {
      vi.spyOn(client, 'saveGiteaToken').mockRejectedValue(new Error('Token Gitea không hợp lệ'));

      renderWithProviders(
        <ProjectSettingsDrawer project={mockProject} isOpen={true} onClose={vi.fn()} />,
      );

      await waitFor(() => {
        expect(screen.getByTestId('project-gitea-section')).toBeInTheDocument();
      });

      const tokenInput = screen.getByPlaceholderText('Dán token rồi bấm Lưu token');
      fireEvent.change(tokenInput, { target: { value: 'bad-token' } });

      const saveTokenBtn = screen.getByTestId('save-gitea-token-button');
      fireEvent.click(saveTokenBtn);

      await waitFor(() => {
        const msg = screen.getByTestId('gitea-status-message');
        expect(msg).toHaveTextContent('Token Gitea không hợp lệ');
        expect(msg).toHaveClass('text-[var(--t-crit)]');
      });
    });
  });

  describe('3. OpenProjectSettings Global Settings', () => {
    it('displays keyConfigured status without exposing the API key', async () => {
      renderWithProviders(<OpenProjectSettings />);

      await waitFor(() => {
        expect(screen.getByTestId('openproject-global-settings')).toBeInTheDocument();
      });

      // op-corp has keyConfigured: true -> placeholder should be "Đã cấu hình"
      const keyInput = screen.getByLabelText('API key') as HTMLInputElement;
      expect(keyInput.type).toBe('password');
      expect(keyInput.placeholder).toBe('Đã cấu hình');
      expect(keyInput.value).toBe('');

      // Switch to op-client which has keyConfigured: false
      const clientSourceBtn = screen.getByText('op-client');
      fireEvent.click(clientSourceBtn);

      expect(keyInput.placeholder).toBe('');
      expect(keyInput.value).toBe('');
    });

    it('displays friendly translated messages for test, sync and daily report', async () => {
      const testSpy = vi.spyOn(client, 'testOpenProjectConnection').mockResolvedValue({ ok: true, name: 'OpenProject Production' });
      const syncSpy = vi.spyOn(client, 'syncOpenProject').mockResolvedValue({ imported: 5, comments: 2 } as any);
      const reportSpy = vi.spyOn(client, 'createOpenProjectDailyReport').mockResolvedValue({ ok: true, path: '/tmp/report.txt', content: 'test' } as any);

      renderWithProviders(<OpenProjectSettings />);

      await waitFor(() => {
        expect(screen.getByTestId('openproject-global-settings')).toBeInTheDocument();
      });

      // Test connection
      const testBtn = screen.getByText('Kiểm tra kết nối');
      fireEvent.click(testBtn);

      await waitFor(() => {
        expect(testSpy).toHaveBeenCalledWith('op-corp');
        expect(screen.getByRole('status')).toHaveTextContent('Kết nối OK: OpenProject Production');
      });

      // Sync now
      const syncBtn = screen.getByText('Đồng bộ ngay');
      fireEvent.click(syncBtn);

      await waitFor(() => {
        expect(syncSpy).toHaveBeenCalledWith('op-corp');
        expect(screen.getByRole('status')).toHaveTextContent('Đã nhập 5 ticket');
      });

      // Daily report
      const reportBtn = screen.getByText('Tạo báo cáo ngày');
      fireEvent.click(reportBtn);

      await waitFor(() => {
        expect(reportSpy).toHaveBeenCalledWith('op-corp');
        expect(screen.getByRole('status')).toHaveTextContent('Đã tạo báo cáo ngày');
      });
    });

    it('shows loading spinner and disables sync button until promise resolves, and displays baseline results', async () => {
      let resolveSync: (val: any) => void = () => {};
      const syncPromise = new Promise((resolve) => {
        resolveSync = resolve;
      });
      const syncSpy = vi.spyOn(client, 'syncOpenProject').mockImplementation(() => syncPromise as any);

      renderWithProviders(<OpenProjectSettings />);

      await waitFor(() => {
        expect(screen.getByText('Đồng bộ ngay')).toBeInTheDocument();
      });

      const syncBtn = screen.getByText('Đồng bộ ngay');
      fireEvent.click(syncBtn);

      await waitFor(() => {
        expect(syncBtn).toBeDisabled();
        expect(syncBtn).toHaveAttribute('aria-busy', 'true');
        expect(syncBtn).toHaveTextContent('Đang đồng bộ…');
        expect(syncBtn.querySelector('.animate-spin')).toBeInTheDocument();
      }, { timeout: 5000 });

      // Other buttons (e.g. Test connection) should NOT be disabled
      expect(screen.getByText('Kiểm tra kết nối')).not.toBeDisabled();

      // Resolve with baseline tickets
      await act(async () => {
        resolveSync({ baseline: 13, watched: 13, imported: 0, comments: 0 });
      });

      await waitFor(() => {
        expect(syncSpy).toHaveBeenCalledWith('op-corp');
        expect(syncBtn).not.toBeDisabled();
        expect(syncBtn).toHaveTextContent('Đồng bộ ngay');
        expect(screen.getByRole('status')).toHaveTextContent('Đã ghi mốc 13 ticket (lần đầu, chưa tạo task, theo dõi 13)');
        expect(screen.getByRole('status')).toHaveClass('text-[var(--t-ok)]');
      }, { timeout: 5000 });
    }, 15_000);

    it('displays error message from server with crit color when save fails', async () => {
      vi.spyOn(client, 'saveOpenProjectSource').mockRejectedValue(new Error('Tên project trong OpenProject không hợp lệ'));

      renderWithProviders(<OpenProjectSettings />);

      await waitFor(() => {
        expect(screen.getByTestId('openproject-global-settings')).toBeInTheDocument();
        expect(screen.getByText('Lưu')).not.toBeDisabled();
      });

      const saveBtn = screen.getByText('Lưu');
      fireEvent.click(saveBtn);

      await waitFor(() => {
        const status = screen.getByRole('status');
        expect(status).toHaveTextContent('Tên project trong OpenProject không hợp lệ');
        expect(status).toHaveClass('text-[var(--t-crit)]');
      });
    });

    it('displays separate error message when saving API key fails', async () => {
      vi.spyOn(client, 'saveOpenProjectSource').mockResolvedValue(mockSources[0]);
      vi.spyOn(client, 'saveOpenProjectKey').mockRejectedValue(new Error('Key 401 Unauthorized'));

      renderWithProviders(<OpenProjectSettings />);

      await waitFor(() => {
        expect(screen.getByTestId('openproject-global-settings')).toBeInTheDocument();
        expect(screen.getByText('Lưu')).not.toBeDisabled();
      });

      const keyInput = screen.getByLabelText('API key');
      fireEvent.change(keyInput, { target: { value: 'invalid-key' } });

      const saveBtn = screen.getByText('Lưu');
      fireEvent.click(saveBtn);

      await waitFor(() => {
        const status = screen.getByRole('status');
        expect(status).toHaveTextContent('Lưu API key thất bại: Key 401 Unauthorized');
        expect(status).toHaveClass('text-[var(--t-crit)]');
      });
    });

    it('displays sync results with watched and baseline 0 on subsequent syncs', async () => {
      const syncSpy = vi.spyOn(client, 'syncOpenProject').mockResolvedValue({
        imported: 1,
        comments: 0,
        baseline: 0,
        watched: 13,
      });

      renderWithProviders(<OpenProjectSettings />);

      await waitFor(() => {
        expect(screen.getByTestId('openproject-global-settings')).toBeInTheDocument();
        expect(screen.getByText('Đồng bộ ngay')).not.toBeDisabled();
      });

      const syncBtn = screen.getByText('Đồng bộ ngay');
      fireEvent.click(syncBtn);

      await waitFor(() => {
        expect(syncSpy).toHaveBeenCalledWith('op-corp');
        expect(screen.getByRole('status')).toHaveTextContent('Đã nhập 1 ticket (theo dõi 13, mốc 0)');
        expect(screen.getByRole('status')).toHaveClass('text-[var(--t-ok)]');
      });
    });

    it('displays sync results with baseline only when watched is not provided', async () => {
      const syncSpy = vi.spyOn(client, 'syncOpenProject').mockResolvedValue({
        imported: 0,
        comments: 0,
        baseline: 7,
      } as any);

      renderWithProviders(<OpenProjectSettings />);

      await waitFor(() => {
        expect(screen.getByTestId('openproject-global-settings')).toBeInTheDocument();
        expect(screen.getByText('Đồng bộ ngay')).not.toBeDisabled();
      });

      const syncBtn = screen.getByText('Đồng bộ ngay');
      fireEvent.click(syncBtn);

      await waitFor(() => {
        expect(syncSpy).toHaveBeenCalledWith('op-corp');
        expect(screen.getByRole('status')).toHaveTextContent('Đã ghi mốc 7 ticket (lần đầu, chưa tạo task)');
        expect(screen.getByRole('status')).toHaveClass('text-[var(--t-ok)]');
      });
    });

    it('disables Test Connection, Sync, and Daily Report buttons with tooltip when source is unsaved', async () => {
      renderWithProviders(<OpenProjectSettings />);

      await waitFor(() => {
        expect(screen.getByTestId('openproject-global-settings')).toBeInTheDocument();
      });

      // Click "Thêm nguồn"
      const addBtn = screen.getByText('Thêm nguồn');
      fireEvent.click(addBtn);

      // Buttons should be disabled with tooltip "Lưu nguồn trước"
      await waitFor(() => {
        const testBtn = screen.getByText('Kiểm tra kết nối');
        const syncBtn = screen.getByText('Đồng bộ ngay');
        const reportBtn = screen.getByText('Tạo báo cáo ngày');

        expect(testBtn).toBeDisabled();
        expect(testBtn).toHaveAttribute('title', 'Lưu nguồn trước');

        expect(syncBtn).toBeDisabled();
        expect(syncBtn).toHaveAttribute('title', 'Lưu nguồn trước');

        expect(reportBtn).toBeDisabled();
        expect(reportBtn).toHaveAttribute('title', 'Lưu nguồn trước');
      });
    });
  });

  describe('3b. OpenProject Status Picker & Fallback', () => {
    it('parseIdList helper drops empty elements, avoids generating 0, and parses comma lists', () => {
      expect(parseIdList('1, 100')).toEqual([1, 100]);
      expect(parseIdList('1,')).toEqual([1]);
      expect(parseIdList('')).toEqual([]);
      expect(parseIdList('   ')).toEqual([]);
      expect(parseIdList('1, , 2')).toEqual([1, 2]);
      expect(parseIdList('0, 5')).toEqual([0, 5]);
      expect(parseIdList('1, abc, 100')).toEqual([1, 100]);
    });

    it('matchStatusIds helper matches names case-insensitively', () => {
      expect(matchStatusIds(mockStatuses, ['new', 'reopened'])).toEqual([1, 4]);
      expect(matchStatusIds(mockStatuses, ['reopened'])).toEqual([4]);
      expect(matchStatusIds(mockStatuses, ['new', 'reopened', 'in progress'])).toEqual([1, 2, 4]);
      expect(matchStatusIds(mockStatuses, ['nonexistent'])).toEqual([]);
    });

    it('renders multi-select chips and single select options with Name (id) when key and statuses are present', async () => {
      renderWithProviders(<OpenProjectSettings />);

      await waitFor(() => {
        expect(screen.getByTestId('openproject-global-settings')).toBeInTheDocument();
        expect(screen.getByTestId('status-picker-watchStatusIds')).toBeInTheDocument();
      });

      // Statuses from mockStatuses are rendered in watchStatusIds picker
      const watchPicker = screen.getByTestId('status-picker-watchStatusIds');
      expect(within(watchPicker).getByText('New (1)')).toBeInTheDocument();
      expect(within(watchPicker).getByText('In progress (2)')).toBeInTheDocument();
      expect(within(watchPicker).getByText('Resolved (3)')).toBeInTheDocument();
      expect(within(watchPicker).getByText('Reopened (4)')).toBeInTheDocument();
      expect(within(watchPicker).getByText('Closed (5)')).toBeInTheDocument();

      // For op-corp, watchStatusIds is [1, 2] -> checkboxes 1 and 2 are checked
      const chip1 = screen.getByTestId('status-chip-watchStatusIds-1').querySelector('input')!;
      const chip2 = screen.getByTestId('status-chip-watchStatusIds-2').querySelector('input')!;
      const chip3 = screen.getByTestId('status-chip-watchStatusIds-3').querySelector('input')!;
      expect(chip1.checked).toBe(true);
      expect(chip2.checked).toBe(true);
      expect(chip3.checked).toBe(false);

      // op-corp has resolvedStatusId: 7 which is not in mockStatuses -> shows unknown
      const resolvedSelect = screen.getByTestId('status-select-resolvedStatusId') as HTMLSelectElement;
      expect(resolvedSelect.value).toBe('7');
      expect(screen.getByText(/không rõ \(7\)/)).toBeInTheDocument();
    });

    it('selecting and deselecting chips updates ID array and persists on save', async () => {
      const saveSpy = vi.spyOn(client, 'saveOpenProjectSource').mockResolvedValue(mockSources[0]);

      renderWithProviders(<OpenProjectSettings />);

      await waitFor(() => {
        expect(screen.getByTestId('status-picker-watchStatusIds')).toBeInTheDocument();
      });

      // Uncheck New (1)
      const chip1 = screen.getByTestId('status-chip-watchStatusIds-1').querySelector('input')!;
      fireEvent.click(chip1);
      expect(chip1.checked).toBe(false);

      // Check Closed (5)
      const chip5 = screen.getByTestId('status-chip-watchStatusIds-5').querySelector('input')!;
      fireEvent.click(chip5);
      expect(chip5.checked).toBe(true);

      // Save
      fireEvent.click(screen.getByText('Lưu'));

      await waitFor(() => {
        expect(saveSpy).toHaveBeenCalledWith(
          'op-corp',
          expect.objectContaining({
            watchStatusIds: [2, 5],
          }),
        );
      });
    });

    it('single select allows choosing null (-- không đổi --) or status ID', async () => {
      const saveSpy = vi.spyOn(client, 'saveOpenProjectSource').mockResolvedValue(mockSources[0]);

      renderWithProviders(<OpenProjectSettings />);

      await waitFor(() => {
        expect(screen.getByTestId('status-select-resolvedStatusId')).toBeInTheDocument();
      });

      const select = screen.getByTestId('status-select-resolvedStatusId') as HTMLSelectElement;
      expect(select.value).toBe('7');

      // Select null ("— không đổi —")
      fireEvent.change(select, { target: { value: '' } });
      expect(select.value).toBe('');

      // Select Resolved (3) for reviewStatusId
      const reviewSelect = screen.getByTestId('status-select-reviewStatusId') as HTMLSelectElement;
      fireEvent.change(reviewSelect, { target: { value: '3' } });
      expect(reviewSelect.value).toBe('3');

      // Save
      fireEvent.click(screen.getByText('Lưu'));

      await waitFor(() => {
        expect(saveSpy).toHaveBeenCalledWith(
          'op-corp',
          expect.objectContaining({
            resolvedStatusId: null,
            reviewStatusId: 3,
          }),
        );
      });
    });

    it('falls back to manual inputs with hint when key is missing or statuses API fails', async () => {
      renderWithProviders(<OpenProjectSettings />);

      await waitFor(() => {
        expect(screen.getByTestId('openproject-global-settings')).toBeInTheDocument();
      });

      // Switch to op-client which has keyConfigured: false
      fireEvent.click(screen.getByText('op-client'));

      await waitFor(() => {
        expect(screen.getByTestId('status-picker-hint')).toHaveTextContent('Lưu URL + API key rồi bấm Tải lại');
        expect(screen.getByTestId('manual-input-watchStatusIds')).toBeInTheDocument();
      });

      // When API rejects with error on an existing source
      vi.spyOn(client, 'getOpenProjectStatuses').mockRejectedValueOnce(new Error('Network error'));
      fireEvent.click(screen.getByText('op-corp'));

      await waitFor(() => {
        expect(screen.getByTestId('status-picker-hint')).toHaveTextContent('Lưu URL + API key rồi bấm Tải lại');
        expect(screen.getByTestId('manual-input-watchStatusIds')).toBeInTheDocument();
      });
    });

    it('typing in manual inputs does not produce 0 and parses properly on blur or save', async () => {
      const saveSpy = vi.spyOn(client, 'saveOpenProjectSource').mockResolvedValue(mockSources[1]);

      renderWithProviders(<OpenProjectSettings />);

      await waitFor(() => {
        expect(screen.getByTestId('openproject-global-settings')).toBeInTheDocument();
      });

      // Switch to op-client (manual input mode)
      fireEvent.click(screen.getByText('op-client'));

      await waitFor(() => {
        expect(screen.getByTestId('manual-input-watchStatusIds')).toBeInTheDocument();
      });

      const input = screen.getByTestId('manual-input-watchStatusIds') as HTMLInputElement;

      // Typing "1," should NOT produce "1, 0"
      fireEvent.change(input, { target: { value: '1,' } });
      expect(input.value).toBe('1,');

      // Typing "1, 100"
      fireEvent.change(input, { target: { value: '1, 100' } });
      expect(input.value).toBe('1, 100');

      // Blur parses properly
      fireEvent.blur(input);
      expect(input.value).toBe('1, 100');

      // Save persists [1, 100]
      fireEvent.click(screen.getByText('Lưu'));

      await waitFor(() => {
        expect(saveSpy).toHaveBeenCalledWith(
          'op-client',
          expect.objectContaining({
            watchStatusIds: [1, 100],
          }),
        );
      });
    });

    it('suggest by name button fills default statuses for an empty source without overwriting existing values', async () => {
      const emptySource: OpenProjectSource = {
        ...mockSources[0],
        id: 'op-empty',
        watchStatusIds: [],
        reopenedStatusIds: [],
        resolvedStatusId: null,
        reviewStatusId: null,
        openStatusIds: [],
      };
      vi.spyOn(client, 'getOpenProjectSources').mockResolvedValue([emptySource]);

      renderWithProviders(<OpenProjectSettings />);

      await waitFor(() => {
        expect(screen.getByTestId('suggest-statuses-button')).toBeInTheDocument();
      });

      // Click Suggest button
      fireEvent.click(screen.getByTestId('suggest-statuses-button'));

      // watchStatusIds should become [1, 4] (New, Reopened)
      // reopenedStatusIds should become [4] (Reopened)
      // resolvedStatusId should become 3 (Resolved)
      // openStatusIds should become [1, 2, 4] (New, Reopened, In progress)
      await waitFor(() => {
        const watch1 = screen.getByTestId('status-chip-watchStatusIds-1').querySelector('input')!;
        const watch4 = screen.getByTestId('status-chip-watchStatusIds-4').querySelector('input')!;
        expect(watch1.checked).toBe(true);
        expect(watch4.checked).toBe(true);

        const reopened4 = screen.getByTestId('status-chip-reopenedStatusIds-4').querySelector('input')!;
        expect(reopened4.checked).toBe(true);

        const resolvedSelect = screen.getByTestId('status-select-resolvedStatusId') as HTMLSelectElement;
        expect(resolvedSelect.value).toBe('3');

        const open1 = screen.getByTestId('status-chip-openStatusIds-1').querySelector('input')!;
        const open2 = screen.getByTestId('status-chip-openStatusIds-2').querySelector('input')!;
        const open4 = screen.getByTestId('status-chip-openStatusIds-4').querySelector('input')!;
        expect(open1.checked).toBe(true);
        expect(open2.checked).toBe(true);
        expect(open4.checked).toBe(true);
      });
    });

    it('reload statuses button triggers refetch and shows loading state with existing data', async () => {
      let resolveStatuses: (val: any) => void = () => {};
      const pendingStatuses = new Promise((resolve) => {
        resolveStatuses = resolve;
      });
      const getStatusesSpy = vi.spyOn(client, 'getOpenProjectStatuses')
        .mockResolvedValueOnce(mockStatuses)
        .mockImplementationOnce(() => pendingStatuses as any);

      renderWithProviders(<OpenProjectSettings />);

      await waitFor(() => {
        expect(screen.getByTestId('reload-statuses-button')).toBeInTheDocument();
        expect(screen.getByTestId('reload-statuses-button')).not.toBeDisabled();
      });

      const reloadBtn = screen.getByTestId('reload-statuses-button');
      fireEvent.click(reloadBtn);

      await waitFor(() => {
        expect(getStatusesSpy).toHaveBeenCalledTimes(2);
        expect(reloadBtn).toBeDisabled();
        expect(reloadBtn).toHaveAttribute('aria-busy', 'true');
        expect(reloadBtn).toHaveTextContent('Đang tải trạng thái...');
        expect(reloadBtn.querySelector('.animate-spin')).toBeInTheDocument();
      });

      await act(async () => {
        resolveStatuses(mockStatuses);
      });

      await waitFor(() => {
        expect(reloadBtn).not.toBeDisabled();
        expect(reloadBtn).not.toHaveAttribute('aria-busy');
        expect(reloadBtn).toHaveTextContent('Tải lại trạng thái');
      });
    });
  });

  describe('4. externalRef links in TasksPage and TaskDetailPage', () => {
    it('renders clickable externalRef link in TaskDetailPage', async () => {
      const taskWithRef: TaskDetail = {
        id: 'proj-1~t1',
        projectId: 'proj-1',
        slug: 't1',
        title: 'Task with external ref',
        externalRef: 'https://openproject.example.com/work_packages/1234',
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

      vi.spyOn(sse, 'subscribeToRunOutput').mockImplementation(() => () => {});
      vi.spyOn(client, 'getTaskLog').mockResolvedValue('');
      vi.spyOn(client, 'getTask').mockResolvedValue(taskWithRef);

      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
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

      await waitFor(() => {
        const link = screen.getByTestId('openproject-ticket-link');
        expect(link).toBeInTheDocument();
        expect(link).toHaveAttribute('href', 'https://openproject.example.com/work_packages/1234');
        expect(link).toHaveAttribute('target', '_blank');
      });
    });

    it('uses the resolved ticket URL and label when externalRef is linked', async () => {
      const taskWithRef: TaskDetail = {
        id: 'proj-1~t2', projectId: 'proj-1', slug: 't2', title: 'Linked task', externalRef: 'OP-12',
        externalUrl: 'https://openproject.example.com/work_packages/12', level: 'easy', status: 'draft',
        dependsOn: '[]', attempt: 0, resume: 0, createdAt: '2026-10-15T00:00:00Z', updatedAt: '2026-10-15T00:00:00Z', runs: [], reviews: [],
      };
      vi.spyOn(client, 'getTask').mockResolvedValue(taskWithRef);
      render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <LocaleProvider initialLocale="vi"><MemoryRouter initialEntries={['/tasks/proj-1~t2']}><Routes><Route path="/tasks/:id" element={<TaskDetailPage />} /></Routes></MemoryRouter></LocaleProvider>
        </QueryClientProvider>,
      );
      await waitFor(() => {
        expect(screen.getByTestId('openproject-ticket-link')).toHaveTextContent('Mở ticket');
        expect(screen.getByTestId('openproject-ticket-link')).toHaveAttribute('href', taskWithRef.externalUrl);
      });
    });

    it('does not render a broken link for an unlinked display ID', async () => {
      const taskWithRef: TaskDetail = {
        id: 'proj-1~t3', projectId: 'proj-1', slug: 't3', title: 'Unlinked task', externalRef: 'OP-13',
        level: 'easy', status: 'draft', dependsOn: '[]', attempt: 0, resume: 0,
        createdAt: '2026-10-15T00:00:00Z', updatedAt: '2026-10-15T00:00:00Z', runs: [], reviews: [],
      };
      vi.spyOn(client, 'getTask').mockResolvedValue(taskWithRef);
      render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <LocaleProvider initialLocale="vi"><MemoryRouter initialEntries={['/tasks/proj-1~t3']}><Routes><Route path="/tasks/:id" element={<TaskDetailPage />} /></Routes></MemoryRouter></LocaleProvider>
        </QueryClientProvider>,
      );
      await waitFor(() => expect(screen.getByText('Unlinked task')).toBeInTheDocument());
      expect(screen.queryByTestId('openproject-ticket-link')).not.toBeInTheDocument();
    });

    it('renders valid non-nested externalRef link in TasksPage project view', async () => {
      const taskItem: Task = {
        id: 'proj-1~t1',
        projectId: 'proj-1',
        slug: 't1',
        title: 'Project view task',
        externalRef: 'https://openproject.example.com/work_packages/5678',
        status: 'queued',
        level: 'easy',
        dependsOn: [],
        attempt: 0,
        resume: 0,
        createdAt: '2026-10-15T00:00:00Z',
        updatedAt: '2026-10-15T00:00:00Z',
      };

      vi.spyOn(client, 'getProjects').mockResolvedValue([mockProject]);
      vi.spyOn(client, 'getTasks').mockResolvedValue([taskItem]);

      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <QueryClientProvider client={queryClient}>
          <LocaleProvider initialLocale="vi">
            <MemoryRouter initialEntries={['/tasks?view=project']}>
              <TasksPage />
            </MemoryRouter>
          </LocaleProvider>
        </QueryClientProvider>,
      );

      await waitFor(() => {
        const link = screen.getByTestId('openproject-ticket-link');
        expect(link).toBeInTheDocument();
        expect(link).toHaveAttribute('href', 'https://openproject.example.com/work_packages/5678');
        // Check that the link is NOT inside an anchor tag (valid HTML)
        expect(link.closest('a')).toBe(link);
        expect(link.parentElement?.closest('a')).toBeNull();
      });
    });
  });
});
