import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LocaleProvider } from '../context/LocaleContext';
import { ThemeProvider } from '../context/ThemeContext';
import { SettingsPage } from '../pages/SettingsPage';
import { ReviewQueue } from '../components/ReviewQueue';
import { TaskDetailPage } from '../pages/TaskDetailPage';
import * as client from '../api/client';
import * as sse from '../api/sse';
import { Task, TaskDetail } from '../types/api';

describe('Reviewer Fallback Web Controls & Badges (b8-claude-review-fallback)', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });

    vi.spyOn(sse, 'subscribeToRunOutput').mockImplementation(() => () => {});

    vi.spyOn(client, 'getTelegramStatus').mockResolvedValue({
      enabled: false,
      hasToken: false,
      chats: [],
      notify: { reviewReady: true, failed: true, blocked: true, quota: true, fallback: true },
    } as any);

    vi.spyOn(client, 'getTelegramPairingCode').mockResolvedValue({
      code: '123456',
      expiresInSec: 600,
    } as any);

    vi.spyOn(client, 'getProfiles').mockResolvedValue([
      { name: 'codex-main', engine: 'codex', kind: 'isolated', home: '/home/codex', email: null, enabled: 1 } as any,
      { name: 'claude-primary', engine: 'claude', kind: 'isolated', home: '/home/claude1', email: null, enabled: 1 } as any,
      { name: 'claude-backup', engine: 'claude', kind: 'isolated', home: '/home/claude2', email: null, enabled: 1 } as any,
    ]);

    vi.spyOn(client, 'getModelOptions').mockResolvedValue({
      suggestions: ['sonnet', 'opus', 'haiku'],
      configured: [],
      models: [
        { id: 'sonnet', engine: 'claude', profiles: ['claude-primary'], verified: true, available: true },
        { id: 'opus', engine: 'claude', profiles: ['claude-primary'], verified: true, available: true },
        { id: 'haiku', engine: 'claude', profiles: ['claude-primary'], verified: true, available: true },
      ],
    });
  });

  describe('1. SettingsPage Review section', () => {
    beforeEach(() => {
      vi.spyOn(client, 'getConfig').mockResolvedValue({
        modelChainHard: ['gemini-3.8-flash-high'],
        modelChainEasy: ['gemini-3.8-flash-medium'],
        defaultTimeout: 10800,
        chat: { claudeBin: 'claude', allowFullMode: false, maxConcurrent: 2, model: 'sonnet' },
        reviewer: {
          model: 'codex:gpt-5.6-luna',
          claudeFallback: true,
          claudeProfiles: ['claude-primary'],
          claudeModel: 'sonnet',
        },
        brain: { mode: 'suggest', digest: { enabled: true, time: '18:00' }, fallback: [] },
        notifications: { desktop: true },
        savings: { bucketTokens: { gemini: 5000000, claude: 5000000 }, claudeFactor: 0.9, claudeOverheadPerTask: 40000 },
      } as any);
    });

    it('renders claudeFallback toggle, claudeModel select, and claudeProfiles select', async () => {
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
        expect(screen.getByTestId('reviewer-settings')).toBeInTheDocument();
      });

      const fallbackToggle = screen.getByTestId('claude-fallback-toggle') as HTMLInputElement;
      expect(fallbackToggle).toBeInTheDocument();
      expect(fallbackToggle.checked).toBe(true);

      const modelSelect = screen.getByTestId('claude-model-select') as HTMLSelectElement;
      expect(modelSelect).toBeInTheDocument();
      expect(modelSelect.value).toBe('sonnet');

      const profilesSelect = screen.getByTestId('claude-profiles-select') as HTMLSelectElement;
      expect(profilesSelect).toBeInTheDocument();

      // Priority list shows 1. claude-primary
      expect(screen.getByTestId('claude-profile-chip-claude-primary')).toBeInTheDocument();
    });

    it('toggles claudeFallback, selects claudeModel, reorders claudeProfiles, and submits updateConfig', async () => {
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
        expect(screen.getByTestId('reviewer-settings')).toBeInTheDocument();
      });

      // 1. Change model to 'opus'
      const modelSelect = screen.getByTestId('claude-model-select');
      fireEvent.change(modelSelect, { target: { value: 'opus' } });

      // 2. Select both claude-primary and claude-backup
      const profilesSelect = screen.getByTestId('claude-profiles-select');
      const opt1 = within(profilesSelect).getByRole('option', { name: 'claude-primary' }) as HTMLOptionElement;
      const opt2 = within(profilesSelect).getByRole('option', { name: 'claude-backup' }) as HTMLOptionElement;
      opt1.selected = true;
      opt2.selected = true;
      fireEvent.change(profilesSelect);

      // Now chips exist for both
      await waitFor(() => {
        expect(screen.getByTestId('claude-profile-chip-claude-backup')).toBeInTheDocument();
      });

      // 3. Move claude-backup up
      const backupChip = screen.getByTestId('claude-profile-chip-claude-backup');
      const moveUpBtn = backupChip.querySelector('button[title="Move up"]');
      if (moveUpBtn) {
        fireEvent.click(moveUpBtn);
      }

      // 4. Toggle fallback
      const fallbackToggle = screen.getByTestId('claude-fallback-toggle');
      fireEvent.click(fallbackToggle); // now false
      fireEvent.click(fallbackToggle); // now true again

      // 5. Submit form
      const saveBtn = screen.getByText('Lưu cấu hình');
      fireEvent.click(saveBtn);

      await waitFor(() => {
        expect(updateSpy).toHaveBeenCalled();
      });

      const callArg = updateSpy.mock.calls[0][0] as any;
      expect(callArg.reviewer).toBeDefined();
      expect(callArg.reviewer.claudeModel).toBe('opus');
      expect(callArg.reviewer.claudeFallback).toBe(true);
      expect(callArg.reviewer.claudeProfiles).toContain('claude-backup');
      expect(callArg.reviewer.claudeProfiles).toContain('claude-primary');
    });
  });

  describe('2. ReviewQueue reviewer badges', () => {
    const mockTasks: Task[] = [
      {
        id: 'proj/task-codex',
        projectId: 'proj',
        slug: 'task-codex',
        title: 'Codex review task',
        level: 'easy',
        status: 'review',
        reviewer: 'codex',
        dependsOn: [],
        attempt: 1,
        resume: 0,
        createdAt: '2026-10-15',
        updatedAt: '2026-10-15',
      },
      {
        id: 'proj/task-claude',
        projectId: 'proj',
        slug: 'task-claude',
        title: 'Claude fallback review task',
        level: 'hard',
        status: 'review',
        reviewer: 'claude',
        dependsOn: [],
        attempt: 1,
        resume: 0,
        createdAt: '2026-10-15',
        updatedAt: '2026-10-15',
      },
    ];

    it('displays distinct Codex and Claude badges for tasks in review queue', () => {
      render(
        <LocaleProvider initialLocale="vi">
          <ThemeProvider>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter>
                <ReviewQueue tasks={mockTasks} />
              </MemoryRouter>
            </QueryClientProvider>
          </ThemeProvider>
        </LocaleProvider>,
      );

      const badges = screen.getAllByTestId('reviewer-badge');
      expect(badges).toHaveLength(2);
      expect(badges[0]).toHaveTextContent('Codex');
      expect(badges[1]).toHaveTextContent('Claude');
    });
  });

  describe('3. TaskDetailPage reviewer badge and timeline', () => {
    it('displays Codex reviewer badge and empty timeline message when no fallback', async () => {
      const taskCodex: TaskDetail = {
        id: 'proj/task-1',
        projectId: 'proj',
        slug: 'task-1',
        title: 'Task under normal Codex review',
        level: 'easy',
        status: 'review',
        reviewer: 'codex',
        dependsOn: [],
        attempt: 1,
        resume: 0,
        runs: [],
        reviews: [],
        events: [],
        checks: [],
        createdAt: '2026-10-15',
        updatedAt: '2026-10-15',
      };

      vi.spyOn(client, 'getTask').mockResolvedValue(taskCodex);
      vi.spyOn(client, 'getTaskLog').mockResolvedValue('');

      render(
        <LocaleProvider initialLocale="vi">
          <ThemeProvider>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter initialEntries={['/tasks/proj~task-1']}>
                <Routes>
                  <Route path="/tasks/:id" element={<TaskDetailPage />} />
                </Routes>
              </MemoryRouter>
            </QueryClientProvider>
          </ThemeProvider>
        </LocaleProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('reviewer-badge')).toBeInTheDocument();
      });

      expect(screen.getByTestId('reviewer-badge')).toHaveTextContent('Codex');
      expect(screen.getByTestId('task-timeline')).toBeInTheDocument();
      expect(screen.queryByTestId('timeline-event-review.fallback')).not.toBeInTheDocument();
    });

    it('displays Claude reviewer badge and review.fallback in timeline when fallback occurred', async () => {
      const taskClaudeFallback: TaskDetail = {
        id: 'proj/task-fb',
        projectId: 'proj',
        slug: 'task-fb',
        title: 'Task after Codex quota fallback',
        level: 'hard',
        status: 'review',
        reviewer: 'claude',
        dependsOn: [],
        attempt: 1,
        resume: 0,
        runs: [],
        reviews: [],
        events: [
          {
            id: 1,
            ts: new Date().toISOString(),
            type: 'review.fallback',
            taskId: 'proj/task-fb',
            payload: { from: 'codex', to: 'claude', profile: 'claude-primary' },
          },
        ],
        checks: [],
        createdAt: '2026-10-15',
        updatedAt: '2026-10-15',
      };

      vi.spyOn(client, 'getTask').mockResolvedValue(taskClaudeFallback);
      vi.spyOn(client, 'getTaskLog').mockResolvedValue('');

      render(
        <LocaleProvider initialLocale="vi">
          <ThemeProvider>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter initialEntries={['/tasks/proj~task-fb']}>
                <Routes>
                  <Route path="/tasks/:id" element={<TaskDetailPage />} />
                </Routes>
              </MemoryRouter>
            </QueryClientProvider>
          </ThemeProvider>
        </LocaleProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('reviewer-badge')).toBeInTheDocument();
      });

      expect(screen.getByTestId('reviewer-badge')).toHaveTextContent('Claude');

      // Timeline has review.fallback event
      expect(screen.getByTestId('task-timeline')).toBeInTheDocument();
      const fallbackEvent = screen.getByTestId('timeline-event-review.fallback');
      expect(fallbackEvent).toBeInTheDocument();
      expect(fallbackEvent).toHaveTextContent('Chuyển reviewer dự phòng');
      expect(fallbackEvent).toHaveTextContent('Codex hết quota, Claude đang duyệt (claude-primary)');
    });
  });
});
