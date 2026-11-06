import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_PALETTE_SIZE, buildProjectColorMap, hashProjectColorIndex, projectColor, projectColorIndex } from '../utils/projectColor';
import { ProjectTag } from '../components/ProjectTag';

describe('projectColor', () => {
  it('is stable per project and stays inside the palette', () => {
    for (const id of ['scrcpy', 'dev-insight', 'drone-strike-online', '', 'a'.repeat(200)]) {
      const index = projectColorIndex(id);
      expect(index).toBe(projectColorIndex(id));
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(PROJECT_PALETTE_SIZE);
      expect(projectColor(id)).toBe(`var(--t-project-${index})`);
    }
  });

  it('gives the first projects distinct colors in creation order, new projects do not shift old ones', () => {
    const projects = [
      { id: 'scrcpy', createdAt: '2026-11-02' },
      { id: 'dev-insight', createdAt: '2026-11-03' },
      { id: 'drone-strike-online', createdAt: '2026-11-01' },
      { id: 'agenthub', createdAt: '2026-11-04' },
    ];
    // scrcpy và dev-insight trùng màu nếu chỉ băm theo mã.
    expect(hashProjectColorIndex('scrcpy')).toBe(hashProjectColorIndex('dev-insight'));
    const map = buildProjectColorMap(projects);
    expect(['drone-strike-online', 'scrcpy', 'dev-insight', 'agenthub'].map((id) => map.get(id))).toEqual([0, 1, 2, 3]);
    const withNew = buildProjectColorMap([...projects, { id: 'zz-new', createdAt: '2026-11-05' }]);
    expect(withNew.get('zz-new')).toBe(4);
    expect(withNew.get('scrcpy')).toBe(1);
    expect(projectColor('unknown-project', map)).toBe(`var(--t-project-${hashProjectColorIndex('unknown-project')})`);
  });

  it('spreads different projects over several colors when hashing', () => {
    const used = new Set(Array.from({ length: 50 }, (_, i) => projectColorIndex(`project-${i}`)));
    expect(used.size).toBeGreaterThanOrEqual(7);
  });

  it('defines every palette token for both light and dark themes', () => {
    const css = readFileSync(join(process.cwd(), 'src/index.css'), 'utf8');
    for (let i = 0; i < PROJECT_PALETTE_SIZE; i++) {
      expect(css.match(new RegExp(`--t-project-${i}:`, 'g'))).toHaveLength(2);
    }
  });
});

describe('ProjectTag', () => {
  it('shows the project name from the projects cache and keeps the id as tooltip', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(['projects'], [
      { id: 'scrcpy', name: 'scrcpy', path: '/s', defaultBranch: 'master', maxParallel: 1, createdAt: '2026-11-01' },
      { id: 'dev-insight', name: 'Dev Insight', path: '/p', defaultBranch: 'main', maxParallel: 1, createdAt: '2026-11-02' },
    ]);
    render(<QueryClientProvider client={queryClient}><ProjectTag projectId="dev-insight" /></QueryClientProvider>);
    const tag = screen.getByTestId('project-tag');
    expect(tag).toHaveTextContent('Dev Insight');
    expect(tag).toHaveAttribute('title', 'dev-insight');
    expect(tag.getAttribute('style')).toContain('var(--t-project-1)');
  });

  it('falls back to the id without a QueryClient', () => {
    render(<ProjectTag projectId="scrcpy" />);
    expect(screen.getByTestId('project-tag')).toHaveTextContent('scrcpy');
  });
});
