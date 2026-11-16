import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LocaleProvider } from '../context/LocaleContext';
import { ThemeProvider } from '../context/ThemeContext';
import { SelectOrCustomInput, SortableModelList } from '../components/ui';
import { SettingsPage } from '../pages/SettingsPage';
import { ProjectSettingsDrawer } from '../components/ProjectSettingsDrawer';
import { DepartmentsPage } from '../pages/DepartmentsPage';
import { NewSessionModal } from '../components/chat/NewSessionModal';
import {
  validateModelSyntax,
  validateChatModelSyntax,
  validateReviewChainReviewerSyntax,
  validateReviewerModelSyntax,
  validateBranchSyntax,
  getModelProvider,
  getModelsForProvider,
  formatDiscoveredModelOptions,
} from '../utils/models';
import * as client from '../api/client';
import * as sse from '../api/sse';

function TestSelectWrapper({ initialValue = 'sonnet', options = ['sonnet', 'opus', 'haiku'] }: { initialValue?: string; options?: string[] }) {
  const [val, setVal] = useState(initialValue);
  return (
    <div>
      <span data-testid="current-value">{val}</span>
      <SelectOrCustomInput
        testId="test-select"
        value={val}
        onChange={setVal}
        options={options}
        validate={(v) => validateModelSyntax(v, (k) => k)}
        ariaLabel="Test Model"
      />
    </div>
  );
}

function TestSortableWrapper({ initialModels = ['sonnet', 'haiku'] }: { initialModels?: string[] }) {
  const [models, setModels] = useState<string[]>(initialModels);
  return (
    <div>
      <div data-testid="models-json">{JSON.stringify(models)}</div>
      <SortableModelList
        title="Model Chain"
        models={models}
        onChange={setModels}
        availableOptions={['sonnet', 'opus', 'haiku', 'codex:gpt-5.6-luna']}
        dataTestId="sortable-list"
      />
    </div>
  );
}

