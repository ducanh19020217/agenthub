import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, Loader2, X, XCircle } from 'lucide-react';

export type ToastKind = 'success' | 'error' | 'warning' | 'info' | 'loading';

export interface ToastInput {
  kind?: ToastKind;
  title: string;
  message?: string;
  /** ms; mặc định 6s, lỗi 9s, 'loading' giữ tới khi được cập nhật. */
  duration?: number;
}

export interface ToastItem extends Required<Pick<ToastInput, 'title'>> {
  id: number;
  kind: ToastKind;
  message?: string;
  duration: number;
}

const DEFAULT_DURATION: Record<ToastKind, number> = { success: 6000, info: 6000, warning: 8000, error: 9000, loading: 0 };

/** Danh sách toast của một trang: push trả id để cập nhật (vd. "đang xử lý" → "xong"). */
export function useToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((old) => old.filter((item) => item.id !== id));
  }, []);

  const schedule = useCallback((id: number, duration: number) => {
    clearTimeout(timers.current.get(id));
    if (duration > 0) timers.current.set(id, setTimeout(() => dismiss(id), duration));
  }, [dismiss]);

  const toItem = (id: number, input: ToastInput): ToastItem => {
    const kind = input.kind ?? 'success';
    return { id, kind, title: input.title, message: input.message, duration: input.duration ?? DEFAULT_DURATION[kind] };
  };

  const push = useCallback((input: ToastInput) => {
    const id = ++seq.current;
    const item = toItem(id, input);
    // Giữ tối đa 5 toast để không che màn hình.
    setToasts((old) => [...old.slice(-4), item]);
    schedule(id, item.duration);
    return id;
  }, [schedule]);

  const update = useCallback((id: number, input: ToastInput) => {
    const item = toItem(id, input);
    setToasts((old) => (old.some((t) => t.id === id) ? old.map((t) => (t.id === id ? item : t)) : [...old.slice(-4), item]));
    schedule(id, item.duration);
  }, [schedule]);

  useEffect(() => () => timers.current.forEach((timer) => clearTimeout(timer)), []);

  return { toasts, push, update, dismiss };
}

const KIND_STYLE: Record<ToastKind, { color: string; Icon: React.ComponentType<{ className?: string }> }> = {
  success: { color: 'var(--t-ok)', Icon: CheckCircle2 },
  error: { color: 'var(--t-crit)', Icon: XCircle },
  warning: { color: 'var(--t-warn)', Icon: AlertTriangle },
  info: { color: 'var(--t-accent)', Icon: Info },
  loading: { color: 'var(--t-accent)', Icon: Loader2 },
};

export function ToastViewport({ toasts, onDismiss, closeLabel = 'Close' }: {
  toasts: ToastItem[];
  onDismiss: (id: number) => void;
  closeLabel?: string;
}) {
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
    >
      {toasts.map((item) => {
        const { color, Icon } = KIND_STYLE[item.kind];
        return (
          <div
            key={item.id}
            role={item.kind === 'error' || item.kind === 'warning' ? 'alert' : 'status'}
            data-kind={item.kind}
            className="toast-enter pointer-events-auto relative overflow-hidden rounded-xl border border-[var(--t-border)] bg-[var(--t-surface)] shadow-xl"
          >
            <div className="absolute inset-y-0 left-0 w-1" style={{ background: color }} />
            <div className="flex items-start gap-3 py-3 pl-4 pr-3">
              <span
                className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
                style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}
              >
                <Icon className={`h-4 w-4 ${item.kind === 'loading' ? 'animate-spin' : ''}`} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold leading-5 text-[var(--t-text)]">{item.title}</p>
                {item.message && (
                  <p className="mt-0.5 break-words text-xs leading-5 text-[var(--t-text-3)]">{item.message}</p>
                )}
              </div>
              <button
                type="button"
                aria-label={closeLabel}
                onClick={() => onDismiss(item.id)}
                className="rounded-md p-1 text-[var(--t-text-3)] hover:bg-[var(--t-surface-2)] hover:text-[var(--t-text)]"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            {item.duration > 0 && (
              <div
                className="toast-progress absolute bottom-0 left-0 h-0.5"
                style={{ background: color, animationDuration: `${item.duration}ms` }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
