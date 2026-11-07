import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { SavingsPage } from '../pages/SavingsPage';
import * as client from '../api/client';
import { SavingsReport } from '../types/api';

const report: SavingsReport = {
  summary: {
    totalWorkerTokens: 123456,
    claudeSavedTokens: 111110,
    claudeCostTokens: 40000,
    savingsRatio: 0.735,
    totalLinesAdded: 42,
    totalLinesDeleted: 7,
    totalLinesChanged: 49,
    tasksApprovedCount: 1,
    avgReviewRounds: 1,
  },
  byEngine: {},
  byModel: {},
  byDay: [],
  tasks: [
    {
      taskId: 'demo/task-1',
      slug: 'task-1',
      title: 'Tạo báo cáo savings',
      projectId: 'demo',
      status: 'done',
      model: 'codex:gpt-5.6-luna',
      engine: 'codex',
      linesAdded: 42,
      linesDeleted: 7,
      filesChanged: 2,
      tokens: 123456,
      estimated: false,
      reviewRounds: 1,
      durationMs: 65000,
      completedAt: '2026-10-15T10:00:00.000Z',
    },
    {
      taskId: 'demo/task-2',
      slug: 'task-2',
      title: 'Task không có thay đổi dòng',
      projectId: 'demo',
      status: 'done',
      model: 'gemini-3.8-flash-high',
      engine: 'agy',
      linesAdded: 0,
      linesDeleted: 0,
      filesChanged: 0,
      tokens: 50000,
      estimated: true,
      reviewRounds: 0,
      durationMs: 12000,
      completedAt: '2026-10-15T11:00:00.000Z',
    },
  ],
};

describe('SavingsPage', () => {
  beforeEach(() => {
    vi.spyOn(client, 'getProjects').mockResolvedValue([]);
    vi.spyOn(client, 'getSavings').mockResolvedValue(report);
  });

  it('renders savings metrics and task data from the API', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <SavingsPage />
        </BrowserRouter>
      </QueryClientProvider>,
    );

    const formattedSavedTokens = new Intl.NumberFormat('vi-VN').format(report.summary.claudeSavedTokens);
    expect(await screen.findByText(formattedSavedTokens)).toBeInTheDocument();
    expect(screen.getByText('Hiệu quả ủy quyền')).toBeInTheDocument();
    expect(screen.getByText('Tạo báo cáo savings')).toBeInTheDocument();
    expect(screen.getByText('Task không có thay đổi dòng')).toBeInTheDocument();
  });

  it('renders ModelBadge with compact name and full title tooltip in task table', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <SavingsPage />
        </BrowserRouter>
      </QueryClientProvider>,
    );

    await screen.findByText('Tạo báo cáo savings');

    const badges = screen.getAllByTestId('model-badge');
    expect(badges.length).toBe(2);

    // First task: codex:gpt-5.6-luna -> Codex Luna
    expect(badges[0]).toHaveTextContent('Codex Luna');
    expect(badges[0]).toHaveAttribute('title', 'Codex / codex:gpt-5.6-luna');
    expect(badges[0]).toHaveClass('badge-model-codex');
    expect(badges[0]).toHaveClass('whitespace-nowrap');

    // Second task: gemini-3.8-flash-high -> Gemini Flash · high
    expect(badges[1]).toHaveTextContent('Gemini Flash · high');
    expect(badges[1]).toHaveAttribute('title', 'Gemini / gemini-3.8-flash-high');
    expect(badges[1]).toHaveClass('badge-model-gemini');
    expect(badges[1]).toHaveClass('whitespace-nowrap');
  });

  it('renders lines column formatted with +N / −M and em-dash when 0, with tabular-nums', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <SavingsPage />
        </BrowserRouter>
      </QueryClientProvider>,
    );

    await screen.findByText('Tạo báo cáo savings');

    // Check non-zero line changes and zero line changes in table body
    const tableBody = container.querySelector('tbody')!;
    expect(tableBody).toHaveTextContent('+42');
    expect(tableBody).toHaveTextContent('−7');
    expect(tableBody).toHaveTextContent('—');

    // Check headers have whitespace-nowrap
    const headers = container.querySelectorAll('thead th');
    expect(headers.length).toBe(7);
    headers.forEach((th) => {
      expect(th).toHaveClass('whitespace-nowrap');
    });

    // Check number columns have tabular-nums
    const tabularCells = container.querySelectorAll('tbody td.tabular-nums');
    expect(tabularCells.length).toBeGreaterThan(0);
  });

  it('renders 0 without negative sign when linesDeleted is 0 or numbers round to 0', async () => {
    const reportZeroDeleted: SavingsReport = {
      summary: {
        totalWorkerTokens: 10000,
        claudeSavedTokens: 9000,
        claudeCostTokens: 1000,
        savingsRatio: -0.00004,
        totalLinesAdded: 15,
        totalLinesDeleted: 0,
        totalLinesChanged: 15,
        tasksApprovedCount: 1,
        avgReviewRounds: -0.004,
      },
      byEngine: {},
      byModel: {},
      byDay: [],
      tasks: [
        {
          taskId: 'demo/task-zero-del',
          slug: 'task-zero-del',
          title: 'Task added lines only',
          projectId: 'demo',
          status: 'done',
          model: 'gemini-3.8-flash-high',
          engine: 'agy',
          linesAdded: 15,
          linesDeleted: 0,
          filesChanged: 1,
          tokens: 10000,
          estimated: false,
          reviewRounds: 0,
          durationMs: 5000,
          completedAt: '2026-10-15T12:00:00.000Z',
        },
      ],
    };

    vi.spyOn(client, 'getSavings').mockResolvedValue(reportZeroDeleted);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <SavingsPage />
        </BrowserRouter>
      </QueryClientProvider>,
    );

    await screen.findByText('Task added lines only');

    // Table line changes should show +15 / 0 (never -0 or −0)
    const tableBody = container.querySelector('tbody')!;
    expect(tableBody).toHaveTextContent('+15');
    expect(tableBody).toHaveTextContent('/0');
    expect(tableBody).not.toHaveTextContent('−0');
    expect(tableBody).not.toHaveTextContent('-0');

    // Metric cards should not have -0
    expect(container).not.toHaveTextContent('-0');
    expect(container).not.toHaveTextContent('−0');
    expect(container).not.toHaveTextContent('-0.0%');
  });
});

