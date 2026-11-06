import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { VersionBanner } from '../components/VersionBanner';
import { setToken, clearToken } from '../api/client';

describe('VersionBanner - Dashboard update notification', () => {
  const originalFetch = window.fetch;
  const originalLocation = window.location;

  beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.clear();
    setToken('test_token_version_123');

    // Mock window.location.reload
    delete (window as any).location;
    window.location = { ...originalLocation, reload: vi.fn() } as any;
  });

  afterEach(() => {
    vi.useRealTimers();
    window.fetch = originalFetch;
    window.location = originalLocation as any;
    clearToken();
    vi.restoreAllMocks();
  });

  it('không hiển thị banner khi khởi tạo và buildId không đổi', async () => {
    window.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ version: '0.1.0', webBuildId: 'build-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    render(<VersionBanner />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByText(/Có phiên bản dashboard mới/i)).not.toBeInTheDocument();

    // Advance 60s timer
    await act(async () => {
      vi.advanceTimersByTime(60000);
      await Promise.resolve();
    });

    expect(screen.queryByText(/Có phiên bản dashboard mới/i)).not.toBeInTheDocument();
  });

  it('bỏ qua 404 từ server cũ mà không báo lỗi', async () => {
    window.fetch = vi.fn().mockResolvedValue(
      new Response('Not Found', {
        status: 404,
        headers: { 'Content-Type': 'text/plain' },
      }),
    );

    render(<VersionBanner />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByText(/Có phiên bản dashboard mới/i)).not.toBeInTheDocument();

    // Advance timer
    await act(async () => {
      vi.advanceTimersByTime(60000);
      await Promise.resolve();
    });

    expect(screen.queryByText(/Có phiên bản dashboard mới/i)).not.toBeInTheDocument();
  });

  it('hiển thị thanh thông báo và nút Tải lại khi webBuildId thay đổi sau 60 giây', async () => {
    let currentBuildId = 'build-v1';

    window.fetch = vi.fn().mockImplementation(async () => {
      return new Response(JSON.stringify({ version: '0.1.0', webBuildId: currentBuildId }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    render(<VersionBanner />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByText(/Có phiên bản dashboard mới/i)).not.toBeInTheDocument();

    // Simulate backend updated with new build
    currentBuildId = 'build-v2';

    await act(async () => {
      vi.advanceTimersByTime(60000);
      await Promise.resolve();
    });

    expect(screen.getByText(/Có phiên bản dashboard mới/i)).toBeInTheDocument();
    const reloadBtn = screen.getByRole('button', { name: /Tải lại/i });
    expect(reloadBtn).toBeInTheDocument();

    fireEvent.click(reloadBtn);
    expect(window.location.reload).toHaveBeenCalledTimes(1);
  });

  it('gọi kiểm tra phiên bản mới khi tab được focus lại', async () => {
    let currentBuildId = 'build-v1';

    window.fetch = vi.fn().mockImplementation(async () => {
      return new Response(JSON.stringify({ version: '0.1.0', webBuildId: currentBuildId }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    render(<VersionBanner />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByText(/Có phiên bản dashboard mới/i)).not.toBeInTheDocument();

    // Simulate new version deployed and user focuses tab
    currentBuildId = 'build-v3';

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });

    expect(screen.getByText(/Có phiên bản dashboard mới/i)).toBeInTheDocument();
  });

  it('người dùng có thể đóng thông báo khi nhấn nút X', async () => {
    let currentBuildId = 'build-v1';

    window.fetch = vi.fn().mockImplementation(async () => {
      return new Response(JSON.stringify({ version: '0.1.0', webBuildId: currentBuildId }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    render(<VersionBanner />);

    await act(async () => {
      await Promise.resolve();
    });

    currentBuildId = 'build-v2';

    await act(async () => {
      vi.advanceTimersByTime(60000);
      await Promise.resolve();
    });

    expect(screen.getByText(/Có phiên bản dashboard mới/i)).toBeInTheDocument();

    const closeBtn = screen.getByRole('button', { name: /Đóng/i });
    expect(closeBtn).toBeInTheDocument();

    fireEvent.click(closeBtn);
    expect(screen.queryByText(/Có phiên bản dashboard mới/i)).not.toBeInTheDocument();
  });
});
