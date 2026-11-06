import React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { apiFetch, getClaudeSessionsPage, rescanClaudeSessions, ClaudeSession } from '../api/client';
import { Card, DataTable } from '../components/ui';
import { ModelBadge } from '../components/ModelBadge';
import { useLocale } from '../context/LocaleContext';
import { formatNumber } from '../utils/format';

type TaskUsage = { taskId: string; effectiveTokens: number };
type Session = ClaudeSession;
type Turn = { ts: string; turnId: string; effectiveTokens: number; input: number; output: number; tasks: TaskUsage[] };
type SessionDetail = Session & { turns: Turn[] };
const formatTokens = (value: number, locale: string) => formatNumber(value, { locale });
const formatTaskId = (id: string, outsideLabel: string) => (id === '_general' ? outsideLabel : id);

const SessionTable: React.FC<{ sessions: Session[]; page: number; pageSize: number; total: number; sortKey: string; sortDirection: 'asc' | 'desc'; onPageChange: (page: number) => void; onPageSizeChange: (size: number) => void; onSortChange: (key: string, direction: 'asc' | 'desc') => void }> = ({ sessions, page, pageSize, total, sortKey, sortDirection, onPageChange, onPageSizeChange, onSortChange }) => {
  const { t, locale } = useLocale();
  return (
    <DataTable
      rows={sessions}
      columns={[
        { key: 'title', title: t('extra.claudeSessions'), sortable: true, sortValue: (session) => session.title || session.sessionId, render: (session) => <div className="min-w-[260px]"><Link className="hover:text-[var(--t-accent)]" to={`/claude-sessions/${encodeURIComponent(session.sessionId)}`}><span className={`inline-block w-2 h-2 rounded-full mr-2 ${session.active ? 'bg-[var(--t-ok)]' : 'bg-[var(--t-text-3)]'}`} title={session.active ? t('claudeSessions.active') : ''} />{session.title || (session.sessionId.length > 8 ? session.sessionId.slice(0, 8) : session.sessionId)}</Link><div className="text-xs text-[var(--t-text-3)] truncate max-w-[320px]" title={session.cwd}>{session.cwd}</div></div> },
        { key: 'messages', title: t('extra.messages'), sortable: true, sortValue: (session) => session.messages, render: (session) => session.messages },
        { key: 'model', title: t('extra.model'), render: (session) => session.model ? <ModelBadge model={session.model} engine="claude" /> : t('extra.unknown') },
        { key: 'tokens', title: t('extra.token'), render: (session) => formatTokens(session.effectiveTokens, locale) },
        { key: 'task', title: t('extra.task'), render: (session) => session.topTasks.length > 0 ? session.topTasks.map((task) => `${formatTaskId(task.taskId, t('claudeSessions.outsideTask'))} (${formatTokens(task.effectiveTokens, locale)})`).join(', ') : t('claudeSessions.outsideTask') },
        { key: 'lastAt', title: t('extra.lastActive'), sortable: true, sortValue: (session) => session.lastAt || '', render: (session) => session.lastAt ? new Date(session.lastAt).toLocaleString(locale === 'vi' ? 'vi-VN' : 'en-US') : '' },
      ]}
      page={page}
      pageSize={pageSize}
      total={total}
      onPageChange={onPageChange}
      onPageSizeChange={onPageSizeChange}
      sortKey={sortKey}
      sortDirection={sortDirection}
      onSortChange={onSortChange}
      emptyTitle={t('pagination.empty')}
    />
  );
};

const TurnChart: React.FC<{ turns: Turn[]; label: string }> = ({ turns, label }) => {
  const max = Math.max(1, ...turns.map((turn) => turn.effectiveTokens));
  const width = Math.max(500, turns.length * 28);
  return (
    <svg className="w-full h-40" viewBox={`0 0 ${width} 120`} role="img" aria-label={label}>
      {turns.map((turn, index) => {
        const height = (turn.effectiveTokens / max) * 90;
        return <rect key={turn.turnId} x={index * Math.max(28, 500 / Math.max(1, turns.length))} y={105 - height} width="16" height={height} rx="3" fill="var(--t-claude)" />;
      })}
    </svg>
  );
};

