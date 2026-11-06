import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { LocaleProvider } from '../context/LocaleContext';
import { ClaudeQuotaCard } from '../components/ClaudeQuotaCard';
import type { ClaudeQuota } from '../types/api';

const inOneHour = Date.now() + 3600_000;
const observedAt = new Date().toISOString();

const quota: ClaudeQuota = {
  status: null,
  resetsAt: null,
  rateLimitType: null,
  observedAt: null,
  profiles: [
    { profileName: 'claude-may', status: 'allowed', resetsAt: inOneHour, rateLimitType: 'five_hour', observedAt, limited: false, source: 'header' },
    { profileName: 'g4', status: 'allowed_warning', resetsAt: inOneHour, rateLimitType: 'five_hour', observedAt, limited: false, source: 'header' },
    { profileName: 'g5', status: 'rejected', resetsAt: inOneHour, rateLimitType: 'five_hour', observedAt, limited: true, source: 'header' },
    { profileName: 'NCS', status: null, resetsAt: null, rateLimitType: null, observedAt, limited: false, source: 'header' },
  ],
};

const renderCard = (value: ClaudeQuota, locale: 'vi' | 'en' = 'vi') => render(
  <LocaleProvider initialLocale={locale}>
    <ClaudeQuotaCard quota={value} />
  </LocaleProvider>,
);

describe('ClaudeQuotaCard', () => {
  it('renders one tile per profile with a status tone and a summary', () => {
    renderCard(quota);
    const items = screen.getAllByTestId('claude-quota-item');
    expect(items).toHaveLength(4);
    expect(items.map((item) => item.getAttribute('data-tone'))).toEqual(['ok', 'warn', 'crit', 'unknown']);
    expect(within(items[0]).getByText('claude-may')).toBeInTheDocument();
    expect(within(items[0]).getByText('Còn quota')).toBeInTheDocument();
    expect(within(items[2]).getByText('Đã hết quota (tạm khoá)')).toBeInTheDocument();
    expect(within(items[3]).getByText('chưa rõ')).toBeInTheDocument();
    expect(screen.getByText('1/4 tài khoản còn quota')).toBeInTheDocument();
  });

  it('falls back to the aggregate status when there are no profiles', () => {
    renderCard({ status: 'allowed', resetsAt: inOneHour, rateLimitType: null, observedAt, limited: false }, 'en');
    const items = screen.getAllByTestId('claude-quota-item');
    expect(items).toHaveLength(1);
    expect(within(items[0]).getByText('Quota available')).toBeInTheDocument();
    expect(screen.queryByText(/accounts available/)).not.toBeInTheDocument();
  });
});
