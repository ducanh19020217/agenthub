import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { SecretRequestCard } from '../components/chat/SecretRequestCard';
import { LocaleProvider } from '../context/LocaleContext';
import * as client from '../api/client';
import * as sse from '../api/sse';

describe('SecretRequestCard', () => {
  let emit: ((event: any) => void) | undefined;
  beforeEach(() => { vi.spyOn(sse, 'subscribeToEvents').mockImplementation((cb) => { emit = cb; return () => {}; }); vi.spyOn(client, 'apiFetch').mockResolvedValue({ configured: true }); });
  afterEach(() => vi.restoreAllMocks());

  it('shows a secret request from SSE and submits without rendering the value', async () => {
    render(<LocaleProvider><SecretRequestCard /></LocaleProvider>);
    act(() => emit?.({ type: 'secret.requested', payload: { requestId: 'req-1', label: 'OpenProject key' } } as any));
    expect(await screen.findByText('OpenProject key')).toBeInTheDocument();
    const input = screen.getByLabelText(/secret|bí mật/i);
    fireEvent.change(input, { target: { value: 'never-render-this' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(client.apiFetch).toHaveBeenCalledWith('/api/secrets/requests/req-1/value', expect.objectContaining({ method: 'POST' })));
    expect(screen.queryByText('never-render-this')).not.toBeInTheDocument();
  });
});
