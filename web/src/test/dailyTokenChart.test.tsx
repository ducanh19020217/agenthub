import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { DailyTokenChart, fillDailyGaps, formatCompact, niceTicks } from '../components/DailyTokenChart';

const labels = { gemini: 'Gemini (agy)', codex: 'Codex', total: 'Tổng', codexShare: 'Tỷ trọng Codex', ariaLabel: 'Token worker theo từng ngày' };
const day = (date: string, geminiTokens: number, codexTokens: number) => ({ date, geminiTokens, codexTokens, totalTokens: geminiTokens + codexTokens });

describe('DailyTokenChart', () => {
  it('fills missing days so the date axis is continuous', () => {
    const points = fillDailyGaps([day('2026-11-16', 5, 1), day('2026-11-14', 2, 0)]);
    expect(points.map((p) => p.date)).toEqual(['2026-11-14', '2026-11-15', '2026-11-16']);
    expect(points[1]).toMatchObject({ total: 0, filled: true });
    expect(points[2]).toMatchObject({ gemini: 5, codex: 1, total: 6, filled: false });
  });

  it('picks nice y-axis ticks and compact labels', () => {
    expect(niceTicks(14_200_000)).toEqual([0, 5_000_000, 10_000_000, 15_000_000]);
    expect(niceTicks(23_000_000)).toEqual([0, 5_000_000, 10_000_000, 15_000_000, 20_000_000, 25_000_000]);
    expect(niceTicks(9_000)).toEqual([0, 2_500, 5_000, 7_500, 10_000]);
    expect(formatCompact(15_000_000, 'en')).toBe('15M');
    expect(formatCompact(2_500_000, 'en')).toBe('2.5M');
    expect(formatCompact(500_000, 'en')).toBe('500K');
  });

  it('renders stacked bars with Codex on top and a tooltip with the total and share', () => {
    render(<DailyTokenChart days={[day('2026-11-11', 9_000_000, 1_000_000), day('2026-11-13', 4_000_000, 0)]} locale="en" labels={labels} />);
    const chart = screen.getByTestId('daily-token-chart');
    expect(chart).toHaveAttribute('data-mode', 'bar');
    const cols = screen.getAllByTestId('daily-token-day');
    expect(cols).toHaveLength(3);
    const segments = cols[0].querySelectorAll('[data-series]');
    expect(Array.from(segments).map((s) => s.getAttribute('data-series'))).toEqual(['codex', 'gemini']);
    expect(cols[1].querySelectorAll('[data-series]')).toHaveLength(0);

    fireEvent.mouseEnter(cols[0]);
    const tip = screen.getByTestId('daily-token-tooltip');
    expect(within(tip).getByText('2026-11-11')).toBeInTheDocument();
    expect(within(tip).getByText('10,000,000')).toBeInTheDocument();
    expect(within(tip).getByText('10%')).toBeInTheDocument();
    fireEvent.mouseLeave(cols[0]);
    expect(screen.queryByTestId('daily-token-tooltip')).toBeNull();
  });

  it('switches to a stacked area for long ranges', () => {
    const days = Array.from({ length: 40 }, (_, i) => day(new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10), 1000 + i, 100));
    render(<DailyTokenChart days={days} locale="vi" labels={labels} />);
    expect(screen.getByTestId('daily-token-chart')).toHaveAttribute('data-mode', 'area');
    expect(screen.getByTestId('daily-token-chart').querySelectorAll('[data-series]')).toHaveLength(0);
  });
});
