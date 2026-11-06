import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CheckResults } from '../components/CheckResults';
import { LocaleProvider } from '../context/LocaleContext';
import type { CheckResult } from '../types/api';

describe('CheckResults component', () => {
  const sampleChecks: CheckResult[] = [
    {
      name: 'typecheck',
      ok: true,
      exitCode: 0,
      durationMs: 2500,
      outputTail: 'Found 0 errors.',
      seq: 1,
      runStartedAt: '2026-10-15 12:00:00',
    },
    {
      name: 'test',
      ok: false,
      exitCode: 1,
      durationMs: 4000,
      outputTail: '1 of 20 tests failed.',
      seq: 2,
      runStartedAt: '2026-10-15 12:00:00',
    },
    {
      name: 'build',
      ok: false,
      exitCode: null,
      durationMs: 0,
      outputTail: 'Skipped due to prior failure.',
      seq: 3,
      runStartedAt: '2026-10-15 12:00:00',
      skipped: true,
    },
  ];

  it('renders sequential numbers according to array order/seq', () => {
    render(
      <LocaleProvider initialLocale="vi">
        <CheckResults checks={sampleChecks} />
      </LocaleProvider>
    );

    // Badges 1, 2, 3 in rows
    expect(screen.getByTestId('check-seq-0')).toHaveTextContent('1');
    expect(screen.getByTestId('check-seq-1')).toHaveTextContent('2');
    expect(screen.getByTestId('check-seq-2')).toHaveTextContent('3');

    // Also check when seq is omitted, fallback to 1-based index
    const checksWithoutSeq: CheckResult[] = [
      { name: 'lint', ok: true, exitCode: 0, durationMs: 1000, outputTail: 'ok' },
      { name: 'zero-byte', ok: true, exitCode: 0, durationMs: 500, outputTail: 'ok' },
    ];

    render(
      <LocaleProvider initialLocale="vi">
        <CheckResults checks={checksWithoutSeq} />
      </LocaleProvider>
    );

    const badges = screen.getAllByTestId('check-seq-0');
    expect(badges[badges.length - 1]).toHaveTextContent('1');
  });

  it('renders stepper with correct number of nodes and status colors', () => {
    render(
      <LocaleProvider initialLocale="vi">
        <CheckResults checks={sampleChecks} />
      </LocaleProvider>
    );

    const stepper = screen.getByTestId('checks-stepper');
    expect(stepper).toBeInTheDocument();

    const node0 = screen.getByTestId('stepper-node-0');
    const node1 = screen.getByTestId('stepper-node-1');
    const node2 = screen.getByTestId('stepper-node-2');

    expect(node0).toHaveAttribute('data-status', 'passed');
    expect(node1).toHaveAttribute('data-status', 'failed');
    expect(node2).toHaveAttribute('data-status', 'skipped');

    // Class inspection for design token color variables
    expect(node0.className).toContain('--t-ok');
    expect(node1.className).toContain('--t-crit');
    expect(node2.className).toContain('--t-border');
    expect(node2.className).toContain('--t-text-3');
  });

  it('opens corresponding check row when stepper node is clicked', () => {
    // Mock scrollIntoView
    window.HTMLElement.prototype.scrollIntoView = vi.fn();

    render(
      <LocaleProvider initialLocale="vi">
        <CheckResults checks={sampleChecks} />
      </LocaleProvider>
    );

    // Initially output tails are closed
    expect(screen.queryByText('Found 0 errors.')).not.toBeInTheDocument();
    expect(screen.queryByText('1 of 20 tests failed.')).not.toBeInTheDocument();

    // Click step 0
    fireEvent.click(screen.getByTestId('stepper-node-0'));
    expect(screen.getByText('Found 0 errors.')).toBeInTheDocument();

    // Click step 1
    fireEvent.click(screen.getByTestId('stepper-node-1'));
    expect(screen.getByText('1 of 20 tests failed.')).toBeInTheDocument();
    expect(screen.queryByText('Found 0 errors.')).not.toBeInTheDocument();
  });

  it('displays total duration and runStartedAt in header if present', () => {
    render(
      <LocaleProvider initialLocale="vi">
        <CheckResults checks={sampleChecks} />
      </LocaleProvider>
    );

    // 2500 + 4000 + 0 = 6500ms = 6.5s
    const meta = screen.getByTestId('checks-summary-meta');
    expect(meta).toHaveTextContent('6.5s');
    expect(meta).toHaveTextContent(/Bắt đầu: \d{2}:\d{2}:\d{2}/);
  });

  it('renders empty state when no checks provided', () => {
    render(
      <LocaleProvider initialLocale="vi">
        <CheckResults checks={[]} />
      </LocaleProvider>
    );

    expect(screen.getByText('Chưa có kết quả kiểm tra.')).toBeInTheDocument();
    expect(screen.queryByTestId('checks-stepper')).not.toBeInTheDocument();
  });
});
