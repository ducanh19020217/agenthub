import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrainCard, BRAIN_ACTIVITY_LABELS } from '../components/BrainCard';
import { ReviewQueue } from '../components/ReviewQueue';
import { DashboardPage } from '../pages/DashboardPage';
import { BrainActivity, Task } from '../types/api';
import * as client from '../api/client';
import * as sse from '../api/sse';
import { translate } from '../locales';

describe('BrainCard Component', () => {
  const activities: BrainActivity[] = [
    'planning',
    'dispatching',
    'reviewing',
    'merging',
    'deploying',
    'waiting',
    'idle',
    'talking',
  ];

  it.each(activities)(
    'renders correctly for activity "%s" with Vietnamese translation',
    (activity) => {
      const expectedLabel = translate('vi', BRAIN_ACTIVITY_LABELS[activity]);

      render(
        <BrowserRouter>
          <BrainCard
            brain={{
              activity,
              detail: `Detail for ${activity}`,
              taskId: 'proj/t-1',
              updatedAt: new Date().toISOString(),
              stale: false,
            }}
          />
        </BrowserRouter>,
      );

      expect(screen.getByTestId('brain-card')).toBeInTheDocument();
      expect(screen.getByText('Claude · Điều phối viên')).toBeInTheDocument();
      expect(screen.getByTestId('brain-activity')).toHaveTextContent(expectedLabel);
      expect(screen.getByTestId('brain-detail')).toHaveTextContent(`Detail for ${activity}`);
      expect(screen.getByTestId('brain-task-link')).toHaveTextContent('proj/t-1');
    },
  );

  it('renders stale state with dimmed opacity and warning badge', () => {
    render(
      <BrowserRouter>
        <BrainCard
          brain={{
            activity: 'waiting',
            detail: 'Chờ worker xong',
            taskId: null,
            updatedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
            stale: true,
          }}
        />
      </BrowserRouter>,
    );

    const card = screen.getByTestId('brain-card');
    expect(card.className).toContain('opacity-60');
    expect(screen.getByTestId('brain-stale-badge')).toHaveTextContent(
      'Claude chưa cập nhật trong 15 phút',
    );
  });

  it('renders Claude avatar with the Claude theme token', () => {
    render(
      <BrowserRouter>
        <BrainCard
          brain={{
            activity: 'idle',
            detail: 'Rảnh rỗi',
            taskId: null,
            updatedAt: new Date().toISOString(),
            stale: false,
          }}
        />
      </BrowserRouter>,
    );

    const avatar = screen.getByTestId('brain-avatar');
    expect(avatar).toHaveStyle({ backgroundColor: 'var(--t-claude)' });
    expect(avatar).toHaveTextContent('C');
  });
});

describe('ReviewQueue Component', () => {
  const mockReviewTasks: Task[] = [
    {
      id: 'proj/task-1',
      projectId: 'proj',
      slug: 'task-1',
      title: 'Task số 1',
      level: 'easy',
      status: 'review',
      dependsOn: [],
      attempt: 1,
      resume: 0,
      createdAt: '2026-10-15',
      updatedAt: '2026-10-15',
    },
    {
      id: 'proj/task-2',
      projectId: 'proj',
      slug: 'task-2',
      title: 'Task số 2',
      level: 'hard',
      status: 'review',
      dependsOn: [],
      attempt: 1,
      resume: 0,
      createdAt: '2026-10-15',
      updatedAt: '2026-10-15',
    },
    {
      id: 'proj/task-3',
      projectId: 'proj',
      slug: 'task-3',
      title: 'Task đang chạy',
      level: 'easy',
      status: 'running',
      dependsOn: [],
      attempt: 1,
      resume: 0,
      createdAt: '2026-10-15',
      updatedAt: '2026-10-15',
    },
  ];

  it('renders review tasks with "chờ Claude review" and marks matching task with "Claude đang xem"', () => {
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <BrowserRouter>
          <ReviewQueue tasks={mockReviewTasks} activeTaskId="proj/task-2" />
        </BrowserRouter>
      </QueryClientProvider>,
    );

    expect(screen.getByTestId('review-queue')).toBeInTheDocument();
    expect(screen.getByTestId('review-queue-count')).toHaveTextContent('2 task chờ review');

    // Task 1 is waiting
    expect(screen.getByText('Task số 1')).toBeInTheDocument();
    expect(screen.getByTestId('review-waiting-note')).toHaveTextContent('chờ Claude review');

    // Task 2 is being reviewed by Claude
    expect(screen.getByText('Task số 2')).toBeInTheDocument();
    const watchingBadge = screen.getByTestId('review-watching-badge');
    expect(watchingBadge).toBeInTheDocument();
    expect(watchingBadge).toHaveTextContent('Claude đang xem');
    expect(watchingBadge).toHaveStyle({ backgroundColor: 'var(--t-claude)' });
  });

  it('renders empty message when no tasks in review state', () => {
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <BrowserRouter>
          <ReviewQueue tasks={[]} activeTaskId={null} />
        </BrowserRouter>
      </QueryClientProvider>,
    );

    expect(screen.getByTestId('review-queue-empty')).toHaveTextContent(
      'Không có task nào chờ review.',
    );
  });
});

