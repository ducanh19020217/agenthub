import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LocaleProvider } from '../context/LocaleContext';
import { ThemeProvider } from '../context/ThemeContext';
import { SettingsPage } from '../pages/SettingsPage';
import { DepartmentsPage } from '../pages/DepartmentsPage';
import { ProjectSettingsDrawer } from '../components/ProjectSettingsDrawer';
import { ProjectWizard } from '../components/ProjectWizard';
import * as client from '../api/client';
import type { Department, EffectiveConfigResponse, PresetDetails, Profile, Project, ProjectInspection } from '../types/api';

const mockProject: Project = {
  id: 'test-project',
  name: 'Test Project',
  path: '/tmp/test-project',
  defaultBranch: 'main',
  maxParallel: 2,
  envTemplate: null,
  review: JSON.stringify({ chain: [{ reviewer: 'claude', mode: 'final' }], maxRounds: 2 }),
  checks: [{ name: 'typecheck', cmd: ['npm', 'run', 'typecheck'], timeoutSec: 120 }],
  settings: {
    preset: 'balanced',
    brain: { mode: 'inherit', permissions: 'standard' },
    worktree: { install: 'auto', gitHooks: 'run' },
    integration: { enabled: false },
    ci: {},
    references: [],
    reviewChecklist: [],
    notifications: { telegramContent: 'full' },
    review: {
      autoMerge: true,
    },
  },
};

const mockEffectiveConfig: EffectiveConfigResponse = {
  preset: 'balanced',
  brain: {
    mode: { value: 'auto', source: 'global' },
    permissions: { value: 'standard', source: 'project' },
    engine: { value: 'claude', source: 'department' },
    model: { value: 'sonnet', source: 'global' },
    budgets: {
      dailyTokenBudget: { value: 50000, source: 'department' },
      maxTurnsPerHour: { value: 10, source: 'global' },
    },
  },
  review: {
    chain: { value: [{ reviewer: 'claude', mode: 'final' }], source: 'project' },
    maxRounds: { value: 2, source: 'global' },
    checks: {
      value: [{ name: 'typecheck', cmd: ['npm', 'run', 'typecheck'], timeoutSec: 120 }],
      source: 'project',
    },
    autoMerge: { value: true, source: 'project' },
  },
  autoMergeReadiness: {
    ready: true,
    missing: [],
  },
};

const mockDepartments: Department[] = [
  {
    id: 'chung',
    name: 'Chung',
    priority: 10,
    maxParallel: 0,
    brainEngine: 'claude',
    brainModel: 'sonnet',
    brainMode: 'inherit',
    brainPermissions: 'inherit',
    brainDailyTokenBudget: 0,
    brainMaxTurnsPerHour: 0,
    claudeDailyTokenBudget: 0,
    telegramTopicId: null,
    createdAt: '2026-01-01T00:00:00Z',
    profiles: [{ profileName: 'claude-default', share: 1, departmentId: 'chung' }],
    projects: [{ id: 'proj-1', name: 'Project 1' }],
  },
  {
    id: 'backend',
    name: 'Backend Dev',
    priority: 5,
    maxParallel: 2,
    brainEngine: 'codex',
    brainModel: 'gpt-5.6',
    brainCodexProfile: 'codex-pro',
    brainMode: 'auto',
    brainPermissions: 'standard',
    brainDailyTokenBudget: 100000,
    brainMaxTurnsPerHour: 20,
    claudeDailyTokenBudget: 0,
    telegramTopicId: null,
    createdAt: '2026-01-01T00:00:00Z',
    profiles: [{ profileName: 'codex-pro', share: 0.8, departmentId: 'backend' }],
    projects: [],
  },
];

