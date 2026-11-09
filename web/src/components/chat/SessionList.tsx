import React, { useMemo, useState } from 'react';
import { ChatSession } from '../../types/api';
import { exportChatSession } from '../../api/chat';
import {
  Plus,
  MessageSquare,
  ShieldCheck,
  AlertTriangle,
  Trash2,
  Clock,
  Search,
  Pin,
  Pencil,
  Archive,
  ArchiveRestore,
  Download,
  Check,
  X,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { useLocale } from '../../context/LocaleContext';
import { formatDateTime, formatIsoTitle, parseApiTime, type TimeLocale } from '../../lib/time';
import { UI_Z_INDEX } from '../ui/layers';

export interface SessionListProps {
  sessions: ChatSession[];
  activeSessionId?: string | null;
  onSelectSession: (session: ChatSession) => void;
  onNewSession: () => void;
  onDeleteSession: (sessionId: string) => void;
  onPinSession?: (sessionId: string, pinned: boolean) => void;
  onRenameSession?: (sessionId: string, newTitle: string) => void;
  onArchiveSession?: (sessionId: string, archived: boolean) => void;
  onExportSession?: (session: ChatSession) => void;
  hasMore?: boolean;
  isLoadingMore?: boolean;
  onLoadMore?: () => void;
  isDeletingId?: string | null;
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
  className?: string;
}

function formatRelativeTime(
  dateString: string,
  t: (key: string, params?: Record<string, string | number>) => string,
  locale: TimeLocale = 'vi',
): string {
  const parsed = parseApiTime(dateString);
  if (!Number.isFinite(parsed)) return '';
  const now = Date.now();
  const diffSec = Math.max(0, Math.floor((now - parsed) / 1000));

  if (diffSec < 60) return t('extra.justNow');
  if (diffSec < 3600) return t('extra.minutesAgo', { count: Math.floor(diffSec / 60) });
  if (diffSec < 86400) return t('extra.hoursAgo', { count: Math.floor(diffSec / 3600) });
  return formatDateTime(parsed, locale, { seconds: false });
}

export const SessionList: React.FC<SessionListProps> = ({
  sessions,
  activeSessionId,
  onSelectSession,
  onNewSession,
  onDeleteSession,
  onPinSession,
  onRenameSession,
  onArchiveSession,
  onExportSession,
  hasMore = false,
  isLoadingMore = false,
  onLoadMore,
  isDeletingId,
  isCollapsed = false,
  onToggleCollapse,
  className = '',
}) => {
  const { t, locale } = useLocale();
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<'active' | 'archived'>('active');

  // Inline rename state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');

  // Delete confirmation modal state
  const [sessionToDelete, setSessionToDelete] = useState<ChatSession | null>(null);

  // Filter & sort sessions
  const filteredSessions = useMemo(() => {
    return sessions
      .filter((s) => {
        // Tab filter (active vs archived)
        const isArchived = Boolean(s.archived);
        if (activeTab === 'active' && isArchived) return false;
        if (activeTab === 'archived' && !isArchived) return false;

        // Search query filter
        if (!searchQuery.trim()) return true;
        const q = searchQuery.toLowerCase();
        const matchTitle = (s.title || '').toLowerCase().includes(q);
        const matchProject = (s.projectId || '').toLowerCase().includes(q);
        return matchTitle || matchProject;
      })
      .sort((a, b) => {
        // Pinned sessions come first
        const pinA = a.pinned ? 1 : 0;
        const pinB = b.pinned ? 1 : 0;
        if (pinA !== pinB) return pinB - pinA;

        // Then by updatedAt
        const timeA = parseApiTime(a.updatedAt) || 0;
        const timeB = parseApiTime(b.updatedAt) || 0;
        return timeB - timeA;
      });
  }, [sessions, activeTab, searchQuery]);

  const handleStartRename = (session: ChatSession, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(session.id);
    setEditTitle(session.title || '');
  };

  const handleSaveRename = (sessionId: string, e?: React.MouseEvent | React.FormEvent) => {
    if (e) e.stopPropagation();
    const trimmed = editTitle.trim();
    if (trimmed && onRenameSession) {
      onRenameSession(sessionId, trimmed);
    }
    setEditingId(null);
  };

  const handleCancelRename = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(null);
  };

  const handleExport = async (session: ChatSession, e: React.MouseEvent) => {
    e.stopPropagation();
    if (onExportSession) {
      onExportSession(session);
      return;
    }
    try {
      const markdown = await exportChatSession(session.id);
      const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${session.title || 'chat'}.md`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      alert(err.message || t('extra.exportMarkdownError'));
    }
  };

  const confirmDelete = () => {
    if (!sessionToDelete) return;
    onDeleteSession(sessionToDelete.id);
    setSessionToDelete(null);
  };

  if (isCollapsed) {
    return (
      <div className={`flex flex-col items-center py-3 bg-[var(--t-surface)] border-r border-[var(--t-border)] w-14 shrink-0 h-full ${className}`}>
        <button
          type="button"
          onClick={onToggleCollapse}
          title={t('extra.expandSessions')}
          aria-label={t('extra.expandSessions')}
          className="p-2 rounded-xl text-[var(--t-text-2)] hover:bg-[var(--t-hover)] hover:text-[var(--t-text)] cursor-pointer"
        >
          <ChevronRight className="w-5 h-5" />
        </button>
        <button
          type="button"
          onClick={onNewSession}
          title={t('extra.newChat')}
          aria-label={t('extra.newChat')}
          className="mt-3 p-2.5 rounded-xl bg-[var(--t-accent)] text-[var(--t-on-accent)] shadow-xs hover:bg-[var(--t-accent-hover)] cursor-pointer"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>
    );
  }

  return (
    <div data-tour="chat-sessions" className={`flex flex-col h-full bg-[var(--t-surface)] border-r border-[var(--t-border)] ${className}`}>
      {/* Top Header / New Chat Button & Collapse Button */}
      <div className="p-3 border-b border-[var(--t-border)] space-y-2.5">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onNewSession}
            data-tour="new-session"
            className="flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl bg-[var(--t-accent)] hover:bg-[var(--t-accent-hover)] text-[var(--t-on-accent)] font-medium text-xs shadow-xs transition-colors cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>+ {t('extra.newChat')}</span>
          </button>
          {onToggleCollapse && (
            <button
              type="button"
              onClick={onToggleCollapse}
              title={t('extra.collapseSessions')}
              aria-label={t('extra.collapseSessions')}
              className="p-2 rounded-xl border border-[var(--t-border)] text-[var(--t-text-2)] hover:bg-[var(--t-hover)] cursor-pointer shrink-0"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Search input */}
        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--t-text-3)] pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('extra.searchSessionsPlaceholder')}
            aria-label={t('extra.searchSessionsAria')}
            className="w-full pl-8 pr-7 py-1.5 rounded-lg text-xs bg-[var(--t-surface-2)] border border-[var(--t-border)] text-[var(--t-text)] placeholder-[var(--t-text-3)] focus:outline-hidden focus:border-[var(--t-accent)]"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-[var(--t-text-3)] hover:text-[var(--t-text)] cursor-pointer"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>

        {/* Filter Tabs: Active vs Archived */}
        <div className="flex items-center gap-1 p-0.5 rounded-lg bg-[var(--t-surface-2)] border border-[var(--t-border)] text-[11px]">
          <button
            type="button"
            onClick={() => setActiveTab('active')}
            className={`flex-1 py-1 rounded-md text-center font-medium transition-colors cursor-pointer ${
              activeTab === 'active'
                ? 'bg-[var(--t-surface)] text-[var(--t-text)] shadow-xs'
                : 'text-[var(--t-text-2)] hover:text-[var(--t-text)]'
            }`}
          >
            {t('extra.tabActive')}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('archived')}
            className={`flex-1 py-1 rounded-md text-center font-medium transition-colors cursor-pointer ${
              activeTab === 'archived'
                ? 'bg-[var(--t-surface)] text-[var(--t-text)] shadow-xs'
                : 'text-[var(--t-text-2)] hover:text-[var(--t-text)]'
            }`}
          >
            {t('extra.tabArchived')}
          </button>
        </div>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {filteredSessions.length === 0 ? (
          <div className="p-6 text-center text-xs text-[var(--t-text-2)]">
            {searchQuery
              ? t('extra.noMatchingChats')
              : activeTab === 'archived'
              ? t('extra.noArchivedChats')
              : t('extra.noChats')}
          </div>
        ) : (
          filteredSessions.map((session) => {
            const isActive = session.id === activeSessionId;
            const isEditing = editingId === session.id;
            const isPinned = Boolean(session.pinned);
            const isArchived = Boolean(session.archived);

            const brainGroup = session.kind === 'assistant' ? 'assistant' : session.id === 'brain' ? 'system' : session.id.startsWith('brain:') ? 'project' : null;
            const groupLabel = brainGroup === 'assistant' ? t('extra.assistantChats') : brainGroup === 'system' ? t('extra.systemBrain') : t('extra.projectBrains');
            return (
              <React.Fragment key={session.id}>
                {brainGroup && (filteredSessions.findIndex((item) => (item.kind === 'assistant' ? 'assistant' : item.id === 'brain' ? 'system' : item.id.startsWith('brain:') ? 'project' : null) === brainGroup) === filteredSessions.indexOf(session)) && <div className="px-2 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--t-text-3)]">{groupLabel}</div>}
              <div
                key={session.id}
                role="button"
                tabIndex={0}
                onClick={() => onSelectSession(session)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    onSelectSession(session);
                  }
                }}
                className={`group relative p-2.5 rounded-xl cursor-pointer transition-all border text-left ${
                  isActive
                    ? 'bg-[var(--t-selected)] border-[var(--t-accent)]/30 text-[var(--t-text)]'
                    : 'border-transparent hover:bg-[var(--t-hover)] text-[var(--t-text)]'
                }`}
              >
                <div className="flex items-start justify-between gap-1.5">
                  <div className="flex items-center gap-1.5 min-w-0 flex-1">
                    <MessageSquare
                      className={`w-4 h-4 shrink-0 ${
                        isActive ? 'text-[var(--t-accent)]' : 'text-[var(--t-text-2)]'
                      }`}
                    />
                    {isEditing ? (
                      <div
                        className="flex items-center gap-1 flex-1 min-w-0"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="text"
                          value={editTitle}
                          onChange={(e) => setEditTitle(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleSaveRename(session.id);
                            if (e.key === 'Escape') setEditingId(null);
                          }}
                          autoFocus
                          aria-label={t('extra.newNameAria')}
                          className="w-full px-2 py-0.5 text-xs rounded border border-[var(--t-accent)] bg-[var(--t-surface)] text-[var(--t-text)] focus:outline-hidden"
                        />
                        <button
                          type="button"
                          onClick={(e) => handleSaveRename(session.id, e)}
                          title={t('extra.saveName')}
                          aria-label={t('extra.saveName')}
                          className="p-1 rounded text-[var(--t-ok)] hover:bg-[var(--t-surface-2)]"
                        >
                          <Check className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={handleCancelRename}
                          title={t('extra.cancelRename')}
                          aria-label={t('extra.cancelRename')}
                          className="p-1 rounded text-[var(--t-text-3)] hover:bg-[var(--t-surface-2)]"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5 min-w-0 flex-1">
                        {isPinned && (
                          <Pin className="w-3 h-3 text-[var(--t-warn)] fill-current shrink-0" />
                        )}
                        <span className="font-medium text-xs truncate">
                          {session.title || t('extra.chat')}
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Actions Toolbar */}
                  {!isEditing && (
                    <div className="opacity-0 group-hover:opacity-100 focus-within:opacity-100 flex items-center gap-0.5 shrink-0 transition-opacity">
                      {/* Pin button */}
                      {onPinSession && (
                        <button
                          type="button"
                          title={isPinned ? t('extra.unpinSession') : t('extra.pinSession')}
                          aria-label={isPinned ? t('extra.unpinSession') : t('extra.pinSession')}
                          onClick={(e) => {
                            e.stopPropagation();
                            onPinSession(session.id, !isPinned);
                          }}
                          className={`p-1 rounded-md text-[var(--t-text-3)] hover:text-[var(--t-warn)] hover:bg-[var(--t-surface-2)] transition-colors ${
                            isPinned ? 'text-[var(--t-warn)]' : ''
                          }`}
                        >
                          <Pin className="w-3.5 h-3.5" />
                        </button>
                      )}

                      {/* Rename button */}
                      {onRenameSession && (
                        <button
                          type="button"
                          title={t('extra.renameSession')}
                          aria-label={t('extra.renameSession')}
                          onClick={(e) => handleStartRename(session, e)}
                          className="p-1 rounded-md text-[var(--t-text-3)] hover:text-[var(--t-text)] hover:bg-[var(--t-surface-2)] transition-colors"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                      )}

                      {/* Archive button */}
                      {onArchiveSession && (
                        <button
                          type="button"
                          title={isArchived ? t('extra.unarchiveSession') : t('extra.archiveSession')}
                          aria-label={isArchived ? t('extra.unarchiveSession') : t('extra.archiveSession')}
                          onClick={(e) => {
                            e.stopPropagation();
                            onArchiveSession(session.id, !isArchived);
                          }}
                          className="p-1 rounded-md text-[var(--t-text-3)] hover:text-[var(--t-text)] hover:bg-[var(--t-surface-2)] transition-colors"
                        >
                          {isArchived ? (
                            <ArchiveRestore className="w-3.5 h-3.5" />
                          ) : (
                            <Archive className="w-3.5 h-3.5" />
                          )}
                        </button>
                      )}

                      {/* Export Markdown button */}
                      <button
                        type="button"
                        title={t('extra.exportMarkdown')}
                        aria-label={t('extra.exportMarkdown')}
                        onClick={(e) => handleExport(session, e)}
                        className="p-1 rounded-md text-[var(--t-text-3)] hover:text-[var(--t-text)] hover:bg-[var(--t-surface-2)] transition-colors"
                      >
                        <Download className="w-3.5 h-3.5" />
                      </button>

                      {/* Delete button (with confirmation) */}
                      <button
                        type="button"
                        title={t('extra.deleteSession')}
                        aria-label={t('extra.deleteSession')}
                        aria-busy={isDeletingId === session.id ? true : undefined}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (session.busy) {
                            alert(t('extra.busySession'));
                            return;
                          }
                          setSessionToDelete(session);
                        }}
                        disabled={isDeletingId === session.id}
                        className="p-1 rounded-md text-[var(--t-text-3)] hover:text-[var(--t-crit)] hover:bg-[var(--t-crit)]/10 transition-colors focus:outline-hidden focus-visible:ring-2 focus-visible:ring-[var(--t-accent)]"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </div>

                {/* Subtitle / Badges */}
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px]">
                  {/* Mode Badge */}
                  {session.mode === 'full' ? (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--t-crit)]/10 text-[var(--t-crit)] border border-[var(--t-crit)]/20 font-medium">
                      <AlertTriangle className="w-3 h-3" />
                      <span>{t('extra.fullMode')}</span>
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--t-ok)]/10 text-[var(--t-ok)] border border-[var(--t-ok)]/20 font-medium">
                      <ShieldCheck className="w-3 h-3" />
                      <span>{t('extra.safeMode')}</span>
                    </span>
                  )}

                  {/* Project badge */}
                  {session.projectId && (
                    <span className="px-1.5 py-0.5 rounded bg-[var(--t-surface-2)] text-[var(--t-text-2)] border border-[var(--t-border)] font-mono">
                      {session.projectId}
                    </span>
                  )}

                  {/* Busy / Answering indicator */}
                  {session.busy && (
                    <span className="inline-flex items-center gap-1 text-[var(--t-accent)] font-medium animate-pulse ml-auto">
                      <span className="w-1.5 h-1.5 rounded-full bg-[var(--t-accent)]" />
                      <span>{t('extra.answering')}</span>
                    </span>
                  )}

                  {/* Time */}
                  {!session.busy && (
                    <span
                      className="inline-flex items-center gap-1 text-[var(--t-text-3)] ml-auto"
                      title={formatIsoTitle(session.updatedAt)}
                    >
                      <Clock className="w-3 h-3" />
                      <span>{formatRelativeTime(session.updatedAt, t, locale)}</span>
                    </span>
                  )}
                </div>
              </div>
              </React.Fragment>
            );
          })
        )}
        {hasMore && onLoadMore && (
          <button
            type="button"
            onClick={onLoadMore}
            disabled={isLoadingMore}
            className="w-full rounded-lg px-3 py-2 text-xs font-medium text-[var(--t-accent)] hover:bg-[var(--t-hover)] disabled:opacity-50"
          >
            {isLoadingMore ? t('pagination.loading') : t('tasks.showMore')}
          </button>
        )}
      </div>

      {/* Delete Confirmation Modal */}
      {sessionToDelete && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t('extra.confirmDeleteTitle')}
          className="fixed inset-0 flex items-center justify-center p-4 bg-[var(--t-overlay)] backdrop-blur-xs animate-fade-in"
          style={{ zIndex: UI_Z_INDEX.modal }}
        >
          <div className="bg-[var(--t-surface)] border border-[var(--t-border)] rounded-2xl p-5 max-w-sm w-full shadow-2xl space-y-4">
            <div className="flex items-center gap-2.5 text-[var(--t-crit)] font-semibold text-sm">
              <AlertTriangle className="w-5 h-5 shrink-0" />
              <span>{t('extra.confirmDeleteTitle')}</span>
            </div>

            <p className="text-xs text-[var(--t-text-2)] leading-relaxed">
              {t('extra.confirmDeleteDesc', { title: sessionToDelete.title || t('extra.chat') })}
            </p>

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setSessionToDelete(null)}
                className="px-3 py-1.5 rounded-xl border border-[var(--t-border)] hover:bg-[var(--t-hover)] text-xs text-[var(--t-text-2)] font-medium cursor-pointer"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={confirmDelete}
                data-testid="confirm-delete-button"
                className="px-3 py-1.5 rounded-xl bg-[var(--t-crit)] hover:bg-[var(--t-crit)]/90 text-[var(--t-on-accent)] text-xs font-semibold shadow-xs cursor-pointer"
              >
                {t('extra.confirmDeleteBtn')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// Backwards compatibility alias
export const ChatSessionList = SessionList;
export type ChatSessionListProps = SessionListProps;
