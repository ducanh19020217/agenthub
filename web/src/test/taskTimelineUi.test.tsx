import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TaskDetailPage } from '../pages/TaskDetailPage';
import { LocaleProvider } from '../context/LocaleContext';
import type { Locale } from '../locales';
import * as client from '../api/client';
import * as sse from '../api/sse';
import type { TaskDetail, TaskTimelineItem } from '../types/api';

describe('Workflow Timeline UI & Status Timestamps', () => {
  let queryClient: QueryClient;

  const baseTask: TaskDetail = {
    id: 'proj-1~t1',
    projectId: 'proj-1',
    slug: 't1',
    title: 'Task Alpha with Multi-round Timeline',
    level: 'easy',
    status: 'running',
    dependsOn: [],
    attempt: 2,
    resume: 0,
    statusChangedAt: '2026-11-12T03:05:00.000Z',
    statusChangedAtEstimated: false,
    createdAt: '2026-11-12T02:00:00.000Z',
    updatedAt: '2026-11-12T03:05:00.000Z',
    runs: [],
    reviews: [],
  };

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });

    vi.spyOn(sse, 'subscribeToRunOutput').mockImplementation(() => () => {});
    vi.spyOn(client, 'getTaskLog').mockResolvedValue('');
    vi.spyOn(client, 'getTasks').mockResolvedValue([]);
    vi.spyOn(client, 'getStatus').mockResolvedValue({
      running: [],
      runningWorkers: [],
      tasksByProject: {},
      disk: { freeGB: 100, minFreeGB: 10 },
      recentEvents: [],
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function renderDetailPage(taskId = 'proj-1~t1', locale: Locale = 'vi') {
    return render(
      <QueryClientProvider client={queryClient}>
        <LocaleProvider initialLocale={locale}>
          <MemoryRouter initialEntries={[`/tasks/${taskId}`]}>
            <Routes>
              <Route path="/tasks/:id" element={<TaskDetailPage />} />
            </Routes>
          </MemoryRouter>
        </LocaleProvider>
      </QueryClientProvider>,
    );
  }

  it('renders multi-round rework steps distinctly without collapsing and displays step durations', async () => {
    const multiRoundTimeline: TaskTimelineItem[] = [
      {
        status: 'queued',
        at: '2026-11-12T02:00:00.000Z',
        durationMs: 5 * 60 * 1000, // 5 phút
      },
      {
        status: 'running',
        at: '2026-11-12T02:05:00.000Z',
        durationMs: 12 * 60 * 1000, // 12 phút (vòng 1)
        runId: 'run-101',
        actor: 'worker-1',
      },
      {
        status: 'review',
        at: '2026-11-12T02:17:00.000Z',
        durationMs: 3 * 60 * 1000, // 3 phút
      },
      {
        status: 'changes_requested',
        at: '2026-11-12T02:20:00.000Z',
        durationMs: 2 * 60 * 1000, // 2 phút
        actor: 'reviewer-agent',
      },
      {
        status: 'running',
        at: '2026-11-12T02:22:00.000Z',
        durationMs: 15 * 60 * 1000, // 15 phút (vòng 2)
        runId: 'run-102',
        actor: 'worker-1',
      },
      {
        status: 'review',
        at: '2026-11-12T02:37:00.000Z',
        durationMs: 4 * 60 * 1000,
      },
      {
        status: 'done',
        at: '2026-11-12T02:41:00.000Z',
      },
    ];

    vi.spyOn(client, 'getTask').mockResolvedValue({
      ...baseTask,
      status: 'done',
      timeline: multiRoundTimeline,
    });
    vi.spyOn(client, 'getTaskTimeline').mockResolvedValue(multiRoundTimeline);

    renderDetailPage();

    const workflowSection = await screen.findByTestId('workflow-timeline');
    expect(workflowSection).toBeInTheDocument();

    // Verify all 7 steps rendered distinctly
    const steps = within(workflowSection).getAllByRole('listitem');
    expect(steps).toHaveLength(7);

    // Verify round 1 running step
    const step1 = screen.getByTestId('workflow-step-1');
    expect(step1).toHaveAttribute('data-status', 'running');
    expect(within(step1).getByTestId('workflow-duration-1')).toHaveTextContent('12 phút');
    expect(step1.textContent).toContain('(run run-101)');

    // Verify changes_requested step
    const step3 = screen.getByTestId('workflow-step-3');
    expect(step3).toHaveAttribute('data-status', 'changes_requested');
    expect(within(step3).getByTestId('workflow-duration-3')).toHaveTextContent('2 phút');
    expect(step3.textContent).toContain('reviewer-agent');

    // Verify round 2 running step (not collapsed!)
    const step4 = screen.getByTestId('workflow-step-4');
    expect(step4).toHaveAttribute('data-status', 'running');
    expect(within(step4).getByTestId('workflow-duration-4')).toHaveTextContent('15 phút');
    expect(step4.textContent).toContain('(run run-102)');

    // Verify current step displays "đang ở bước này từ"
    const currentStepText = screen.getByTestId('workflow-current-step');
    expect(currentStepText).toHaveTextContent(/đang ở bước này từ/i);
  });

  it('renders current step in English with "currently at this step since" and localized duration', async () => {
    const timelineEn: TaskTimelineItem[] = [
      {
        status: 'queued',
        at: '2026-11-12T02:00:00.000Z',
        durationMs: 5 * 60 * 1000,
      },
      {
        status: 'running',
        at: '2026-11-12T02:05:00.000Z',
        runId: 'run-999',
      },
    ];

    vi.spyOn(client, 'getTask').mockResolvedValue({
      ...baseTask,
      status: 'running',
      timeline: timelineEn,
    });
    vi.spyOn(client, 'getTaskTimeline').mockResolvedValue(timelineEn);

    renderDetailPage('proj-1~t1', 'en');

    const workflowSection = await screen.findByTestId('workflow-timeline');
    expect(workflowSection).toBeInTheDocument();

    // In en, step 0 duration is 5m
    const step0Duration = screen.getByTestId('workflow-duration-0');
    expect(step0Duration).toHaveTextContent('5m');

    // In en, current step says "currently at this step since"
    const currentStepText = screen.getByTestId('workflow-current-step');
    expect(currentStepText).toHaveTextContent(/currently at this step since/i);
  });

  it('indicates estimated timestamp for legacy tasks without events', async () => {
    const estimatedTimeline: TaskTimelineItem[] = [
      {
        status: 'done',
        at: '2026-10-15T00:00:00.000Z',
        estimated: true,
      },
    ];

    vi.spyOn(client, 'getTask').mockResolvedValue({
      ...baseTask,
      status: 'done',
      statusChangedAtEstimated: true,
      timeline: estimatedTimeline,
    });
    vi.spyOn(client, 'getTaskTimeline').mockResolvedValue(estimatedTimeline);

    renderDetailPage();

    const workflowSection = await screen.findByTestId('workflow-timeline');
    expect(workflowSection.textContent).toContain('ước lượng');
  });
});
