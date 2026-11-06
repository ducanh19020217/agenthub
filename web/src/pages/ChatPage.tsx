import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  stopChatSession,
  createChatSession,
  updateChatSession,
  deleteChatSession,
  getChatMessages,
  getChatSessions,
  sendChatMessage,
  warmChatSession,
  decideChatPermission,
  getChatPermissions,
  compactChatSession,
  forkSummaryChatSession,
  normalizeMessagesResponse,
  retryChatLimitNow,
} from '../api/chat';
import { getConfig } from '../api/client';
import { subscribeToEvents } from '../api/sse';
import { ChatMessage, ChatMode, ChatSession, ChatPermissionRequest, UpdateChatSessionInput } from '../types/api';
import { SessionList } from '../components/chat/SessionList';
import { MessageList } from '../components/chat/MessageList';
import { Composer } from '../components/chat/Composer';
import { ContextMeter } from '../components/chat/ContextMeter';
import { SecretRequestCard } from '../components/chat/SecretRequestCard';
import { NewSessionModal } from '../components/chat/NewSessionModal';
import { useLocale } from '../context/LocaleContext';
import { UI_Z_INDEX } from '../components/ui/layers';
import {
  Menu,
  X,
  Plus,
  Bot,
  Square,
  RotateCcw,
} from 'lucide-react';
import { ToastViewport, useToasts, type ToastKind } from '../components/ui/Toast';

const EMPTY_SESSIONS: ChatSession[] = [];
type ChatSessionsQuery = { pages: Array<{ items: ChatSession[]; total: number; nextCursor: string | null }>; pageParams: unknown[] };

function updateChatSessionPages(
  queryClient: ReturnType<typeof useQueryClient>,
  updater: (sessions: ChatSession[]) => ChatSession[],
): void {
  queryClient.setQueryData<ChatSessionsQuery>(['chatSessions'], (current) => {
    if (!current) return current;
    return {
      ...current,
      pages: current.pages.map((page) => ({ ...page, items: updater(page.items) })),
    };
  });
}

