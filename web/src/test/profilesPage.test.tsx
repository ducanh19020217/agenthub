import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProfilesPage } from '../pages/ProfilesPage';
import { LocaleProvider } from '../context/LocaleContext';
import * as client from '../api/client';
import * as sse from '../api/sse';
import { Profile, EventItem } from '../types/api';

describe('ProfilesPage - Bật/Tắt, Nút Check và Quota Mark', () => {
  let queryClient: QueryClient;
  let sseCallback: sse.EventCallback | null = null;
  let mockProfiles: Profile[];

  const createMockProfiles = (): Profile[] => [
    {
      name: 'g1',
      engine: 'agy',
      kind: 'isolated',
      email: 'g1@example.com',
      loggedIn: true,
      enabled: 1,
      quotaMarks: [
        {
          profileName: 'g1',
          family: 'gemini-2.5-pro',
          until: Math.floor(Date.now() / 1000) + 3600,
          reason: 'Daily token quota exceeded',
        },
      ],
      usage: [
        {
          grp: 'gemini-flash',
          window: '5h',
          remainingPct: 85,
          resetAt: Math.floor(Date.now() / 1000) + 7200,
          fetchedAt: Math.floor(Date.now() / 1000),
        },
      ],
    },
    {
      name: 'g2',
      engine: 'agy',
      kind: 'isolated',
      email: 'g2@example.com',
      loggedIn: true,
      enabled: 0,
      quotaMarks: [],
    },
  ];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-23T10:00:00+07:00'));
    mockProfiles = createMockProfiles();
    window.history.replaceState({}, '', '/profiles');
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
    const prototype = HTMLElement.prototype as { scrollIntoView?: unknown };
    delete prototype.scrollIntoView;
  });

  it('scrolls to the profile named by the URL hash after profiles load', async () => {
    window.history.replaceState({}, '', '/profiles#profile-g1');
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });

    renderPage();
    await screen.findByText('g1');

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
  });

  it('does not scroll again when profile data is refreshed', async () => {
    window.history.replaceState({}, '', '/profiles#profile-g1');
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });

    renderPage();
    await screen.findByText('g1');
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    queryClient.setQueryData(['profiles'], mockProfiles.map((profile) => ({ ...profile })));
    await act(async () => {
      await Promise.resolve();
    });

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  function renderPage() {
    return render(
      <QueryClientProvider client={queryClient}>
        <LocaleProvider initialLocale="vi">
          <BrowserRouter>
            <ProfilesPage />
          </BrowserRouter>
        </LocaleProvider>
      </QueryClientProvider>,
    );
  }

  it('1. Bật/Tắt hồ sơ: click nút toggle khi profile đang bật (enabled: 1) gọi updateProfile với enabled = false', async () => {
    const updateSpy = vi.spyOn(client, 'updateProfile').mockResolvedValue({
      ...mockProfiles[0],
      enabled: 0,
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    renderPage();

    expect(await screen.findByText('g1')).toBeInTheDocument();

    const toggleG1 = screen.getByRole('button', { name: 'Bật tắt hồ sơ g1' });
    expect(toggleG1).toBeInTheDocument();
    // Đang bật -> class có bg-[var(--t-accent)]
    expect(toggleG1).toHaveClass('bg-[var(--t-accent)]');

    await act(async () => {
      fireEvent.click(toggleG1);
      await Promise.resolve();
    });

    expect(updateSpy).toHaveBeenCalledWith('g1', { enabled: false });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['profiles'] });
  });

  it('renders duplicate email names through i18n without leaving a placeholder', async () => {
    vi.mocked(client.getProfiles).mockResolvedValueOnce([
      { ...mockProfiles[0], duplicateWarning: true, duplicateEmailWith: ['g2'] },
    ]);

    renderPage();

    const duplicate = await screen.findByText('Trùng email với: g2');
    expect(duplicate).toBeInTheDocument();
    expect(duplicate).not.toHaveTextContent('{');
    expect(duplicate).toHaveAttribute('title', 'Gợi ý: Bấm đăng nhập lại bằng tài khoản Google khác!');
  });

  it('2. Bật/Tắt hồ sơ: click nút toggle khi profile đang tắt (enabled: 0) gọi updateProfile với enabled = true', async () => {
    const updateSpy = vi.spyOn(client, 'updateProfile').mockResolvedValue({
      ...mockProfiles[1],
      enabled: 1,
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    renderPage();

    expect(await screen.findByText('g2')).toBeInTheDocument();

    const toggleG2 = screen.getByRole('button', { name: 'Bật tắt hồ sơ g2' });
    expect(toggleG2).toBeInTheDocument();
    // Đang tắt -> class có bg-[var(--t-surface-2)]
    expect(toggleG2).toHaveClass('bg-[var(--t-surface-2)]');

    await act(async () => {
      fireEvent.click(toggleG2);
      await Promise.resolve();
    });

    expect(updateSpy).toHaveBeenCalledWith('g2', { enabled: true });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['profiles'] });
  });

  it('3. Nút Check: gửi request checkProfile (202), nút chuyển sang đang kiểm tra và bị disabled', async () => {
    const checkSpy = vi.spyOn(client, 'checkProfile').mockResolvedValue({ started: true });

    renderPage();

    expect(await screen.findByText('g1')).toBeInTheDocument();

    const checkButtons = screen.getAllByRole('button', { name: /^Check$/ });
    const checkG1 = checkButtons[0];

    await act(async () => {
      fireEvent.click(checkG1);
      await Promise.resolve();
    });

    expect(checkSpy).toHaveBeenCalledWith('g1');

    // Nút chuyển sang "Đang kiểm tra…" và bị disabled
    expect(screen.getByRole('button', { name: /Đang kiểm tra…/i })).toBeDisabled();
  });

  it('4. Nút Check: nhận SSE profile.check (ok: true) hiển thị toast thành công kèm durationMs và refreshProfileUsage', async () => {
    vi.spyOn(client, 'checkProfile').mockResolvedValue({ started: true });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    renderPage();

    expect(await screen.findByText('g1')).toBeInTheDocument();

    const checkButtons = screen.getAllByRole('button', { name: /^Check$/ });
    await act(async () => {
      fireEvent.click(checkButtons[0]);
      await Promise.resolve();
    });

    // Server phát sự kiện SSE profile.check thành công
    expect(sseCallback).toBeDefined();
    await act(async () => {
      const sseEvent: EventItem = {
        id: 201,
        ts: new Date().toISOString(),
        type: 'profile.check',
        payload: {
          name: 'g1',
          ok: true,
          message: 'Tài khoản hoạt động tốt',
          durationMs: 420,
        },
      };
      sseCallback!(sseEvent);
      await Promise.resolve();
    });

    // Toast hiển thị icon ✓ và thời gian thực thi
    const toast = screen.getByRole('alert');
    expect(toast).toHaveTextContent('✓');
    expect(toast).toHaveTextContent('Tài khoản hoạt động tốt (420ms)');

    // Invalidate queries và refresh usage
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['profiles'] });
    expect(client.refreshProfileUsage).toHaveBeenCalledWith('g1');
  });

  it('5. Nút Check: nhận SSE profile.check (ok: false) hiển thị toast lỗi ✗', async () => {
    vi.spyOn(client, 'checkProfile').mockResolvedValue({ started: true });

    renderPage();

    expect(await screen.findByText('g1')).toBeInTheDocument();

    const checkButtons = screen.getAllByRole('button', { name: /^Check$/ });
    await act(async () => {
      fireEvent.click(checkButtons[0]);
      await Promise.resolve();
    });

    // Server phát sự kiện SSE profile.check thất bại
    await act(async () => {
      const sseEvent: EventItem = {
        id: 202,
        ts: new Date().toISOString(),
        type: 'profile.check',
        payload: {
          name: 'g1',
          ok: false,
          message: 'Token hết hạn',
          durationMs: 150,
        },
      };
      sseCallback!(sseEvent);
      await Promise.resolve();
    });

    // Toast hiển thị icon ✗ và message lỗi
    const toast = screen.getByRole('alert');
    expect(toast).toHaveTextContent('✗');
    expect(toast).toHaveTextContent('Token hết hạn (150ms)');
  });

  it('6. Quota mark API: deleteQuota gọi đúng API DELETE /api/profiles/:name/quota?family=:family', async () => {
    const apiFetchSpy = vi.spyOn(client, 'deleteQuota').mockResolvedValue({ ok: true });

    const result = await client.deleteQuota('g1', 'gemini-2.5-pro');

    expect(result).toEqual({ ok: true });
    expect(apiFetchSpy).toHaveBeenCalledWith('g1', 'gemini-2.5-pro');
  });

  it('7. Quota mark UI: hiển thị badge khóa quota còn hiệu lực với text "Đã khóa <family> tới HH:MM", countdown timer, tooltip lý do và nút Gỡ', async () => {
    renderPage();

    expect(await screen.findByText('g1')).toBeInTheDocument();
    expect(screen.getByText('g2')).toBeInTheDocument();

    // Hồ sơ g1 có quotaMarks còn hiệu lực
    const badge = screen.getByTestId('quota-mark-gemini-2.5-pro');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAttribute('title', 'Daily token quota exceeded');
    expect(badge).toHaveTextContent(/Đã khóa gemini-2.5-pro tới (?:còn \d+ phút|còn 1 giờ) · \d{2}:\d{2} (?:hôm nay|ngày mai)/);

    // Có CountdownTimer đếm ngược
    const countdown = screen.getByTestId('countdown-timer');
    expect(countdown).toBeInTheDocument();

    // Có nút Gỡ
    const removeBtn = screen.getByRole('button', { name: /^Gỡ$/ });
    expect(removeBtn).toBeInTheDocument();
  });

  it('7b. Quota mark UI: hiển thị badge đúng định dạng "ngày mai" khi mốc hết hạn rơi sang ngày hôm sau', async () => {
    vi.setSystemTime(new Date('2026-10-23T23:50:00+07:00'));
    const nextDayProfiles: Profile[] = [
      {
        name: 'g1',
        engine: 'agy',
        kind: 'isolated',
        email: 'g1@example.com',
        loggedIn: true,
        enabled: 1,
        quotaMarks: [
          {
            profileName: 'g1',
            family: 'gemini-2.5-pro',
            until: Math.floor(Date.now() / 1000) + 3600, // 00:50 ngày mai
            reason: 'Daily token quota exceeded',
          },
        ],
      },
    ];
    vi.spyOn(client, 'getProfiles').mockResolvedValue(nextDayProfiles);

    renderPage();

    expect(await screen.findByText('g1')).toBeInTheDocument();
    const badge = screen.getByTestId('quota-mark-gemini-2.5-pro');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent(/Đã khóa gemini-2.5-pro tới (?:còn 59 phút|còn 1 giờ) · 00:50 ngày mai/);
  });

  it('8. Quota mark UI: bấm nút Gỡ nhưng hủy xác nhận (confirm = false) thì không gọi deleteQuota', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const deleteSpy = vi.spyOn(client, 'deleteQuota');

    renderPage();

    expect(await screen.findByText('g1')).toBeInTheDocument();

    const removeBtn = screen.getByRole('button', { name: /^Gỡ$/ });
    await act(async () => {
      fireEvent.click(removeBtn);
      await Promise.resolve();
    });

    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('gemini-2.5-pro'));
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it('9. Quota mark UI: bấm nút Gỡ, xác nhận (confirm = true) thì gọi deleteQuota với đúng tham số family và tải lại danh sách hồ sơ', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const deleteSpy = vi.spyOn(client, 'deleteQuota').mockResolvedValue({ ok: true });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    renderPage();

    expect(await screen.findByText('g1')).toBeInTheDocument();

    const removeBtn = screen.getByRole('button', { name: /^Gỡ$/ });
    await act(async () => {
      fireEvent.click(removeBtn);
      await Promise.resolve();
    });

    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('gemini-2.5-pro'));
    expect(deleteSpy).toHaveBeenCalledWith('g1', 'gemini-2.5-pro');
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['profiles'] });

    // Hiển thị toast thông báo thành công
    const toast = screen.getByRole('alert');
    expect(toast).toHaveTextContent(/Đã gỡ khóa quota/i);
  });

  it('9b. Nút Làm mới hiển thị thông báo kèm kết quả lấy ảnh đại diện', async () => {
    vi.mocked(client.refreshProfileUsage).mockResolvedValue({ ...mockProfiles[0], avatarMessage: 'Đã cập nhật ảnh đại diện' });
    renderPage();
    expect(await screen.findByText('g1')).toBeInTheDocument();

    const card = screen.getByTestId('profile-card-g1');
    const refreshBtn = Array.from(card.querySelectorAll('button')).find((b) => /Làm mới/.test(b.textContent || ''))!;
    await act(async () => {
      fireEvent.click(refreshBtn);
    });

    expect(client.refreshProfileUsage).toHaveBeenCalledWith('g1');
    expect(await screen.findByRole('alert')).toHaveTextContent(/Đã làm mới g1 · Đã cập nhật ảnh đại diện/);
  });

  it('9c. Dùng token: nhập xong thì thẻ tự chuyển sang đang kiểm tra, không cần bấm Check', async () => {
    const importSpy = vi.spyOn(client, 'importAgyTokens').mockResolvedValue({
      success: true, total: 1, successCount: 1, failedCount: 0,
      results: [{ name: 'g1', email: 'g1@example.com', action: 'updated', status: 'ok', message: 'ok' }],
    });
    const checkSpy = vi.spyOn(client, 'checkProfile').mockResolvedValue({ started: true });
    renderPage();
    expect(await screen.findByText('g1')).toBeInTheDocument();

    const card = screen.getByTestId('profile-card-g1');
    fireEvent.click(Array.from(card.querySelectorAll('button')).find((b) => /Dùng token/.test(b.textContent || ''))!);
    fireEvent.change(screen.getByPlaceholderText('1//...'), { target: { value: '1//rt' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Đăng nhập' }));
    });

    expect(importSpy).toHaveBeenCalledWith({
      tokens: [{ name: 'g1', email: 'g1@example.com', refresh_token: '1//rt' }],
      accountType: undefined,
    });
    expect(await screen.findByText(/Đang kiểm tra/)).toBeInTheDocument();
    expect(checkSpy).not.toHaveBeenCalled();
  });

  it('10. Quota mark UI: không hiển thị quota mark đã hết hạn (until trong quá khứ)', async () => {
    const profilesWithExpired: Profile[] = [
      {
        name: 'g_expired',
        engine: 'agy',
        kind: 'isolated',
        email: 'expired@example.com',
        loggedIn: true,
        enabled: 1,
        quotaMarks: [
          {
            profileName: 'g_expired',
            family: 'claude-3-7-sonnet',
            until: Math.floor(Date.now() / 1000) - 3600, // Đã hết hạn 1 tiếng trước
            reason: 'Old quota mark',
          },
        ],
      },
    ];
    vi.spyOn(client, 'getProfiles').mockResolvedValue(profilesWithExpired);

    renderPage();

    expect(await screen.findByText('g_expired')).toBeInTheDocument();
    expect(screen.queryByTestId('quota-mark-claude-3-7-sonnet')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Gỡ$/ })).not.toBeInTheDocument();
  });

  it('11. Quota mark UI: hiển thị badge và nút xóa đúng trong ngôn ngữ tiếng Anh (en)', async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <LocaleProvider initialLocale="en">
          <BrowserRouter>
            <ProfilesPage />
          </BrowserRouter>
        </LocaleProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByText('g1')).toBeInTheDocument();

    const badge = screen.getByTestId('quota-mark-gemini-2.5-pro');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent(/Locked gemini-2.5-pro until (?:in \d+ minutes|in 1 hour) · \d{2}:\d{2} (?:today|tomorrow)/);

    const removeBtn = screen.getByRole('button', { name: /^Remove$/ });
    expect(removeBtn).toBeInTheDocument();
  });

  it('11b. Quota mark UI: hiển thị badge đúng định dạng "tomorrow" khi mốc hết hạn rơi sang ngày hôm sau trong tiếng Anh (en)', async () => {
    vi.setSystemTime(new Date('2026-10-23T23:50:00+07:00'));
    const nextDayProfiles: Profile[] = [
      {
        name: 'g1',
        engine: 'agy',
        kind: 'isolated',
        email: 'g1@example.com',
        loggedIn: true,
        enabled: 1,
        quotaMarks: [
          {
            profileName: 'g1',
            family: 'gemini-2.5-pro',
            until: Math.floor(Date.now() / 1000) + 3600, // 00:50 tomorrow
            reason: 'Daily token quota exceeded',
          },
        ],
      },
    ];
    vi.spyOn(client, 'getProfiles').mockResolvedValue(nextDayProfiles);

    render(
      <QueryClientProvider client={queryClient}>
        <LocaleProvider initialLocale="en">
          <BrowserRouter>
            <ProfilesPage />
          </BrowserRouter>
        </LocaleProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByText('g1')).toBeInTheDocument();
    const badge = screen.getByTestId('quota-mark-gemini-2.5-pro');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent(/Locked gemini-2.5-pro until (?:in 59 minutes|in 1 hour) · 00:50 tomorrow/);
  });

  it('12. Claude card: displays limited sessions with auto-resume toggle and detail link', async () => {
    const claudeProfile: Profile = {
      name: 'claude-may',
      engine: 'claude',
      kind: 'system',
      email: 'user@example.com',
      loggedIn: true,
      enabled: 1,
      quotaMarks: [],
      limitedSessions: [
        {
          sessionId: 'sess-abc-12345',
          title: 'Implement feature X',
          cwd: '/projects/repo-a',
          limitResetAt: Math.floor(Date.now() / 1000) + 1800,
          autoResumeEnabled: true,
        },
      ],
    };
    vi.spyOn(client, 'getProfiles').mockResolvedValue([claudeProfile]);
    const apiFetchSpy = vi.spyOn(client, 'apiFetch').mockResolvedValue({} as any);

    renderPage();

    expect(await screen.findByText('claude-may')).toBeInTheDocument();
    expect(screen.getAllByText('Phiên đang chờ reset').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Implement feature X')).toBeInTheDocument();
    expect(screen.getByText('/projects/repo-a')).toBeInTheDocument();

    const detailLink = screen.getByText('Xem chi tiết →');
    expect(detailLink).toBeInTheDocument();
    expect(detailLink.closest('a')).toHaveAttribute('href', '/claude-sessions/sess-abc-12345');

    const toggle = screen.getByRole('checkbox', { name: /Tự tiếp tục khi hết giới hạn/ });
    expect(toggle).toBeChecked();

    fireEvent.click(toggle);
    expect(apiFetchSpy).toHaveBeenCalledWith(
      '/api/claude/sessions/sess-abc-12345/auto-resume',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ enabled: false }),
      }),
    );
  });

  it('13. Claude card: hides limited sessions section when there are no limited sessions', async () => {
    const claudeProfile: Profile = {
      name: 'claude-may',
      engine: 'claude',
      kind: 'system',
      email: 'user@example.com',
      loggedIn: true,
      enabled: 1,
      quotaMarks: [],
      limitedSessions: [],
    };
    vi.spyOn(client, 'getProfiles').mockResolvedValue([claudeProfile]);

    renderPage();

    expect(await screen.findByText('claude-may')).toBeInTheDocument();
    expect(screen.queryByTestId('claude-limited-section-claude-may')).not.toBeInTheDocument();
    expect(screen.queryByText('Phiên đang chờ reset')).not.toBeInTheDocument();
  });

  it('13b. Claude card: dismiss and clean buttons invoke APIs correctly', async () => {
    const claudeProfile: Profile = {
      name: 'claude-may',
      engine: 'claude',
      kind: 'system',
      email: 'user@example.com',
      loggedIn: true,
      enabled: 1,
      quotaMarks: [],
      limitedSessions: [
        {
          sessionId: 'sess-fut',
          title: 'Future Session',
          cwd: '/projects/repo-a',
          limitResetAt: Math.floor(Date.now() / 1000) + 1800,
          autoResumeEnabled: true,
        },
        {
          sessionId: 'sess-past',
          title: 'Past Session',
          cwd: '/projects/repo-b',
          limitResetAt: Math.floor(Date.now() / 1000) - 1800,
          autoResumeEnabled: true,
        },
      ],
    };
    vi.spyOn(client, 'getProfiles').mockResolvedValue([claudeProfile]);
    const apiFetchSpy = vi.spyOn(client, 'apiFetch').mockResolvedValue({} as any);

    renderPage();

    expect(await screen.findByText('claude-may')).toBeInTheDocument();
    expect(screen.getByText('Chờ tự tiếp tục')).toBeInTheDocument();

    const dismissBtn = screen.getByTestId('dismiss-limit-sess-fut');
    fireEvent.click(dismissBtn);
    expect(apiFetchSpy).toHaveBeenCalledWith(
      '/api/claude/sessions/sess-fut/dismiss-limit',
      expect.objectContaining({ method: 'POST' }),
    );

    const cleanBtn = screen.getByTestId('clean-reset-sessions-claude-may');
    fireEvent.click(cleanBtn);
    expect(apiFetchSpy).toHaveBeenCalledWith(
      '/api/claude/sessions/clean-reset',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('14. displays error message and retry button when profiles fail to load', async () => {
    const getProfilesSpy = vi.spyOn(client, 'getProfiles').mockRejectedValueOnce(new Error('Network error'));
    renderPage();

    expect(await screen.findByText('Không thể tải danh sách tài khoản.')).toBeInTheDocument();
    const retryButtons = screen.getAllByRole('button', { name: 'Thử lại' });
    expect(retryButtons.length).toBeGreaterThanOrEqual(1);

    getProfilesSpy.mockResolvedValueOnce(mockProfiles);
    await act(async () => {
      fireEvent.click(retryButtons[0]);
    });

    expect(await screen.findByText('g1')).toBeInTheDocument();
  });
});
