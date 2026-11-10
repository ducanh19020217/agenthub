import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LocaleProvider } from '../context/LocaleContext';
import { RestartBanner } from '../components/Layout';
import * as client from '../api/client';

describe('RestartBanner', () => {
  beforeEach(() => {
    vi.spyOn(client, 'getStatus').mockResolvedValue({ restart: { draining: true, waitingFor: [{ taskId: 'p/t', kind: 'run', startedAt: Date.now() }] } } as any);
  });

  it('cancels a drain or confirms an immediate restart', async () => {
    const cancel = vi.spyOn(client, 'cancelRestart').mockResolvedValue({ draining: false, since: null, reason: null, timeoutAt: null, waitingFor: [] });
    const restart = vi.spyOn(client, 'requestRestart').mockResolvedValue({ draining: false, since: null, reason: null, timeoutAt: null, waitingFor: [] });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={queryClient}><LocaleProvider><RestartBanner /></LocaleProvider></QueryClientProvider>);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Đang chờ 1 task xong'));
    fireEvent.click(screen.getByRole('button', { name: 'Khởi động lại ngay' }));
    await waitFor(() => expect(restart).toHaveBeenCalledWith('now'));
    fireEvent.click(screen.getByRole('button', { name: 'Hủy' }));
    await waitFor(() => expect(cancel).toHaveBeenCalled());
  });
});
