import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LocaleProvider } from '../context/LocaleContext';
import { ThemeProvider } from '../context/ThemeContext';
import type { Locale } from '../locales';
import { ProjectSettingsDrawer, parseArgv, parseDeployEnv } from '../components/ProjectSettingsDrawer';
import { OpenProjectSettings } from '../components/OpenProjectSettings';
import { TasksPage } from '../pages/TasksPage';
import { TaskDetailPage } from '../pages/TaskDetailPage';
import * as client from '../api/client';
import * as sse from '../api/sse';
import type { Project, Task, TaskDetail, OpenProjectSource } from '../types/api';

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
    vi.spyOn(client, 'getGiteaStatus').mockResolvedValue({ projectId: 'proj-1', status: 'ok', finishedAt: '2026-11-03T10:00:00Z' });
    vi.spyOn(client, 'getRemoteDeployStatus').mockResolvedValue({ projectId: 'proj-1', status: 'succeeded', finishedAt: '2026-11-03T11:00:00Z' });
    vi.spyOn(client, 'getEffectiveConfig').mockResolvedValue({} as any);
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
      const tokenInput = screen.getByLabelText('Token') as HTMLInputElement;
      expect(tokenInput.type).toBe('password');
      expect(tokenInput.value).toBe('');

      // Enter token and save
      fireEvent.change(tokenInput, { target: { value: 'secret-token-123' } });
      const saveTokenBtn = screen.getByTestId('save-gitea-token-button');
      fireEvent.click(saveTokenBtn);

      await waitFor(() => {
        expect(saveTokenSpy).toHaveBeenCalledWith('proj-1', 'secret-token-123');
      });

      // Check Deploy env input is type=password and empty initially
      const envInput = screen.getByLabelText('Bí mật env (KEY=VALUE)') as HTMLInputElement;
      expect(envInput.type).toBe('password');
      expect(envInput.value).toBe('');

      // Enter deploy secrets with '=' inside value
      fireEvent.change(envInput, { target: { value: 'TOKEN=secret=with=equals' } });
      const saveEnvBtn = screen.getByTestId('save-deploy-env-button');
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
