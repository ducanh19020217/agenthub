import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';
import { LocaleProvider, useLocale } from '../context/LocaleContext';
import { StatusBadge } from '../components/StatusBadge';
import { translate } from '../locales';
import { Layout } from '../components/Layout';
import { ChatInput } from '../components/chat/ChatInput';
import { ThemeProvider } from '../context/ThemeContext';

const TestConsumer: React.FC = () => {
  const { locale, toggleLocale, setLocale, t } = useLocale();
  return (
    <div>
      <span data-testid="current-locale">{locale}</span>
      <span data-testid="dashboard-text">{t('common.dashboard')}</span>
      <span data-testid="param-text">{t('dashboard.workersExecuting', { count: 3 })}</span>
      <button data-testid="toggle-btn" onClick={toggleLocale}>
        Toggle
      </button>
      <button data-testid="set-en-btn" onClick={() => setLocale('en')}>
        Set EN
      </button>
    </div>
  );
};

describe('i18n & LocaleContext', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('translates with default Vietnamese locale', () => {
    render(
      <LocaleProvider key="vi-layout" initialLocale="vi">
        <TestConsumer />
      </LocaleProvider>,
    );

    expect(screen.getByTestId('current-locale').textContent).toBe('vi');
    expect(screen.getByTestId('dashboard-text').textContent).toBe('Tổng quan');
    expect(screen.getByTestId('param-text').textContent).toBe('3 worker đang thực thi');
  });

  it('switches to English when setLocale or toggleLocale is called', () => {
    render(
      <LocaleProvider initialLocale="vi">
        <TestConsumer />
      </LocaleProvider>,
    );

    fireEvent.click(screen.getByTestId('toggle-btn'));
    expect(screen.getByTestId('current-locale').textContent).toBe('en');
    expect(screen.getByTestId('dashboard-text').textContent).toBe('Dashboard');
    expect(screen.getByTestId('param-text').textContent).toBe('3 worker(s) running');

    fireEvent.click(screen.getByTestId('toggle-btn'));
    expect(screen.getByTestId('current-locale').textContent).toBe('vi');
    expect(screen.getByTestId('dashboard-text').textContent).toBe('Tổng quan');
  });

  it('persists selected locale in localStorage', () => {
    render(
      <LocaleProvider>
        <TestConsumer />
      </LocaleProvider>,
    );

    fireEvent.click(screen.getByTestId('set-en-btn'));
    expect(localStorage.getItem('agenthub_locale')).toBe('en');
    expect(document.documentElement.lang).toBe('en');
  });

  it('renders StatusBadge in English when inside English LocaleProvider', () => {
    render(
      <LocaleProvider key="en-layout" initialLocale="en">
        <StatusBadge status="running" />
        <StatusBadge status="review" />
        <StatusBadge status="done" />
        <StatusBadge status="waiting_quota" />
        <StatusBadge status="blocked" />
        <StatusBadge status="failed" />
      </LocaleProvider>,
    );

    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.getByText('In Review')).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(screen.getByText('Waiting')).toBeInTheDocument();
    expect(screen.getByText('Blocked')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
  });

  it('translate helper falls back to Vietnamese or key if missing', () => {
    expect(translate('en', 'common.dashboard')).toBe('Dashboard');
    expect(translate('vi', 'common.dashboard')).toBe('Tổng quan');
    expect(translate('en', 'nonexistent.key')).toBe('nonexistent.key');
  });

  it('translates all Kanban status titles in Vietnamese and English', () => {
    const statuses = [
      'draft',
      'queued',
      'running',
      'waiting_quota',
      'review',
      'blocked',
      'failed',
      'done',
      'cancelled',
    ] as const;

    const viExpected = {
      draft: 'Nháp',
      queued: 'Chờ chạy',
      running: 'Đang chạy',
      waiting_quota: 'Đang chờ',
      review: 'Chờ duyệt',
      blocked: 'Bị chặn',
      failed: 'Lỗi',
      done: 'Hoàn thành',
      cancelled: 'Đã hủy',
    };

    const enExpected = {
      draft: 'Draft',
      queued: 'Queued',
      running: 'Running',
      waiting_quota: 'Waiting',
      review: 'In Review',
      blocked: 'Blocked',
      failed: 'Failed',
      done: 'Done',
      cancelled: 'Cancelled',
    };

    for (const s of statuses) {
      expect(translate('vi', `status.${s}`)).toBe(viExpected[s]);
      expect(translate('en', `status.${s}`)).toBe(enExpected[s]);
    }
  });

  it('switches dashboard navigation and chat controls between Vietnamese and English', () => {
    const { rerender } = render(
      <LocaleProvider initialLocale="vi">
        <ThemeProvider><MemoryRouter><Layout /></MemoryRouter></ThemeProvider>
      </LocaleProvider>,
    );
    expect(screen.getAllByText('Tổng quan').length).toBeGreaterThan(0);
    rerender(
      <LocaleProvider key="en-chat" initialLocale="en">
        <ThemeProvider><MemoryRouter><Layout /></MemoryRouter></ThemeProvider>
      </LocaleProvider>,
    );
    expect(screen.getAllByText('Dashboard').length).toBeGreaterThan(0);

    rerender(
      <LocaleProvider initialLocale="en">
        <ChatInput onSend={() => {}} onCancel={() => {}} busy={false} isEmpty={false} />
      </LocaleProvider>,
    );
    expect(screen.getByPlaceholderText(/Type a message/)).toBeInTheDocument();
  });
});
