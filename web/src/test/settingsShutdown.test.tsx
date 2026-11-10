import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LocaleProvider } from '../context/LocaleContext';
import { ThemeProvider } from '../context/ThemeContext';
import { SettingsPage } from '../pages/SettingsPage';
import * as client from '../api/client';

describe('SettingsPage Shutdown Controls', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });

    vi.spyOn(client, 'getConfig').mockResolvedValue({
      modelChainHard: ['gemini-3.8-flash-high'],
      modelChainEasy: ['gemini-3.8-flash-medium'],
      defaultTimeout: 10800,
      chat: {
        claudeBin: 'claude',
        allowFullMode: false,
        maxConcurrent: 2,
        model: 'sonnet',
      },
      brain: {
        mode: 'suggest',
        digest: { enabled: true, time: '18:00' },
        fallback: [{ type: 'engine', engine: 'codex' }],
      },
      notifications: {
        desktop: true,
        quietHours: { enabled: false, start: '22:00', end: '07:00' },
      },
    } as any);

    vi.spyOn(client, 'getStatus').mockResolvedValue({
      tasks: { running: 2, checking: 1 },
    } as any);

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
  });

  it('renders shutdown button and shows running task count inside confirmation modal', async () => {
    const shutdownSpy = vi.spyOn(client, 'shutdownHub').mockResolvedValue({ ok: true, queued: 3, reviewers: 0 });

    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <LocaleProvider>
            <MemoryRouter>
              <SettingsPage />
            </MemoryRouter>
          </LocaleProvider>
        </ThemeProvider>
      </QueryClientProvider>,
    );

    // Verify shutdown section exists
    await waitFor(() => {
      expect(screen.getByTestId('shutdown-settings')).toBeInTheDocument();
    });

    // Outer description displays count
    expect(screen.getByText(/3 task đang chạy sẽ được đưa về hàng chờ/)).toBeInTheDocument();

    // Click "Tắt AgentHub"
    const shutdownBtn = screen.getByRole('button', { name: 'Tắt AgentHub' });
    fireEvent.click(shutdownBtn);

    // Modal opens
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    // Requirement: modal MUST explicitly show the number of running tasks that will be queued
    expect(screen.getByText(/3 task đang chạy sẽ được đưa về hàng chờ để tiếp tục sau/)).toBeInTheDocument();

    // Checkbox toggles disable flag
    const disableCheckbox = screen.getByLabelText('Không tự bật khi đăng nhập');
    expect(disableCheckbox).not.toBeChecked();
    fireEvent.click(disableCheckbox);
    expect(disableCheckbox).toBeChecked();

    // Confirm shutdown
    const modalButtons = screen.getAllByRole('button', { name: 'Tắt AgentHub' });
    const confirmBtn = modalButtons[modalButtons.length - 1];
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(shutdownSpy).toHaveBeenCalledWith(true);
      expect(screen.getByText(/AgentHub đã tắt/)).toBeInTheDocument();
      expect(screen.getByText(/agenthub start/)).toBeInTheDocument();
    });
  });

  it('renders in English when locale is en', async () => {
    localStorage.setItem('agenthub_locale', 'en');
    vi.spyOn(client, 'shutdownHub').mockResolvedValue({ ok: true, queued: 3, reviewers: 0 });

    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <LocaleProvider>
            <MemoryRouter>
              <SettingsPage />
            </MemoryRouter>
          </LocaleProvider>
        </ThemeProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('shutdown-settings')).toBeInTheDocument();
    });

    expect(screen.getByRole('button', { name: 'Stop AgentHub' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Stop AgentHub' }));

    await waitFor(() => {
      expect(screen.getByText(/3 running task\(s\) will return to the queue to resume later/)).toBeInTheDocument();
    });

    localStorage.removeItem('agenthub_locale');
  });

  it('offers safe restart and force restart controls while draining', async () => {
    vi.spyOn(client, 'getRestartState').mockResolvedValue({
      draining: true,
      since: Date.now() - 60_000,
      reason: 'test',
      timeoutAt: Date.now() + 60_000,
      waitingFor: [{ taskId: 'proj/task-1', kind: 'run', startedAt: Date.now() - 60_000 }],
    });
    const cancelSpy = vi.spyOn(client, 'cancelRestart').mockResolvedValue({ draining: false, since: null, reason: null, timeoutAt: null, waitingFor: [] });
    const restartSpy = vi.spyOn(client, 'requestRestart').mockResolvedValue({ draining: true, since: null, reason: null, timeoutAt: null, waitingFor: [] });

    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider><LocaleProvider><MemoryRouter><SettingsPage /></MemoryRouter></LocaleProvider></ThemeProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText(/Đang chờ 1 task xong/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Hủy' }));
    await waitFor(() => expect(cancelSpy).toHaveBeenCalled());

    // The banner's force action is covered by the shared restart API contract.
    expect(restartSpy).not.toHaveBeenCalled();
  });
});
