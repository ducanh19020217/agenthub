import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LocaleProvider } from '../context/LocaleContext';
import { ThemeProvider } from '../context/ThemeContext';
import { SettingsPage } from '../pages/SettingsPage';
import * as client from '../api/client';

describe('SettingsPage Notifications & Digest (b-brain-notify)', () => {
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
      savings: {
        bucketTokens: { gemini: 5000000, claude: 5000000 },
        claudeFactor: 0.9,
        claudeOverheadPerTask: 40000,
      },
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

  it('renders notifications section with quiet hours and digest options in Vietnamese', async () => {
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
      expect(screen.getByTestId('notifications-settings')).toBeInTheDocument();
    });

    expect(screen.getByText('Thông báo & Tóm tắt')).toBeInTheDocument();
    expect(screen.getByText('Thông báo trên máy tính (Desktop Notifications)')).toBeInTheDocument();
    expect(screen.getByText('Chế độ hoạt động của Bộ não')).toBeInTheDocument();
    expect(screen.getByText('Giờ yên tĩnh (Quiet Hours)')).toBeInTheDocument();
    expect(screen.getByText('Tóm tắt định kỳ (Daily Digest)')).toBeInTheDocument();

    // Radio options for brain mode
    expect(screen.getByLabelText('Tắt (Off)')).toBeInTheDocument();
    expect(screen.getByLabelText('Gợi ý (Suggest)')).toBeInTheDocument();
    expect(screen.getByLabelText('Tự động (Auto)')).toBeInTheDocument();
  });

  it('toggles quiet hours inputs when enabled', async () => {
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
      expect(screen.getByTestId('notifications-settings')).toBeInTheDocument();
    });

    // Quiet hours is disabled initially
    expect(screen.queryByText('Giờ bắt đầu')).not.toBeInTheDocument();

    // Find quiet hours checkbox and check it
    const quietHoursCheckbox = screen.getByTestId('quiet-hours-toggle');
    fireEvent.click(quietHoursCheckbox);

    expect(screen.getByText('Giờ bắt đầu')).toBeInTheDocument();
    expect(screen.getByText('Giờ kết thúc')).toBeInTheDocument();
  });

  it('submits updated notifications and brain settings to API', async () => {
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
      expect(screen.getByTestId('notifications-settings')).toBeInTheDocument();
    });

    // Switch brain mode to 'auto'
    const autoRadio = screen.getByLabelText('Tự động (Auto)');
    fireEvent.click(autoRadio);

    // Save configuration
    const saveButton = screen.getByText('Lưu cấu hình');
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalled();
      expect(screen.getByRole('status')).toHaveTextContent('Cài đặt hệ thống đã được cập nhật thành công!');
    });

    const callPayload = updateSpy.mock.calls[0][0];
    expect(callPayload.brain?.mode).toBe('auto');
    expect(callPayload.brain?.digest).toBeDefined();
    expect(callPayload.notifications).toBeDefined();
    expect(callPayload.notifications?.desktop).toBe(true);
  });

  it('shows a translated error and never reports success when saving fails', async () => {
    vi.spyOn(client, 'updateConfig').mockRejectedValue(new Error('Không thể lưu cài đặt'));

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

    await waitFor(() => expect(screen.getByTestId('notifications-settings')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Lưu cấu hình'));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Không thể lưu cài đặt');
    });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('updates desktop notification level and quiet hours in settings form and saves correctly', async () => {
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
      expect(screen.getByTestId('notifications-settings')).toBeInTheDocument();
    });

    // Change desktop notification level to critical
    const levelSelect = screen.getByTestId('desktop-notify-level');
    fireEvent.change(levelSelect, { target: { value: 'critical' } });

    // Enable quiet hours
    const quietHoursToggle = screen.getByTestId('quiet-hours-toggle');
    fireEvent.click(quietHoursToggle);

    // Set custom quiet hours
    const startInput = screen.getByTestId('quiet-hours-start');
    fireEvent.change(startInput, { target: { value: '23:00' } });

    const endInput = screen.getByTestId('quiet-hours-end');
    fireEvent.change(endInput, { target: { value: '06:30' } });

    // Save
    const saveButton = screen.getByText('Lưu cấu hình');
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalled();
    });

    const callPayload = updateSpy.mock.calls[0][0];
    expect(callPayload.notifications?.desktopLevel).toBe('critical');
    expect(callPayload.notifications?.quietHours).toEqual({
      enabled: true,
      start: '23:00',
      end: '06:30',
    });
  });
});
