import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../api/client';

export interface UseAuthedImageResult {
  src: string | null;
  isLoading: boolean;
  error: Error | null;
}

function createBlobUrl(blob: Blob): string {
  if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
    return URL.createObjectURL(blob);
  }
  if (typeof window !== 'undefined' && typeof window.URL?.createObjectURL === 'function') {
    return window.URL.createObjectURL(blob);
  }
  return `blob:${Math.random().toString(36).slice(2)}`;
}

function revokeBlobUrl(url: string | null | undefined): void {
  if (!url || !url.startsWith('blob:')) return;
  if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
    URL.revokeObjectURL(url);
  } else if (typeof window !== 'undefined' && typeof window.URL?.revokeObjectURL === 'function') {
    window.URL.revokeObjectURL(url);
  }
}

/**
 * Tải ảnh yêu cầu header Authorization qua apiFetch, bọc qua Blob URL (URL.createObjectURL).
 * Tự động revoke URL cũ khi unmount hoặc khi url / cacheKey thay đổi.
 * Nếu tải lỗi thì trả về error và src: null để component hiển thị fallback.
 */
export function useAuthedImage(url: string | null | undefined, cacheKey?: unknown): UseAuthedImageResult {
  const [src, setSrc] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(Boolean(url));
  const [error, setError] = useState<Error | null>(null);

  const activeBlobUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!url) {
      if (activeBlobUrlRef.current) {
        revokeBlobUrl(activeBlobUrlRef.current);
        activeBlobUrlRef.current = null;
      }
      setSrc(null);
      setError(null);
      setIsLoading(false);
      return;
    }

    if (url.startsWith('data:') || url.startsWith('blob:')) {
      if (activeBlobUrlRef.current) {
        revokeBlobUrl(activeBlobUrlRef.current);
        activeBlobUrlRef.current = null;
      }
      setSrc(url);
      setError(null);
      setIsLoading(false);
      return;
    }

    if (/^https?:\/\//i.test(url) && typeof window !== 'undefined') {
      try {
        const parsed = new URL(url, window.location.href);
        if (parsed.origin !== window.location.origin) {
          if (activeBlobUrlRef.current) {
            revokeBlobUrl(activeBlobUrlRef.current);
            activeBlobUrlRef.current = null;
          }
          setSrc(url);
          setError(null);
          setIsLoading(false);
          return;
        }
      } catch {
        // Fallback sang apiFetch nếu URL không parse được
      }
    }

    let active = true;
    const controller = new AbortController();

    setIsLoading(true);
    setError(null);

    apiFetch<Blob>(url, {
      signal: controller.signal,
      responseType: 'blob',
    })
      .then((blob) => {
        if (!active) return;
        const objectUrl = createBlobUrl(blob);
        if (activeBlobUrlRef.current) {
          revokeBlobUrl(activeBlobUrlRef.current);
        }
        activeBlobUrlRef.current = objectUrl;
        setSrc(objectUrl);
        setIsLoading(false);
      })
      .catch((err) => {
        if (!active || controller.signal.aborted) return;
        if (activeBlobUrlRef.current) {
          revokeBlobUrl(activeBlobUrlRef.current);
          activeBlobUrlRef.current = null;
        }
        setSrc(null);
        setError(err instanceof Error ? err : new Error(String(err)));
        setIsLoading(false);
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [url, cacheKey]);

  useEffect(() => {
    return () => {
      if (activeBlobUrlRef.current) {
        revokeBlobUrl(activeBlobUrlRef.current);
        activeBlobUrlRef.current = null;
      }
    };
  }, []);

  return { src, isLoading, error };
}
