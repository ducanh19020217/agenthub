import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProfilesPage } from '../pages/ProfilesPage';
import * as client from '../api/client';
import * as sse from '../api/sse';
import { Profile, EventItem } from '../types/api';

describe('ProfilesPage - Nút Check, SSE profile.check, 409 và timeout', () => {
  let queryClient: QueryClient;
  let sseCallback: sse.EventCallback | null = null;

  const mockProfiles: Profile[] = [
    {
      name: 'g1',
      engine: 'agy',
      kind: 'isolated',
      email: 'g1@example.com',
      loggedIn: true,
      enabled: 1,
    },
  ];

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });

    sseCallback = null;
    vi.spyOn(sse, 'subscribeToEvents').mockImplementation((cb) => {
      sseCallback = cb;
      return () => {
        sseCallback = null;
      };
    });

    vi.spyOn(client, 'getProfiles').mockResolvedValue(mockProfiles);
    vi.spyOn(client, 'refreshProfileUsage').mockResolvedValue({} as any);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('1. Bấm Check (202), nút chuyển sang "Đang kiểm tra…", nhận SSE profile.check rồi hiện toast thành công', async () => {
    const checkSpy = vi.spyOn(client, 'checkProfile').mockResolvedValue({ started: true });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    render(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <ProfilesPage />
        </BrowserRouter>
      </QueryClientProvider>,
    );

    const checkBtn = await screen.findByRole('button', { name: /^Check$/ });
    expect(checkBtn).toBeEnabled();

    // Click Check
    await act(async () => {
      fireEvent.click(checkBtn);
      await Promise.resolve();
    });

    expect(checkSpy).toHaveBeenCalledWith('g1');

    // Nút chuyển sang trạng thái "Đang kiểm tra…" kèm spinner và bị vô hiệu hóa
    expect(screen.getByText(/Đang kiểm tra…/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Đang kiểm tra…/i })).toBeDisabled();

    // Server phát sự kiện SSE profile.check
    expect(sseCallback).toBeDefined();
    await act(async () => {
      const sseEvent: EventItem = {
        id: 101,
        ts: new Date().toISOString(),
        type: 'profile.check',
        payload: {
          name: 'g1',
          ok: true,
          message: 'Kết nối Antigravity thành công',
          durationMs: 350,
        },
      };
      sseCallback!(sseEvent);
      await Promise.resolve();
    });

    // Toast hiển thị ✓ kèm message và thời gian chạy
    const toast = document.querySelector('[data-kind="success"]')!;
    expect(toast).toBeInTheDocument();
    expect(toast).toHaveTextContent('Kết nối Antigravity thành công');
    expect(toast).toHaveTextContent('350ms');

    // Nút Check quay lại bình thường
    expect(screen.getByRole('button', { name: /^Check$/ })).toBeEnabled();

    // Tải lại danh sách hồ sơ và usage
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['profiles'] });
    expect(client.refreshProfileUsage).toHaveBeenCalledWith('g1');
  });

  it('2. Nhận SSE profile.check với ok: false hiển thị toast ✗ kèm message và thời gian chạy', async () => {
    vi.spyOn(client, 'checkProfile').mockResolvedValue({ started: true });

    render(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <ProfilesPage />
        </BrowserRouter>
      </QueryClientProvider>,
    );

    const checkBtn = await screen.findByRole('button', { name: /^Check$/ });

    await act(async () => {
      fireEvent.click(checkBtn);
      await Promise.resolve();
    });

    // Phát sự kiện SSE thất bại
    await act(async () => {
      sseCallback!({
        id: 102,
        ts: new Date().toISOString(),
        type: 'profile.check',
        payload: {
          name: 'g1',
          ok: false,
          message: 'Không thể kết nối đến CLI',
          durationMs: 500,
        },
      });
      await Promise.resolve();
    });

    const alert = screen.getByRole('alert');
    expect(alert).toHaveAttribute('data-kind', 'error');
    expect(alert).toHaveTextContent('Không thể kết nối đến CLI');
    expect(alert).toHaveTextContent('500ms');

    expect(screen.getByRole('button', { name: /^Check$/ })).toBeEnabled();
  });

  it('3. Gặp 409 thì báo "đang kiểm tra"', async () => {
    const conflictError: any = new Error('Lỗi 409: Profile check already in progress');
    conflictError.status = 409;
    vi.spyOn(client, 'checkProfile').mockRejectedValue(conflictError);

    render(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <ProfilesPage />
        </BrowserRouter>
      </QueryClientProvider>,
    );

    const checkBtn = await screen.findByRole('button', { name: /^Check$/ });

    await act(async () => {
      fireEvent.click(checkBtn);
      await Promise.resolve();
    });

    // Báo "đang kiểm tra"
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/đang kiểm tra/i);
  });

  it('4. Nếu sau 75 giây vẫn chưa có kết quả thì báo "quá thời gian"', async () => {
    vi.spyOn(client, 'checkProfile').mockResolvedValue({ started: true });

    render(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <ProfilesPage />
        </BrowserRouter>
      </QueryClientProvider>,
    );

    const checkBtn = await screen.findByRole('button', { name: /^Check$/ });

    // Enable fake timers only after component has mounted and initial data is rendered
    vi.useFakeTimers();

    await act(async () => {
      fireEvent.click(checkBtn);
      await Promise.resolve();
    });

    expect(screen.getByRole('button', { name: /Đang kiểm tra…/i })).toBeDisabled();

    // Tua nhanh 75 giây
    await act(async () => {
      vi.advanceTimersByTime(75000);
      await Promise.resolve();
    });

    // Hiển thị báo quá thời gian
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/quá thời gian/i);

    // Nút quay lại trạng thái Check
    expect(screen.getByRole('button', { name: /^Check$/ })).toBeEnabled();
  });
});
