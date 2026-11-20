import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TaskDetailPage } from '../pages/TaskDetailPage';
import * as client from '../api/client';
import * as sse from '../api/sse';
import { TaskDetail } from '../types/api';
import { cleanTerminalLog } from '../utils/terminalLog';

describe('cleanTerminalLog', () => {
  it('strips ANSI colour, cursor and OSC sequences like cargo and agent CLIs emit', () => {
    expect(cleanTerminalLog('\x1b[38;5;77m   Compiling\x1b[0m web v0.1.0')).toBe('   Compiling web v0.1.0');
    expect(cleanTerminalLog('\x1b[1m\x1b[32mFinished\x1b[0m release')).toBe('Finished release');
    expect(cleanTerminalLog('a\x1b[2K\x1b[1Ab')).toBe('ab');
    expect(cleanTerminalLog('\x1b]0;title\x07done')).toBe('done');
    expect(cleanTerminalLog('\x1b]8;;https://x\x1b\\link\x1b]8;;\x1b\\')).toBe('link');
  });

  it('keeps the last redraw of a line rewritten with a bare carriage return', () => {
    expect(cleanTerminalLog('Building [=>   ] 1/9\rBuilding [===> ] 5/9\rBuilding [=====] 9/9\nnext')).toBe('Building [=====] 9/9\nnext');
    expect(cleanTerminalLog('progress 50%\r\nline two\r\n')).toBe('progress 50%\nline two\n');
    expect(cleanTerminalLog('final text\r')).toBe('final text');
  });

  it('drops other control characters but keeps tabs and newlines', () => {
    expect(cleanTerminalLog('a\tb\x07\x08c\nd')).toBe('a\tbc\nd');
    expect(cleanTerminalLog('')).toBe('');
  });
});

describe('TaskDetailPage - long live log rendering', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 3000 } } });
    vi.spyOn(sse, 'subscribeToRunOutput').mockImplementation(() => () => {});
    vi.spyOn(sse, 'subscribeToEvents').mockImplementation(() => () => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders virtualized rows without wrapping or ANSI noise so long lines cannot overlap', async () => {
    const task: TaskDetail = {
      id: 'demo/long-log', projectId: 'demo', slug: 'long-log', title: 'Long log', level: 'easy', status: 'running',
      dependsOn: '[]', attempt: 0, resume: 0, createdAt: '2026-10-15T08:00:00Z', updatedAt: '2026-10-15T08:00:00Z', runs: [], reviews: [],
    };
    const longCommand = `rustc --crate-name web ${'--extern dep=/very/long/path/libdep.rlib '.repeat(40)}`;
    const lines = Array.from({ length: 600 }, (_, index) => `line ${index}`);
    lines.push(`\x1b[38;5;77m   Compiling\x1b[0m web v0.1.0`, longCommand, 'progress 10%\rprogress 100%', 'tail marker');
    vi.spyOn(client, 'getTask').mockResolvedValue(task);
    vi.spyOn(client, 'getTaskLog').mockResolvedValue(`${lines.join('\n')}\n`);

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/tasks/demo~long-log']}>
          <Routes><Route path="/tasks/:id" element={<TaskDetailPage />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const virtual = await screen.findByTestId('log-virtual');
    const container = virtual.parentElement as HTMLElement;
    // The scroller must not wrap in virtualized mode and must allow horizontal scrolling.
    expect(container.className).toContain('whitespace-pre');
    expect(container.className).not.toContain('whitespace-pre-wrap');
    expect(container.className).toContain('overflow-auto');

    // jsdom has no layout, so scrollTop stays 0: the first window of rows is rendered.
    const rows = virtual.querySelectorAll(':scope > div > div');
    expect(rows.length).toBeGreaterThan(0);
    rows.forEach((row) => {
      expect(row.className).toContain('h-[18px]');
      expect(row.className).toContain('leading-[18px]');
      expect(row.className).toContain('whitespace-pre');
      expect(row.className).not.toContain('whitespace-pre-wrap');
    });
    expect(virtual.style.height).toBe(`${(lines.length + 1) * 18}px`);
  });

  it('shows cleaned text for short logs too', async () => {
    const task: TaskDetail = {
      id: 'demo/short-log', projectId: 'demo', slug: 'short-log', title: 'Short log', level: 'easy', status: 'running',
      dependsOn: '[]', attempt: 0, resume: 0, createdAt: '2026-10-15T08:00:00Z', updatedAt: '2026-10-15T08:00:00Z', runs: [], reviews: [],
    };
    vi.spyOn(client, 'getTask').mockResolvedValue(task);
    vi.spyOn(client, 'getTaskLog').mockResolvedValue('\x1b[38;5;77m    Finished\x1b[0m generating JS/WASM\nstep 1\rstep 2\n');

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/tasks/demo~short-log']}>
          <Routes><Route path="/tasks/:id" element={<TaskDetailPage />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const finished = await screen.findByText(/Finished generating JS\/WASM/);
    expect(finished.textContent).not.toContain('\x1b');
    expect(finished.textContent).not.toContain('[38;5;77m');
    expect(finished.textContent).toContain('step 2');
    expect(finished.textContent).not.toContain('step 1');
  });
});
