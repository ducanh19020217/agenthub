import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LocaleProvider } from '../context/LocaleContext';
import { ThemeProvider } from '../context/ThemeContext';

const { preview, run, getTimesheet, searchTickets, addManual, updateManual, deleteManual, writeDay } = vi.hoisted(() => ({ preview: vi.fn(), run: vi.fn(), getTimesheet: vi.fn(), searchTickets: vi.fn(), addManual: vi.fn(), updateManual: vi.fn(), deleteManual: vi.fn(), writeDay: vi.fn() }));

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
  getTimesheet,
  searchOpenProjectWorkPackages: searchTickets,
  addTimesheetManual: addManual,
  updateTimesheetManual: updateManual,
  deleteTimesheetManual: deleteManual,
  writeTimesheetDay: writeDay,
}));

import { OpenProjectSettings } from '../components/OpenProjectSettings';
import { TimesheetPage } from '../pages/TimesheetPage';

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
    resolvePreview({
      date: '2026-11-05',
      hours: 8,
      entries: [{ displayId: 'OP-1', subject: 'Export', run: 10, wait: 5, chat: 10, level: 1, weight: 22.5, hours: 8, rawHours: 6, estimateHours: 10 }],
      estimateSkipped: [{ displayId: 'OP-2', reason: 'estimate đã do người khác đặt' }],
    });
    const previewEl = await screen.findByTestId('timesheet-preview');
    expect(previewEl).toHaveTextContent('OP-1');
    expect(previewEl).toHaveTextContent('10h');
    expect(previewEl).toHaveTextContent('8h');
    expect(previewEl).toHaveTextContent('estimate đã do người khác đặt');
  });

  it('shows an error when writing fails', async () => {
    run.mockRejectedValueOnce(new Error('write failed'));
    renderSettings();
    const button = await screen.findByRole('button', { name: 'Ghi lên OpenProject' });
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('write failed'));
  });
});

describe('manual timesheet page', () => {
  it('shows search results, manual form and recalculates after changing the daily total', async () => {
    getTimesheet.mockResolvedValue({ sourceId: 'op', date: '2026-11-05', hours: 8, entries: [{ wpId: 42, displayId: 'OP-42', subject: 'Deploy', comment: 'Deploy', kind: 'manual', rawHours: 2, hours: 2, pinned: false, manualIds: ['m1'], writtenAt: '2026-11-05 18:00:00' }], overMinimum: false });
    searchTickets.mockResolvedValue([{ id: 42, displayId: 'OP-42', subject: 'Deploy' }]);
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><LocaleProvider initialLocale="vi"><ThemeProvider><TimesheetPage /></ThemeProvider></LocaleProvider></QueryClientProvider>);
    expect(await screen.findByText('OP-42')).toBeInTheDocument();
    expect(screen.getByText(/Đã ghi lúc/)).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('Tìm mã hoặc tên ticket'), { target: { value: 'Deploy' } });
    await waitFor(() => expect(searchTickets).toHaveBeenCalled());
    expect(screen.getByText('Thêm việc thủ công')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Tổng giờ ngày'), { target: { value: '9' } });
    expect(screen.getByLabelText('Tổng giờ ngày')).toHaveValue(9);
  });
});