const mockPresets: PresetDetails[] = [
  {
    id: 'safe',
    name: { vi: 'An toàn', en: 'Safe' },
    description: { vi: 'Mô tả an toàn', en: 'Safe description' },
    config: {
      brain: { mode: 'suggest', permissions: 'standard' },
      review: { chainDescription: { vi: '1 bước', en: '1 step' }, maxRounds: 1, autoMerge: false },
      autoFixOnFail: false,
      planning: { requireApproval: true, approvalMinTasks: 1 },
    },
  },
  {
    id: 'balanced',
    name: { vi: 'Cân bằng', en: 'Balanced' },
    description: { vi: 'Mô tả cân bằng', en: 'Balanced description' },
    config: {
      brain: { mode: 'auto', permissions: 'trusted' },
      review: { chainDescription: { vi: '2 bước', en: '2 steps' }, maxRounds: 2, autoMerge: false },
      autoFixOnFail: true,
      planning: { requireApproval: true, approvalMinTasks: 5 },
    },
  },
  {
    id: 'auto',
    name: { vi: 'Tự động', en: 'Auto' },
    description: { vi: 'Mô tả tự động', en: 'Auto description' },
    config: {
      brain: { mode: 'auto', permissions: 'trusted' },
      review: { chainDescription: { vi: 'Tự merge', en: 'Auto merge' }, maxRounds: 3, autoMerge: true },
      autoFixOnFail: true,
      planning: { requireApproval: false, approvalMinTasks: 0 },
    },
  },
];

const mockProfiles: Profile[] = [
  { name: 'claude-default', engine: 'claude', enabled: true, kind: 'isolated' },
  { name: 'codex-pro', engine: 'codex', enabled: true, kind: 'codex' },
];

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <LocaleProvider initialLocale="vi">
          <MemoryRouter>{ui}</MemoryRouter>
        </LocaleProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