const SessionDetail: React.FC<{ data: SessionDetail; sessionId: string }> = ({ data, sessionId }) => {
  const { t, locale } = useLocale();
  return (
    <div className="space-y-4 max-w-6xl mx-auto">
      <Link className="text-[var(--t-accent)] text-sm" to="/claude-sessions">← {t('extra.claudeSessions')}</Link>
      <Card>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{data.title || (sessionId.length > 8 ? sessionId.slice(0, 8) : sessionId)}</h1>
          {data.active && (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-[color-mix(in_srgb,var(--t-ok)_15%,transparent)] text-[var(--t-ok)] border border-[color-mix(in_srgb,var(--t-ok)_30%,transparent)]">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--t-ok)] animate-pulse" />
              {t('claudeSessions.active')}
            </span>
          )}
        </div>
        <p className="text-sm text-[var(--t-text-3)] mt-1 break-all flex items-center gap-1.5 flex-wrap"><span>{data.cwd}</span><span>·</span>{data.model ? <ModelBadge model={data.model} engine="claude" /> : <span>{t('extra.unknown')}</span>}</p>
        <label className="flex items-center gap-2 mt-4 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={data.autoResumeEnabled === 1}
            onChange={(event) => {
              void apiFetch(`/api/claude/sessions/${encodeURIComponent(sessionId)}/auto-resume`, {
                method: 'PATCH',
                body: JSON.stringify({ enabled: event.target.checked }),
              });
            }}
          />
          {t('claudeSessions.autoResumeLimit')}
        </label>
        {data.limitResetAt ? (
          <p className="text-sm text-[var(--t-warn)] mt-2">
            {t('claudeSessions.rateLimit5h', {
              time: new Date(data.limitResetAt * 1000 + 60_000).toLocaleString(locale === 'vi' ? 'vi-VN' : 'en-US'),
            })}
          </p>
        ) : null}
        <h2 className="font-semibold mt-6 mb-2">{t('extra.tokensOverTime')}</h2>
        <TurnChart turns={data.turns} label={t('extra.tokensOverTime')} />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[var(--t-text-3)]">
                <th className="py-2">{t('extra.tokensOverTime')}</th>
                <th>{t('extra.token')}</th>
                <th>{t('extra.task')}</th>
              </tr>
            </thead>
            <tbody>
              {data.turns.map((turn) => (
                <tr className="border-t border-[var(--t-border)]" key={`${turn.turnId}-${turn.ts}`}>
                  <td className="py-2">{new Date(turn.ts).toLocaleString(locale === 'vi' ? 'vi-VN' : 'en-US')}</td>
                  <td>{formatTokens(turn.effectiveTokens, locale)}</td>
                  <td>
                    {turn.tasks.length > 0
                      ? turn.tasks
                          .map((task) => `${formatTaskId(task.taskId, t('claudeSessions.outsideTask'))} (${formatTokens(task.effectiveTokens, locale)})`)
                          .join(', ')
                      : t('claudeSessions.outsideTask')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
};

export const ClaudeSessionsPage: React.FC = () => {
  const { t } = useLocale();
  const { sessionId } = useParams();
  const queryClient = useQueryClient();
  const [urlParams, setUrlParams] = useSearchParams();
  const [page, setPage] = React.useState(Math.max(1, Number(urlParams.get('page') || 1)));
  const [pageSize, setPageSize] = React.useState(Math.max(20, Number(urlParams.get('pageSize') || 20)));
  const [sortKey, setSortKey] = React.useState<'lastAt' | 'title' | 'messages' | 'effectiveTokens'>((urlParams.get('sort') as 'lastAt' | 'title' | 'messages' | 'effectiveTokens') || 'lastAt');
  const [sortDirection, setSortDirection] = React.useState<'asc' | 'desc'>((urlParams.get('order') as 'asc' | 'desc') || 'desc');
  const sessions = useQuery({ queryKey: ['claude-sessions', page, pageSize, sortKey, sortDirection], queryFn: () => getClaudeSessionsPage({ limit: pageSize, offset: (page - 1) * pageSize, sort: sortKey, order: sortDirection }) });
  const detail = useQuery({ queryKey: ['claude-session', sessionId], queryFn: () => apiFetch<SessionDetail>(`/api/claude/sessions/${encodeURIComponent(sessionId!)}`), enabled: !!sessionId });
  const rescan = useMutation({ mutationFn: rescanClaudeSessions, onSuccess: () => queryClient.invalidateQueries({ queryKey: ['claude-sessions'] }) });

  if (sessionId && detail.data) return <SessionDetail data={detail.data} sessionId={sessionId} />;
  return (
    <div className="space-y-4 max-w-6xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t('extra.claudeSessions')}</h1>
          <p className="text-xs text-[var(--t-text-3)] mt-0.5">{t('claudeSessions.scopeNote')}</p>
        </div>
        <button
          type="button"
          onClick={() => rescan.mutate()}
          disabled={rescan.isPending}
          className="rounded-lg bg-[var(--t-accent)] text-[var(--t-on-accent)] px-3 py-2 text-sm disabled:opacity-50 self-start sm:self-auto cursor-pointer"
        >
          {rescan.isPending ? '…' : t('extra.rescan')}
        </button>
      </div>
      <SessionTable
        sessions={sessions.data?.items || []}
        page={page}
        pageSize={pageSize}
        total={sessions.data?.total || 0}
        onPageChange={(nextPage) => { setPage(nextPage); setUrlParams((current) => { current.set('page', String(nextPage)); return current; }, { replace: true }); }}
        onPageSizeChange={(nextSize) => { setPageSize(nextSize); setPage(1); setUrlParams((current) => { current.delete('page'); current.set('pageSize', String(nextSize)); return current; }, { replace: true }); }}
        sortKey={sortKey}
        sortDirection={sortDirection}
        onSortChange={(key, direction) => { setSortKey(key as typeof sortKey); setSortDirection(direction); setPage(1); setUrlParams((current) => { current.delete('page'); current.set('sort', key); current.set('order', direction); return current; }, { replace: true }); }}
      />
    </div>
  );
};
