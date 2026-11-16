import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TasksPage } from '../pages/TasksPage';
import { LocaleProvider } from '../context/LocaleContext';
import { ThemeProvider } from '../context/ThemeContext';
import * as client from '../api/client';
import type { TaskGraphResponse } from '../types/api';

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof client>('../api/client');
  return { ...actual, getProjects: vi.fn().mockResolvedValue([]), getTasks: vi.fn().mockResolvedValue([]), getTasksPage: vi.fn().mockResolvedValue({ items: [], total: 0 }), getTaskGraph: vi.fn(), getStatus: vi.fn().mockResolvedValue({}) };
});

function renderPage(initialEntry = '/tasks') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}><ThemeProvider><LocaleProvider><MemoryRouter initialEntries={[initialEntry]}><TasksPage /></MemoryRouter></LocaleProvider></ThemeProvider></QueryClientProvider>);
}

const graph: TaskGraphResponse = {
  nodes: [
    { id: 'agenthub-video-auto~image-review-stage', projectId: 'agenthub-video-auto', slug: 'image-review-stage', title: 'Image review stage', status: 'running', level: 'easy', blockedCount: 1, isCritical: true, isMaxBlocker: true, currentRun: { model: 'gemini', profileName: 'fixture' } },
    { id: 'agenthub-video-auto~per-channel-image-source-order', projectId: 'agenthub-video-auto', slug: 'per-channel-image-source-order', title: 'Per channel image source order', status: 'queued', level: 'easy', blockedCount: 0, isCritical: true, isMaxBlocker: false },
  ],
  edges: [{ from: 'agenthub-video-auto~image-review-stage', to: 'agenthub-video-auto~per-channel-image-source-order', isCritical: true }],
  criticalPath: [], maxBlockingTaskId: null, maxBlockedCount: 0,
};

describe('TasksPage view persistence and toolbar contract', () => {
  beforeEach(() => { localStorage.clear(); vi.mocked(client.getTaskGraph).mockResolvedValue(graph); });
  afterEach(() => { localStorage.clear(); });

  it('uses a valid URL view before a saved view, and remembers selections', async () => {
    localStorage.setItem('agenthub:tasks:view', 'dag');
    renderPage('/tasks?view=list');
    expect(screen.getByTestId('view-toggle-list').className).toContain('bg-[var(--t-accent)]');
    fireEvent.click(screen.getByTestId('view-toggle-kanban'));
    expect(localStorage.getItem('agenthub:tasks:view')).toBe('kanban');
  });

  it('restores a valid saved view and safely falls back for invalid values', async () => {
    localStorage.setItem('agenthub:tasks:view', 'project');
    const saved = renderPage();
    expect(screen.getByTestId('project-view-wrapper')).toBeInTheDocument();
    saved.unmount();
    localStorage.setItem('agenthub:tasks:view', 'unknown');
    renderPage('/tasks?view=not-a-view');
    await waitFor(() => expect(screen.getByTestId('flow-view-wrapper')).toBeInTheDocument());
  });

  it('keeps the view tabs and toolbar shrink/wrap classes required for narrow layouts', () => {
    renderPage();
    for (const mode of ['kanban', 'flow', 'project', 'list', 'dag']) {
      expect(screen.getByTestId(`view-toggle-${mode}`).className).toContain('whitespace-nowrap');
    }
    expect(screen.getByTestId('task-views').className).toContain('shrink-0');
    expect(screen.getByTestId('tasks-toolbar').className).toContain('flex-wrap');
    expect(screen.getByTestId('tasks-search-container').className).toContain('min-w-0');
    expect(screen.getByLabelText('Lọc slug / tiêu đề').className).toContain('w-full');
  });

  it('renders the active running-to-queued dependency chain in the default DAG filter', async () => {
    renderPage('/tasks?view=dag');
    await waitFor(() => expect(screen.getByTestId('task-dag-container')).toBeInTheDocument());
    expect(screen.getByTestId('dag-node-agenthub-video-auto~image-review-stage')).toBeInTheDocument();
    expect(screen.getByTestId('dag-node-agenthub-video-auto~per-channel-image-source-order')).toBeInTheDocument();
    expect(screen.getByTestId('dag-edge-agenthub-video-auto~image-review-stage-agenthub-video-auto~per-channel-image-source-order')).toBeInTheDocument();
    expect(screen.queryByTestId('task-dag-empty')).not.toBeInTheDocument();
  });

  it('shows graph failures as errors and gives filtered emptiness a clear action', async () => {
    vi.mocked(client.getTaskGraph).mockRejectedValueOnce(new Error('offline'));
    renderPage('/tasks?view=dag');
    await waitFor(() => expect(screen.getByTestId('task-dag-error')).toBeInTheDocument());
    expect(screen.queryByTestId('task-dag-empty')).not.toBeInTheDocument();

    vi.mocked(client.getTaskGraph).mockResolvedValue(graph);
    renderPage('/tasks?view=dag&status=cancelled');
    await waitFor(() => expect(screen.getByTestId('task-dag-empty-filtered')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Xóa bộ lọc'));
    await waitFor(() => expect(screen.getByTestId('task-dag-container')).toBeInTheDocument());
  });
});