export const ChatPage: React.FC = () => {
  const { t } = useLocale();
  const { sessionId } = useParams<{ sessionId?: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const { toasts, push: pushToast, dismiss: dismissToast } = useToasts();
  const setToastMessage = (title: string, kind: ToastKind = 'error') => pushToast({ title, kind, duration: kind === 'error' ? 6000 : 3500 });
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null);
  const [isLocalBusy, setIsLocalBusy] = useState(false);
  const [permission, setPermission] = useState<ChatPermissionRequest | null>(null);
  const [editText, setEditText] = useState<string | null>(null);
  const retryLimitMutation = useMutation({
    mutationFn: (id: string) => retryChatLimitNow(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['chatSessions'] }),
  });

  // Fetch chat sessions
  const sessionsQuery = useInfiniteQuery({
    queryKey: ['chatSessions'],
    queryFn: async ({ pageParam }) => {
      const result = await getChatSessions({ limit: 50, cursor: pageParam });
      if (Array.isArray(result)) return { items: result, total: result.length, nextCursor: null };
      return result;
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor || undefined,
  });
  const sessions = useMemo(
    () => sessionsQuery.data?.pages.flatMap((page) => page.items) || EMPTY_SESSIONS,
    [sessionsQuery.data],
  );
  const isSessionsLoading = sessionsQuery.isLoading;
  const { data: systemConfig } = useQuery({ queryKey: ['config'], queryFn: getConfig });

  // Resolve active session
  const activeSession = useMemo(() => {
    if (sessionId) {
      return sessions.find((s) => s.id === sessionId) || null;
    }
    return null;
  }, [sessionId, sessions]);

  // Navigate to first session if no sessionId specified
  useEffect(() => {
    if (!sessionId && sessions.length > 0 && !isSessionsLoading) {
      navigate(`/chat/${sessions[0].id}`, { replace: true });
    }
  }, [sessionId, sessions, isSessionsLoading, navigate]);

  // Pagination & Messages State
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  // Fetch initial messages for active session
  const {
    data: remoteMessages,
    isLoading: isMessagesLoading,
  } = useQuery({
    queryKey: ['chatMessages', activeSession?.id],
    queryFn: () => getChatMessages(activeSession!.id, { limit: 50 }),
    enabled: !!activeSession?.id,
  });

  useEffect(() => {
    if (remoteMessages) {
      const normalized = normalizeMessagesResponse(remoteMessages);
      setMessages(normalized.messages);
      setHasMore(normalized.hasMore);
    }
  }, [remoteMessages]);

  useEffect(() => {
    if (activeSession?.id) warmChatSession(activeSession.id).catch(() => {});
  }, [activeSession?.id]);

  useEffect(() => {
    if (!activeSession?.id) { setPermission(null); return; }
    getChatPermissions(activeSession.id).then((items) => setPermission(items[0] || null)).catch(() => {});
  }, [activeSession?.id]);

  const [thinkingSince, setThinkingSince] = useState<number | null>(null);
  const [thinkingSeconds, setThinkingSeconds] = useState(0);
  const [currentTool, setCurrentTool] = useState<string | null>(null);
  const [toolStepCount, setToolStepCount] = useState(0);
  const isBusy = Boolean(activeSession?.busy || isLocalBusy || streamingMessageId);

  useEffect(() => {
    if (!isBusy) { setThinkingSince(null); setThinkingSeconds(0); setToolStepCount(0); return; }
    const started = thinkingSince || Date.now();
    if (!thinkingSince) setThinkingSince(started);
    const timer = setInterval(() => setThinkingSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [isBusy, thinkingSince]);

  // The compact endpoint ships with this dashboard build; an unauthenticated OPTIONS probe
  // used to log a 401 on every session switch.
  const hasCompactApi = Boolean(activeSession?.id);

  // Load older messages (infinite scroll up)
  const handleLoadMore = async () => {
    if (!activeSession?.id || isLoadingMore || !hasMore || messages.length === 0) return;
    const oldestId = messages[0].id;
    setIsLoadingMore(true);
    try {
      const res = await getChatMessages(activeSession.id, { before: oldestId, limit: 50 });
      const normalized = normalizeMessagesResponse(res);
      setMessages((prev) => [...normalized.messages, ...prev]);
      setHasMore(normalized.hasMore);
    } catch (err: any) {
      setToastMessage(err.message || t('extra.failedLoadMessages'));
    } finally {
      setIsLoadingMore(false);
    }
  };

  // Listen to SSE Events
  useEffect(() => {
    const unsub = subscribeToEvents((event) => {
      const type = event.type;
      const payload = event.payload || {};
      const targetSessionId = payload.sessionId;

      if (!targetSessionId || targetSessionId !== activeSession?.id) {
        return;
      }

      if (type === 'chat.delta') {
        const { messageId, text } = payload;
        setStreamingMessageId(messageId);
        setIsLocalBusy(true);

        setMessages((prev) => {
          const index = prev.findIndex((m) => m.id === messageId);
          if (index !== -1) {
            const updated = [...prev];
            updated[index] = {
              ...updated[index],
              content: updated[index].content + text,
            };
            return updated;
          }
          const newMsg: ChatMessage = {
            id: messageId,
            role: 'assistant',
            content: text,
            createdAt: new Date().toISOString(),
          };
          return [...prev, newMsg];
        });
      } else if (type === 'chat.tool') {
        const { messageId, toolMessageId, toolUseId, name, summary, input, output, status, durationMs, diff } = payload;
        const toolId = toolMessageId || `tool-${toolUseId || messageId}`;
        if (status !== 'done' && status !== 'error') setToolStepCount((count) => count + 1);
        setCurrentTool(summary || name || null);
        setMessages((prev) => {
          const existingIndex = prev.findIndex((message) => message.id === toolId);
          if (existingIndex !== -1) {
            const updated = [...prev];
            updated[existingIndex] = {
              ...updated[existingIndex],
              content: summary || name || updated[existingIndex].content,
              meta: {
                ...updated[existingIndex].meta,
                name,
                summary,
                ...(input !== undefined ? { input } : {}),
                ...(output !== undefined ? { output } : {}),
                ...(status !== undefined ? { status } : {}),
                ...(durationMs !== undefined ? { durationMs } : {}),
                ...(diff !== undefined ? { diff } : {}),
              },
            };
            return updated;
          }
          const toolMsg: ChatMessage = {
            id: toolId,
            role: 'tool',
            content: summary || name,
            meta: { name, summary, input, output, status, durationMs, diff },
            createdAt: new Date().toISOString(),
          };
          return [...prev, toolMsg];
        });
      } else if (type === 'chat.done') {
        const { messageId, durationMs, costUsd, numTurns } = payload;
        setStreamingMessageId(null);
        setIsLocalBusy(false);
        setCurrentTool(null);

        setMessages((prev) => {
          const index = prev.findIndex((m) => m.id === messageId);
          if (index !== -1) {
            const updated = [...prev];
            updated[index] = {
              ...updated[index],
              meta: {
                ...updated[index].meta,
                durationMs,
                costUsd,
                numTurns,
              },
            };
            return updated;
          }
          return prev;
        });

        queryClient.invalidateQueries({ queryKey: ['chatSessions'] });
      } else if (type === 'chat.error') {
        const { messageId, message } = payload;
        setStreamingMessageId(null);
        setIsLocalBusy(false);
        setCurrentTool(null);

        setMessages((prev) => [
          ...prev,
          {
            id: messageId || `err-${Date.now()}`,
            role: 'error',
            content: message || t('extra.processingError'),
            createdAt: new Date().toISOString(),
          },
        ]);

        queryClient.invalidateQueries({ queryKey: ['chatSessions'] });
      } else if (type === 'chat.compacted') {
        setToastMessage(t('extra.compacted'), 'success');
        queryClient.invalidateQueries({ queryKey: ['chatMessages', activeSession?.id] });
        queryClient.invalidateQueries({ queryKey: ['chatSessions'] });
      } else if (type === 'chat.status') {
        updateChatSessionPages(queryClient, (prev) =>
          prev.map((session) =>
            session.id === targetSessionId
              ? {
                  ...session,
                  state: payload.status,
                  busy: payload.status !== 'idle' && payload.status !== 'error',
                }
              : session,
          ),
        );
      } else if (type === 'chat.permission_request') {
        let input: Record<string, unknown> = {};
        try {
          input = typeof payload.input === 'string' ? JSON.parse(payload.input) : (payload.input || {});
        } catch { /* malformed stays empty */ }
        setPermission({
          id: String(payload.id),
          sessionId: targetSessionId,
          messageId: payload.messageId,
          toolName: String(payload.toolName || 'tool'),
          input,
          status: 'pending',
          message: null,
          createdAt: String(payload.createdAt || new Date().toISOString()),
        });
      } else if (type === 'chat.permission_resolved' && permission?.id === payload.id) {
        setPermission(null);
      }
    });

    return () => unsub();
  }, [activeSession?.id, queryClient, permission?.id, t]);

  const resolvePermission = async (decision: 'allow' | 'deny' | 'allow_always') => {
    if (!permission) return;
    try {
      await decideChatPermission(permission.id, decision);
      setPermission(null);
    } catch (err: any) {
      setToastMessage(err.message || t('extra.failedHandlePermission'));
    }
  };

  // Mutations
  const createSessionMutation = useMutation({
    mutationFn: (data: any) => createChatSession(data),
    onSuccess: (newSession) => {
      queryClient.setQueryData<ChatSessionsQuery>(['chatSessions'], (current) => {
        if (!current || current.pages.length === 0) return current;
        return { ...current, pages: [{ ...current.pages[0], items: [newSession, ...current.pages[0].items] }, ...current.pages.slice(1)] };
      });
      setIsModalOpen(false);
      setMobileDrawerOpen(false);
      navigate(`/chat/${newSession.id}`);
    },
    onError: (err: any) => {
      alert(err.message || t('extra.createChatError'));
    },
  });

  const updateSessionMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateChatSessionInput }) =>
      updateChatSession(id, data),
    onSuccess: (updatedSession) => {
      updateChatSessionPages(queryClient, (prev) =>
        prev.map((s) => (s.id === updatedSession.id ? { ...s, ...updatedSession } : s)),
      );
    },
    onError: (err: any) => {
      setToastMessage(err.message || t('extra.failedUpdateSession'));
    },
  });

  const deleteSessionMutation = useMutation({
    mutationFn: (id: string) => deleteChatSession(id),
    onSuccess: (_, deletedId) => {
      updateChatSessionPages(queryClient, (prev) =>
        prev.filter((s) => s.id !== deletedId),
      );
      if (activeSession?.id === deletedId) {
        const remaining = sessions.filter((s) => s.id !== deletedId);
        if (remaining.length > 0) {
          navigate(`/chat/${remaining[0].id}`);
        } else {
          navigate('/chat');
        }
      }
    },
    onError: (err: any) => {
      alert(err.message || t('extra.deleteChatError'));
    },
  });

  const sendMessageMutation = useMutation({
    mutationFn: ({ sessId, text }: { sessId: string; text: string }) =>
      sendChatMessage(sessId, text),
    onMutate: async ({ text }) => {
      setIsLocalBusy(true);
      const tempUserMsgId = `temp-${Date.now()}`;
      const tempUserMsg: ChatMessage = {
        id: tempUserMsgId,
        role: 'user',
        content: text,
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, tempUserMsg]);
    },
    onSuccess: (res) => {
      setStreamingMessageId(res.assistantMessageId);
    },
    onError: (err: any) => {
      setIsLocalBusy(false);
      setStreamingMessageId(null);
      if (
        err.status === 409 ||
        err.message?.includes('409') ||
        err.message?.includes('busy') ||
        err.message?.includes('answering')
      ) {
        setToastMessage(t('extra.claudeAnswering'), 'warning');
      } else {
        setToastMessage(err.message || t('extra.sendError'));
      }
    },
  });

  const cancelMutation = useMutation({
    mutationFn: (id: string) => stopChatSession(id),
    onSuccess: () => {
      setIsLocalBusy(false);
      setStreamingMessageId(null);
      queryClient.invalidateQueries({ queryKey: ['chatSessions'] });
    },
    onError: (err: any) => {
      alert(err.message || t('extra.stopError'));
    },
  });

  const compactMutation = useMutation({
    mutationFn: compactChatSession,
    onSuccess: () => {
      setToastMessage(t('extra.compactRequested'), 'info');
      queryClient.invalidateQueries({ queryKey: ['chatSessions'] });
      if (activeSession?.id) {
        queryClient.invalidateQueries({ queryKey: ['chatMessages', activeSession.id] });
      }
    },
    onError: (err: any) => {
      setToastMessage(err.message || t('extra.failedCompact'));
    },
  });

  const forkSummaryMutation = useMutation({
    mutationFn: (sessId: string) => forkSummaryChatSession(sessId),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['chatSessions'] });
      navigate(`/chat/${res.id || res.sessionId}`);
    },
    onError: (err: any) => {
      setToastMessage(err.message || t('extra.forkSummaryError'));
    },
  });

  const handleSendMessage = (text: string) => {
    if (!activeSession) return;
    setEditText(null);
    sendMessageMutation.mutate({ sessId: activeSession.id, text });
  };

  const handleCancelMessage = () => {
    if (!activeSession) return;
    cancelMutation.mutate(activeSession.id);
  };

  const handleRetryLastTurn = () => {
    if (!activeSession) return;
    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
    if (lastUserMsg) {
      handleSendMessage(lastUserMsg.content);
    }
  };

  const handleRetryFromError = (errorMsg: ChatMessage) => {
    if (!activeSession) return;
    const idx = messages.findIndex((m) => m.id === errorMsg.id);
    const previous =
      idx > 0
        ? [...messages]
            .slice(0, idx)
            .reverse()
            .find((m) => m.role === 'user')
        : undefined;
    if (previous) {
      handleSendMessage(previous.content);
    }
  };

  const handleCreateSessionSubmit = (data: {
    projectId?: string | null;
    title?: string;
    mode: ChatMode;
    model?: string;
    profileName?: string | null;
  }) => {
    createSessionMutation.mutate(data);
  };

  const sessionState = activeSession?.state || (isBusy ? 'running' : 'idle');

  return (
    <div className="relative h-[calc(100vh-8.5rem)] flex rounded-2xl border border-[var(--t-border)] bg-[var(--t-bg)] overflow-hidden shadow-xs">
      <ToastViewport toasts={toasts} onDismiss={dismissToast} closeLabel={t('common.close')} />

      {/* Desktop Left Column (Session List) >= 900px */}
      <aside className="hidden min-[900px]:block w-72 lg:w-80 shrink-0 h-full">
        <SessionList
          sessions={sessions}
          hasMore={sessionsQuery.hasNextPage}
          isLoadingMore={sessionsQuery.isFetchingNextPage}
          onLoadMore={() => { void sessionsQuery.fetchNextPage(); }}
          activeSessionId={activeSession?.id}
          onSelectSession={(s) => navigate(`/chat/${s.id}`)}
          onNewSession={() => setIsModalOpen(true)}
          onDeleteSession={(id) => deleteSessionMutation.mutate(id)}
          onPinSession={(id, pinned) => updateSessionMutation.mutate({ id, data: { pinned } })}
          onRenameSession={(id, title) => updateSessionMutation.mutate({ id, data: { title } })}
          onArchiveSession={(id, archived) => updateSessionMutation.mutate({ id, data: { archived } })}
          isDeletingId={deleteSessionMutation.variables}
        />
      </aside>

      {/* Mobile Drawer Backdrop & Drawer < 900px */}
      {mobileDrawerOpen && (
        <div className="min-[900px]:hidden fixed inset-0 flex" style={{ zIndex: UI_Z_INDEX.modal }}>
          <div
            className="fixed inset-0 bg-[var(--t-overlay)] backdrop-blur-xs"
            onClick={() => setMobileDrawerOpen(false)}
          />
          <div className="relative w-72 max-w-[80vw] h-full bg-[var(--t-surface)] shadow-2xl z-10 flex flex-col">
            <div className="flex items-center justify-between p-3 border-b border-[var(--t-border)]">
              <span className="font-semibold text-xs text-[var(--t-text)]">
                {t('extra.chatList')}
              </span>
              <button
                type="button"
                onClick={() => setMobileDrawerOpen(false)}
                className="p-1.5 rounded-lg text-[var(--t-text-2)] hover:bg-[var(--t-hover)]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-hidden">
              <SessionList
                sessions={sessions}
                hasMore={sessionsQuery.hasNextPage}
                isLoadingMore={sessionsQuery.isFetchingNextPage}
                onLoadMore={() => { void sessionsQuery.fetchNextPage(); }}
                activeSessionId={activeSession?.id}
                onSelectSession={(s) => {
                  navigate(`/chat/${s.id}`);
                  setMobileDrawerOpen(false);
                }}
                onNewSession={() => {
                  setIsModalOpen(true);
                  setMobileDrawerOpen(false);
                }}
                onDeleteSession={(id) => deleteSessionMutation.mutate(id)}
                onPinSession={(id, pinned) => updateSessionMutation.mutate({ id, data: { pinned } })}
                onRenameSession={(id, title) => updateSessionMutation.mutate({ id, data: { title } })}
                onArchiveSession={(id, archived) => updateSessionMutation.mutate({ id, data: { archived } })}
                isDeletingId={deleteSessionMutation.variables}
              />
            </div>
          </div>
        </div>
      )}

      {/* Right Column (Chat Area) */}
      <section className="flex-1 flex flex-col h-full min-w-0 bg-[var(--t-surface)]">
        {/* Top Chat Header */}
        <div className="min-h-14 px-4 py-2 border-b border-[var(--t-border)] flex items-center justify-between gap-3 bg-[var(--t-surface)]">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            {/* Mobile drawer button */}
            <button
              type="button"
              onClick={() => setMobileDrawerOpen(true)}
              className="min-[900px]:hidden p-1.5 rounded-lg text-[var(--t-text-2)] hover:bg-[var(--t-hover)] hover:text-[var(--t-text)] cursor-pointer shrink-0"
              title={t('extra.openSessions')}
              aria-label={t('extra.openSessions')}
            >
              <Menu className="w-5 h-5" />
            </button>

            {activeSession ? (
              <div className="min-w-0 flex items-center gap-2.5 flex-1" data-tour="assistant-chat">
                <div className="w-7 h-7 rounded-full bg-[var(--t-claude)] text-[var(--t-on-accent)] font-bold text-xs flex items-center justify-center shrink-0">
                  C
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h2 className="text-xs sm:text-sm font-semibold text-[var(--t-text)] truncate">
                      {activeSession.title}
                    </h2>

                    {/* Session State Badge */}
                    {sessionState === 'running' && (
                      <span
                        data-testid="session-state-running"
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-[var(--t-accent)]/10 text-[var(--t-accent)] border border-[var(--t-accent)]/20 font-medium animate-pulse shrink-0"
                      >
                        <span className="w-1.5 h-1.5 rounded-full bg-[var(--t-accent)]" />
                        <span>{t('extra.stateRunning')}</span>
                      </span>
                    )}
                    {sessionState === 'waiting_permission' && (
                      <span
                        data-testid="session-state-waiting-permission"
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-[var(--t-warn)]/10 text-[var(--t-warn)] border border-[var(--t-warn)]/20 font-medium shrink-0"
                      >
                        <span className="w-1.5 h-1.5 rounded-full bg-[var(--t-warn)]" />
                        <span>{t('extra.stateWaitingPermission')}</span>
                      </span>
                    )}
                    {sessionState === 'error' && (
                      <span
                        data-testid="session-state-error"
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-[var(--t-crit)]/10 text-[var(--t-crit)] border border-[var(--t-crit)]/20 font-medium shrink-0"
                      >
                        <span className="w-1.5 h-1.5 rounded-full bg-[var(--t-crit)]" />
                        <span>{t('extra.stateError')}</span>
                      </span>
                    )}
                    {sessionState === 'idle' && (
                      <span
                        data-testid="session-state-idle"
                        className="hidden sm:inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-[var(--t-surface-2)] text-[var(--t-text-2)] border border-[var(--t-border)] font-medium shrink-0"
                      >
                        <span>{t('extra.stateIdle')}</span>
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2 text-[10px] text-[var(--t-text-2)] mt-0.5">
                    <span>
                      {t('extra.mode')}:{' '}
                      {activeSession.mode === 'full' ? t('extra.fullMode') : t('extra.safeMode')}
                    </span>
                    {activeSession.projectId && (
                      <span>• {t('extra.project')}: {activeSession.projectId}</span>
                    )}
                    <span>• Model: {activeSession.model || systemConfig?.chat?.model || 'sonnet'}</span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-sm text-[var(--t-text-2)] font-medium">
                <Bot className="w-5 h-5 text-[var(--t-accent)]" />
                <span>{t('extra.chatWithClaude')}</span>
              </div>
            )}
          </div>

          {/* Right Header: Context Meter & Controls */}
          <div className="flex items-center gap-2 shrink-0">
            {activeSession && (
              <>
                {/* Context Meter */}
                <select
                  aria-label={t('extra.modelChatAria')}
                  value={activeSession.model || systemConfig?.chat?.model || 'sonnet'}
                  disabled={isBusy || updateSessionMutation.isPending}
                  onChange={(event) => updateSessionMutation.mutate({ id: activeSession.id, data: { model: event.target.value } })}
                  className="hidden sm:block max-w-28 text-xs rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-2 py-1.5 text-[var(--t-text)]"
                >
                  {(systemConfig?.chat?.models || ['opus', 'sonnet', 'haiku']).map((model) => <option key={model} value={model}>{model}</option>)}
                </select>
                <div className="hidden md:block w-56 lg:w-72">
                  <ContextMeter
                    session={activeSession}
                    hasCompactApi={hasCompactApi}
                    onCompact={() => compactMutation.mutate(activeSession.id)}
                    onForkSummary={() => forkSummaryMutation.mutate(activeSession.id)}
                  />
                </div>

                {/* State Control Buttons: Stop / Retry */}
                {sessionState === 'running' && (
                  <button
                    type="button"
                    onClick={handleCancelMessage}
                    data-testid="header-stop-button"
                    title={t('extra.stopResponse')}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-[var(--t-crit)]/10 hover:bg-[var(--t-crit)]/20 text-[var(--t-crit)] border border-[var(--t-crit)]/30 transition-colors cursor-pointer"
                  >
                    <Square className="w-3.5 h-3.5 fill-current" />
                    <span>{t('extra.stop')}</span>
                  </button>
                )}

                {sessionState === 'error' && (
                  <button
                    type="button"
                    onClick={handleRetryLastTurn}
                    data-testid="header-retry-button"
                    title={t('extra.retryLastTurn')}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-[var(--t-accent)] hover:bg-[var(--t-accent-hover)] text-[var(--t-on-accent)] transition-colors cursor-pointer shadow-xs"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>{t('common.retry')}</span>
                  </button>
                )}
                {sessionState === 'waiting_limit' && (
                  <button type="button" onClick={() => retryLimitMutation.mutate(activeSession.id)} className="px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-[var(--t-warn)]/15 text-[var(--t-warn)] border border-[var(--t-warn)]/30">{t('extra.retryLimit')}</button>
                )}
              </>
            )}

            {/* New chat button */}
            <button
              type="button"
              onClick={() => setIsModalOpen(true)}
              aria-label={t('extra.newChat')}
              title={t('extra.newChat')}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-[var(--t-surface-2)] hover:bg-[var(--t-hover)] border border-[var(--t-border)] text-[var(--t-text)] transition-colors cursor-pointer shrink-0"
            >
              <Plus className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{t('common.create')}</span>
            </button>
          </div>
        </div>

        {/* Mobile Context Meter Bar */}
        {activeSession && (
          <div className="md:hidden px-4 py-1.5 border-b border-[var(--t-border)] bg-[var(--t-surface-2)]">
            <ContextMeter
              session={activeSession}
              hasCompactApi={hasCompactApi}
              onCompact={() => compactMutation.mutate(activeSession.id)}
              onForkSummary={() => forkSummaryMutation.mutate(activeSession.id)}
            />
          </div>
        )}

        {/* Messages Body */}
        {isMessagesLoading ? (
          <div className="flex items-center justify-center flex-1 h-full">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--t-accent)]" />
          </div>
        ) : (
          <MessageList
            messages={messages}
            activeSession={activeSession}
            streamingMessageId={streamingMessageId}
            isBusy={isBusy}
            hasMore={hasMore}
            isLoadingMore={isLoadingMore}
            onLoadMore={handleLoadMore}
            onRetryMessage={handleRetryFromError}
            onNewSession={() => setIsModalOpen(true)}
            onEditMessage={(message) => setEditText(message.content)}
          />
        )}

        {/* Input Bar */}
        {activeSession && (
          <>
            <SecretRequestCard />
            {/* Permission Request Dialog */}
            {permission && (
              <div
                data-tour="chat-permissions"
                className="mx-5 mb-2 rounded-xl border border-[var(--t-warn)] bg-[var(--t-warn)]/10 p-3 text-sm animate-fade-in"
                role="dialog"
                aria-label={t('extra.permissionAria')}
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) return;
                  if (event.key === 'Enter') { event.preventDefault(); resolvePermission('allow'); }
                  if (event.key === 'Escape') { event.preventDefault(); resolvePermission('deny'); }
                }}
              >
                <div className="font-semibold text-[var(--t-text)]">
                  {t('extra.permissionTitle', { tool: permission.toolName })}
                </div>
                <div className="text-xs text-[var(--t-text-3)]">
                  {`${t(permission.projectName ? 'extra.permissionProject' : 'extra.permissionNoProject', { project: permission.projectName ? `${permission.projectName} (${activeSession.projectId || ''})` : undefined })} · ${t('extra.permissionSession', { session: `${permission.sessionTitle || activeSession.title} (${permission.sessionId})` })}`}
                </div>
                <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-words text-xs text-[var(--t-text-3)] font-mono">
                  {typeof permission.input.command === 'string' ? permission.input.command.slice(0, 500) : JSON.stringify(permission.input, null, 2)}
                </pre>
                {typeof permission.input.cwd === 'string' && <div className="text-xs text-[var(--t-text-3)]">{t('extra.permissionCwd')}: <code>{permission.input.cwd}</code></div>}
                {typeof permission.input.file_path === 'string' && <div className="text-xs text-[var(--t-text-3)]">{t('extra.permissionFile')}: <code>{permission.input.file_path}</code></div>}
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    onClick={() => resolvePermission('allow')}
                    className="rounded-lg bg-[var(--t-ok)] px-3 py-1.5 text-xs font-semibold text-[var(--t-on-accent)] cursor-pointer"
                  >
                    {t('extra.allow')}
                  </button>
                  {permission.canAlwaysAllow !== false && <button
                    type="button"
                    onClick={() => resolvePermission('allow_always')}
                    className="rounded-lg bg-[var(--t-accent)] px-3 py-1.5 text-xs font-semibold text-[var(--t-on-accent)] cursor-pointer"
                  >
                    {`${t('extra.allowAlways')} ${permission.permissionLabel || permission.toolName}`}
                  </button>}
                  <button
                    type="button"
                    onClick={() => resolvePermission('deny')}
                    className="rounded-lg border border-[var(--t-crit)] px-3 py-1.5 text-xs font-semibold text-[var(--t-crit)] cursor-pointer"
                  >
                    {t('extra.deny')}
                  </button>
                </div>
              </div>
            )}

            {/* Status & Progress indicator */}
            {(isBusy || (activeSession.state && activeSession.state !== 'idle')) && (
              <div className="px-5 pb-2 text-xs text-[var(--t-text-3)]" role="status">
                {activeSession.state === 'waiting_permission'
                  ? t('extra.waitingPermissionStatus')
                  : activeSession.state === 'error'
                  ? t('extra.chatErrorStatus')
                  : currentTool
                  ? t('extra.progress', {
                      tool: currentTool,
                      step: toolStepCount,
                      time: `${Math.floor(thinkingSeconds / 60)}:${String(
                        thinkingSeconds % 60,
                      ).padStart(2, '0')}`,
                    })
                  : t('extra.thinking', { seconds: thinkingSeconds })}
              </div>
            )}

            <Composer
              onSend={handleSendMessage}
              onCancel={handleCancelMessage}
              busy={isBusy}
              isEmpty={messages.length === 0}
              disabled={!activeSession}
              sessionKey={activeSession.id}
              editText={editText}
            />
          </>
        )}
      </section>

      {/* New Session Dialog */}
      <NewSessionModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onSubmit={handleCreateSessionSubmit}
        isSubmitting={createSessionMutation.isPending}
      />
    </div>
  );
};