describe('DashboardPage - Claude Integration', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    vi.spyOn(sse, 'subscribeToEvents').mockImplementation(() => () => {});
  });

  it('renders BrainCard on top and displays Claude icons in event feed', async () => {
    vi.spyOn(client, 'getStatus').mockResolvedValue({
      tasks: { running: 0, review: 1 },
      running: [],
      brain: {
        activity: 'dispatching',
        detail: 'dispatching task-99',
        taskId: 'agenthub/task-99',
        updatedAt: new Date().toISOString(),
        stale: false,
      },
      recentEvents: [
        {
          id: 1,
          ts: '12:00:00',
          type: 'brain.status',
          taskId: 'agenthub/task-99',
          payload: { activity: 'dispatching', detail: 'dispatching task-99' },
        },
        {
          id: 2,
          ts: '12:01:00',
          type: 'task.done',
          taskId: 'agenthub/task-88',
          payload: { by: 'claude-review', verdict: 'approved' },
        },
        {
          id: 3,
          ts: '12:02:00',
          type: 'task.running',
          taskId: 'agenthub/task-77',
          payload: { engine: 'agy' },
        },
      ],
    } as any);

    render(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <DashboardPage />
        </BrowserRouter>
      </QueryClientProvider>,
    );

    // BrainCard should be visible with dispatching activity
    expect(await screen.findByTestId('brain-card')).toBeInTheDocument();
    expect(screen.getByTestId('brain-activity')).toHaveTextContent('Đang giao việc');
    expect(screen.getByTestId('brain-detail')).toHaveTextContent('dispatching task-99');

    // Events 1 and 2 should show Claude icon, event 3 should not
    const claudeIcons = screen.getAllByTestId('claude-event-icon');
    expect(claudeIcons.length).toBe(2);
  });

  it('renders system and project brain rows without chat entry points', async () => {
    vi.spyOn(client, 'getStatus').mockResolvedValue({ tasks: {}, running: [] } as any);
    vi.spyOn(client, 'getBrain').mockResolvedValue({
      activity: 'idle', detail: '', updatedAt: new Date().toISOString(), stale: false,
      brains: [
        { projectId: null, projectName: 'Hệ thống', mode: 'auto', sessionId: 'brain', state: 'idle', queued: false, lastTurnAt: null, tokensToday: 12 },
        { projectId: 'demo', projectName: 'Demo', mode: 'external', sessionId: 'brain:demo', state: 'waiting', queued: true, lastTurnAt: null, tokensToday: 345 },
      ],
    });
    render(<QueryClientProvider client={queryClient}><BrowserRouter><DashboardPage /></BrowserRouter></QueryClientProvider>);
    expect(await screen.findByTestId('brain-row-system')).toHaveTextContent('Hệ thống');
    expect(screen.getByTestId('brain-row-demo')).toHaveTextContent('Demo');
    expect(screen.getByTestId('brain-row-demo').querySelector('a')).toBeNull();
  });
});
