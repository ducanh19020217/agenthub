import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CockpitSyncModal } from '../components/CockpitSyncModal';
import { ProfilesPage } from '../pages/ProfilesPage';
import * as client from '../api/client';
import * as sse from '../api/sse';
import type { CockpitScanResult, SystemConfig } from '../types/api';

describe('CockpitSyncModal', () => {
  let queryClient: QueryClient;

  const mockScanResult: CockpitScanResult = {
    dataDir: '/home/test/.cockpit_tools',
    exists: true,
    schemaVersion: '1.3.81',
    items: [
      {
        source: 'antigravity',
        cockpitId: 'agy-new',
        email: 'agy.new@gmail.com',
        disabled: false,
        importable: true,
        hubStatus: 'new',
      },
      {
        source: 'antigravity',
        cockpitId: 'agy-exists',
        email: 'agy.exists@gmail.com',
        disabled: false,
        importable: true,
        hubStatus: 'exists',
      },
      {
        source: 'antigravity',
        cockpitId: 'agy-legacy',
        email: 'agy.legacy@gmail.com',
        disabled: false,
        importable: false,
        skipReason: 'Token mã hoá kiểu cũ, hãy mở Cockpit để nâng cấp',
        hubStatus: 'new',
      },
      {
        source: 'codex',
        cockpitId: 'codex-new',
        email: 'codex.new@openai.test',
        disabled: false,
        importable: true,
        hubStatus: 'new',
      },
      {
        source: 'codex',
        cockpitId: 'codex-disabled',
        email: 'codex.disabled@openai.test',
        disabled: true,
        importable: true,
        hubStatus: 'new',
      },
      {
        source: 'claude',
        cockpitId: 'claude-new',
        email: 'claude.new@anthropic.test',
        disabled: false,
        importable: true,
        hubStatus: 'new',
      },
      {
        source: 'claude',
        cockpitId: 'claude-key',
        email: 'claude.key@anthropic.test',
        disabled: false,
        importable: false,
        skipReason: 'Bỏ qua tài khoản API key',
        hubStatus: 'new',
      },
    ],
  };

  const mockConfig: SystemConfig = {
    modelChainHard: ['gemini-2.5-pro'],
    modelChainEasy: ['gemini-2.5-flash'],
    defaultTimeout: 300,
    integrations: {
      cockpit: {
        dataDir: '/home/test/.cockpit_tools',
        autoSync: {
          enabled: false,
          intervalMinutes: 30,
          engines: ['antigravity'],
        },
      },
    },
  };

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    vi.spyOn(sse, 'subscribeToEvents').mockImplementation(() => () => {});
    vi.spyOn(client, 'getConfig').mockResolvedValue(mockConfig);
    vi.spyOn(client, 'scanCockpit').mockResolvedValue(mockScanResult);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders 3 groups, status badges, and token rotation warning for Codex/Claude', async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <CockpitSyncModal isOpen={true} onClose={() => {}} />
      </QueryClientProvider>,
    );

    // Group titles
    expect(await screen.findByText('Antigravity (Gemini)')).toBeInTheDocument();
    expect(screen.getByText('Codex (OpenAI)')).toBeInTheDocument();
    expect(screen.getByText('Claude (Anthropic)')).toBeInTheDocument();

    // Accounts
    expect(screen.getByText('agy.new@gmail.com')).toBeInTheDocument();
    expect(screen.getByText('agy.exists@gmail.com')).toBeInTheDocument();
    expect(screen.getByText('codex.new@openai.test')).toBeInTheDocument();
    expect(screen.getByText('claude.new@anthropic.test')).toBeInTheDocument();

    // Statuses
    expect(screen.getAllByText('Mới').length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText('Đã có')).toBeInTheDocument();
    expect(screen.getByText('Bị tắt trong Cockpit')).toBeInTheDocument();
    expect(screen.getByText(/Token mã hoá kiểu cũ/)).toBeInTheDocument();
    expect(screen.getByText(/Bỏ qua tài khoản API key/)).toBeInTheDocument();

    // Token rotation warnings for Codex and Claude (rendered in both sections)
    const warnings = screen.getAllByText(/Lưu ý về xoay vòng token/);
    expect(warnings.length).toBe(2);
  });

  it('default ticks importable new accounts and calls importCockpit with ticked items', async () => {
    const importSpy = vi.spyOn(client, 'importCockpit').mockResolvedValue({
      total: 4,
      importedCount: 4,
      updatedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      items: [
        {
          source: 'antigravity',
          cockpitId: 'agy-new',
          email: 'agy.new@gmail.com',
          action: 'imported',
          status: 'ok',
        },
        {
          source: 'codex',
          cockpitId: 'codex-new',
          email: 'codex.new@openai.test',
          action: 'imported',
          status: 'ok',
        },
        {
          source: 'codex',
          cockpitId: 'codex-disabled',
          email: 'codex.disabled@openai.test',
          action: 'imported',
          status: 'ok',
        },
        {
          source: 'claude',
          cockpitId: 'claude-new',
          email: 'claude.new@anthropic.test',
          action: 'imported',
          status: 'ok',
        },
      ],
    });

    render(
      <QueryClientProvider client={queryClient}>
        <CockpitSyncModal isOpen={true} onClose={() => {}} />
      </QueryClientProvider>,
    );

    // Wait for scan
    await screen.findByText('agy.new@gmail.com');

    // Default ticked items: 4 new importable accounts (agy-new, codex-new, codex-disabled, claude-new)
    const importBtn = screen.getByRole('button', { name: /Nhập 4 tài khoản/ });
    expect(importBtn).toBeInTheDocument();
    expect(importBtn).toBeEnabled();

    // Click import
    fireEvent.click(importBtn);

    await waitFor(() => {
      expect(importSpy).toHaveBeenCalledWith(
        expect.arrayContaining([
          { source: 'antigravity', cockpitId: 'agy-new' },
          { source: 'codex', cockpitId: 'codex-new' },
          { source: 'claude', cockpitId: 'claude-new' },
        ]),
        expect.objectContaining({
          verify: true,
          dataDir: '/home/test/.cockpit_tools',
        }),
      );
    });

    // Check summary after import
    expect(await screen.findByText(/Đã nhập 4 tài khoản mới/)).toBeInTheDocument();
  });

  it('shows missing directory alert when exists is false', async () => {
    vi.spyOn(client, 'scanCockpit').mockResolvedValue({
      dataDir: '/missing/path',
      exists: false,
      items: [],
    });

    render(
      <QueryClientProvider client={queryClient}>
        <CockpitSyncModal isOpen={true} onClose={() => {}} />
      </QueryClientProvider>,
    );

    expect(await screen.findByText('Không tìm thấy thư mục Cockpit')).toBeInTheDocument();
    expect(screen.getByText(/Vui lòng cài đặt Cockpit Tools/)).toBeInTheDocument();
  });

  it('allows toggling and saving auto-sync configuration', async () => {
    const updateSpy = vi.spyOn(client, 'updateConfig').mockResolvedValue(mockConfig);

    render(
      <QueryClientProvider client={queryClient}>
        <CockpitSyncModal isOpen={true} onClose={() => {}} />
      </QueryClientProvider>,
    );

    await screen.findByText('agy.new@gmail.com');

    // Open auto-sync section
    const autoSyncToggleBtn = screen.getByText('Cài đặt tự đồng bộ định kỳ');
    fireEvent.click(autoSyncToggleBtn);

    // Enable checkbox
    const enableCheckbox = screen.getByLabelText('Bật tự động đồng bộ');
    fireEvent.click(enableCheckbox);

    // Save button
    const saveBtn = screen.getByRole('button', { name: 'Lưu cài đặt tự đồng bộ' });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith({
        integrations: {
          cockpit: {
            dataDir: '/home/test/.cockpit_tools',
            autoSync: {
              enabled: true,
              intervalMinutes: 30,
              engines: ['antigravity'],
            },
          },
        },
      });
    });

    expect(await screen.findByText('Đã lưu cấu hình tự đồng bộ')).toBeInTheDocument();
  });

  it('renders "Đồng bộ từ Cockpit" button on ProfilesPage and opens CockpitSyncModal', async () => {
    vi.spyOn(client, 'getProfiles').mockResolvedValue([]);

    render(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <ProfilesPage />
        </BrowserRouter>
      </QueryClientProvider>,
    );

    const syncBtn = await screen.findByRole('button', { name: 'Đồng bộ từ Cockpit' });
    expect(syncBtn).toBeInTheDocument();

    fireEvent.click(syncBtn);

    expect(await screen.findByText('Đồng bộ tài khoản từ Cockpit Tools')).toBeInTheDocument();
  });
});
