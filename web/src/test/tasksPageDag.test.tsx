import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TasksPage } from '../pages/TasksPage';
import { LocaleProvider } from '../context/LocaleContext';
import { ThemeProvider } from '../context/ThemeContext';
import * as client from '../api/client';
import { Task } from '../types/api';

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof client>('../api/client');
  return {
    ...actual,
    getProjects: vi.fn(),
    getAllTasksPaged: vi.fn(),
    getTaskGraph: vi.fn(),
    getStatus: vi.fn().mockResolvedValue({}),
  };
});

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <LocaleProvider>
          <MemoryRouter>{ui}</MemoryRouter>
        </LocaleProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

const mockTasksData: Task[] = [
  {
    id: 'p1~t1',
    projectId: 'p1',
    slug: 'task-1',
    title: 'Core Task 1',
    level: 'easy',
    status: 'running',
    dependsOn: [],
    attempt: 1,
    resume: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'p1~t2',
    projectId: 'p1',
    slug: 'task-2',
    title: 'Dependent Task 2',
    level: 'hard',
    status: 'queued',
    dependsOn: ['p1~t1'],
    attempt: 0,
    resume: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'p1~t3',
    projectId: 'p1',
    slug: 'task-3',
    title: 'Old Done Task',
    level: 'easy',
    status: 'done',
    dependsOn: [],
    attempt: 1,
    resume: 0,
    createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
  },
];

const mockGraphData = {
  nodes: mockTasksData.map((task) => ({ id: task.id, projectId: task.projectId, slug: task.slug, title: task.title, status: task.status, level: task.level, blockedCount: 0, isCritical: false, isMaxBlocker: false })),
  edges: [{ from: 'p1~t1', to: 'p1~t2', isCritical: true }],
  criticalPath: ['p1~t1', 'p1~t2'],
  maxBlockingTaskId: null,
  maxBlockedCount: 0,
};

describe('TasksPage - DAG View and Filters', () => {
  it('toggles between Kanban and Sơ đồ (DAG) view', async () => {
    vi.mocked(client.getProjects).mockResolvedValue([
      { id: 'p1', name: 'Project 1', path: '/tmp/p1', defaultBranch: 'main', maxParallel: 2 },
    ]);
    vi.mocked(client.getAllTasksPaged).mockResolvedValue(mockTasksData);
    vi.mocked(client.getTaskGraph).mockResolvedValue(mockGraphData);

    renderWithProviders(<TasksPage />);

    // Mặc định mở ở view Quy trình (TaskFlow)
    await waitFor(() => {
      expect(screen.getByTestId('flow-view-wrapper')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('kanban-column-running')).not.toBeInTheDocument();

    // Check view toggle buttons
    const dagToggleBtn = screen.getByTestId('view-toggle-dag');
    const kanbanToggleBtn = screen.getByTestId('view-toggle-kanban');
    expect(dagToggleBtn).toBeInTheDocument();
    expect(kanbanToggleBtn).toBeInTheDocument();

    // Switch to DAG view
    fireEvent.click(dagToggleBtn);

    // DAG container is displayed
    await waitFor(() => {
      expect(screen.getByTestId('dag-view-wrapper')).toBeInTheDocument();
      expect(screen.getByTestId('task-dag-container')).toBeInTheDocument();
    });

    // Node task-1 and task-2 are visible
    expect(screen.getByTestId('dag-node-p1~t1')).toBeInTheDocument();
    expect(screen.getByTestId('dag-node-p1~t2')).toBeInTheDocument();

    // Default doneFilter is active_chains: t3 is an isolated done task so it is hidden
    expect(screen.queryByTestId('dag-node-p1~t3')).not.toBeInTheDocument();

    // Switch back to Kanban
    fireEvent.click(kanbanToggleBtn);
    await waitFor(() => {
      expect(screen.getByTestId('kanban-column-running')).toBeInTheDocument();
      expect(screen.queryByTestId('dag-view-wrapper')).not.toBeInTheDocument();
    });
  });

  it('filters by status and done tasks in DAG view', async () => {
    vi.mocked(client.getProjects).mockResolvedValue([
      { id: 'p1', name: 'Project 1', path: '/tmp/p1', defaultBranch: 'main', maxParallel: 2 },
    ]);
    vi.mocked(client.getAllTasksPaged).mockResolvedValue(mockTasksData);
    vi.mocked(client.getTaskGraph).mockResolvedValue(mockGraphData);

    renderWithProviders(<TasksPage />);

    // Switch to DAG view
    await waitFor(() => {
      expect(screen.getByTestId('view-toggle-dag')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('view-toggle-dag'));

    await waitFor(() => {
      expect(screen.getByTestId('task-dag-container')).toBeInTheDocument();
    });

    // Filter by status: 'queued'
    const statusSelect = screen.getByLabelText('Lọc theo trạng thái');
    fireEvent.change(statusSelect, { target: { value: 'queued' } });

    // The queued match keeps its running prerequisite as dependency context.
    expect(screen.getByTestId('dag-node-p1~t1')).toBeInTheDocument();
    expect(screen.getByTestId('dag-node-p1~t2')).toBeInTheDocument();
    expect(screen.getByTestId('dag-edge-p1~t1-p1~t2')).toBeInTheDocument();

    // Reset status filter to 'all'
    fireEvent.change(statusSelect, { target: { value: 'all' } });
    expect(screen.getByTestId('dag-node-p1~t1')).toBeInTheDocument();
    expect(screen.getByTestId('dag-node-p1~t2')).toBeInTheDocument();

    // Done filter: change to 'all' to show all completed tasks including t3
    const doneSelect = screen.getByLabelText('Lọc task hoàn thành');
    fireEvent.change(doneSelect, { target: { value: 'all' } });

    expect(screen.getByTestId('dag-node-p1~t3')).toBeInTheDocument();
  });
});
