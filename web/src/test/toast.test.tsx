import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act, renderHook } from '@testing-library/react';
import { ToastViewport, useToasts } from '../components/ui/Toast';

describe('Toast', () => {
  it('shows title, detail and an accessible role per kind, and closes on demand', () => {
    const onDismiss = vi.fn();
    render(
      <ToastViewport
        onDismiss={onDismiss}
        closeLabel="Đóng"
        toasts={[
          { id: 1, kind: 'success', title: 'Đã lưu', message: 'Chi tiết', duration: 6000 },
          { id: 2, kind: 'error', title: 'Lỗi', duration: 9000 },
        ]}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Đã lưuChi tiết');
    expect(screen.getByRole('alert')).toHaveTextContent('Lỗi');
    fireEvent.click(screen.getAllByRole('button', { name: 'Đóng' })[1]);
    expect(onDismiss).toHaveBeenCalledWith(2);
  });

  it('updates a loading toast in place and auto-dismisses it afterwards', () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useToasts());
      let id = 0;
      act(() => { id = result.current.push({ kind: 'loading', title: 'Đang chạy' }); });
      act(() => { vi.advanceTimersByTime(60_000); });
      expect(result.current.toasts).toHaveLength(1);

      act(() => result.current.update(id, { kind: 'success', title: 'Xong' }));
      expect(result.current.toasts).toEqual([expect.objectContaining({ id, kind: 'success', title: 'Xong' })]);
      act(() => { vi.advanceTimersByTime(6_000); });
      expect(result.current.toasts).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