describe('Settings Select Inputs and Sortable Lists (f-settings-select-inputs)', () => {
  it('classifies and filters models without mixing providers', () => {
    expect(getModelProvider('gemini-3.8-flash-high')).toBe('gemini');
    expect(getModelProvider('claude-opus-4-6-thinking')).toBe('claude');
    expect(getModelProvider('codex:gpt-5.6-luna')).toBe('codex');
    expect(getModelProvider('gpt-oss-120b-medium')).toBeNull();
    expect(getModelProvider('codex:gpt-oss-120b-medium')).toBeNull();
    expect(getModelsForProvider([
      'gemini-3.8-flash-high',
      'claude-opus-4-6-thinking',
      'codex:gpt-5.6-luna',
      'sonnet',
    ], 'gemini')).toEqual(['gemini-3.8-flash-high']);
    expect(getModelsForProvider([
      'gemini-3.8-flash-high',
      'claude-opus-4-6-thinking',
      'codex:gpt-5.6-luna',
      'sonnet',
    ], 'claude')).toEqual(['claude-opus-4-6-thinking', 'sonnet']);
    expect(getModelsForProvider([
      'gemini-3.8-flash-high',
      'claude-opus-4-6-thinking',
      'codex:gpt-5.6-luna',
      'gpt-5.6-turbo',
    ], 'codex')).toEqual(['codex:gpt-5.6-luna', 'gpt-5.6-turbo']);
  });

  describe('1. SelectOrCustomInput Component', () => {
    it('renders preset options and allows selecting a standard model', () => {
      render(
        <LocaleProvider initialLocale="vi">
          <TestSelectWrapper initialValue="sonnet" />
        </LocaleProvider>,
      );

      const select = screen.getByTestId('test-select') as HTMLSelectElement;
      expect(select.value).toBe('sonnet');
      expect(screen.getByTestId('current-value').textContent).toBe('sonnet');

      fireEvent.change(select, { target: { value: 'opus' } });
      expect(screen.getByTestId('current-value').textContent).toBe('opus');
    });

    it('switches to custom mode when selecting "Tùy chỉnh" and validates syntax live', async () => {
      render(
        <LocaleProvider initialLocale="vi">
          <TestSelectWrapper initialValue="sonnet" />
        </LocaleProvider>,
      );

      const select = screen.getByTestId('test-select') as HTMLSelectElement;
      fireEvent.change(select, { target: { value: '__custom__' } });

      const customInput = screen.getByTestId('test-select-custom-input') as HTMLInputElement;
      expect(customInput).toBeInTheDocument();

      // Enter invalid model with spaces
      fireEvent.change(customInput, { target: { value: 'invalid model name' } });
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByText('settings.invalidModelSyntax')).toBeInTheDocument();

      // Fix syntax to valid model
      fireEvent.change(customInput, { target: { value: 'codex:gpt-custom-model-1' } });
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByTestId('current-value').textContent).toBe('codex:gpt-custom-model-1');
    });

    it('preserves an existing out-of-list value when loaded without data loss', () => {
      render(
        <LocaleProvider initialLocale="vi">
          <TestSelectWrapper initialValue="enterprise-private-llm:v2" />
        </LocaleProvider>,
      );

      // Custom mode is opened automatically so the value is displayed and editable
      const customInput = screen.getByTestId('test-select-custom-input') as HTMLInputElement;
      expect(customInput.value).toBe('enterprise-private-llm:v2');
      expect(screen.getByTestId('current-value').textContent).toBe('enterprise-private-llm:v2');

      // Presets can be restored via the back button
      const backBtn = screen.getByLabelText(/Quay lại danh sách/i);
      fireEvent.click(backBtn);
      expect(screen.getByTestId('current-value').textContent).toBe('sonnet');
    });

    it('switches back to preset mode when options are loaded asynchronously after first render', async () => {
      const AsyncWrapper = () => {
        const [val, setVal] = useState('codex:dyn-model-1');
        const [opts, setOpts] = useState<string[]>([]);
        return (
          <div>
            <SelectOrCustomInput
              value={val}
              onChange={setVal}
              options={opts}
              testId="async-select"
            />
            <button type="button" onClick={() => setOpts(['codex:dyn-model-1', 'codex:dyn-model-2'])}>
              Load Options
            </button>
          </div>
        );
      };

      render(
        <LocaleProvider initialLocale="vi">
          <AsyncWrapper />
        </LocaleProvider>,
      );

      // Initially opts is empty, so val is unknown and custom input is rendered
      expect(screen.getByTestId('async-select-custom-input')).toBeInTheDocument();

      // Load options asynchronously
      fireEvent.click(screen.getByRole('button', { name: 'Load Options' }));

      // Custom input should disappear, and select should show the known option
      await waitFor(() => {
        expect(screen.queryByTestId('async-select-custom-input')).not.toBeInTheDocument();
        const select = screen.getByTestId('async-select') as HTMLSelectElement;
        expect(select.value).toBe('codex:dyn-model-1');
      });
    });

    it('validates branch names correctly', () => {
      expect(validateBranchSyntax('main', (k) => k)).toBeNull();
      expect(validateBranchSyntax('feat/feature-1', (k) => k)).toBeNull();
      expect(validateBranchSyntax('invalid branch', (k) => k)).toBe('settings.invalidBranchSyntax');
      expect(validateBranchSyntax('/leading-slash', (k) => k)).toBe('settings.invalidBranchSyntax');
      expect(validateBranchSyntax('double..dot', (k) => k)).toBe('settings.invalidBranchSyntax');
      expect(validateBranchSyntax('has:colon', (k) => k)).toBe('settings.invalidBranchSyntax');
    });

    it('validates worker model syntax consistently with backend modelValidator', () => {
      expect(validateModelSyntax('gemini-3.8-flash-high', (k) => k)).toBeNull();
      expect(validateModelSyntax('claude-sonnet-4-6', (k) => k)).toBeNull();
      expect(validateModelSyntax('codex:gpt-5.6-luna', (k) => k)).toBeNull();
      expect(validateModelSyntax('codex:gpt-4o', (k) => k)).toBeNull();
      expect(validateModelSyntax('codex:x', (k) => k)).toBeNull();
      expect(validateModelSyntax('codex:custom-model-id', (k) => k)).toBeNull();
      expect(validateModelSyntax('   ', (k) => k)).toBe('settings.emptyChainWarning');
      expect(validateModelSyntax('gemini-custom', (k) => k)).toBeNull();
      expect(validateModelSyntax('gpt-custom', (k) => k)).toBeNull();
      expect(validateModelSyntax('claude:custom', (k) => k)).toBeNull();
      expect(validateModelSyntax('custom model', (k) => k)).toBe('settings.invalidModelSyntax');
    });

    it('validates chat model syntax consistently with chat.model enum', () => {
      expect(validateChatModelSyntax('', (k) => k)).toBeNull();
      expect(validateChatModelSyntax('sonnet', (k) => k)).toBeNull();
      expect(validateChatModelSyntax('opus', (k) => k)).toBeNull();
      expect(validateChatModelSyntax('haiku', (k) => k)).toBeNull();
      // Accepts newly discovered Claude models
      expect(validateChatModelSyntax('claude-sonnet-5-5', (k) => k, ['claude-sonnet-5-5'])).toBeNull();
      // Accepts custom models without whitespace
      expect(validateChatModelSyntax('custom-model-id', (k) => k)).toBeNull();
      expect(validateChatModelSyntax('gemini-3.8-flash-high', (k) => k)).toBeNull();
      expect(validateChatModelSyntax('codex:gpt-5.6-luna', (k) => k)).toBeNull();
      // Rejects model strings with whitespace
      expect(validateChatModelSyntax('custom model with space', (k) => k)).toBe('settings.invalidChatModelSyntax');
      expect(validateChatModelSyntax('sonnet with space', (k) => k)).toBe('settings.invalidChatModelSyntax');
    });

    it('validates review chain reviewer syntax and reviewer model syntax', () => {
      expect(validateReviewChainReviewerSyntax('claude', (k) => k)).toBeNull();
      expect(validateReviewChainReviewerSyntax('codex:gpt-5.6-luna', (k) => k)).toBeNull();
      expect(validateReviewChainReviewerSyntax('unknown-reviewer', (k) => k)).toBe('settings.invalidReviewChainReviewer');
      expect(validateReviewChainReviewerSyntax('codex:', (k) => k)).toBe('settings.invalidReviewChainReviewer');
      expect(validateReviewChainReviewerSyntax('codex:x', (k) => k)).toBe('settings.invalidReviewChainReviewer');

      expect(validateReviewerModelSyntax('sonnet', 'claude', (k) => k)).toBeNull();
      expect(validateReviewerModelSyntax('claude-sonnet-4-6', 'claude', (k) => k)).toBeNull();
      expect(validateReviewerModelSyntax('claude:sonnet', 'claude', (k) => k)).toBeNull();
      expect(validateReviewerModelSyntax('gpt-5.6-luna', 'codex', (k) => k)).toBeNull();
      expect(validateReviewerModelSyntax('codex:gpt-5.6-luna', 'codex', (k) => k)).toBeNull();
      expect(validateReviewerModelSyntax('my-model', 'codex', (k) => k)).toBeNull();
      expect(validateReviewerModelSyntax('my-model', 'claude', (k) => k)).toBeNull();
      expect(validateReviewerModelSyntax('invalid model with space', 'codex', (k) => k)).toBe('settings.invalidModelSyntax');
      expect(validateReviewerModelSyntax('codex:', 'codex', (k) => k)).toBe('settings.invalidModelSyntax');
      expect(validateReviewerModelSyntax('claude:', 'claude', (k) => k)).toBe('settings.invalidModelSyntax');
      expect(validateReviewerModelSyntax('', 'codex', (k) => k)).toBe('settings.emptyChainWarning');

      // Accepts newly discovered Codex models when knownModels is passed
      expect(validateReviewerModelSyntax('o3-mini', 'codex', (k) => k, ['codex:o3-mini'])).toBeNull();
      expect(validateReviewerModelSyntax('codex:o3-mini', 'codex', (k) => k, ['o3-mini'])).toBeNull();
      expect(validateReviewerModelSyntax('custom-reviewer', 'codex', (k) => k, ['custom-reviewer'])).toBeNull();
      expect(validateReviewChainReviewerSyntax('codex:o3-mini', (k) => k, ['codex:o3-mini'])).toBeNull();
    });
  });

  describe('2. SortableModelList Component', () => {
    it('moves items up and down with buttons and updates order', () => {
      render(
        <LocaleProvider initialLocale="vi">
          <TestSortableWrapper initialModels={['sonnet', 'haiku']} />
        </LocaleProvider>,
      );

      expect(screen.getByTestId('models-json').textContent).toBe('["sonnet","haiku"]');

      // Move down button for first item
      const moveDownFirst = screen.getByLabelText(/Di chuyển xuống \(sonnet\)/i);
      fireEvent.click(moveDownFirst);
      expect(screen.getByTestId('models-json').textContent).toBe('["haiku","sonnet"]');

      // Move up button for second item
      const moveUpSecond = screen.getByLabelText(/Di chuyển lên \(sonnet\)/i);
      fireEvent.click(moveUpSecond);
      expect(screen.getByTestId('models-json').textContent).toBe('["sonnet","haiku"]');
    });

    it('removes an item and shows empty chain warning when empty', () => {
      render(
        <LocaleProvider initialLocale="vi">
          <TestSortableWrapper initialModels={['sonnet']} />
        </LocaleProvider>,
      );

      const removeBtn = screen.getByLabelText(/X[oó][aá] model \(sonnet\)/i);
      fireEvent.click(removeBtn);

      expect(screen.getByTestId('models-json').textContent).toBe('[]');
      expect(screen.getByText(/Chuỗi model không được để trống/i)).toBeInTheDocument();
    });

    it('adds a new model from available options', () => {
      render(
        <LocaleProvider initialLocale="vi">
          <TestSortableWrapper initialModels={['sonnet']} />
        </LocaleProvider>,
      );

      const addBtn = screen.getByRole('button', { name: /Thêm model/i });
      fireEvent.click(addBtn);

      expect(screen.getByTestId('models-json').textContent).toBe('["sonnet","sonnet"]');
    });
  });

  describe('3. SettingsPage Integration with Sortable Lists & Select Inputs', () => {
    let queryClient: QueryClient;

    beforeEach(() => {
      queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });

      vi.spyOn(sse, 'subscribeToRunOutput').mockImplementation(() => () => {});
      vi.spyOn(client, 'getTelegramStatus').mockResolvedValue({
        enabled: false,
        hasToken: false,
        chats: [],
        notify: { reviewReady: true, failed: true, blocked: true, quota: true, fallback: true },
      } as any);
      vi.spyOn(client, 'getTelegramPairingCode').mockResolvedValue({ code: '123456', expiresInSec: 600 } as any);
      vi.spyOn(client, 'getProfiles').mockResolvedValue([
        { name: 'codex-main', engine: 'codex', kind: 'isolated', home: '/home/codex', email: null, enabled: 1 } as any,
        { name: 'claude-main', engine: 'claude', kind: 'isolated', home: '/home/claude', email: null, enabled: 1 } as any,
      ]);
      vi.spyOn(client, 'getModelOptions').mockResolvedValue({
        suggestions: ['gemini-3.8-flash-high', 'codex:gpt-5.6-luna', 'sonnet'],
        configured: ['sonnet', 'opus'],
      });
      vi.spyOn(client, 'getConfig').mockResolvedValue({
        modelChainHard: ['gemini-3.8-flash-high', 'codex:gpt-5.6-luna'],
        modelChainEasy: ['gemini-3.8-flash-medium'],
        defaultTimeout: 10800,
        chat: { claudeBin: 'claude', allowFullMode: false, maxConcurrent: 2, model: 'sonnet', models: ['opus', 'sonnet', 'haiku'] },
        reviewer: {
          model: 'codex:gpt-5.6-luna',
          claudeFallback: true,
          claudeProfiles: ['claude-main'],
          claudeModel: 'sonnet',
          order: [{ engine: 'codex', model: 'codex:gpt-5.6-luna', profiles: [] }],
          fallback: { onUnavailable: true, onError: true, onBusyAfterMin: 10 },
          arbiter: { engine: 'claude', model: 'sonnet' },
        },
        brain: { mode: 'suggest', digest: { enabled: true, time: '18:00' }, fallback: [] },
        notifications: { desktop: true },
        savings: { bucketTokens: { gemini: 5000000, claude: 5000000 }, claudeFactor: 0.9, claudeOverheadPerTask: 40000 },
      } as any);
    });

    it('renders hard and easy model chains as sortable lists and loads reviewer order', async () => {
      render(
        <LocaleProvider initialLocale="vi">
          <ThemeProvider>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter>
                <SettingsPage />
              </MemoryRouter>
            </QueryClientProvider>
          </ThemeProvider>
        </LocaleProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('hard-chain-list')).toBeInTheDocument();
        expect(screen.getByTestId('easy-chain-list')).toBeInTheDocument();
        expect(screen.getByTestId('reviewer-order')).toBeInTheDocument();
      });

      expect(screen.getAllByText('gemini-3.8-flash-high').length).toBeGreaterThan(0);
      expect(screen.getAllByText('codex:gpt-5.6-luna').length).toBeGreaterThan(0);
    });

    it('saves configuration with valid values', async () => {
      const updateSpy = vi.spyOn(client, 'updateConfig').mockResolvedValue({} as any);

      render(
        <LocaleProvider initialLocale="vi">
          <ThemeProvider>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter>
                <SettingsPage />
              </MemoryRouter>
            </QueryClientProvider>
          </ThemeProvider>
        </LocaleProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('hard-chain-list')).toBeInTheDocument();
      });

      const saveBtn = screen.getByRole('button', { name: /Lưu cấu hình/i });
      fireEvent.click(saveBtn);

      await waitFor(() => {
        expect(updateSpy).toHaveBeenCalled();
      });
      const payload = updateSpy.mock.calls[0][0];
      expect(payload.modelChainHard).toEqual(['gemini-3.8-flash-high', 'codex:gpt-5.6-luna']);
      expect(payload.reviewer?.order?.[0]?.model).toBe('codex:gpt-5.6-luna');
    });

    it('preserves old/inactive profiles in reviewer order without dropping them', async () => {
      vi.spyOn(client, 'getProfiles').mockResolvedValue([
        { name: 'claude-active', engine: 'claude', kind: 'isolated', home: '/home/claude', email: null, enabled: 1 } as any,
      ]);
      vi.spyOn(client, 'getConfig').mockResolvedValue({
        modelChainHard: ['gemini-3.8-flash-high'],
        modelChainEasy: ['gemini-3.8-flash-medium'],
        chat: { model: 'sonnet', models: ['sonnet', 'opus'] },
        reviewer: {
          model: 'codex:gpt-5.6-luna',
          order: [
            { engine: 'claude', model: 'sonnet', profiles: ['claude-deleted-old', 'claude-active'] },
          ],
          fallback: { onUnavailable: true, onError: true, onBusyAfterMin: 10 },
          arbiter: { engine: 'claude', model: 'sonnet' },
        },
      } as any);

      render(
        <LocaleProvider initialLocale="vi">
          <ThemeProvider>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter>
                <SettingsPage />
              </MemoryRouter>
            </QueryClientProvider>
          </ThemeProvider>
        </LocaleProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('reviewer-order')).toBeInTheDocument();
      });

      // The old profile should still appear as an option with the inactive label
      const profileSelect = screen.getByLabelText(/Hồ sơ Claude review \(theo thứ tự ưu tiên\) 1/i);
      expect(profileSelect).toBeInTheDocument();
      expect(screen.getByText(/claude-deleted-old \(cũ \/ không khả dụng\)/i)).toBeInTheDocument();
    });

    it('preserves inactive/deleted codexProfile with inactive label and retains it on save', async () => {
      const updateSpy = vi.spyOn(client, 'updateConfig').mockResolvedValue({} as any);
      vi.spyOn(client, 'getProfiles').mockResolvedValue([
        { name: 'codex-active', engine: 'codex', kind: 'isolated', home: '/home/codex', email: null, enabled: 1 } as any,
      ]);
      vi.spyOn(client, 'getConfig').mockResolvedValue({
        modelChainHard: ['gemini-3.8-flash-high'],
        modelChainEasy: ['gemini-3.8-flash-medium'],
        brain: {
          engine: 'codex',
          codexProfile: 'codex-archived-legacy',
          mode: 'suggest',
          digest: { enabled: true, time: '18:00' },
          fallback: [],
        },
        chat: { model: 'sonnet', models: ['sonnet', 'opus'] },
        reviewer: {
          model: 'codex:gpt-5.6-luna',
          order: [{ engine: 'claude', model: 'sonnet', profiles: [] }],
          fallback: { onUnavailable: true, onError: true, onBusyAfterMin: 10 },
          arbiter: { engine: 'claude', model: 'sonnet' },
        },
      } as any);

      render(
        <LocaleProvider initialLocale="vi">
          <ThemeProvider>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter>
                <SettingsPage />
              </MemoryRouter>
            </QueryClientProvider>
          </ThemeProvider>
        </LocaleProvider>,
      );

      await waitFor(() => {
        expect(screen.getByText(/Hồ sơ Codex cho Brain/i)).toBeInTheDocument();
      });

      // The inactive profile option should be present with the inactive label
      expect(screen.getByText(/codex-archived-legacy \(cũ \/ không khả dụng\)/i)).toBeInTheDocument();

      // Click save and verify codex-archived-legacy was preserved
      const saveBtn = screen.getByRole('button', { name: /Lưu cấu hình/i });
      fireEvent.click(saveBtn);

      await waitFor(() => {
        expect(updateSpy).toHaveBeenCalled();
      });
      const payload = updateSpy.mock.calls[0][0];
      expect(payload.brain?.codexProfile).toBe('codex-archived-legacy');
    });

    it('preserves fallback step pointing to an old profile absent from claudeProfiles and profiles list', async () => {
      const updateSpy = vi.spyOn(client, 'updateConfig').mockResolvedValue({} as any);
      vi.spyOn(client, 'getProfiles').mockResolvedValue([
        { name: 'claude-current', engine: 'claude', kind: 'isolated', home: '/home/claude', email: null, enabled: 1 } as any,
      ]);
      vi.spyOn(client, 'getConfig').mockResolvedValue({
        modelChainHard: ['gemini-3.8-flash-high'],
        modelChainEasy: ['gemini-3.8-flash-medium'],
        brain: {
          mode: 'suggest',
          digest: { enabled: true, time: '18:00' },
          fallback: [
            { type: 'profile', profile: 'legacy-fallback-claude' },
          ],
        },
        chat: { model: 'sonnet', models: ['sonnet', 'opus'] },
        reviewer: {
          model: 'codex:gpt-5.6-luna',
          claudeProfiles: ['claude-current'],
          order: [{ engine: 'claude', model: 'sonnet', profiles: ['claude-current'] }],
          fallback: { onUnavailable: true, onError: true, onBusyAfterMin: 10 },
          arbiter: { engine: 'claude', model: 'sonnet' },
        },
      } as any);

      render(
        <LocaleProvider initialLocale="vi">
          <ThemeProvider>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter>
                <SettingsPage />
              </MemoryRouter>
            </QueryClientProvider>
          </ThemeProvider>
        </LocaleProvider>,
      );

      await waitFor(() => {
        expect(screen.getByText(/Claude fallback chain/i)).toBeInTheDocument();
      });

      // The fallback profile input should recognize legacy-fallback-claude as a preset option with inactive label
      expect(screen.getByText(/legacy-fallback-claude \(cũ \/ không khả dụng\)/i)).toBeInTheDocument();

      // Click save and verify fallback profile is retained
      const saveBtn = screen.getByRole('button', { name: /Lưu cấu hình/i });
      fireEvent.click(saveBtn);

      await waitFor(() => {
        expect(updateSpy).toHaveBeenCalled();
      });
      const payload = updateSpy.mock.calls[0][0];
      expect(payload.brain?.fallback?.[0]).toEqual({ type: 'profile', profile: 'legacy-fallback-claude' });
    });

    it('creates reviewer with empty model when dynamic codex models are empty', async () => {
      vi.spyOn(client, 'getModelOptions').mockResolvedValue({
        suggestions: ['sonnet'],
        configured: ['sonnet'],
      });
      vi.spyOn(client, 'getConfig').mockResolvedValue({
        modelChainHard: ['sonnet'],
        modelChainEasy: ['sonnet'],
        defaultTimeout: 10800,
        chat: { claudeBin: 'claude', allowFullMode: false, maxConcurrent: 2, model: 'sonnet', models: ['sonnet'] },
        reviewer: {
          model: 'sonnet',
          order: [],
          fallback: { onUnavailable: true, onError: true, onBusyAfterMin: 10 },
          arbiter: { engine: 'claude', model: 'sonnet' },
        },
      } as any);

      render(
        <LocaleProvider initialLocale="vi">
          <ThemeProvider>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter>
                <SettingsPage />
              </MemoryRouter>
            </QueryClientProvider>
          </ThemeProvider>
        </LocaleProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('reviewer-order')).toBeInTheDocument();
      });

      const orderBlock = screen.getByTestId('reviewer-order');
      const addReviewerBtn = within(orderBlock).getByRole('button', { name: /Thêm reviewer/i });
      fireEvent.click(addReviewerBtn);

      const reviewerSelect = within(orderBlock).getByRole('combobox', { name: /^Model reviewer 1$/i }) as HTMLSelectElement;
      expect(reviewerSelect.value).toBe('');
      expect(within(reviewerSelect).queryByText(/gpt-5.6-luna/i)).not.toBeInTheDocument();

      // Switch to Claude engine, should pick sonnet from claude models
      const engineSelect = within(orderBlock).getByRole('combobox', { name: /^Thứ tự duyệt 1$/i }) as HTMLSelectElement;
      fireEvent.change(engineSelect, { target: { value: 'claude' } });
      await waitFor(() => {
        const updatedReviewerSelect = within(orderBlock).getByRole('combobox', { name: /^Model reviewer 1$/i }) as HTMLSelectElement;
        expect(updatedReviewerSelect.value).toBe('sonnet');
      });

      // Switch back to Codex engine, should reset to '' since codex models are empty
      const reloadedEngineSelect = within(orderBlock).getByRole('combobox', { name: /^Thứ tự duyệt 1$/i }) as HTMLSelectElement;
      fireEvent.change(reloadedEngineSelect, { target: { value: 'codex' } });
      await waitFor(() => {
        const updatedReviewerSelect = within(orderBlock).getByRole('combobox', { name: /^Model reviewer 1$/i }) as HTMLSelectElement;
        expect(updatedReviewerSelect.value).toBe('');
      });
    });

    it('handles empty dynamic models and empty chains without inserting hardcoded codex:gpt-5.6-luna in SettingsPage', async () => {
      vi.spyOn(client, 'getModelOptions').mockResolvedValue({
        suggestions: ['sonnet'],
        configured: [],
      });
      vi.spyOn(client, 'getConfig').mockResolvedValue({
        modelChainHard: [],
        modelChainEasy: [],
        defaultTimeout: 10800,
        chat: { claudeBin: 'claude', allowFullMode: false, maxConcurrent: 2, model: 'sonnet', models: ['sonnet'] },
        reviewer: {
          model: '',
          claudeFallback: false,
        },
      } as any);

      render(
        <LocaleProvider initialLocale="vi">
          <ThemeProvider>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter>
                <SettingsPage />
              </MemoryRouter>
            </QueryClientProvider>
          </ThemeProvider>
        </LocaleProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('hard-chain-list')).toBeInTheDocument();
        expect(screen.getByTestId('easy-chain-list')).toBeInTheDocument();
        expect(screen.getByTestId('reviewer-order')).toBeInTheDocument();
      });

      // Hard and easy chains show empty warnings
      const emptyWarnings = screen.getAllByText(/Chuỗi model không được để trống/i);
      expect(emptyWarnings.length).toBeGreaterThanOrEqual(2);

      // Reviewer model input is empty and not hardcoded to codex:gpt-5.6-luna
      const reviewerModelInput = screen.getByTestId('reviewer-model-input') as HTMLSelectElement | HTMLInputElement;
      expect(reviewerModelInput.value).toBe('');

      // Reviewer order has no items
      const orderBlock = screen.getByTestId('reviewer-order');
      expect(within(orderBlock).queryByRole('combobox', { name: /^Model reviewer/i })).not.toBeInTheDocument();
    });

    it('chooses the default Claude account for brain and chat and sends it on save', async () => {
      const updateSpy = vi.spyOn(client, 'updateConfig').mockResolvedValue({} as any);

      render(
        <LocaleProvider initialLocale="vi">
          <ThemeProvider>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter>
                <SettingsPage />
              </MemoryRouter>
            </QueryClientProvider>
          </ThemeProvider>
        </LocaleProvider>,
      );

      const select = await screen.findByLabelText('Tài khoản Claude mặc định cho Brain và Chat');
      expect(select).toHaveValue('');
      await waitFor(() => expect(within(select).getByRole('option', { name: /claude-main/ })).toBeInTheDocument());
      expect(within(select).queryByRole('option', { name: /codex-main/ })).not.toBeInTheDocument();
      fireEvent.change(select, { target: { value: 'claude-main' } });

      fireEvent.click(screen.getByRole('button', { name: /Lưu cấu hình/i }));
      await waitFor(() => expect(updateSpy).toHaveBeenCalled());
      const payload = updateSpy.mock.calls[0][0];
      expect(payload.chat?.claudeProfile).toBe('claude-main');
      expect(payload.brain?.claudeProfile).toBe('claude-main');
    });

    const renderSettings = () => render(
      <LocaleProvider initialLocale="vi">
        <ThemeProvider>
          <QueryClientProvider client={queryClient}>
            <MemoryRouter>
              <SettingsPage />
            </MemoryRouter>
          </QueryClientProvider>
        </ThemeProvider>
      </LocaleProvider>,
    );

    it('allows saving a custom chat model without whitespace', async () => {
      const updateSpy = vi.spyOn(client, 'updateConfig').mockResolvedValue({} as any);
      renderSettings();

      const chatSelect = await screen.findByLabelText('Model chat Claude');
      expect(chatSelect).toBeInTheDocument();
      fireEvent.change(chatSelect, { target: { value: '__custom__' } });

      const customInput = within(chatSelect.closest('div')!).getByPlaceholderText('sonnet');
      expect(customInput).toBeInTheDocument();
      fireEvent.change(customInput, { target: { value: 'custom-claude-model' } });

      fireEvent.click(screen.getByRole('button', { name: /Lưu cấu hình/i }));
      await waitFor(() => expect(updateSpy).toHaveBeenCalled());
      const payload = updateSpy.mock.calls[0][0];
      expect(payload.chat?.model).toBe('custom-claude-model');
    });

    it('allows saving a custom reviewer model my-model with custom warning', async () => {
      const updateSpy = vi.spyOn(client, 'updateConfig').mockResolvedValue({} as any);
      renderSettings();

      const reviewerSelect = await screen.findByLabelText('Model reviewer 1');
      expect(reviewerSelect).toBeInTheDocument();
      fireEvent.change(reviewerSelect, { target: { value: '__custom__' } });

      const customInput = within(reviewerSelect.closest('div')!).getByPlaceholderText('codex:model');
      expect(customInput).toBeInTheDocument();
      fireEvent.change(customInput, { target: { value: 'my-model' } });

      await waitFor(() => {
        expect(within(reviewerSelect.closest('div')!).getByTestId('custom-warning')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /Lưu cấu hình/i }));
      await waitFor(() => expect(updateSpy).toHaveBeenCalled());
      const payload = updateSpy.mock.calls[0][0];
      expect(payload.reviewer?.order?.[0]?.model).toBe('my-model');
    });

    it('shows a success toast after saving the config', async () => {
      let resolveSave: (value: any) => void = () => {};
      vi.spyOn(client, 'updateConfig').mockImplementation(() => new Promise((resolve) => { resolveSave = resolve; }));
      renderSettings();

      fireEvent.click(await screen.findByRole('button', { name: /Lưu cấu hình/i }));
      await waitFor(() => expect(document.querySelector('[data-kind="loading"]')).toHaveTextContent('Đang lưu...'));

      resolveSave({});
      await waitFor(() => expect(document.querySelector('[data-kind="success"]')).toHaveTextContent('Cài đặt hệ thống đã được cập nhật thành công!'));
      expect(document.querySelector('[data-kind="loading"]')).toBeNull();
    });

    it('shows an error toast with the server message when saving fails', async () => {
      vi.spyOn(client, 'updateConfig').mockRejectedValue(new Error('boom from server'));
      renderSettings();

      fireEvent.click(await screen.findByRole('button', { name: /Lưu cấu hình/i }));
      await waitFor(() => {
        const toast = document.querySelector('[data-kind="error"]');
        expect(toast).toHaveTextContent('Không thể lưu cài đặt');
        expect(toast).toHaveTextContent('boom from server');
      });
      expect(document.querySelector('[data-kind="loading"]')).toBeNull();
    });
  });

  describe('4. ProjectSettingsDrawer Reviewer Order, Fallback & Review Chain Integration', () => {
    let queryClient: QueryClient;

    const mockProject = {
      id: 'p1',
      name: 'XFarm',
      path: '/home/repo',
      defaultBranch: 'main',
      maxParallel: 2,
      settings: {
        integration: { enabled: true, branch: 'integration', baseRef: 'main' },
        commitConvention: { branchTemplate: 'agenthub/{slug}' },
        brain: { engine: 'claude', model: 'sonnet', mode: 'suggest', permissions: 'standard' },
        worktree: {},
        ci: {},
        references: [],
        reviewChecklist: [],
        notifications: { telegramContent: 'full' },
        review: {
          order: [{ engine: 'codex', model: 'codex:gpt-5.6-luna', profiles: ['codex-main'] }],
          fallback: { onUnavailable: true, onError: true, onBusyAfterMin: 10 },
        },
      },
      review: {
        chain: [
          { reviewer: 'codex:gpt-5.6-luna', mode: 'gate' },
          { reviewer: 'claude', mode: 'final' },
        ],
        maxRounds: 2,
      },
    } as any;

    beforeEach(() => {
      queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      vi.spyOn(client, 'getModelOptions').mockResolvedValue({
        suggestions: ['codex:gpt-5.6-luna', 'sonnet'],
        configured: ['codex:gpt-5.6-luna', 'sonnet'],
      });
      vi.spyOn(client, 'getProfiles').mockResolvedValue([
        { name: 'codex-main', engine: 'codex', kind: 'isolated', home: '/home/codex', email: null, enabled: 1 } as any,
        { name: 'claude-main', engine: 'claude', kind: 'isolated', home: '/home/claude', email: null, enabled: 1 } as any,
      ]);
      vi.spyOn(client, 'getConfig').mockResolvedValue({} as any);
      vi.spyOn(client, 'getFocus').mockResolvedValue({ projectId: null, since: null, pauseRunning: false } as any);
    });

    it('renders structured reviewer order and review chain controls without JSON textareas', async () => {
      render(
        <LocaleProvider initialLocale="vi">
          <ThemeProvider>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter>
                <ProjectSettingsDrawer
                  project={mockProject}
                  isOpen={true}
                  onClose={() => {}}
                />
              </MemoryRouter>
            </QueryClientProvider>
          </ThemeProvider>
        </LocaleProvider>,
      );

      // Open advanced settings section
      const advancedSummary = screen.getByTestId('advanced-settings-section').querySelector('summary');
      if (advancedSummary) fireEvent.click(advancedSummary);

      await waitFor(() => {
        expect(screen.getByTestId('project-reviewer-order')).toBeInTheDocument();
        expect(screen.getByTestId('project-review-chain')).toBeInTheDocument();
      });

      // Assert that old JSON textareas are NOT present
      expect(screen.queryByTestId('review-chain-textarea')).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/Ghi đè thứ tự reviewer/i)).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/Ghi đè fallback reviewer/i)).not.toBeInTheDocument();

      // Assert that interactive controls are present
      await waitFor(() => {
        expect(screen.getAllByText('codex:gpt-5.6-luna').length).toBeGreaterThan(0);
        expect(screen.getAllByText('claude').length).toBeGreaterThan(0);
      });
    });

    it('saves updated reviewer order and review chain correctly', async () => {
      const updateProjectSpy = vi.spyOn(client, 'updateProject').mockResolvedValue(mockProject);

      render(
        <LocaleProvider initialLocale="vi">
          <ThemeProvider>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter>
                <ProjectSettingsDrawer
                  project={mockProject}
                  isOpen={true}
                  onClose={() => {}}
                />
              </MemoryRouter>
            </QueryClientProvider>
          </ThemeProvider>
        </LocaleProvider>,
      );

      const advancedSummary = screen.getByTestId('advanced-settings-section').querySelector('summary');
      if (advancedSummary) fireEvent.click(advancedSummary);

      await waitFor(() => {
        expect(screen.getByTestId('project-review-chain')).toBeInTheDocument();
      });

      // Add a review step
      const addStepBtn = screen.getByRole('button', { name: /Thêm bước review/i });
      fireEvent.click(addStepBtn);

      // Unsaved changes bar should appear
      expect(screen.getByTestId('unsaved-changes-bar')).toBeInTheDocument();

      const saveBtn = screen.getByRole('button', { name: 'Lưu' });
      fireEvent.click(saveBtn);

      await waitFor(() => {
        expect(updateProjectSpy).toHaveBeenCalled();
      });

      const callArgs = updateProjectSpy.mock.calls[0][1];
      expect(callArgs.review?.chain.length).toBe(3);
    });

    it('handleDiscard resets reviewerOrder, reviewerFallback, reviewChain and override flags to original state', async () => {
      render(
        <LocaleProvider initialLocale="vi">
          <ThemeProvider>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter>
                <ProjectSettingsDrawer
                  project={mockProject}
                  isOpen={true}
                  onClose={() => {}}
                />
              </MemoryRouter>
            </QueryClientProvider>
          </ThemeProvider>
        </LocaleProvider>,
      );

      const advancedSummary = screen.getByTestId('advanced-settings-section').querySelector('summary');
      if (advancedSummary) fireEvent.click(advancedSummary);

      await waitFor(() => {
        expect(screen.getByTestId('project-review-chain')).toBeInTheDocument();
        expect(screen.getByTestId('project-reviewer-order')).toBeInTheDocument();
      });

      // Initially review chain has 2 steps and reviewer order has 1 item
      expect(within(screen.getByTestId('project-review-chain')).getByText('1.')).toBeInTheDocument();
      expect(within(screen.getByTestId('project-review-chain')).getByText('2.')).toBeInTheDocument();
      expect(within(screen.getByTestId('project-review-chain')).queryByText('3.')).not.toBeInTheDocument();

      // Add a review step (chain now has 3 steps)
      const addStepBtn = screen.getByRole('button', { name: /Thêm bước review/i });
      fireEvent.click(addStepBtn);
      expect(within(screen.getByTestId('project-review-chain')).getByText('3.')).toBeInTheDocument();

      // Add a reviewer (reviewerOrder now has 2 items)
      const addReviewerBtn = screen.getByRole('button', { name: /Thêm reviewer/i });
      fireEvent.click(addReviewerBtn);
      expect(within(screen.getByTestId('project-reviewer-order')).getByText('2.')).toBeInTheDocument();

      // Unsaved changes bar should appear
      expect(screen.getByTestId('unsaved-changes-bar')).toBeInTheDocument();

      // Click "Huỷ" / Discard
      const discardBtn = screen.getByRole('button', { name: 'Huỷ' });
      fireEvent.click(discardBtn);

      // Unsaved changes bar should disappear
      expect(screen.queryByTestId('unsaved-changes-bar')).not.toBeInTheDocument();

      // Review steps and reviewer order should be restored to original counts
      expect(within(screen.getByTestId('project-review-chain')).queryByText('3.')).not.toBeInTheDocument();
      expect(within(screen.getByTestId('project-review-chain')).getByText('2.')).toBeInTheDocument();
      expect(within(screen.getByTestId('project-reviewer-order')).queryByText('2.')).not.toBeInTheDocument();
      expect(within(screen.getByTestId('project-reviewer-order')).getByText('1.')).toBeInTheDocument();
    });

    it('preserves existing project.review when chain is empty and does not send review: null on unrelated changes', async () => {
      const updateProjectSpy = vi.spyOn(client, 'updateProject').mockResolvedValue(mockProject);
      const projectWithEmptyChain = {
        ...mockProject,
        review: {
          chain: [],
          maxRounds: 2,
        },
      };

      render(
        <LocaleProvider initialLocale="vi">
          <ThemeProvider>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter>
                <ProjectSettingsDrawer
                  project={projectWithEmptyChain}
                  isOpen={true}
                  onClose={() => {}}
                />
              </MemoryRouter>
            </QueryClientProvider>
          </ThemeProvider>
        </LocaleProvider>,
      );

      const advancedSummary = screen.getByTestId('advanced-settings-section').querySelector('summary');
      if (advancedSummary) fireEvent.click(advancedSummary);

      await waitFor(() => {
        expect(screen.getByTestId('project-review-chain')).toBeInTheDocument();
      });

      // Upon opening, unsaved changes bar MUST NOT be present
      expect(screen.queryByTestId('unsaved-changes-bar')).not.toBeInTheDocument();

      // The review chain override is preserved even with empty chain (displays empty notice, not system default)
      expect(within(screen.getByTestId('project-review-chain')).getByText(/Chưa có bước review nào/i)).toBeInTheDocument();

      // Modify an unrelated field: hooks
      const hooksTextarea = screen.getByTestId('hooks-textarea');
      fireEvent.change(hooksTextarea, { target: { value: 'echo "hello"' } });

      // Unsaved changes bar appears
      expect(screen.getByTestId('unsaved-changes-bar')).toBeInTheDocument();

      // Save
      const saveBtn = screen.getByRole('button', { name: 'Lưu' });
      fireEvent.click(saveBtn);

      await waitFor(() => {
        expect(updateProjectSpy).toHaveBeenCalled();
      });

      const callArgs = updateProjectSpy.mock.calls[0][1];
      // review should NOT be in callArgs (or definitely not null!)
      expect(callArgs.review).toBeUndefined();
    });

    it('sends review: null only when user explicitly clicks useSystemDefault to remove review chain override', async () => {
      const updateProjectSpy = vi.spyOn(client, 'updateProject').mockResolvedValue(mockProject);
      const projectWithChain = {
        ...mockProject,
        review: {
          chain: [{ reviewer: 'claude', mode: 'final' }],
          maxRounds: 2,
        },
      };

      render(
        <LocaleProvider initialLocale="vi">
          <ThemeProvider>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter>
                <ProjectSettingsDrawer
                  project={projectWithChain}
                  isOpen={true}
                  onClose={() => {}}
                />
              </MemoryRouter>
            </QueryClientProvider>
          </ThemeProvider>
        </LocaleProvider>,
      );

      const advancedSummary = screen.getByTestId('advanced-settings-section').querySelector('summary');
      if (advancedSummary) fireEvent.click(advancedSummary);

      await waitFor(() => {
        expect(screen.getByTestId('project-review-chain')).toBeInTheDocument();
      });

      // Click "Dùng mặc định hệ thống" in the review chain block
      const chainBlock = screen.getByTestId('project-review-chain');
      const useSystemDefaultBtn = within(chainBlock).getByRole('button', { name: /Dùng mặc định hệ thống/i });
      fireEvent.click(useSystemDefaultBtn);

      // Unsaved changes bar should appear
      expect(screen.getByTestId('unsaved-changes-bar')).toBeInTheDocument();

      // Save
      const saveBtn = screen.getByRole('button', { name: 'Lưu' });
      fireEvent.click(saveBtn);

      await waitFor(() => {
        expect(updateProjectSpy).toHaveBeenCalled();
      });

      const callArgs = updateProjectSpy.mock.calls[0][1];
      // review must explicitly be null to clear override on backend
      expect(callArgs.review).toBeNull();
    });

    it('populates review chain and reviewer order options dynamically from getModelOptions without defaulting to custom', async () => {
      vi.spyOn(client, 'getModelOptions').mockResolvedValue({
        suggestions: ['codex:custom-model-dynamic', 'gemini-3.8-flash-high'],
        configured: ['codex:custom-model-dynamic', 'sonnet'],
      });

      const projectWithDynamicModel = {
        ...mockProject,
        settings: {
          ...mockProject.settings,
          review: {
            order: [{ engine: 'codex', model: 'codex:custom-model-dynamic', profiles: [] }],
            fallback: { onUnavailable: true, onError: true, onBusyAfterMin: 10 },
          },
        },
        review: {
          chain: [
            { reviewer: 'codex:custom-model-dynamic', mode: 'gate' },
            { reviewer: 'gemini-3.8-flash-high', mode: 'gate' },
            { reviewer: 'codex:gpt-oss-120b-medium', mode: 'gate' },
          ],
          maxRounds: 2,
        },
      };

      render(
        <LocaleProvider initialLocale="vi">
          <ThemeProvider>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter>
                <ProjectSettingsDrawer
                  project={projectWithDynamicModel}
                  isOpen={true}
                  onClose={() => {}}
                />
              </MemoryRouter>
            </QueryClientProvider>
          </ThemeProvider>
        </LocaleProvider>,
      );

      const advancedSummary = screen.getByTestId('advanced-settings-section').querySelector('summary');
      if (advancedSummary) fireEvent.click(advancedSummary);

      await waitFor(() => {
        expect(screen.getByTestId('project-review-chain')).toBeInTheDocument();
        expect(screen.getByTestId('project-reviewer-order')).toBeInTheDocument();
      });

      // Review step select should display codex:custom-model-dynamic as a known select option, NOT custom input
      const chainBlock = screen.getByTestId('project-review-chain');
      await waitFor(() => {
        const stepSelect = within(chainBlock).getByRole('combobox', { name: /^Bước review 1$/i }) as HTMLSelectElement;
        expect(stepSelect.value).toBe('codex:custom-model-dynamic');
      });
      const stepSelect = within(chainBlock).getByRole('combobox', { name: /^Bước review 1$/i }) as HTMLSelectElement;
      expect(stepSelect.tagName.toLowerCase()).toBe('select');
      expect(within(stepSelect).getByRole('option', { name: 'codex:custom-model-dynamic' })).toBeInTheDocument();
      // Ensure hardcoded models like gpt-5.6-turbo/luna are NOT included when not in API or config
      expect(within(stepSelect).queryByRole('option', { name: 'codex:gpt-5.6-turbo' })).not.toBeInTheDocument();
      expect(within(stepSelect).queryByRole('option', { name: 'codex:gpt-5.6-luna' })).not.toBeInTheDocument();
      expect(within(stepSelect).queryByRole('option', { name: 'gemini-3.8-flash-high' })).not.toBeInTheDocument();
      expect(within(stepSelect).queryByRole('option', { name: 'codex:gpt-oss-120b-medium' })).not.toBeInTheDocument();

      // Reviewer order select should also have codex:custom-model-dynamic as option
      const orderBlock = screen.getByTestId('project-reviewer-order');
      const reviewerSelect = within(orderBlock).getByRole('combobox', { name: /^Model reviewer 1$/i }) as HTMLSelectElement;
      expect(reviewerSelect.tagName.toLowerCase()).toBe('select');
      expect(reviewerSelect.value).toBe('codex:custom-model-dynamic');
      expect(within(reviewerSelect).queryByRole('option', { name: 'codex:gpt-5.6-turbo' })).not.toBeInTheDocument();
      expect(within(reviewerSelect).queryByRole('option', { name: 'gpt-5.6-turbo' })).not.toBeInTheDocument();

      // Models from another provider must not leak into the Codex selector.
      expect(within(reviewerSelect).queryByRole('option', { name: 'gemini-3.8-flash-high' })).not.toBeInTheDocument();

      // Switching provider must also replace the list with Claude-only models.
      const engineSelect = within(orderBlock).getByRole('combobox', { name: /^Thứ tự duyệt 1$/i }) as HTMLSelectElement;
      fireEvent.change(engineSelect, { target: { value: 'claude' } });
      expect(within(reviewerSelect).getByRole('option', { name: 'sonnet' })).toBeInTheDocument();
      expect(within(reviewerSelect).queryByRole('option', { name: 'codex:custom-model-dynamic' })).not.toBeInTheDocument();
      expect(within(reviewerSelect).queryByRole('option', { name: 'gemini-3.8-flash-high' })).not.toBeInTheDocument();
    });

    it('sends review order: null and fallback: null when user resets overrides to system default', async () => {
      const updateProjectSpy = vi.spyOn(client, 'updateProject').mockResolvedValue(mockProject);
      const projectWithOverrides = {
        ...mockProject,
        settings: {
          ...mockProject.settings,
          review: {
            order: [{ engine: 'codex', model: 'codex:gpt-5.6-luna', profiles: [] }],
            fallback: { onUnavailable: true, onError: true, onBusyAfterMin: 10 },
          },
        },
      };

      render(
        <LocaleProvider initialLocale="vi">
          <ThemeProvider>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter>
                <ProjectSettingsDrawer
                  project={projectWithOverrides}
                  isOpen={true}
                  onClose={() => {}}
                />
              </MemoryRouter>
            </QueryClientProvider>
          </ThemeProvider>
        </LocaleProvider>,
      );

      const advancedSummary = screen.getByTestId('advanced-settings-section').querySelector('summary');
      if (advancedSummary) fireEvent.click(advancedSummary);

      await waitFor(() => {
        expect(screen.getByTestId('project-reviewer-order')).toBeInTheDocument();
        expect(screen.getByTestId('project-reviewer-fallback')).toBeInTheDocument();
      });

      // Click "Dùng mặc định" in reviewer order block
      const orderBlock = screen.getByTestId('project-reviewer-order');
      const fallbackBlock = screen.getByTestId('project-reviewer-fallback');
      const defaultOrderBtn = within(orderBlock).getAllByRole('button', { name: /Dùng mặc định/i })[0];
      fireEvent.click(defaultOrderBtn);

      // Click "Dùng mặc định" in reviewer fallback block
      const defaultFallbackBtn = within(fallbackBlock).getByRole('button', { name: /Dùng mặc định/i });
      fireEvent.click(defaultFallbackBtn);

      // Save
      const saveBtn = screen.getByRole('button', { name: 'Lưu' });
      fireEvent.click(saveBtn);

      await waitFor(() => {
        expect(updateProjectSpy).toHaveBeenCalled();
      });

      const callArgs = updateProjectSpy.mock.calls[0][1];
      expect(callArgs.settings?.review?.order).toBeNull();
      expect(callArgs.settings?.review?.fallback).toBeNull();
    });

    it('handles empty dynamic models gracefully without inserting hardcoded codex:gpt-5.6-luna in ProjectSettingsDrawer', async () => {
      // Mock project with NO reviewer order or chain overrides, and clean config
      const cleanProject = {
        ...mockProject,
        review: null,
        settings: {
          ...mockProject.settings,
          review: undefined,
        },
      };

      // Mock getModelOptions returning no codex suggestions
      vi.spyOn(client, 'getModelOptions').mockResolvedValue({
        configured: [],
        suggestions: ['sonnet', 'opus'],
      });
      // Mock getConfig returning no codex models
      vi.spyOn(client, 'getConfig').mockResolvedValue({
        chat: { model: 'sonnet', models: ['sonnet', 'opus'] },
        reviewer: { model: '', claudeModel: 'sonnet' },
        modelChainHard: [],
        modelChainEasy: [],
      } as any);

      render(
        <LocaleProvider initialLocale="vi">
          <ThemeProvider>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter>
                <ProjectSettingsDrawer
                  project={cleanProject}
                  isOpen={true}
                  onClose={() => {}}
                />
              </MemoryRouter>
            </QueryClientProvider>
          </ThemeProvider>
        </LocaleProvider>,
      );

      const advancedSummary = screen.getByTestId('advanced-settings-section').querySelector('summary');
      if (advancedSummary) fireEvent.click(advancedSummary);

      await waitFor(() => {
        expect(screen.getByTestId('project-reviewer-order')).toBeInTheDocument();
        expect(screen.getByTestId('project-review-chain')).toBeInTheDocument();
      });

      // 1. Override reviewer order: should create row with model "" instead of hardcoded luna
      const orderBlock = screen.getByTestId('project-reviewer-order');
      const overrideOrderBtn = within(orderBlock).getAllByRole('button', { name: /\+ Ghi đè cấu hình/i })[0];
      fireEvent.click(overrideOrderBtn);

      const reviewerSelect = within(orderBlock).getByRole('combobox', { name: /^Model reviewer 1$/i }) as HTMLSelectElement;
      expect(reviewerSelect.value).toBe('');
      expect(within(reviewerSelect).queryByText(/gpt-5.6-luna/i)).not.toBeInTheDocument();

      // 2. Add another reviewer: should also have model ""
      const addReviewerBtn = within(orderBlock).getByRole('button', { name: /Thêm reviewer/i });
      fireEvent.click(addReviewerBtn);
      const reviewerSelect2 = within(orderBlock).getByRole('combobox', { name: /^Model reviewer 2$/i }) as HTMLSelectElement;
      expect(reviewerSelect2.value).toBe('');
      expect(within(reviewerSelect2).queryByText(/gpt-5.6-luna/i)).not.toBeInTheDocument();

      // 3. Switch reviewer 1 engine to claude: should pick sonnet
      const engineSelect = within(orderBlock).getByRole('combobox', { name: /^Thứ tự duyệt 1$/i }) as HTMLSelectElement;
      fireEvent.change(engineSelect, { target: { value: 'claude' } });
      expect(reviewerSelect.value).toBe('sonnet');

      // Switch back to codex: should reset to '' since codex models are empty
      fireEvent.change(engineSelect, { target: { value: 'codex' } });
      expect(reviewerSelect.value).toBe('');

      // 4. Override review chain: codex step should have reviewer "" instead of hardcoded luna
      const chainBlock = screen.getByTestId('project-review-chain');
      const overrideChainBtn = within(chainBlock).getByRole('button', { name: /\+ Ghi đè cấu hình/i });
      fireEvent.click(overrideChainBtn);

      const step1Select = within(chainBlock).getByRole('combobox', { name: /^Bước review 1$/i }) as HTMLSelectElement;
      expect(step1Select.value).toBe('');
      expect(within(step1Select).queryByText(/gpt-5.6-luna/i)).not.toBeInTheDocument();
    });

    it('does not insert hardcoded codex:gpt-5.6-luna when applying presets or quick-fix in ProjectSettingsDrawer with empty codex models', async () => {
      const cleanProject = {
        ...mockProject,
        review: null,
        settings: {
          ...mockProject.settings,
          review: undefined,
        },
      };

      vi.spyOn(client, 'getModelOptions').mockResolvedValue({
        configured: [],
        models: [
          { id: 'sonnet', name: 'Claude Sonnet', engine: 'claude', profiles: ['p1'], verified: true, available: true },
        ],
        suggestions: ['sonnet'],
      });
      vi.spyOn(client, 'getConfig').mockResolvedValue({
        chat: { model: 'sonnet', models: ['sonnet'] },
        reviewer: { model: '', claudeModel: 'sonnet' },
        modelChainHard: [],
        modelChainEasy: [],
      } as any);

      render(
        <LocaleProvider initialLocale="vi">
          <ThemeProvider>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter>
                <ProjectSettingsDrawer
                  project={cleanProject}
                  isOpen={true}
                  onClose={() => {}}
                />
              </MemoryRouter>
            </QueryClientProvider>
          </ThemeProvider>
        </LocaleProvider>,
      );

      const advancedSummary = screen.getByTestId('advanced-settings-section').querySelector('summary');
      if (advancedSummary) fireEvent.click(advancedSummary);

      await waitFor(() => {
        expect(screen.getByTestId('project-review-chain')).toBeInTheDocument();
      });

      // Quick fix button should be disabled when no codex model is available
      const fixBtn = screen.queryByTestId('automerge-fix-chain');
      if (fixBtn) {
        expect(fixBtn).toBeDisabled();
      }

      // Applying balanced preset should not contain codex:gpt-5.6-luna
      const balancedBtn = screen.getByTestId('project-preset-card-balanced');
      fireEvent.click(balancedBtn);

      const chainBlock = screen.getByTestId('project-review-chain');
      expect(within(chainBlock).queryByText(/gpt-5.6-luna/i)).not.toBeInTheDocument();
    });

    it('displays warning badge and excludes unavailable configured models from drawer reviewer dropdown', async () => {
      const projectWithUnavailableModel = {
        ...mockProject,
        id: 'p-unavailable',
        settings: {
          ...mockProject.settings,
          review: {
            order: [{ engine: 'codex', model: 'codex:unavailable-model', profiles: [] }],
            fallback: { onUnavailable: true, onError: true, onBusyAfterMin: 10 },
          },
        },
        review: {
          chain: [
            { reviewer: 'codex:unavailable-model', mode: 'gate' },
          ],
          maxRounds: 2,
        },
      };

      vi.spyOn(client, 'getModelOptions').mockResolvedValue({
        configured: ['codex:unavailable-model'],
        models: [
          { id: 'codex:valid-model', engine: 'codex', profiles: ['p1'], verified: true, available: true },
          { id: 'codex:unavailable-model', engine: 'codex', profiles: [], verified: false, available: false, warning: 'Không có tài khoản' },
        ],
        suggestions: ['codex:valid-model'],
      });

      render(
        <LocaleProvider initialLocale="vi">
          <ThemeProvider>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter>
                <ProjectSettingsDrawer
                  project={projectWithUnavailableModel}
                  isOpen={true}
                  onClose={() => {}}
                />
              </MemoryRouter>
            </QueryClientProvider>
          </ThemeProvider>
        </LocaleProvider>,
      );

      const advancedSummary = screen.getByTestId('advanced-settings-section').querySelector('summary');
      if (advancedSummary) fireEvent.click(advancedSummary);

      await waitFor(() => {
        expect(screen.getByTestId('project-review-chain')).toBeInTheDocument();
        expect(screen.getByTestId('project-reviewer-order')).toBeInTheDocument();
      });

      // Warning badge is shown in both reviewer-order and review-chain for unavailable-model
      await waitFor(() => {
        const orderBlock = screen.getByTestId('project-reviewer-order');
        expect(within(orderBlock).getByTestId('model-unavailable-warning')).toBeInTheDocument();
      });

      const chainBlock = screen.getByTestId('project-review-chain');
      expect(within(chainBlock).getByTestId('model-unavailable-warning')).toBeInTheDocument();

      // Dropdown does NOT propose unavailable model as an available option
      const orderBlock = screen.getByTestId('project-reviewer-order');
      const reviewerSelect = within(orderBlock).getByRole('combobox', { name: /^Model reviewer 1$/i }) as HTMLSelectElement;
      expect(within(reviewerSelect).queryByRole('option', { name: 'codex:unavailable-model' })).not.toBeInTheDocument();
      expect(within(reviewerSelect).getByRole('option', { name: 'codex:valid-model' })).toBeInTheDocument();
    });
  });

  describe('5. Discovered Models Integration & Warnings (f-account-model-discovery)', () => {
    it('formatDiscoveredModelOptions groups models by engine and formats labels with account count', () => {
      const mockModels = [
        { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)', engine: 'agy' as const, profiles: ['huynq766', 'work'], verified: true, available: true },
        { id: 'codex:gpt-5.6-luna', name: 'GPT-5.6 Luna', engine: 'codex' as const, profiles: ['openai-1'], verified: true, available: true },
        { id: 'sonnet', name: 'Claude Sonnet', engine: 'claude' as const, profiles: [], verified: false, available: false, warning: 'No active profile' },
      ];

      const viOptions = formatDiscoveredModelOptions(mockModels, (k, params) => {
        if (k === 'models.engineAgy') return 'Antigravity (agy)';
        if (k === 'models.engineCodex') return 'Codex';
        if (k === 'models.engineClaude') return 'Claude';
        if (k === 'models.accountCount') return `${params?.count} tài khoản`;
        if (k === 'models.unavailableWarning') return 'Không khả dụng';
        return k;
      });

      expect(viOptions).toHaveLength(3);
      expect(viOptions[0].group).toBe('Antigravity (agy)');
      expect(viOptions[0].label).toContain('Gemini 3.8 Flash (High) (gemini-3.8-flash-high) (2 tài khoản)');
      expect(viOptions[1].group).toBe('Codex');
      expect(viOptions[1].label).toContain('(1 tài khoản)');
      expect(viOptions[2].group).toBe('Claude');
      expect(viOptions[2].label).toContain('⚠️ Không khả dụng');

      // Filter by engine
      const codexOnly = formatDiscoveredModelOptions(mockModels, undefined, 'codex');
      expect(codexOnly).toHaveLength(1);
      expect(codexOnly[0].value).toBe('codex:gpt-5.6-luna');
    });

    it('SelectOrCustomInput renders grouped options inside optgroups', () => {
      const groupedOpts = [
        { value: 'gemini-3.8-flash-high', label: 'Gemini Flash (2 tài khoản)', group: 'Antigravity' },
        { value: 'codex:gpt-5.6-luna', label: 'GPT Luna (1 tài khoản)', group: 'Codex' },
      ];

      render(
        <LocaleProvider initialLocale="vi">
          <SelectOrCustomInput
            testId="grouped-select"
            value="gemini-3.8-flash-high"
            onChange={() => {}}
            options={groupedOpts}
            ariaLabel="Grouped Select"
          />
        </LocaleProvider>,
      );

      const select = screen.getByTestId('grouped-select') as HTMLSelectElement;
      const optgroups = select.querySelectorAll('optgroup');
      expect(optgroups.length).toBe(2);
      expect(optgroups[0].label).toBe('Antigravity');
      expect(optgroups[1].label).toBe('Codex');
    });

    it('SelectOrCustomInput displays custom warning when showCustomWarning is enabled and custom value entered', () => {
      render(
        <LocaleProvider initialLocale="vi">
          <SelectOrCustomInput
            testId="custom-warning-select"
            value="my-custom-model"
            onChange={() => {}}
            options={['preset-model-1']}
            showCustomWarning={true}
            ariaLabel="Custom Warning Select"
          />
        </LocaleProvider>,
      );

      // In custom mode with an unverified model
      expect(screen.getByTestId('custom-warning')).toBeInTheDocument();
      expect(screen.getByTestId('custom-warning').textContent).toContain('chưa được xác minh');
    });

    it('SortableModelList marks unavailable models with warning badge', () => {
      render(
        <LocaleProvider initialLocale="vi">
          <SortableModelList
            title="Model Chain"
            models={['gemini-3.8-flash-high', 'deprecated-model']}
            onChange={() => {}}
            availableOptions={['gemini-3.8-flash-high']}
            unavailableModels={new Set(['deprecated-model'])}
          />
        </LocaleProvider>,
      );

      const warnings = screen.getAllByTestId('model-unavailable-warning');
      expect(warnings.length).toBe(1);
      expect(warnings[0].textContent).toContain('không còn khả dụng');
    });

    it('SettingsPage displays refresh button and handles clicking refresh', async () => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const refreshSpy = vi.spyOn(client, 'refreshModels').mockResolvedValue({
        suggestions: ['gemini-3.8-flash-high'],
        configured: ['gemini-3.8-flash-high'],
        models: [
          { id: 'gemini-3.8-flash-high', engine: 'agy', profiles: ['huynq766'], verified: true, available: true },
        ],
      });

      render(
        <LocaleProvider initialLocale="vi">
          <ThemeProvider>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter>
                <SettingsPage />
              </MemoryRouter>
            </QueryClientProvider>
          </ThemeProvider>
        </LocaleProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('refresh-models-btn')).toBeInTheDocument();
      });

      const refreshBtn = screen.getByTestId('refresh-models-btn');
      fireEvent.click(refreshBtn);

      await waitFor(() => {
        expect(refreshSpy).toHaveBeenCalled();
      });
    });

    it('formatDiscoveredModelOptions with onlyAvailable=true filters out unavailable models', () => {
      const mockModels = [
        { id: 'gemini-3.8-flash-high', name: 'Gemini Flash', engine: 'agy' as const, profiles: ['p1'], verified: true, available: true },
        { id: 'gemini-old', name: 'Gemini Old', engine: 'agy' as const, profiles: [], verified: false, available: false },
      ];

      const all = formatDiscoveredModelOptions(mockModels);
      expect(all).toHaveLength(2);

      const availableOnly = formatDiscoveredModelOptions(mockModels, undefined, undefined, true);
      expect(availableOnly).toHaveLength(1);
      expect(availableOnly[0].value).toBe('gemini-3.8-flash-high');
    });

    it('SettingsPage does not propose unavailable configured models in Add Model dropdown', async () => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      vi.spyOn(client, 'getModelOptions').mockResolvedValue({
        suggestions: ['gemini-3.8-flash-high'],
        configured: ['gemini-3.8-flash-high', 'unavailable-configured-model'],
        models: [
          { id: 'gemini-3.8-flash-high', engine: 'agy', profiles: ['huynq766'], verified: true, available: true },
          { id: 'unavailable-configured-model', engine: 'agy', profiles: [], verified: false, available: false, warning: 'Không có tài khoản nào' },
        ],
      });
      vi.spyOn(client, 'getConfig').mockResolvedValue({
        modelChainHard: ['gemini-3.8-flash-high', 'unavailable-configured-model'],
        modelChainEasy: ['gemini-3.8-flash-high'],
        defaultTimeout: 10800,
        chat: { claudeBin: 'claude', allowFullMode: false, maxConcurrent: 2, model: 'sonnet', models: ['sonnet'] },
        reviewer: {
          model: 'sonnet',
          order: [],
          fallback: { onUnavailable: true, onError: true, onBusyAfterMin: 10 },
          arbiter: { engine: 'claude', model: 'sonnet' },
        },
      } as any);

      render(
        <LocaleProvider initialLocale="vi">
          <ThemeProvider>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter>
                <SettingsPage />
              </MemoryRouter>
            </QueryClientProvider>
          </ThemeProvider>
        </LocaleProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('hard-chain-list')).toBeInTheDocument();
      });

      // Existing chain item shows warning for unavailable-configured-model
      const hardChain = screen.getByTestId('hard-chain-list');
      expect(within(hardChain).getByTestId('model-unavailable-warning')).toBeInTheDocument();

      // But "Add model to chain" select should NOT include unavailable-configured-model as an option
      const addModelSelect = within(hardChain).getByRole('combobox', { name: /Thêm model vào chuỗi/i }) as HTMLSelectElement;
      expect(within(addModelSelect).queryByRole('option', { name: /unavailable-configured-model/i })).not.toBeInTheDocument();
    });

    it('does not insert hardcoded default models as new options when /api/models returns all models as unavailable', async () => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      vi.spyOn(client, 'getModelOptions').mockResolvedValue({
        suggestions: [],
        configured: ['sonnet'],
        models: [
          { id: 'sonnet', engine: 'claude', profiles: [], verified: false, available: false, warning: 'Chưa xác minh' },
          { id: 'opus', engine: 'claude', profiles: [], verified: false, available: false, warning: 'Chưa xác minh' },
          { id: 'gpt-5.6-luna', engine: 'codex', profiles: [], verified: false, available: false, warning: 'Chưa xác minh' },
        ],
      });
      vi.spyOn(client, 'getConfig').mockResolvedValue({
        modelChainHard: [],
        modelChainEasy: [],
        defaultTimeout: 10800,
        chat: { claudeBin: 'claude', allowFullMode: false, maxConcurrent: 2, model: 'sonnet', models: ['sonnet'] },
        reviewer: {
          model: 'sonnet',
          order: [],
          fallback: { onUnavailable: true, onError: true, onBusyAfterMin: 10 },
          arbiter: { engine: 'claude', model: 'sonnet' },
        },
      } as any);

      render(
        <LocaleProvider initialLocale="vi">
          <ThemeProvider>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter>
                <SettingsPage />
              </MemoryRouter>
            </QueryClientProvider>
          </ThemeProvider>
        </LocaleProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('hard-chain-list')).toBeInTheDocument();
      });

      // In chat settings, "Thêm model" dropdown should NOT offer opus or haiku from DEFAULT_CLAUDE_MODELS
      const addChatModelSelect = screen.queryByRole('combobox', { name: /Thêm model Claude/i }) as HTMLSelectElement | null;
      if (addChatModelSelect) {
        expect(within(addChatModelSelect).queryByRole('option', { name: 'opus' })).not.toBeInTheDocument();
        expect(within(addChatModelSelect).queryByRole('option', { name: 'haiku' })).not.toBeInTheDocument();
      }
    });

    it('DepartmentsPage does not propose DEFAULT_CLAUDE_MODELS or DEFAULT_CODEX_MODELS when modelOptions is empty', async () => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      vi.spyOn(client, 'getModelOptions').mockResolvedValue({
        suggestions: [],
        configured: [],
        models: [],
      });
      vi.spyOn(client, 'getDepartments').mockResolvedValue([
        {
          id: 'dept-1',
          name: 'Engineering',
          priority: 1,
          maxParallel: 2,
          claudeDailyTokenBudget: 0,
          telegramTopicId: null,
          brainEngine: 'claude',
          brainModel: 'inherit',
          brainCodexProfile: null,
          brainMode: 'auto',
          brainPermissions: 'trusted',
          brainDailyTokenBudget: 100,
          brainMaxTurnsPerHour: 2,
          profiles: [],
          projects: [],
          createdAt: '2026-01-01T00:00:00Z',
        },
      ]);
      vi.spyOn(client, 'getProfiles').mockResolvedValue([]);
      vi.spyOn(client, 'getProjects').mockResolvedValue([]);

      render(
        <LocaleProvider initialLocale="vi">
          <ThemeProvider>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter>
                <DepartmentsPage />
              </MemoryRouter>
            </QueryClientProvider>
          </ThemeProvider>
        </LocaleProvider>,
      );

      await screen.findByText('Engineering');
      fireEvent.click(screen.getByText('Cấu hình Brain'));

      const brainModelSelect = screen.getByLabelText('Model Brain') as HTMLSelectElement;
      expect(brainModelSelect).toBeInTheDocument();
      // Should not have opus or haiku from hardcoded defaults
      expect(within(brainModelSelect).queryByRole('option', { name: 'opus' })).not.toBeInTheDocument();
      expect(within(brainModelSelect).queryByRole('option', { name: 'haiku' })).not.toBeInTheDocument();
    });

    it('NewSessionModal uses discovered models from getModelOptions and excludes unverified hardcoded defaults', async () => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      vi.spyOn(client, 'getModelOptions').mockResolvedValue({
        suggestions: ['claude-3-5-sonnet'],
        configured: [],
        models: [
          { id: 'claude-3-5-sonnet', engine: 'claude', profiles: ['claude-p1'], verified: true, available: true },
        ],
      });
      vi.spyOn(client, 'getProjects').mockResolvedValue([]);
      vi.spyOn(client, 'getConfig').mockResolvedValue({
        chat: { allowFullMode: false, models: ['opus', 'sonnet', 'haiku'] },
      } as any);
      vi.spyOn(client, 'getProfiles').mockResolvedValue([]);

      render(
        <LocaleProvider initialLocale="vi">
          <ThemeProvider>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter>
                <NewSessionModal isOpen={true} onClose={vi.fn()} onSubmit={vi.fn()} />
              </MemoryRouter>
            </QueryClientProvider>
          </ThemeProvider>
        </LocaleProvider>,
      );

      await screen.findByText(/Cuộc trò chuyện mới/i);
      const modelSelect = screen.getByDisplayValue(/Mặc định của Claude Code/i);
      expect(modelSelect).toBeInTheDocument();

      // Discovered model must be present once query resolves
      await waitFor(() => {
        expect(screen.getByRole('option', { name: 'claude-3-5-sonnet' })).toBeInTheDocument();
      });

      // Hardcoded defaults opus and haiku must NOT be offered
      expect(screen.queryByRole('option', { name: 'opus' })).not.toBeInTheDocument();
      expect(screen.queryByRole('option', { name: 'haiku' })).not.toBeInTheDocument();
    });

    it('NewSessionModal allows custom model entry and displays warning for custom model', async () => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      vi.spyOn(client, 'getModelOptions').mockResolvedValue({
        suggestions: ['claude-3-5-sonnet'],
        configured: ['claude-unavailable-model'],
        models: [
          { id: 'claude-3-5-sonnet', engine: 'claude', profiles: ['claude-p1'], verified: true, available: true },
          { id: 'claude-unavailable-model', engine: 'claude', profiles: [], verified: false, available: false, warning: 'Không có tài khoản' },
        ],
      });
      vi.spyOn(client, 'getProjects').mockResolvedValue([]);
      vi.spyOn(client, 'getConfig').mockResolvedValue({
        chat: { allowFullMode: false, models: ['opus', 'sonnet', 'haiku'] },
      } as any);
      vi.spyOn(client, 'getProfiles').mockResolvedValue([]);

      const handleSubmit = vi.fn();

      render(
        <LocaleProvider initialLocale="vi">
          <ThemeProvider>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter>
                <NewSessionModal isOpen={true} onClose={vi.fn()} onSubmit={handleSubmit} />
              </MemoryRouter>
            </QueryClientProvider>
          </ThemeProvider>
        </LocaleProvider>,
      );

      await screen.findByText(/Cuộc trò chuyện mới/i);
      const modelSelect = screen.getByLabelText(/Model Claude/i) as HTMLSelectElement;
      expect(modelSelect).toBeInTheDocument();

      // Switch to custom mode
      fireEvent.change(modelSelect, { target: { value: '__custom__' } });

      const customInput = screen.getByPlaceholderText(/Mặc định của Claude Code/i);
      expect(customInput).toBeInTheDocument();

      // Enter a custom model
      fireEvent.change(customInput, { target: { value: 'my-custom-claude-model' } });

      // Custom warning is displayed
      await waitFor(() => {
        expect(screen.getByTestId('custom-warning')).toBeInTheDocument();
      });
    });

    it('SettingsPage Claude reviewer select uses SelectOrCustomInput and shows model-unavailable-warning when configured model is unavailable', async () => {
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      vi.spyOn(client, 'getModelOptions').mockResolvedValue({
        suggestions: ['claude-sonnet-4-6'],
        configured: ['old-unavailable-claude'],
        models: [
          { id: 'claude-sonnet-4-6', engine: 'claude', profiles: ['p1'], verified: true, available: true },
          { id: 'old-unavailable-claude', engine: 'claude', profiles: [], verified: false, available: false },
        ],
      });
      vi.spyOn(client, 'getConfig').mockResolvedValue({
        modelChainHard: ['gemini-3.8-flash-high'],
        modelChainEasy: ['gemini-3.8-flash-medium'],
        chat: { claudeBin: 'claude', model: 'claude-sonnet-4-6', models: ['claude-sonnet-4-6'] },
        reviewer: {
          claudeFallback: true,
          claudeModel: 'old-unavailable-claude',
          claudeProfiles: [],
        },
        brain: { fallback: [] },
      } as any);
      vi.spyOn(client, 'getProfiles').mockResolvedValue([]);
      vi.spyOn(client, 'getTelegramStatus').mockResolvedValue({ enabled: false, hasToken: false, chats: [], notify: {} } as any);
      vi.spyOn(client, 'getTelegramPairingCode').mockResolvedValue({ code: '123' } as any);

      render(
        <LocaleProvider initialLocale="vi">
          <ThemeProvider>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter>
                <SettingsPage />
              </MemoryRouter>
            </QueryClientProvider>
          </ThemeProvider>
        </LocaleProvider>,
      );

      await screen.findByTestId('reviewer-settings');
      const claudeSelect = screen.getByTestId('claude-model-select');
      expect(claudeSelect).toBeInTheDocument();

      // Warning should be displayed for old-unavailable-claude
      await waitFor(() => {
        expect(screen.getAllByTestId('model-unavailable-warning').length).toBeGreaterThan(0);
      });
    });

    it('SettingsPage isolates unavailable models in chatModel, chatModels badges, and fallback chain with warning badges', async () => {
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      vi.spyOn(client, 'getModelOptions').mockResolvedValue({
        suggestions: ['claude-sonnet-4-6'],
        configured: ['old-chat-model', 'old-fallback-model'],
        models: [
          { id: 'claude-sonnet-4-6', engine: 'claude', profiles: ['p1'], verified: true, available: true },
          { id: 'old-chat-model', engine: 'claude', profiles: [], verified: false, available: false },
          { id: 'old-fallback-model', engine: 'claude', profiles: [], verified: false, available: false },
        ],
      });
      vi.spyOn(client, 'getConfig').mockResolvedValue({
        modelChainHard: ['gemini-3.8-flash-high'],
        modelChainEasy: ['gemini-3.8-flash-medium'],
        chat: {
          claudeBin: 'claude',
          model: 'old-chat-model',
          models: ['old-chat-model', 'claude-sonnet-4-6'],
        },
        reviewer: { claudeFallback: false, claudeProfiles: [] },
        brain: {
          fallback: [{ type: 'model', model: 'old-fallback-model' }],
        },
      } as any);
      vi.spyOn(client, 'getProfiles').mockResolvedValue([]);
      vi.spyOn(client, 'getTelegramStatus').mockResolvedValue({ enabled: false, hasToken: false, chats: [], notify: {} } as any);
      vi.spyOn(client, 'getTelegramPairingCode').mockResolvedValue({ code: '123' } as any);

      render(
        <LocaleProvider initialLocale="vi">
          <ThemeProvider>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter>
                <SettingsPage />
              </MemoryRouter>
            </QueryClientProvider>
          </ThemeProvider>
        </LocaleProvider>,
      );

      await screen.findByText(/Cấu hình Chat với Claude/i);
      const warnings = await screen.findAllByTestId('model-unavailable-warning');
      expect(warnings.length).toBeGreaterThanOrEqual(3);
    });

    it('DepartmentsPage brain model uses SelectOrCustomInput and shows model-unavailable-warning when model is unavailable', async () => {
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      vi.spyOn(client, 'getModelOptions').mockResolvedValue({
        suggestions: ['sonnet'],
        configured: ['unavailable-brain-model'],
        models: [
          { id: 'sonnet', engine: 'claude', profiles: ['p1'], verified: true, available: true },
          { id: 'unavailable-brain-model', engine: 'claude', profiles: [], verified: false, available: false },
        ],
      });
      vi.spyOn(client, 'getDepartments').mockResolvedValue([
        {
          id: 'dept-1',
          name: 'Security Dept',
          priority: 1,
          maxParallel: 2,
          claudeDailyTokenBudget: 0,
          telegramTopicId: null,
          brainEngine: 'claude',
          brainModel: 'unavailable-brain-model',
          brainCodexProfile: null,
          brainMode: 'auto',
          brainPermissions: 'trusted',
          brainDailyTokenBudget: 100,
          brainMaxTurnsPerHour: 2,
          profiles: [],
          projects: [],
          createdAt: '2026-01-01T00:00:00Z',
        },
      ]);
      vi.spyOn(client, 'getProfiles').mockResolvedValue([]);
      vi.spyOn(client, 'getProjects').mockResolvedValue([]);

      render(
        <LocaleProvider initialLocale="vi">
          <ThemeProvider>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter>
                <DepartmentsPage />
              </MemoryRouter>
            </QueryClientProvider>
          </ThemeProvider>
        </LocaleProvider>,
      );

      await screen.findByText('Security Dept');
      fireEvent.click(screen.getByText('Cấu hình Brain'));

      const brainModelSelect = screen.getByLabelText('Model Brain');
      expect(brainModelSelect).toBeInTheDocument();

      const warning = await screen.findByTestId('model-unavailable-warning');
      expect(warning).toBeInTheDocument();
    });

    it('SettingsPage excludes unavailable models from reviewer options and shows model-unavailable-warning for arbiter and reviewerModel', async () => {
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      vi.spyOn(client, 'getModelOptions').mockResolvedValue({
        suggestions: ['sonnet', 'codex:gpt-5.6-luna'],
        configured: ['unavailable-codex-model', 'unavailable-arbiter-model'],
        models: [
          { id: 'sonnet', engine: 'claude', profiles: ['p1'], verified: true, available: true },
          { id: 'codex:gpt-5.6-luna', engine: 'codex', profiles: ['p2'], verified: true, available: true },
          { id: 'unavailable-codex-model', engine: 'codex', profiles: [], verified: false, available: false },
          { id: 'unavailable-arbiter-model', engine: 'claude', profiles: [], verified: false, available: false },
        ],
      });
      vi.spyOn(client, 'getConfig').mockResolvedValue({
        modelChainHard: ['gemini-3.8-flash-high'],
        modelChainEasy: ['gemini-3.8-flash-medium'],
        defaultTimeout: 10800,
        chat: { claudeBin: 'claude', allowFullMode: false, maxConcurrent: 2, model: 'sonnet', models: ['sonnet'] },
        reviewer: {
          model: 'unavailable-codex-model',
          order: [{ engine: 'codex', model: 'codex:gpt-5.6-luna', profiles: [] }],
          fallback: { onUnavailable: true, onError: true, onBusyAfterMin: 10 },
          arbiter: { engine: 'claude', model: 'unavailable-arbiter-model' },
        },
        brain: { mode: 'off', fallback: [] },
      } as any);
      vi.spyOn(client, 'getProfiles').mockResolvedValue([]);

      render(
        <LocaleProvider initialLocale="vi">
          <ThemeProvider>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter>
                <SettingsPage />
              </MemoryRouter>
            </QueryClientProvider>
          </ThemeProvider>
        </LocaleProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('hard-chain-list')).toBeInTheDocument();
      });

      // Arbiter options should not propose unavailable models with inactiveOrOld label
      const arbiterInput = screen.getByLabelText('Trọng tài Model reviewer');
      expect(arbiterInput).toBeInTheDocument();
      expect(within(arbiterInput).queryByText(/ngừng hoạt động hoặc cũ/i)).not.toBeInTheDocument();

      // Legacy reviewer model options should not propose unavailable models with inactiveOrOld label
      const reviewerModelInput = screen.getByTestId('reviewer-model-input');
      expect(reviewerModelInput).toBeInTheDocument();
      expect(within(reviewerModelInput).queryByText(/ngừng hoạt động hoặc cũ/i)).not.toBeInTheDocument();

      const warnings = await screen.findAllByTestId('model-unavailable-warning');
      expect(warnings.length).toBeGreaterThanOrEqual(2);
    });
  });
});
