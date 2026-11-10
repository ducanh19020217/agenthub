import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearToken, setToken } from '../api/client';
import { useAuthedImage } from '../hooks/useAuthedImage';

describe('useAuthedImage hook', () => {
  const originalFetch = window.fetch;
  let createObjectURLSpy: any;
  let revokeObjectURLSpy: any;
  let objectUrlCounter = 0;

  beforeEach(() => {
    sessionStorage.clear();
    setToken('test_token_image');
    objectUrlCounter = 0;

    createObjectURLSpy = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
      objectUrlCounter += 1;
      return `blob:http://localhost/mock-uuid-${objectUrlCounter}`;
    });
    revokeObjectURLSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  });

  afterEach(() => {
    window.fetch = originalFetch;
    createObjectURLSpy?.mockRestore();
    revokeObjectURLSpy?.mockRestore();
    clearToken();
    vi.restoreAllMocks();
  });

  it('trả về null và không fetch khi url rỗng', () => {
    const { result } = renderHook(() => useAuthedImage(null));
    expect(result.current.src).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(createObjectURLSpy).not.toHaveBeenCalled();
  });

  it('tải ảnh qua fetch có header Authorization, tạo blob URL', async () => {
    let capturedHeaders: Headers | undefined;
    window.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response(new Blob(['<svg></svg>'], { type: 'image/svg+xml' }), {
        status: 200,
        headers: { 'Content-Type': 'image/svg+xml' },
      });
    });

    const { result } = renderHook(() => useAuthedImage('/api/branding/logo?v=1', 1));

    await waitFor(() => {
      expect(result.current.src).toBe('blob:http://localhost/mock-uuid-1');
    });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(capturedHeaders?.get('Authorization')).toBe('Bearer test_token_image');
    expect(createObjectURLSpy).toHaveBeenCalledTimes(1);
  });

  it('thu hồi URL cũ khi key thay đổi và tạo URL mới', async () => {
    window.fetch = vi.fn().mockImplementation(async () => {
      return new Response(new Blob(['img-bytes'], { type: 'image/png' }), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      });
    });

    const { result, rerender } = renderHook(
      ({ ver }) => useAuthedImage(`/api/branding/logo?v=${ver}`, ver),
      { initialProps: { ver: 1 } },
    );

    await waitFor(() => {
      expect(result.current.src).toBe('blob:http://localhost/mock-uuid-1');
    });

    // Cập nhật version (key mới)
    rerender({ ver: 2 });

    await waitFor(() => {
      expect(result.current.src).toBe('blob:http://localhost/mock-uuid-2');
    });

    // Đã revoke blob URL 1
    expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:http://localhost/mock-uuid-1');
  });

  it('thu hồi URL khi component unmount', async () => {
    window.fetch = vi.fn().mockImplementation(async () => {
      return new Response(new Blob(['img-bytes'], { type: 'image/png' }), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      });
    });

    const { result, unmount } = renderHook(() => useAuthedImage('/api/branding/logo?v=1', 1));

    await waitFor(() => {
      expect(result.current.src).toBe('blob:http://localhost/mock-uuid-1');
    });

    unmount();
    expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:http://localhost/mock-uuid-1');
  });

  it('xử lý lỗi tải ảnh: trả về error và src: null', async () => {
    window.fetch = vi.fn().mockImplementation(async () => {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const { result } = renderHook(() => useAuthedImage('/api/branding/logo?v=1', 1));

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });

    expect(result.current.src).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it('giữ nguyên data URI hoặc blob URL có sẵn mà không fetch', () => {
    const fetchSpy = vi.fn();
    window.fetch = fetchSpy;

    const dataUri = 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=';
    const { result } = renderHook(() => useAuthedImage(dataUri));

    expect(result.current.src).toBe(dataUri);
    expect(result.current.isLoading).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
