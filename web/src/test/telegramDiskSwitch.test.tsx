import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TelegramCard } from '../components/TelegramCard';
import { LocaleProvider } from '../context/LocaleContext';
import { ThemeProvider } from '../context/ThemeContext';
import * as client from '../api/client';

describe('TelegramCard - Disk notification switch', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    localStorage.clear();
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    vi.spyOn(client, 'getTelegramPairingCode').mockResolvedValue({
      code: '123456',
      expiresInSec: 300,
      enabled: true,
      allowedChatIds: [100],
      chats: [],
    });
    vi.spyOn(client, 'getProjects').mockResolvedValue([]);
    vi.spyOn(client, 'getDepartments').mockResolvedValue([]);
  });

  it('renders disk notification toggle in Vietnamese and handles toggling', async () => {
    const updateSpy = vi.spyOn(client, 'updateTelegramConfig').mockResolvedValue({} as any);
    vi.spyOn(client, 'getTelegramStatus').mockResolvedValue({
      enabled: true,
      hasToken: true,
      topicMode: 'project',
      allowedChatIds: [100],
      chats: [],
      projectTopics: {},
      notify: {
        reviewReady: true,
        failed: true,
        blocked: true,
        quotaPerModel: false,
        quotaAllExhausted: true,
        fallback: false,
        disk: true,
      },
    } as any);

    render(
      <LocaleProvider initialLocale="vi">
        <ThemeProvider>
          <QueryClientProvider client={queryClient}>
            <TelegramCard />
          </QueryClientProvider>
        </ThemeProvider>
      </LocaleProvider>
    );

    const checkbox = await screen.findByLabelText('Ổ đĩa thấp / hết chỗ');
    expect(checkbox).toBeInTheDocument();
    expect(checkbox).toBeChecked();

    fireEvent.click(checkbox);
    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith({ notify: { disk: false } });
    });
  });

  it('renders disk notification toggle in English', async () => {
    vi.spyOn(client, 'getTelegramStatus').mockResolvedValue({
      enabled: true,
      hasToken: true,
      topicMode: 'project',
      allowedChatIds: [100],
      chats: [],
      projectTopics: {},
      notify: {
        reviewReady: true,
        failed: true,
        blocked: true,
        quotaPerModel: false,
        quotaAllExhausted: true,
        fallback: false,
        disk: false,
      },
    } as any);

    render(
      <LocaleProvider initialLocale="en">
        <ThemeProvider>
          <QueryClientProvider client={queryClient}>
            <TelegramCard />
          </QueryClientProvider>
        </ThemeProvider>
      </LocaleProvider>
    );

    const checkbox = await screen.findByLabelText('Low disk space');
    expect(checkbox).toBeInTheDocument();
    expect(checkbox).not.toBeChecked();
  });
});
