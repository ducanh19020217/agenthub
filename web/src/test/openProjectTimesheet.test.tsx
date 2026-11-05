import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LocaleProvider } from '../context/LocaleContext';
import { ThemeProvider } from '../context/ThemeContext';

const { preview, run } = vi.hoisted(() => ({ preview: vi.fn(), run: vi.fn() }));

vi.mock('../api/client', () => ({
  getOpenProjectSources: vi.fn(async () => [{ id: 'op', url: 'https://op.test', project: 'demo', keyConfigured: true, pollIntervalSec: 120, watchStatusIds: [], reopenedStatusIds: [], openStatusIds: [], minTicketNumber: 0, autoStart: true, autoResolve: true, triage: 'off', triageModelChain: [], feedbackStatusId: null, language: 'vi', split: { typeIds: [], keyword: '[chia]', workerMayRequest: true, maxParts: 5, createChildTickets: true }, dailyReport: { enabled: false, time: '18:00', weekdaysOnly: true, maxItems: 10, telegram: false }, timesheet: { enabled: true, time: '17:30', weekdaysOnly: true, hours: 8, activityId: null, minEntryHours: 0.5, roundTo: 0.25 } }]),
  getOpenProjectStatuses: vi.fn(async () => []),
  getOpenProjectTypes: vi.fn(async () => []),
  getOpenProjectTimeEntryActivities: vi.fn(async () => { throw new Error('activities unavailable'); }),
  previewOpenProjectTimesheet: preview,
  runOpenProjectTimesheet: run,
  deleteOpenProjectSource: vi.fn(),
  saveOpenProjectKey: vi.fn(),
  saveOpenProjectSource: vi.fn(),
  syncOpenProject: vi.fn(),
  testOpenProjectConnection: vi.fn(),
  createOpenProjectDailyReport: vi.fn(),
}));

import { OpenProjectSettings } from '../components/OpenProjectSettings';

function renderSettings() {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><LocaleProvider initialLocale="vi"><ThemeProvider><OpenProjectSettings /></ThemeProvider></LocaleProvider></QueryClientProvider>);
}

describe('OpenProject timesheet controls', () => {
  it('shows activity fallback and preview loading/result', async () => {
    let resolvePreview!: (value: unknown) => void;
    preview.mockReturnValueOnce(new Promise((resolve) => { resolvePreview = resolve; }));
    renderSettings();
    expect(await screen.findByPlaceholderText('ID activity')).toBeInTheDocument();
    const previewButton = screen.getByRole('button', { name: 'Xem bảng giờ hôm nay' });
    fireEvent.click(previewButton);
    await waitFor(() => expect(preview).toHaveBeenCalled());
    expect(await screen.findByRole('button', { name: 'Đang xử lý…' })).toBeDisabled();
    resolvePreview({ date: '2026-11-05', hours: 8, entries: [{ displayId: 'OP-1', subject: 'Export', run: 10, wait: 5, chat: 10, level: 1, weight: 22.5, hours: 8 }] });
    expect(await screen.findByTestId('timesheet-preview')).toHaveTextContent('OP-1');
  });

  it('shows an error when writing fails', async () => {
    run.mockRejectedValueOnce(new Error('write failed'));
    renderSettings();
    const button = await screen.findByRole('button', { name: 'Ghi lên OpenProject' });
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('write failed'));
  });
});