describe('Simple Settings UI (f-simple-settings-ui)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();

    vi.spyOn(client, 'getPresets').mockResolvedValue(mockPresets);
    vi.spyOn(client, 'getCurrentPreset').mockResolvedValue({ preset: 'balanced' });
    vi.spyOn(client, 'getDepartments').mockResolvedValue(mockDepartments);
    vi.spyOn(client, 'getProjects').mockResolvedValue([mockProject]);
    vi.spyOn(client, 'getProfiles').mockResolvedValue(mockProfiles);
    vi.spyOn(client, 'getModelOptions').mockResolvedValue({
      suggestions: ['sonnet', 'opus', 'codex:gpt-5.6', 'codex:gpt-5.6-turbo'],
      configured: ['sonnet', 'codex:gpt-5.6'],
      custom: [],
    } as any);
    vi.spyOn(client, 'getEffectiveConfig').mockResolvedValue(mockEffectiveConfig);
    vi.spyOn(client, 'getConfig').mockResolvedValue({
      planning: { enabled: true },
      brain: { mode: 'auto' },
    } as any);
  });

  describe('1. Global SettingsPage Preset Apply & Diff Preview', () => {
    it('renders preset cards and collapses advanced settings by default', async () => {
      renderWithProviders(<SettingsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('preset-card-safe')).toBeInTheDocument();
        expect(screen.getByTestId('preset-card-balanced')).toBeInTheDocument();
        expect(screen.getByTestId('preset-card-auto')).toBeInTheDocument();
      });

      await waitFor(() => {
        const advanced = screen.getByTestId('advanced-settings') as HTMLDetailsElement;
        expect(advanced).toBeInTheDocument();
        expect(advanced.open).toBe(false);
      });
    });

    it('marks the preset currently in use', async () => {
      renderWithProviders(<SettingsPage />);
      await waitFor(() => expect(screen.getByTestId('preset-active-balanced')).toBeInTheDocument());
      expect(screen.queryByTestId('preset-active-safe')).not.toBeInTheDocument();
      expect(screen.queryByTestId('preset-active-auto')).not.toBeInTheDocument();
      expect(screen.queryByTestId('preset-active-custom')).not.toBeInTheDocument();
    });

    it('says when the config matches no preset', async () => {
      vi.spyOn(client, 'getCurrentPreset').mockResolvedValue({ preset: 'custom' });
      renderWithProviders(<SettingsPage />);
      await waitFor(() => expect(screen.getByTestId('preset-active-custom')).toBeInTheDocument());
      expect(screen.queryByTestId('preset-active-balanced')).not.toBeInTheDocument();
    });

    it('triggers dry-run on preset card click and displays diff table preview', async () => {
      const applySpy = vi.spyOn(client, 'applyPreset').mockResolvedValue({
        scope: 'global',
        preset: 'safe',
        applied: false,
        diff: {
          before: { 'brain.permissions': 'full', 'notifications.telegramContent': 'full' },
          after: { 'brain.permissions': 'standard', 'notifications.telegramContent': 'minimal' },
        },
      });

      renderWithProviders(<SettingsPage />);

      await waitFor(() => expect(screen.getByTestId('preset-card-safe')).toBeInTheDocument());
      fireEvent.click(screen.getByTestId('preset-card-safe'));

      await waitFor(() => {
        expect(applySpy).toHaveBeenCalledWith({ scope: 'global', preset: 'safe', dryRun: true });
        expect(screen.getByTestId('preset-diff-preview')).toBeInTheDocument();
        expect(screen.getByText('brain.permissions')).toBeInTheDocument();
        expect(screen.getAllByText('"full"').length).toBeGreaterThan(0);
        expect(screen.getByText('"standard"')).toBeInTheDocument();
      });

      // Confirm apply button is rendered
      const confirmBtn = screen.getByTestId('confirm-apply-preset-btn');
      expect(confirmBtn).toBeInTheDocument();

      // Click confirm apply
      applySpy.mockResolvedValueOnce({
        scope: 'global',
        preset: 'safe',
        applied: true,
        diff: { before: {}, after: {} },
      });
      fireEvent.click(confirmBtn);

      await waitFor(() => {
        expect(applySpy).toHaveBeenCalledWith({ scope: 'global', preset: 'safe', dryRun: false });
      });
    });
  });

  describe('2. ProjectSettingsDrawer Effective Config & AutoMerge Checklist', () => {
    it('displays effective config with source attribution badges', async () => {
      renderWithProviders(
        <ProjectSettingsDrawer
          project={mockProject}
          isOpen={true}
          onClose={vi.fn()}
        />,
      );

      await waitFor(() => {
        expect(screen.getByTestId('effective-config-section')).toBeInTheDocument();
        expect(screen.getByTestId('effective-source-brainMode')).toHaveTextContent('Toàn cục');
        expect(screen.getByTestId('effective-source-permissions')).toHaveTextContent('Dự án');
        expect(screen.getByTestId('effective-source-engine')).toHaveTextContent('Phòng ban');
      });
    });

    it('renders automerge checklist and allows quick fixes', async () => {
      vi.spyOn(client, 'getEffectiveConfig').mockResolvedValue({
        ...mockEffectiveConfig,
        review: {
          ...mockEffectiveConfig.review,
          autoMerge: { value: false, source: 'project' },
        },
        autoMergeReadiness: {
          ready: false,
          missing: ['reviewChain', 'checks', 'autoMerge'],
        },
      });

      renderWithProviders(
        <ProjectSettingsDrawer
          project={{
            ...mockProject,
            checks: [],
            review: JSON.stringify({ chain: [] }),
            settings: {
              ...mockProject.settings,
              brain: { mode: 'inherit', permissions: 'standard' },
              worktree: { install: 'auto', gitHooks: 'run' },
              integration: { enabled: false },
              ci: {},
              references: [],
              reviewChecklist: [],
              notifications: { telegramContent: 'full' },
              review: { autoMerge: false },
            },
          }}
          isOpen={true}
          onClose={vi.fn()}
        />,
      );

      await waitFor(() => {
        expect(screen.getByTestId('automerge-checklist')).toBeInTheDocument();
      });

      // Quick fix chain button
      const fixChainBtn = screen.getByTestId('automerge-fix-chain');
      expect(fixChainBtn).toBeInTheDocument();
      fireEvent.click(fixChainBtn);

      // Quick fix checks button
      const fixChecksBtn = screen.getByTestId('automerge-fix-checks');
      expect(fixChecksBtn).toBeInTheDocument();
      fireEvent.click(fixChecksBtn);

      // Quick fix autoMerge button
      const fixAutoMergeBtn = screen.getByTestId('automerge-fix-automerge');
      expect(fixAutoMergeBtn).toBeInTheDocument();
      fireEvent.click(fixAutoMergeBtn);
    });

    it('structured checks form: add, remove, and round-trip sync with raw JSON', async () => {
      renderWithProviders(
        <ProjectSettingsDrawer
          project={mockProject}
          isOpen={true}
          onClose={vi.fn()}
        />,
      );

      await waitFor(() => {
        expect(screen.getByTestId('structured-checks-form')).toBeInTheDocument();
        expect(screen.getByDisplayValue('typecheck')).toBeInTheDocument();
      });

      // Add a new check
      const addCheckBtn = screen.getByTestId('add-check-row-btn');
      fireEvent.click(addCheckBtn);

      // Verify row added with default name lint
      expect(screen.getByDisplayValue('lint')).toBeInTheDocument();

      // Open raw checks JSON in Advanced section
      const rawTextarea = screen.getByTestId('checks-json-textarea') as HTMLTextAreaElement;
      expect(rawTextarea).toBeInTheDocument();
      expect(rawTextarea.value).toContain('typecheck');
      expect(rawTextarea.value).toContain('lint');

      // Edit raw JSON and verify it reflects in structured form
      const updatedJson = JSON.stringify([
        { name: 'test:unit', cmd: ['npm', 'test'], timeoutSec: 60 },
      ]);
      fireEvent.change(rawTextarea, { target: { value: updatedJson } });

      expect(screen.getByDisplayValue('test:unit')).toBeInTheDocument();
    });
  });

  describe('3. DepartmentsPage Brain Inherit, Profile Share, and Project Assign', () => {
    it('renders brain* fields with inherit options and supports Codex profile switch', async () => {
      const updateDeptSpy = vi.spyOn(client, 'updateDepartment').mockResolvedValue(mockDepartments[0]);

      renderWithProviders(<DepartmentsPage />);

      await waitFor(() => {
        expect(screen.getByText('Chung')).toBeInTheDocument();
      });

      // Open Brain settings details
      fireEvent.click(screen.getAllByText('Cấu hình Brain')[0]);

      // Find brainEngine select for Chung
      const engineSelect = screen.getAllByLabelText('Engine Brain')[0] as HTMLSelectElement;
      expect(engineSelect).toBeInTheDocument();

      // Change brainEngine to codex
      fireEvent.change(engineSelect, { target: { value: 'codex' } });
      await waitFor(() => {
        expect(updateDeptSpy).toHaveBeenCalledWith('chung', { brainEngine: 'codex' });
      });

      // Change brainMode to inherit
      const modeSelect = screen.getAllByLabelText('Chế độ Brain')[0] as HTMLSelectElement;
      fireEvent.change(modeSelect, { target: { value: 'inherit' } });
      await waitFor(() => {
        expect(updateDeptSpy).toHaveBeenCalledWith('chung', { brainMode: 'inherit' });
      });
    });

    it('updates profile share allocation via number input', async () => {
      const updateProfilesSpy = vi.spyOn(client, 'updateDepartmentProfiles').mockResolvedValue(mockDepartments[0]);

      renderWithProviders(<DepartmentsPage />);

      await waitFor(() => {
        expect(screen.getByText('Chung')).toBeInTheDocument();
      });

      // Find share input for claude-default in Chung
      const shareInput = screen.getByLabelText('claude-default share');
      expect(shareInput).toBeInTheDocument();

      fireEvent.change(shareInput, { target: { value: '0.65' } });
      fireEvent.blur(shareInput);

      await waitFor(() => {
        expect(updateProfilesSpy).toHaveBeenCalledWith('chung', [
          { profileName: 'claude-default', share: 0.65 },
        ]);
      });
    });

    it('assigns and transfers projects between departments', async () => {
      const assignSpy = vi.spyOn(client, 'updateDepartmentProjects').mockResolvedValue(mockDepartments[1]);
      const transferSpy = vi.spyOn(client, 'updateProject').mockResolvedValue(mockProject);

      renderWithProviders(<DepartmentsPage />);

      await waitFor(() => {
        expect(screen.getByText('Chung')).toBeInTheDocument();
        expect(screen.getByRole('heading', { name: 'Backend Dev' })).toBeInTheDocument();
      });

      // Transfer proj-1 from Chung to Backend Dev
      const transferSelect = screen.getByLabelText('Transfer Project 1');
      fireEvent.change(transferSelect, { target: { value: 'backend' } });

      await waitFor(() => {
        expect(transferSpy).toHaveBeenCalledWith('proj-1', { departmentId: 'backend' });
      });

      // Assign project to Backend Dev
      const assignSelect = screen.getAllByLabelText(/Chọn dự án để gán/i)[1];
      fireEvent.change(assignSelect, { target: { value: 'test-project' } });

      const assignBtn = screen.getAllByRole('button', { name: /Gán/i })[1];
      fireEvent.click(assignBtn);

      await waitFor(() => {
        expect(assignSpy).toHaveBeenCalledWith('backend', { projectId: 'test-project' });
      });
    });
  });

  describe('4. ProjectWizard Preset and Department Selection', () => {
    it('renders preset and department selection in StepBrain and shows in StepSummary', async () => {
      renderWithProviders(<ProjectWizard onClose={vi.fn()} />);

      // Step 0: Mode (select new)
      fireEvent.click(screen.getByRole('button', { name: /Dự án mới/i }));
      fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));

      // Step 1: Path
      fireEvent.change(screen.getByPlaceholderText(/vd: XFarm/), { target: { value: 'Wizard Preset Test' } });
      fireEvent.change(screen.getByPlaceholderText(/vd: \/home/), { target: { value: '/tmp/wizard-test' } });
      fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));

      // Steps 2, 3, 4
      fireEvent.click(screen.getByRole('button', { name: 'Tiếp' })); // 2: Inspect
      fireEvent.click(screen.getByRole('button', { name: 'Tiếp' })); // 3: Suggestions
      fireEvent.click(screen.getByRole('button', { name: 'Tiếp' })); // 4: Context

      // Step 5: Brain & Settings with Presets and Department
      await waitFor(() => {
        expect(screen.getByTestId('wizard-preset-safe')).toBeInTheDocument();
        expect(screen.getByTestId('wizard-preset-auto')).toBeInTheDocument();
        expect(screen.getByTestId('wizard-department-select')).toBeInTheDocument();
      });

      // Select Safe preset
      fireEvent.click(screen.getByTestId('wizard-preset-safe'));

      // Select Backend department
      fireEvent.change(screen.getByTestId('wizard-department-select'), { target: { value: 'backend' } });

      // Go to Step 6: Summary
      fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));

      // Verify chosen preset and department are displayed in summary
      await waitFor(() => {
        expect(screen.getByText(/Tóm tắt lựa chọn/i)).toBeInTheDocument();
        expect(screen.getByText(/An toàn/i)).toBeInTheDocument();
        expect(screen.getByText(/backend/i)).toBeInTheDocument();
      });
    });

    it('maps sensitive selection in suggestions step to safe preset', async () => {
      const inspectSpy = vi.spyOn(client, 'inspectProject').mockResolvedValue({
        path: '/media/usb/repo',
        exists: true,
        isDirectory: true,
        isGitRepo: true,
        currentBranch: 'main',
        branches: ['main'],
        remoteHost: null,
        estimatedSizeBytes: 100,
        sizeTruncated: false,
        lockfiles: [],
        monorepo: { detected: false, type: null },
        gitHooks: { husky: false, commitlint: false },
        language: 'TypeScript',
        projectFiles: [],
        guidanceFiles: [],
        mount: { mountpoint: '/media/usb', temporary: false, encrypted: false },
        claudeSessions: [],
        claudeSessionPreviews: [],
        hasClaudeMemory: false,
        memoryPreview: null,
        suggestedSettings: {
          skipInstall: false,
          skipGitHooks: false,
          sensitiveProject: true,
          checks: [],
        },
      });

      renderWithProviders(<ProjectWizard onClose={vi.fn()} />);

      // Step 0: Existing mode (default)
      fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));

      // Step 1: Path
      fireEvent.change(screen.getByPlaceholderText(/vd: XFarm/), { target: { value: 'Sensitive Repo' } });
      fireEvent.change(screen.getByPlaceholderText(/vd: \/home/), { target: { value: '/media/usb/repo' } });
      fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));

      await waitFor(() => expect(inspectSpy).toHaveBeenCalledWith('/media/usb/repo'));

      // Step 2: Inspect -> click Tiếp
      fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));

      // Step 3: Suggestions -> Sensitive checkbox should be present and checked by default
      const sensitiveCheckbox = screen.getByRole('checkbox', { name: /Đánh dấu dự án nhạy cảm/i });
      expect(sensitiveCheckbox).toBeChecked();

      // Advance to Context, then Brain
      fireEvent.click(screen.getByRole('button', { name: 'Tiếp' })); // 4: Context
      fireEvent.click(screen.getByRole('button', { name: 'Tiếp' })); // 5: Brain

      // Verify Safe preset is selected
      await waitFor(() => {
        const safeBtn = screen.getByTestId('wizard-preset-safe');
        expect(safeBtn.className).toContain('border-[var(--t-accent)]');
      });
    });

    it('clears the sensitive override when switching from safe to another preset', async () => {
      const inspectSpy = vi.spyOn(client, 'inspectProject').mockResolvedValue({
        exists: true,
        isDirectory: true,
        isGitRepo: true,
        currentBranch: 'main',
        branches: ['main'],
        remoteHost: null,
        estimatedSizeBytes: 100,
        sizeTruncated: false,
        lockfiles: [],
        monorepo: { detected: false, type: null },
        gitHooks: { husky: false, commitlint: false },
        language: 'TypeScript',
        projectFiles: [],
        guidanceFiles: [],
        mount: { mountpoint: '/media/usb', temporary: false, encrypted: false },
        claudeSessions: [],
        claudeSessionPreviews: [],
        hasClaudeMemory: false,
        memoryPreview: null,
        path: '/media/usb/repo',
        suggestedSettings: { skipInstall: false, skipGitHooks: false, sensitiveProject: false, checks: [] },
      } satisfies ProjectInspection);
      const createSpy = vi.spyOn(client, 'createProject').mockResolvedValue(mockProject);

      renderWithProviders(<ProjectWizard onClose={vi.fn()} />);
      fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
      fireEvent.change(screen.getByPlaceholderText(/vd: XFarm/), { target: { value: 'Preset switch' } });
      fireEvent.change(screen.getByPlaceholderText(/vd: \/home/), { target: { value: '/media/usb/repo' } });
      fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
      await waitFor(() => expect(inspectSpy).toHaveBeenCalled());

      fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
      fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
      fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
      fireEvent.click(screen.getByTestId('wizard-preset-safe'));
      fireEvent.click(screen.getByTestId('wizard-preset-auto'));
      fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
      fireEvent.click(screen.getByRole('button', { name: 'Tạo dự án' }));

      await waitFor(() => expect(createSpy).toHaveBeenCalled());
      expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({
        settings: expect.objectContaining({ preset: 'auto' }),
      }));
    });
  });
});
