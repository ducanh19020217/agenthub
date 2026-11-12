import React, { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate, Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Markdown from 'react-markdown';
import {
  cancelTask,
  createTaskFromError,
  deleteWorktree,
  getTask,
  getTaskRunsPage,
  getTasks,
  getTaskLog,
  retryTask,
  reviewTask,
  decideOpenProjectTicket,
  submitOpenProjectTriageInput,
  retryReviewer,
  startTask,
  updateTask,
  rerunChecks,
  getStatus,
  getProjectNotes,
  createTaskNote,
  getModelOptions,
  pauseTask,
  resumeTask,
  splitTask,
} from '../api/client';
import { TaskLevel, EventItem } from '../types/api';
import { subscribeToRunOutput, subscribeToEvents } from '../api/sse';
import { parseApiTime } from '../lib/time';
import { CheckResults } from '../components/CheckResults';
import { StatusBadge } from '../components/StatusBadge';
import { SilentRunIndicator } from '../components/SilentRunIndicator';
import { WorkerProgressPanel } from '../components/WorkerProgressPanel';
import { ModelBadge } from '../components/ModelBadge';
import { useLocale } from '../context/LocaleContext';
import { UI_Z_INDEX } from '../components/ui/layers';
import { CollapsibleList } from '../components/CollapsibleList';
import { formatEventType, formatReason, formatReviewWaitingReason } from '../utils/events';
import { Pagination } from '../components/ui/Pagination';
import { getReviewerEngine } from '../utils/reviewer';
import { autoMergeReasonKey } from '../utils/autoMerge';
import {
  ArrowLeft,
  Play,
  Pause,
  RotateCcw,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Terminal,
  FileText,
  GitCommit,
  Clock,
  Trash2,
  ArrowDown,
  ArrowUp,
  Plus,
  X,
  Edit3,
  Bell,
  ExternalLink,
  GitFork,
} from 'lucide-react';

const VALID_MODELS = [
  'gemini-3.8-flash-high',
  'gemini-3.8-flash-medium',
  'gemini-3.8-flash-low',
  'claude-sonnet-4-6',
  'claude-opus-4-6-thinking',
  'codex:gpt-5.6-luna',
  'gpt-oss-120b-medium',
];

export const TaskDetailPage: React.FC = () => {
  const { t, locale } = useLocale();
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Active Tab: 'log' | 'body' | 'runs' | 'report' | 'bulletin'
  const [activeTab, setActiveTab] = useState<'log' | 'body' | 'runs' | 'report' | 'bulletin'>('log');
  const [newNoteText, setNewNoteText] = useState('');
  const [triageNote, setTriageNote] = useState('');
  const [triageInput, setTriageInput] = useState('');

  // Modals
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [showRetryModal, setShowRetryModal] = useState(false);
  const [retryNote, setRetryNote] = useState('');
  const [showChangesModal, setShowChangesModal] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const [capture, setCapture] = useState<{ excerpt: string; checkName?: string } | null>(null);
  const [captureTitle, setCaptureTitle] = useState('');
  const [captureSlug, setCaptureSlug] = useState('');

  // Edit Task Modal
  const [showEditModal, setShowEditModal] = useState(false);
  const [editLevel, setEditLevel] = useState<TaskLevel>('easy');
  const [modelChain, setModelChain] = useState<string[]>([]);
  const [selectedDeps, setSelectedDeps] = useState<string[]>([]);
  const [selectedModelToAdd, setSelectedModelToAdd] = useState(VALID_MODELS[0]);
  const [editError, setEditError] = useState<string | null>(null);
  const [retryWithDifferentModel, setRetryWithDifferentModel] = useState(false);

  // Live log state
  const [liveLog, setLiveLog] = useState<string>('');
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const logContainerRef = useRef<HTMLDivElement>(null);
  const logLines = React.useMemo(() => liveLog.split('\n'), [liveLog]);
  const [logScrollTop, setLogScrollTop] = useState(0);
  const logVirtualized = logLines.length > 500;
  const logStart = logVirtualized ? Math.max(0, Math.floor(logScrollTop / 18) - 20) : 0;
  const logEnd = logVirtualized ? Math.min(logLines.length, logStart + 80) : logLines.length;

  const { data: task, isLoading, error } = useQuery({
    queryKey: ['task', id],
    queryFn: () => getTask(id),
    enabled: !!id,
    refetchInterval: 4000,
  });

  const [runParams, setRunParams] = useSearchParams();
  const [runsPage, setRunsPage] = useState(Math.max(1, Number(runParams.get('runsPage') || 1)));
  const [runsCursors, setRunsCursors] = useState<Record<number, string | undefined>>({});
  const runsCursor = runsCursors[runsPage - 1];
  const runsQuery = useQuery({
    queryKey: ['task-runs', id, runsPage, runsCursor],
    queryFn: () => getTaskRunsPage(id, { limit: 20, offset: runsCursor ? undefined : (runsPage - 1) * 20, cursor: runsCursor }),
    enabled: Boolean(id) && activeTab === 'runs',
    placeholderData: (previous) => previous,
  });
  const runs = runsQuery.isSuccess ? runsQuery.data.items : task?.runs || [];
  useEffect(() => {
    if (runsQuery.data?.nextCursor) setRunsCursors((current) => ({ ...current, [runsPage]: runsQuery.data!.nextCursor || undefined }));
  }, [runsPage, runsQuery.data?.nextCursor]);

  const { data: hubStatus } = useQuery({
    queryKey: ['status'],
    queryFn: getStatus,
    enabled: task?.status === 'waiting_quota' && task?.waitReason === 'disk',
    refetchInterval: 10_000,
  });

  const { data: projectNotes = [], refetch: refetchNotes } = useQuery({
    queryKey: ['projectNotes', task?.projectId],
    queryFn: () => (task?.projectId ? getProjectNotes(task.projectId) : Promise.resolve([])),
    enabled: Boolean(task?.projectId),
    refetchInterval: 5000,
  });

  const sendNoteMutation = useMutation({
    mutationFn: (content: string) => createTaskNote(task!.id, { content }),
    onSuccess: () => {
      setNewNoteText('');
      refetchNotes();
    },
  });

  const [liveEvents, setLiveEvents] = useState<EventItem[]>([]);
  useEffect(() => {
    const unsub = subscribeToEvents((event: EventItem) => {
      const rawId = id ? id.replace('~', '/') : '';
      if (event.taskId === id || (rawId && event.taskId === rawId)) {
        setLiveEvents((prev) => [event, ...prev.filter((e) => e.id !== event.id)]);
      }
    });
    return unsub;
  }, [id]);

  const timelineEvents = React.useMemo(() => {
    const initial = task?.events || [];
    const combined = [...liveEvents, ...initial];
    const seen = new Set<string | number>();
    const unique: EventItem[] = [];
    for (const ev of combined) {
      const key = ev.id ?? `${ev.type}-${ev.ts}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(ev);
      }
    }
    return unique;
  }, [task?.events, liveEvents]);

  // Fetch initial log
  useQuery({
    queryKey: ['taskLog', id],
    queryFn: async () => {
      const text = await getTaskLog(id, { tail: 500 });
      setLiveLog(text);
      return text;
    },
    enabled: !!id,
  });

  // Reset log on task change
  useEffect(() => {
    setLiveLog('');
  }, [id]);

  // Listen to SSE live output
  useEffect(() => {
    if (!id) return;
    const unsubscribe = subscribeToRunOutput((taskId, chunk) => {
      const match =
        taskId === id ||
        taskId.replace(/\//g, '~') === id.replace(/\//g, '~') ||
        taskId.replace(/~/g, '/') === id.replace(/~/g, '/');
      if (match) {
        setLiveLog((prev) => prev + chunk);
      }
    });
    return unsubscribe;
  }, [id]);

  // Handle auto-scroll
  useEffect(() => {
    if (autoScroll && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [liveLog, autoScroll]);

  const handleScroll = () => {
    if (!logContainerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = logContainerRef.current;
    setLogScrollTop(scrollTop);
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 30;
    setAutoScroll(isAtBottom);
  };

  const scrollToBottom = () => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
      setAutoScroll(true);
    }
  };

  // Mutations
  const startMutation = useMutation({
    mutationFn: () => startTask(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['task', id] });
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
  });

  const cancelMutation = useMutation({
    mutationFn: () => cancelTask(id),
    onSuccess: () => {
      setShowCancelModal(false);
      queryClient.invalidateQueries({ queryKey: ['task', id] });
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
  });

  const pauseMutation = useMutation({
    mutationFn: () => pauseTask(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['task', id] });
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      queryClient.invalidateQueries({ queryKey: ['status'] });
    },
  });

  const resumeMutation = useMutation({
    mutationFn: () => resumeTask(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['task', id] });
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      queryClient.invalidateQueries({ queryKey: ['status'] });
    },
  });

  const retryMutation = useMutation({
    mutationFn: () => retryTask(id, { note: retryNote }),
    onSuccess: () => {
      setShowRetryModal(false);
      setRetryNote('');
      queryClient.invalidateQueries({ queryKey: ['task', id] });
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
  });

  const retryReviewerMutation = useMutation({
    mutationFn: () => retryReviewer(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['task', id] });
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
  });

  const reviewMutation = useMutation({
    mutationFn: ({ verdict, fb, merge }: { verdict: 'approved' | 'changes_requested'; fb?: string; merge?: boolean }) =>
      reviewTask(id, { verdict, feedback: fb, merge }),
    onSuccess: () => {
      setShowChangesModal(false);
      setFeedback('');
      queryClient.invalidateQueries({ queryKey: ['task', id] });
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
  });

  const triageMutation = useMutation({
    mutationFn: (action: 'do' | 'split' | 'ask' | 'skip' | 'manual') => {
      if (!task?.triage) throw new Error(t('taskDetail.triageError'));
      return decideOpenProjectTicket(task.triage.sourceId, task.triage.wpId, action, triageNote || undefined);
    },
    onSuccess: () => {
      setTriageNote('');
      queryClient.invalidateQueries({ queryKey: ['task', id] });
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
  const triageInputMutation = useMutation({
    mutationFn: () => {
      if (!task?.triage || !triageInput.trim()) throw new Error(t('taskDetail.triageInputMissing'));
      return submitOpenProjectTriageInput(task.triage.sourceId, task.triage.wpId, triageInput.trim());
    },
    onSuccess: () => { setTriageInput(''); queryClient.invalidateQueries({ queryKey: ['task', id] }); },
  });

  const deleteWorktreeMutation = useMutation({
    mutationFn: () => deleteWorktree(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['task', id] });
    },
  });

  const rerunChecksMutation = useMutation({
    mutationFn: () => rerunChecks(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['task', id] }),
  });

  const captureMutation = useMutation({
    mutationFn: () => createTaskFromError({ sourceTaskId: task?.id || id, excerpt: capture?.excerpt || '', checkName: capture?.checkName, slug: captureSlug, title: captureTitle, level: 'easy' }),
    onSuccess: (created) => { setCapture(null); queryClient.invalidateQueries({ queryKey: ['tasks'] }); navigate(`/tasks/${encodeURIComponent(created.id.replace('/', '~'))}`); },
  });

  const splitTaskMutation = useMutation({
    mutationFn: () => splitTask(id),
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      queryClient.invalidateQueries({ queryKey: ['task', id] });
      navigate(`/tasks/${encodeURIComponent(created.taskId.replace('/', '~'))}`);
    },
  });

  // Text currently selected inside the live log; drives the "create fix task" button.
  const [logSelection, setLogSelection] = useState('');
  useEffect(() => {
    const onSelectionChange = () => {
      const sel = window.getSelection();
      const inLog = !!sel && !!sel.anchorNode && !!logContainerRef.current?.contains(sel.anchorNode);
      setLogSelection(inLog ? sel.toString().trim() : '');
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, []);

  const openCapture = (excerpt: string, checkName?: string) => {
    const first = excerpt.split(/\r?\n/).find((line) => line.trim())?.trim() || 'fix-error';
    setCapture({ excerpt, checkName });
    setCaptureTitle(`${checkName || t('common.error')}: ${first.slice(0, 80)}`);
    setCaptureSlug(`${task?.slug || 'task'}-fix-${Date.now().toString(36)}`.replace(/[^a-zA-Z0-9_-]/g, '-'));
  };

  const { data: projectTasks = [] } = useQuery({
    queryKey: ['tasks', { project: task?.projectId }],
    queryFn: () => getTasks({ project: task?.projectId }),
    enabled: showEditModal && !!task?.projectId,
  });
  const { data: modelOptions } = useQuery({ queryKey: ['model-options'], queryFn: getModelOptions });
  const modelSuggestions = modelOptions?.suggestions?.length ? modelOptions.suggestions : VALID_MODELS;

  const editMutation = useMutation({
    mutationFn: (data: { modelChain: string[]; dependsOn: string[]; level: TaskLevel }) => updateTask(id, data),
    onSuccess: () => {
      setShowEditModal(false);
      queryClient.invalidateQueries({ queryKey: ['task', id] });
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      if (retryWithDifferentModel) {
        setRetryWithDifferentModel(false);
        retryMutation.mutate();
      }
    },
    onError: (err: any) => {
      setEditError(err.message || t('taskDetail.updateError'));
    },
  });

  const openEditModal = () => {
    if (!task) return;
    let initialChain: string[] = [];
    if (task.modelChain) {
      if (Array.isArray(task.modelChain)) {
        initialChain = task.modelChain;
      } else {
        try {
          const p = JSON.parse(task.modelChain);
          if (Array.isArray(p)) initialChain = p;
        } catch {
          initialChain = [];
        }
      }
    }
    let initialDeps: string[] = [];
    if (task.dependsOn) {
      if (Array.isArray(task.dependsOn)) {
        initialDeps = task.dependsOn;
      } else {
        try {
          const p = JSON.parse(task.dependsOn);
          if (Array.isArray(p)) initialDeps = p;
        } catch {
          initialDeps = [];
        }
      }
    }
    setModelChain(initialChain);
    setSelectedDeps(initialDeps);
    setEditLevel(task.level || 'easy');
    setSelectedModelToAdd(modelSuggestions[0] || VALID_MODELS[0]);
    setEditError(null);
    setShowEditModal(true);
  };

  const moveModel = (index: number, direction: -1 | 1) => {
    const newIndex = index + direction;
    if (newIndex < 0 || newIndex >= modelChain.length) return;
    setModelChain((prev) => {
      const next = [...prev];
      const temp = next[index];
      next[index] = next[newIndex];
      next[newIndex] = temp;
      return next;
    });
  };

  const removeModel = (index: number) => {
    setModelChain((prev) => prev.filter((_, i) => i !== index));
  };

  const addModel = () => {
    if (selectedModelToAdd) {
      setModelChain((prev) => [...prev, selectedModelToAdd]);
    }
  };

  const toggleDep = (depId: string) => {
    const norm = depId.includes('~') ? depId.replace('~', '/') : depId;
    setSelectedDeps((prev) => {
      const exists = prev.some((d) => d === norm || d.replace('~', '/') === norm);
      return exists ? prev.filter((d) => d !== norm && d.replace('~', '/') !== norm) : [...prev, norm];
    });
  };

  const handleEditSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setEditError(null);
    editMutation.mutate({
      modelChain,
      dependsOn: selectedDeps,
      level: editLevel,
    });
  };

  const handleChangesSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!feedback.trim()) {
      setFeedbackError(t('taskDetail.changesRequiredError'));
      return;
    }
    setFeedbackError(null);
    reviewMutation.mutate({ verdict: 'changes_requested', fb: feedback.trim() });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--t-accent)]" />
      </div>
    );
  }

  if (error || !task) {
    return (
      <div className="p-6 bg-[color-mix(in_srgb,var(--t-crit)_15%,transparent)] text-[var(--t-crit)] rounded-xl border border-[var(--t-crit)]">
        {t('taskDetail.notFound')}
      </div>
    );
  }

  function calculateDuration(start: string, end?: string | null): string {
    const s = parseApiTime(start);
    const e = end ? parseApiTime(end) : Date.now();
    if (!Number.isFinite(s) || !Number.isFinite(e)) return '-';
    const sec = Math.max(0, Math.floor((e - s) / 1000));
    const m = Math.floor(sec / 60);
    const sRem = sec % 60;
    return `${m}m ${sRem}s`;
  }

  return (
    <div className="space-y-6" data-tour="task-summary">
      {task.reviewerEscalated ? (
        <div className="rounded-xl border border-[var(--t-warn)] bg-[color-mix(in_srgb,var(--t-warn)_12%,transparent)] px-4 py-3 text-sm text-[var(--t-text)]">
          {t('extra.waitingApprover')}
          {task.reviewerEscalationReason ? ` (${task.reviewerEscalationReason})` : ''}.
        </div>
      ) : null}
      {task.autoMergeSkippedReason ? (
        <div data-testid="task-manual-approval" className="rounded-xl border border-[var(--t-warn)] bg-[color-mix(in_srgb,var(--t-warn)_12%,transparent)] px-4 py-3 text-sm text-[var(--t-text)]">
          {t('extra.manualApproval')}: {t(autoMergeReasonKey(task.autoMergeSkippedReason))}
        </div>
      ) : null}
      {(task.status === 'review' || task.reviewMaxRounds) ? (
        <div data-testid="task-review-round" className="rounded-xl border border-[var(--t-border)] bg-[var(--t-surface)] px-4 py-3 text-sm text-[var(--t-text)]">
          {t('extra.reviewRound', { current: task.reviewRound ?? 1, max: task.reviewMaxRounds ?? 2 })}
        </div>
      ) : null}
      {task.reviewChain && task.reviewChain.length > 0 ? (
        <div className="rounded-xl border border-[var(--t-border)] bg-[var(--t-surface)] px-4 py-3 text-xs">
          <div className="font-semibold mb-2">{t('taskDetail.reviewChain')}</div>
          <div className="flex flex-wrap items-center gap-2">
            {task.reviewChain.map((step, index) => (
              <React.Fragment key={`${step.reviewer}-${index}`}>
                {index > 0 ? <span className="text-[var(--t-text-3)]">→</span> : null}
                <span className={`rounded-full px-2 py-1 border ${index < (task.reviewStep ?? 0) ? 'border-[var(--t-ok)] text-[var(--t-ok)]' : index === (task.reviewStep ?? 0) ? 'border-[var(--t-accent)] text-[var(--t-accent)]' : 'border-[var(--t-border)] text-[var(--t-text-3)]'}`}>
                  {step.reviewer} · {step.mode}
                </span>
              </React.Fragment>
            ))}
          </div>
        </div>
      ) : null}
      {/* Top Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-[var(--t-border)]">
        <div className="flex items-start gap-3">
          <button
            type="button"
            onClick={() => navigate('/tasks')}
            aria-label={t('common.back')}
            title={t('common.back')}
            className="p-2 mt-1 rounded-lg text-[var(--t-text-3)] hover:text-[var(--t-text)] hover:bg-[var(--t-surface-2)] cursor-pointer"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <span className="text-xs font-mono font-medium px-2 py-0.5 rounded bg-[var(--t-surface-2)] text-[var(--t-text)]">
                {task.projectId}
              </span>
              <span className="text-xs font-mono text-[var(--t-text-3)]">/</span>
              <span className="text-xs font-mono font-semibold text-[var(--t-text-3)]">
                {task.slug}
              </span>
              <StatusBadge
                status={task.status}
                waitReason={task.waitReason}
                blockingDisk={task.blockingDisk}
                diskFreeGB={task.blockingDisk?.freeGB ?? hubStatus?.disk?.freeGB}
                diskMinFreeGB={task.blockingDisk?.minFreeGB ?? hubStatus?.disk?.minFreeGB}
                diskLabel={task.blockingDisk?.label}
                projectId={task.projectId}
                size="sm"
              />
              {(task.status === 'review' || (task.reviews && task.reviews.length > 0) || task.reviewChain?.length) && (
                <span
                  data-testid="reviewer-badge"
                  className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full text-[var(--t-on-accent)] shadow-2xs ${
                    getReviewerEngine(task) === 'claude' ? 'bg-[var(--t-claude)]' : 'bg-[var(--t-ok)]'
                  }`}
                  style={getReviewerEngine(task) === 'claude' ? { backgroundColor: 'var(--t-claude)' } : undefined}
                >
                  {getReviewerEngine(task) === 'claude' ? 'Claude' : 'Codex'}
                </span>
              )}
              {task.status === 'running' && (task.paused || task.currentRun?.paused) && (
                <span
                  data-testid="task-paused-badge"
                  className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-semibold border ${
                    (task.pauseReason === 'load' || task.pauseReason === 'brain_load' || task.currentRun?.pauseReason === 'load' || task.currentRun?.pauseReason === 'brain_load')
                      ? 'bg-[color-mix(in_srgb,var(--t-warn)_15%,transparent)] text-[var(--t-warn)] border-[color-mix(in_srgb,var(--t-warn)_30%,transparent)]'
                      : 'bg-[var(--t-surface-2)] text-[var(--t-text-2)] border-[var(--t-border)]'
                  }`}
                >
                  {(task.pauseReason === 'load' || task.pauseReason === 'brain_load' || task.currentRun?.pauseReason === 'load' || task.currentRun?.pauseReason === 'brain_load')
                    ? t('status.pausedOverload')
                    : (task.pauseReason === 'focus' || task.currentRun?.pauseReason === 'focus')
                      ? t('status.pausedFocus')
                    : t('status.pausedManual')}
                </span>
              )}
              {task.status === 'running' && !task.paused && !task.currentRun?.paused && (
                <SilentRunIndicator lastActivityAt={task.currentRun?.lastActivityAt} />
              )}
              {task.status === 'running' && task.currentRun?.noCommitMinutes != null && task.currentRun.noCommitMinutes > 0 && (
                <span className="inline-flex items-center rounded bg-[color-mix(in_srgb,var(--t-warn)_15%,transparent)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--t-warn)] border border-[color-mix(in_srgb,var(--t-warn)_30%,transparent)]">
                  {t('extra.noCommit', { minutes: task.currentRun.noCommitMinutes })}
                </span>
              )}
              {task.status === 'running' && task.currentRun?.isLooping && (
                <span className="inline-flex items-center rounded bg-[color-mix(in_srgb,var(--t-crit)_15%,transparent)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--t-crit)] border border-[color-mix(in_srgb,var(--t-crit)_30%,transparent)]">
                  {t('extra.looping')}
                </span>
              )}
              {task.status === 'running' && (task.currentRun?.rss || task.currentRun?.cpu !== undefined) && (
                <span className="text-xs px-2 py-0.5 rounded bg-[var(--t-surface-2)] font-mono text-[var(--t-text-3)]">
                  {task.currentRun?.rss ? `${(task.currentRun.rss / (1024 * 1024)).toFixed(0)} MB` : '0 MB'} · {(task.currentRun?.cpu ?? 0).toFixed(1)}% CPU
                </span>
              )}
              <span className="text-xs px-2 py-0.5 rounded bg-[var(--t-surface-2)] font-mono text-[var(--t-text-3)]">
                {t('taskDetail.level', { level: task.level })}
              </span>
            </div>
            <h1 className="text-xl md:text-2xl font-bold tracking-tight">{task.title}</h1>
            {task.externalRef && (task.externalUrl || task.externalRef.startsWith('http')) && <a href={task.externalUrl || task.externalRef} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs text-[var(--t-accent)] hover:underline" data-testid="openproject-ticket-link">{task.externalUrl ? t('taskDetail.openTicket') : task.externalRef}<ExternalLink className="h-3 w-3" /></a>}
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-2 flex-wrap" data-tour="task-run-actions">
          {/* Edit (if draft, queued, waiting_quota, or failed) */}
          {['draft', 'queued', 'waiting_quota', 'failed'].includes(task.status) && (
            <button
              type="button"
              onClick={openEditModal}
              className="px-3.5 py-1.5 rounded-lg border border-[var(--t-border)] hover:bg-[var(--t-surface-2)] text-[var(--t-text)] text-xs font-semibold inline-flex items-center gap-1.5 shadow-xs cursor-pointer"
            >
              <Edit3 className="w-4 h-4" />
              <span>{t('taskDetail.btnEdit')}</span>
            </button>
          )}

          {/* Start (if draft) */}
          {task.status === 'draft' && (
            <button
              type="button"
              onClick={() => startMutation.mutate()}
              disabled={startMutation.isPending}
              className="px-3.5 py-1.5 rounded-lg bg-[color-mix(in_srgb,var(--t-ok)_15%,transparent)] hover:bg-[color-mix(in_srgb,var(--t-ok)_15%,transparent)] text-[var(--t-on-accent)] text-xs font-semibold inline-flex items-center gap-1.5 shadow-xs cursor-pointer"
            >
              <Play className="w-4 h-4" />
              <span>{t('taskDetail.btnStart')}</span>
            </button>
          )}

          {/* Pause / Resume (if running) */}
          {task.status === 'running' && (
            (task.paused || task.currentRun?.paused) ? (
              <button
                type="button"
                onClick={() => resumeMutation.mutate()}
                disabled={resumeMutation.isPending}
                className="px-3.5 py-1.5 rounded-lg bg-[color-mix(in_srgb,var(--t-ok)_15%,transparent)] hover:bg-[color-mix(in_srgb,var(--t-ok)_25%,transparent)] text-[var(--t-on-accent)] text-xs font-semibold inline-flex items-center gap-1.5 shadow-xs cursor-pointer"
              >
                <Play className="w-4 h-4" />
                <span>{t('taskDetail.btnResume')}</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => pauseMutation.mutate()}
                disabled={pauseMutation.isPending}
                className="px-3.5 py-1.5 rounded-lg border border-[var(--t-border)] hover:bg-[var(--t-surface-2)] text-[var(--t-text)] text-xs font-semibold inline-flex items-center gap-1.5 shadow-xs cursor-pointer"
              >
                <Pause className="w-4 h-4" />
                <span>{t('taskDetail.btnPause')}</span>
              </button>
            )
          )}

          {/* Cancel (if not done or cancelled) */}
          {task.status !== 'done' && task.status !== 'cancelled' && (
            <button
              type="button"
              onClick={() => setShowCancelModal(true)}
              className="px-3.5 py-1.5 rounded-lg bg-[color-mix(in_srgb,var(--t-crit)_15%,transparent)] hover:bg-[color-mix(in_srgb,var(--t-crit)_15%,transparent)] text-[var(--t-on-accent)] text-xs font-semibold inline-flex items-center gap-1.5 shadow-xs cursor-pointer"
            >
              <XCircle className="w-4 h-4" />
              <span>{t('taskDetail.btnCancel')}</span>
            </button>
          )}

          {/* Split (if queued or blocked, has externalRef, not already plan) */}
          {task.externalRef && (task.status === 'queued' || task.status === 'blocked') && !task.slug.endsWith('-plan') && (
            <button
              type="button"
              data-testid="btn-split-task"
              onClick={() => splitTaskMutation.mutate()}
              disabled={splitTaskMutation.isPending}
              className="px-3.5 py-1.5 rounded-lg border border-[var(--t-border)] hover:bg-[var(--t-surface-2)] text-[var(--t-text)] text-xs font-semibold inline-flex items-center gap-1.5 shadow-xs cursor-pointer"
            >
              <GitFork className="w-4 h-4" />
              <span>{t('taskDetail.btnSplit')}</span>
            </button>
          )}

          {/* Retry (if failed or blocked) */}
          {(task.status === 'failed' || task.status === 'blocked') && (
            <>
              <button type="button" onClick={() => setShowRetryModal(true)} className="px-3.5 py-1.5 rounded-lg bg-[var(--t-accent)] hover:bg-[var(--t-accent-hover)] text-[var(--t-on-accent)] text-xs font-semibold inline-flex items-center gap-1.5 shadow-xs cursor-pointer">
                <RotateCcw className="w-4 h-4" /><span>{t('taskDetail.btnRetry')}</span>
              </button>
              <button type="button" onClick={() => { setRetryWithDifferentModel(true); openEditModal(); }} className="px-3.5 py-1.5 rounded-lg border border-[var(--t-accent)] text-[var(--t-accent)] text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer">
                <RotateCcw className="w-4 h-4" /><span>{t('taskDetail.retryWithModel')}</span>
              </button>
            </>
          )}

          {task.triage?.analysis && !task.triage.decision && (
            <section data-testid="triage-actions" className="rounded-xl border border-[var(--t-border)] bg-[var(--t-surface)] p-4 space-y-3">
              <div className="text-sm"><strong>{t('taskDetail.triageTitle')}</strong> · {task.triage.analysis.conclusion} · {task.triage.analysis.size}</div>
              <Markdown>{Object.entries(task.triage.analysis).map(([key, value]) => `### ${key}\n${Array.isArray(value) ? value.join(', ') : value || ''}`).join('\n\n')}</Markdown>
              <textarea value={triageNote} onChange={(event) => setTriageNote(event.target.value)} placeholder={t('taskDetail.triageNotePlaceholder')} className="w-full rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] p-2 text-sm" rows={2} />
              <textarea value={triageInput} onChange={(event) => setTriageInput(event.target.value)} placeholder={t('taskDetail.triageInputPlaceholder')} className="w-full rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] p-2 text-sm" rows={3} />
              <button type="button" onClick={() => triageInputMutation.mutate()} className="px-3 py-1.5 rounded-lg border text-xs">{t('taskDetail.triageInputSubmit')}</button>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => triageMutation.mutate(task.triage?.analysis?.conclusion?.startsWith('vi') ? 'manual' : 'do')} className="px-3 py-1.5 rounded-lg bg-[var(--t-accent)] text-xs">{task.triage.analysis.conclusion?.startsWith('vi') ? t('taskDetail.triageManual') : t('taskDetail.triageDo')}</button>
                {(task.triage.analysis.size === 'lớn' || task.triage.analysis.size?.includes('(')) && <button type="button" onClick={() => triageMutation.mutate('split')} className="px-3 py-1.5 rounded-lg border text-xs">{t('taskDetail.triageSplit')}</button>}
                <button type="button" onClick={() => triageMutation.mutate('ask')} className="px-3 py-1.5 rounded-lg border text-xs">{t('taskDetail.triageAsk')}</button>
                <button type="button" onClick={() => triageMutation.mutate('skip')} className="px-3 py-1.5 rounded-lg border text-xs">{t('taskDetail.triageSkip')}</button>
              </div>
            </section>
          )}

          {/* Review actions (if review) */}
          {task.status === 'review' && (
            <>
              {task.reviewerEscalated ? (
                <button
                  type="button"
                  onClick={() => retryReviewerMutation.mutate()}
                  disabled={retryReviewerMutation.isPending}
                  className="px-3.5 py-1.5 rounded-lg bg-[var(--t-accent)] hover:bg-[var(--t-accent-hover)] text-[var(--t-on-accent)] text-xs font-semibold inline-flex items-center gap-1.5 shadow-xs cursor-pointer"
                >
                  <RotateCcw className="w-4 h-4" />
                  <span>{t('extra.retryReviewer')}</span>
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => reviewMutation.mutate({ verdict: 'approved', merge: false })}
                disabled={reviewMutation.isPending}
                className="px-3.5 py-1.5 rounded-lg bg-[color-mix(in_srgb,var(--t-ok)_15%,transparent)] hover:bg-[color-mix(in_srgb,var(--t-ok)_15%,transparent)] text-[var(--t-on-accent)] text-xs font-semibold inline-flex items-center gap-1.5 shadow-xs cursor-pointer"
              >
                <CheckCircle2 className="w-4 h-4" />
              <span>{t('taskDetail.btnReview')}</span>
              </button>
              <button
                type="button"
                onClick={() => reviewMutation.mutate({ verdict: 'approved', merge: true })}
                className="px-3.5 py-1.5 rounded-lg bg-[var(--t-accent)] hover:bg-[var(--t-accent-hover)] text-[var(--t-on-accent)] text-xs font-semibold inline-flex items-center gap-1.5 shadow-xs cursor-pointer"
                disabled={reviewMutation.isPending || task.mergeAvailable === false}
                title={task.mergeAvailable === false ? (task.mergeUnavailableReason || t('taskDetail.mergeNotConfigured')) : undefined}
              >
                <GitCommit className="w-4 h-4" />
                <span>{t('taskDetail.btnMerge')}</span>
              </button>
              {task.mergeAvailable === false && (
                <span className="text-xs text-[var(--t-text-3)] max-w-xs">
                  {task.mergeUnavailableReason || t('taskDetail.mergeEnableHint')}
                  {' '}
                  <Link className="underline text-[var(--t-accent)]" to={`/projects/${encodeURIComponent(task.projectId)}/settings`}>
                    {t('taskDetail.mergeSettingsLink')}
                  </Link>
                </span>
              )}

              <button
                type="button"
                onClick={() => {
                  setFeedbackError(null);
                  setShowChangesModal(true);
                }}
                className="px-3.5 py-1.5 rounded-lg bg-[color-mix(in_srgb,var(--t-warn)_15%,transparent)] hover:bg-[color-mix(in_srgb,var(--t-warn)_15%,transparent)] text-[var(--t-on-accent)] text-xs font-semibold inline-flex items-center gap-1.5 shadow-xs cursor-pointer"
              >
                <AlertCircle className="w-4 h-4" />
              <span>{t('taskDetail.btnRequestChanges')}</span>
              </button>
            </>
          )}

          {/* Delete worktree (if done or cancelled and has worktreePath) */}
          {(task.status === 'done' || task.status === 'cancelled') && task.worktreePath && (
            <button
              type="button"
              onClick={() => {
                if (window.confirm(t('taskDetail.confirmDeleteWorktree'))) {
                  deleteWorktreeMutation.mutate();
                }
              }}
              disabled={deleteWorktreeMutation.isPending}
              className="px-3 py-1.5 rounded-lg border border-[var(--t-border)] text-[var(--t-text-3)] text-xs font-medium hover:bg-[var(--t-surface-2)] inline-flex items-center gap-1.5 cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5 text-[var(--t-crit)]" />
              <span>{t('taskDetail.btnDeleteWorktree')}</span>
            </button>
          )}
        </div>
      </div>

      {task.modelWarnings?.length ? (
        <div className="rounded-xl border border-[var(--t-warn)] bg-[color-mix(in_srgb,var(--t-warn)_12%,transparent)] px-4 py-3 text-sm text-[var(--t-text)]">
          <strong>{t('taskDetail.modelWarningTitle')}</strong>
          <ul className="mt-1 list-disc pl-5">
            {task.modelWarnings.map((model) => <li key={model}>{t('taskDetail.modelWarningItem', { model })}</li>)}
          </ul>
        </div>
      ) : null}

      <CheckResults checks={task.checks} onRerun={() => rerunChecksMutation.mutate()} rerunning={rerunChecksMutation.isPending} onCreateTask={(check) => openCapture(check.outputTail, check.name)} />

      {task.reviews.length > 0 && (
        <section data-testid="task-reviews" className="bg-[var(--t-surface)] rounded-xl border border-[var(--t-border)] p-5 shadow-xs space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--t-text-3)]">{t('taskDetail.reviewHistory')}</h2>
          <ul className="space-y-2">
            {task.reviews.map((review) => (
              <li key={review.id} className="flex items-center justify-between gap-3 flex-wrap text-sm">
                <span className="font-medium text-[var(--t-text)]">
                  {review.actor || t('taskDetail.unknownReviewer')}
                  {review.model ? <span className="ml-2 text-xs font-mono text-[var(--t-text-3)]">({review.model})</span> : null}
                </span>
                <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-1 rounded-full ${review.verdict === 'approved' ? 'text-[var(--t-ok)] bg-[color-mix(in_srgb,var(--t-ok)_15%,transparent)]' : 'text-[var(--t-warn)] bg-[color-mix(in_srgb,var(--t-warn)_15%,transparent)]'}`}>
                  {review.verdict === 'approved' ? t('taskDetail.reviewApproved') : t('taskDetail.reviewChangesRequested')}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {(task.sourceRef || (task.derivedTasks && task.derivedTasks.length > 0)) && <section className="bg-[var(--t-surface)] rounded-xl border border-[var(--t-border)] p-5 text-sm space-y-2"><h2 className="font-semibold">{t('extra.linkedTasks')}</h2>{task.sourceRef && <p>{t('extra.generatedFrom')}: <button type="button" className="text-[var(--t-accent)] underline cursor-pointer" onClick={() => navigate(`/tasks/${encodeURIComponent(task.sourceRef!.taskId.replace('/', '~'))}`)}>{task.sourceRef.taskId}</button></p>}{task.derivedTasks?.map((derived) => <p key={derived.id}>{t('extra.generatedTask')}: <button type="button" className="text-[var(--t-accent)] underline cursor-pointer" onClick={() => navigate(`/tasks/${encodeURIComponent(derived.id.replace('/', '~'))}`)}>{derived.id}</button></p>)}</section>}

      {/* Timeline */}
      <div data-testid="task-timeline" className="bg-[var(--t-surface)] p-6 rounded-xl border border-[var(--t-border)] space-y-3 shadow-xs">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-[var(--t-text-3)] flex items-center gap-2">
          <Clock className="w-4 h-4 text-[var(--t-accent)]" />
          <span>{t('taskDetail.timeline')}</span>
        </h3>
        {timelineEvents.length === 0 ? (
          <p className="text-xs text-[var(--t-text-3)] italic">{t('taskDetail.noEvents')}</p>
        ) : (
          <ol className="relative border-l border-[var(--t-border)] ml-2 space-y-3 pl-4 text-xs">
            {timelineEvents.map((evt, idx) => (
              <li
                key={evt.id || idx}
                data-testid={`timeline-event-${evt.type}`}
                className="space-y-1"
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <span title={evt.type} className="font-mono font-semibold px-1.5 py-0.5 rounded bg-[var(--t-surface-2)] text-[var(--t-text)] border border-[var(--t-border)]">
                    {formatEventType(evt.type, locale)}
                  </span>
                  {evt.ts && (
                    <span className="text-[var(--t-text-3)] font-mono text-[11px]">
                      {Number.isFinite(parseApiTime(evt.ts))
                        ? new Date(parseApiTime(evt.ts)).toISOString()
                        : String(evt.ts)}
                    </span>
                  )}
                </div>
                {evt.type === 'review.fallback' && (
                  <p className="text-xs text-[var(--t-warn)] font-medium">
                    {t('taskDetail.reviewFallbackLine', { profile: evt.payload?.profile || 'claude' })}
                  </p>
                )}
                {evt.type === 'review.waiting' && evt.payload?.reason && (
                  <p className="text-xs text-[var(--t-warn)] font-medium">
                    {formatReviewWaitingReason(String(evt.payload.reason), locale)}
                  </p>
                )}
                {evt.type === 'task.waiting_quota' && evt.payload?.reason && (
                  <p className="text-xs text-[var(--t-warn)] font-medium">
                    {formatReason(String(evt.payload.reason), locale)}
                  </p>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>

      {/* Tabs */}
      <div className="flex border-b border-[var(--t-border)] space-x-6 text-sm font-medium" data-tour="task-detail-tabs">
        <button
          type="button"
          onClick={() => setActiveTab('log')}
          className={`pb-3 flex items-center gap-2 border-b-2 transition-colors cursor-pointer ${
            activeTab === 'log'
              ? 'border-[var(--t-accent)] text-[var(--t-accent)] font-semibold'
              : 'border-transparent text-[var(--t-text-3)] hover:text-[var(--t-text)]'
          }`}
        >
          <Terminal className="w-4 h-4" />
          <span>{t('taskDetail.tabLog')}</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('body')}
          className={`pb-3 flex items-center gap-2 border-b-2 transition-colors cursor-pointer ${
            activeTab === 'body'
              ? 'border-[var(--t-accent)] text-[var(--t-accent)] font-semibold'
              : 'border-transparent text-[var(--t-text-3)] hover:text-[var(--t-text)]'
          }`}
        >
          <FileText className="w-4 h-4" />
          <span>{t('taskDetail.tabBody')}</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('runs')}
          className={`pb-3 flex items-center gap-2 border-b-2 transition-colors cursor-pointer ${
            activeTab === 'runs'
              ? 'border-[var(--t-accent)] text-[var(--t-accent)] font-semibold'
              : 'border-transparent text-[var(--t-text-3)] hover:text-[var(--t-text)]'
          }`}
        >
          <Clock className="w-4 h-4" />
          <span>{t('taskDetail.tabRuns', { count: (task.runs || []).length })}</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('report')}
          className={`pb-3 flex items-center gap-2 border-b-2 transition-colors cursor-pointer ${
            activeTab === 'report'
              ? 'border-[var(--t-accent)] text-[var(--t-accent)] font-semibold'
              : 'border-transparent text-[var(--t-text-3)] hover:text-[var(--t-text)]'
          }`}
        >
          <GitCommit className="w-4 h-4" />
          <span>{t('taskDetail.tabReport')}</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('bulletin')}
          className={`pb-3 flex items-center gap-2 border-b-2 transition-colors cursor-pointer ${
            activeTab === 'bulletin'
              ? 'border-[var(--t-accent)] text-[var(--t-accent)] font-semibold'
              : 'border-transparent text-[var(--t-text-3)] hover:text-[var(--t-text)]'
          }`}
        >
          <Bell className="w-4 h-4" />
          <span>{t('taskDetail.tabBulletin')}</span>
        </button>
      </div>

      {/* Tab Contents */}
      {/* 1. Live log */}
      {activeTab === 'log' && (
        <div className="relative">
          {task?.status === 'running' && (
            <WorkerProgressPanel
              currentRun={task.currentRun}
              logEmpty={!liveLog}
            />
          )}
          <div
            ref={logContainerRef}
            onScroll={handleScroll}
            className="w-full h-[520px] bg-[var(--t-log-bg)] text-[var(--t-log-text)] font-mono text-xs p-4 rounded-xl overflow-y-auto border border-[var(--t-border)] shadow-inner whitespace-pre-wrap leading-relaxed select-text"
          >
            {liveLog ? (
              logVirtualized ? (
                <div style={{ height: `${logLines.length * 18}px`, position: 'relative' }}>
                  <div style={{ position: 'absolute', top: `${logStart * 18}px`, left: 0, right: 0 }}>
                    {logLines.slice(logStart, logEnd).map((line, index) => <div key={logStart + index} className="h-[18px]">{line || '\u00a0'}</div>)}
                  </div>
                </div>
              ) : liveLog
            ) : <span className="text-[var(--t-log-muted)]">{t('taskDetail.noLog')}</span>}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button type="button" disabled={!logSelection} title={t('extra.captureFromSelectionTip')} onClick={() => { if (logSelection) openCapture(logSelection, 'log'); }} className="px-3 py-1.5 rounded-lg bg-[var(--t-accent)] text-[var(--t-on-accent)] text-xs font-semibold cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">{t('extra.captureFromSelection')}</button>
            <span className="text-xs text-[var(--t-text-3)]">{logSelection ? t('extra.captureSelectedChars', { count: logSelection.length }) : t('extra.captureFromSelectionHint')}</span>
          </div>

          {!autoScroll && (
            <button
              type="button"
              onClick={scrollToBottom}
              className="absolute bottom-4 right-4 bg-[var(--t-accent)] hover:bg-[var(--t-accent-hover)] text-[var(--t-on-accent)] text-xs px-3 py-1.5 rounded-full shadow-lg flex items-center gap-1.5 transition-all cursor-pointer animate-bounce"
            >
              <ArrowDown className="w-3.5 h-3.5" />
              <span>{t('taskDetail.scrollToBottom')}</span>
            </button>
          )}
        </div>
      )}

      {/* 2. Specification (rendered Markdown, NO dangerouslySetInnerHTML) */}
      {activeTab === 'body' && (
        <div className="bg-[var(--t-surface)] p-6 rounded-xl border border-[var(--t-border)] prose prose-invert max-w-none text-sm">
          {task.body ? (
            <Markdown>{task.body}</Markdown>
          ) : (
            <p className="text-[var(--t-text-3)] italic">{t('taskDetail.noBody')}</p>
          )}
        </div>
      )}

      {/* 3. Runs list */}
      {activeTab === 'runs' && (
        <div className="bg-[var(--t-surface)] rounded-xl border border-[var(--t-border)] overflow-hidden shadow-xs">
          {runsQuery.isLoading && !task?.runs?.length ? (
            <div className="p-8 text-center text-sm text-[var(--t-text-3)]">{t('pagination.loading')}</div>
          ) : runs.length === 0 ? (
            <div className="p-8 text-center text-sm text-[var(--t-text-3)]">{t('taskDetail.noRuns')}</div>
          ) : (
            <>
            <table className="w-full text-left text-sm">
              <thead className="bg-[var(--t-surface-2)] text-xs text-[var(--t-text-3)] uppercase">
                <tr>
                  <th className="px-6 py-3">{t('taskDetail.thId')}</th>
                  <th className="px-6 py-3">{t('taskDetail.thEngine')}</th>
                  <th className="px-6 py-3">{t('taskDetail.thModel')}</th>
                  <th className="px-6 py-3">{t('taskDetail.thProfile')}</th>
                  <th className="px-6 py-3">{t('taskDetail.thOutcome')}</th>
                  <th className="px-6 py-3">{t('taskDetail.thStarted')}</th>
                  <th className="px-6 py-3">{t('taskDetail.thDuration')}</th>
                </tr>
              </thead>
              <tbody className="divide-y border-[var(--t-border)]">
                <CollapsibleList items={runs} initial={20} step={20} storageKey={`agenthub:task:${id}:runs`} tableColSpan={7}>
                {(r) => (
                  <tr key={r.id}>
                    <td className="px-6 py-3 font-mono text-xs">{r.id}</td>
                    <td className="px-6 py-3 font-medium uppercase text-xs">{r.engine}</td>
                    <td className="px-6 py-3 whitespace-nowrap">
                      <ModelBadge model={r.model} engine={r.engine} />
                    </td>
                    <td className="px-6 py-3 font-medium">{r.profileName}</td>
                    <td className="px-6 py-3">
                      <span className="text-xs px-2 py-0.5 rounded font-mono bg-[var(--t-surface-2)]">
                        {r.reason === 'stalled' ? t('extra.stuck') : (r.outcome || t('status.running'))}
                      </span>
                    </td>
                    <td className="px-6 py-3 text-xs text-[var(--t-text-3)]">
                      {Number.isFinite(parseApiTime(r.startedAt))
                        ? new Date(parseApiTime(r.startedAt)).toISOString()
                        : String(r.startedAt || '')}
                    </td>
                    <td className="px-6 py-3 text-xs font-mono text-[var(--t-text-3)]">
                      {calculateDuration(r.startedAt, r.endedAt)}
                    </td>
                  </tr>
                )}
                </CollapsibleList>
              </tbody>
            </table>
            {runsQuery.data && <Pagination
              page={runsPage}
              pageSize={20}
              total={runsQuery.data.total}
              onPageChange={(nextPage) => {
                setRunsPage(nextPage);
                setRunParams((current) => { if (nextPage === 1) current.delete('runsPage'); else current.set('runsPage', String(nextPage)); return current; }, { replace: true });
              }}
              onPageSizeChange={() => undefined}
            />}
            </>
          )}
        </div>
      )}

      {/* 4. DONE / BLOCKED reports and commits */}
      {activeTab === 'report' && (
        <div className="space-y-6">
          {task.doneContent && (
            <div className="bg-[var(--t-surface)] p-6 rounded-xl border border-[var(--t-ok)] prose prose-invert max-w-none text-sm">
              <h2 className="text-[var(--t-ok)] font-bold mb-4">{t('taskDetail.reportDone')}</h2>
              <Markdown>{task.doneContent}</Markdown>
            </div>
          )}

          {task.blockedContent && (
            <div className="bg-[var(--t-surface)] p-6 rounded-xl border border-[var(--t-warn)] prose prose-invert max-w-none text-sm">
              <h2 className="text-[var(--t-warn)] font-bold mb-4">{t('taskDetail.reportBlocked')}</h2>
              <Markdown>{task.blockedContent}</Markdown>
            </div>
          )}

          {/* Commits */}
          <div className="bg-[var(--t-surface)] p-6 rounded-xl border border-[var(--t-border)] space-y-3">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-[var(--t-text-3)]">
              {t('taskDetail.commitList')}
            </h3>
            {((task.commits && task.commits.length > 0) || (task.gitCommits && task.gitCommits.length > 0)) ? (
              <ul className="space-y-1.5 font-mono text-xs">
                {(task.commits || task.gitCommits)!.map((c, i) => (
                  <li key={i} className="p-2 rounded bg-[var(--t-surface-2)] text-[var(--t-text)]">
                    {c}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-[var(--t-text-3)] italic">{t('taskDetail.noCommits')}</p>
            )}
          </div>
        </div>
      )}

      {/* 5. Bulletin tab */}
      {activeTab === 'bulletin' && (
        <div data-testid="task-bulletin-tab" className="space-y-6">
          {/* Overlaps section */}
          <div className="bg-[var(--t-surface)] p-6 rounded-xl border border-[var(--t-border)] space-y-3">
            <h3 className="text-sm font-semibold text-[var(--t-text)] flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-[var(--t-warn)]" />
              <span>{t('taskDetail.bulletinOverlapsTitle')}</span>
            </h3>
            {projectNotes.filter(
              (n) =>
                n.kind === 'overlap' &&
                (n.taskId === task.id ||
                  n.content.includes(task.id) ||
                  n.content.includes(task.slug)),
            ).length > 0 ? (
              <div className="space-y-2">
                {projectNotes
                  .filter(
                    (n) =>
                      n.kind === 'overlap' &&
                      (n.taskId === task.id ||
                        n.content.includes(task.id) ||
                        n.content.includes(task.slug)),
                  )
                  .map((ov) => (
                    <div
                      key={ov.id}
                      className="p-3 rounded-lg border border-[var(--t-warn)] bg-[color-mix(in_srgb,var(--t-warn)_10%,transparent)] text-xs flex items-center justify-between gap-2"
                    >
                      <div className="flex items-center gap-2 text-[var(--t-text)]">
                        <span className="font-mono px-1.5 py-0.5 rounded bg-[var(--t-surface-2)] border border-[var(--t-border)]">
                          {ov.taskId}
                        </span>
                        <span className="font-medium">{ov.content}</span>
                      </div>
                      <span className="text-[var(--t-text-3)] text-[10px] shrink-0 font-mono">
                        {ov.createdAt}
                      </span>
                    </div>
                  ))}
              </div>
            ) : (
              <p className="text-xs text-[var(--t-text-3)] italic">
                {t('taskDetail.bulletinNoOverlaps')}
              </p>
            )}
          </div>

          {/* Project notes section */}
          <div className="bg-[var(--t-surface)] p-6 rounded-xl border border-[var(--t-border)] space-y-4">
            <h3 className="text-sm font-semibold text-[var(--t-text)] flex items-center gap-2">
              <FileText className="w-4 h-4 text-[var(--t-accent)]" />
              <span>{t('taskDetail.bulletinNotesTitle')}</span>
            </h3>

            {/* Input to send note */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const text = newNoteText.trim();
                if (!text || sendNoteMutation.isPending) return;
                sendNoteMutation.mutate(text);
              }}
              className="flex gap-2"
            >
              <input
                type="text"
                value={newNoteText}
                onChange={(e) => setNewNoteText(e.target.value)}
                placeholder={t('taskDetail.bulletinAddNotePlaceholder')}
                className="flex-1 px-3 py-2 text-xs rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] text-[var(--t-text)] focus:outline-none focus:border-[var(--t-accent)]"
              />
              <button
                type="submit"
                disabled={!newNoteText.trim() || sendNoteMutation.isPending}
                className="px-4 py-2 text-xs font-semibold rounded-lg bg-[var(--t-accent)] text-[var(--t-on-accent)] hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
              >
                {sendNoteMutation.isPending ? t('taskDetail.bulletinSendingBtn') : t('taskDetail.bulletinSendBtn')}
              </button>
            </form>

            {projectNotes.filter((n) => n.kind === 'note').length > 0 ? (
              <div className="space-y-2">
                {projectNotes
                  .filter((n) => n.kind === 'note')
                  .map((note) => (
                    <div
                      key={note.id}
                      className="p-3 rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] text-xs space-y-1"
                    >
                      <div className="flex items-center justify-between text-[11px] text-[var(--t-text-3)]">
                        <span className="font-semibold text-[var(--t-text)]">
                          {note.taskId}
                        </span>
                        <span className="font-mono text-[10px]">{note.createdAt}</span>
                      </div>
                      <p className="text-[var(--t-text)]">{note.content}</p>
                    </div>
                  ))}
              </div>
            ) : (
              <p className="text-xs text-[var(--t-text-3)] italic">
                {t('taskDetail.bulletinNoNotes')}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Cancel Confirmation Modal */}
      {showCancelModal && (
        <div className="fixed inset-0 flex items-center justify-center bg-[var(--t-overlay)] backdrop-blur-xs p-4" style={{ zIndex: UI_Z_INDEX.modal }}>
          <div className="bg-[var(--t-surface)] rounded-xl max-w-md w-full p-6 space-y-4 border border-[var(--t-border)] shadow-xl">
            <h3 className="text-lg font-bold text-[var(--t-text)]">{t('taskDetail.cancelTitle')}</h3>
            <p className="text-sm text-[var(--t-text-3)]">
              {t('taskDetail.cancelDesc')}
            </p>
            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setShowCancelModal(false)}
                className="px-4 py-2 rounded-lg text-xs font-medium border border-[var(--t-border)] hover:bg-[var(--t-surface-2)] cursor-pointer"
              >
                {t('taskDetail.cancelNo')}
              </button>
              <button
                type="button"
                onClick={() => cancelMutation.mutate()}
                disabled={cancelMutation.isPending}
                className="px-4 py-2 rounded-lg text-xs font-semibold bg-[color-mix(in_srgb,var(--t-crit)_15%,transparent)] hover:bg-[color-mix(in_srgb,var(--t-crit)_15%,transparent)] text-[var(--t-on-accent)] cursor-pointer"
              >
                {t('taskDetail.cancelConfirm')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Retry Modal with Note */}
      {showRetryModal && (
        <div className="fixed inset-0 flex items-center justify-center bg-[var(--t-overlay)] backdrop-blur-xs p-4" style={{ zIndex: UI_Z_INDEX.modal }}>
          <div className="bg-[var(--t-surface)] rounded-xl max-w-md w-full p-6 space-y-4 border border-[var(--t-border)] shadow-xl">
            <h3 className="text-lg font-bold text-[var(--t-text)]">{t('taskDetail.retryTitle')}</h3>
            <div>
              <label className="block text-xs font-medium text-[var(--t-text)] mb-1">
                {t('taskDetail.retryNoteLabel')}
              </label>
              <textarea
                rows={3}
                placeholder={t('taskDetail.retryPlaceholder')}
                value={retryNote}
                onChange={(e) => setRetryNote(e.target.value)}
                className="w-full text-xs rounded-lg border border-[var(--t-border)] p-2.5 bg-[var(--t-surface-2)] text-[var(--t-text)] focus:outline-none focus:ring-2 focus:ring-[var(--t-accent)]"
              />
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setShowRetryModal(false)}
                className="px-4 py-2 rounded-lg text-xs font-medium border border-[var(--t-border)] hover:bg-[var(--t-surface-2)] cursor-pointer"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={() => retryMutation.mutate()}
                disabled={retryMutation.isPending}
                className="px-4 py-2 rounded-lg text-xs font-semibold bg-[var(--t-accent)] hover:bg-[var(--t-accent-hover)] text-[var(--t-on-accent)] cursor-pointer"
              >
                {t('taskDetail.retryRunBtn')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Changes Requested Modal - MANDATORY FEEDBACK */}
      {showChangesModal && (
        <div className="fixed inset-0 flex items-center justify-center bg-[var(--t-overlay)] backdrop-blur-xs p-4" style={{ zIndex: UI_Z_INDEX.modal }}>
          <div className="bg-[var(--t-surface)] rounded-xl max-w-lg w-full p-6 space-y-4 border border-[var(--t-border)] shadow-xl">
            <h3 className="text-lg font-bold text-[var(--t-text)]">{t('taskDetail.changesTitle')}</h3>
            <p className="text-xs text-[var(--t-text-3)]">
              {t('taskDetail.changesDesc')}
            </p>

            <form onSubmit={handleChangesSubmit} data-testid="changes-requested-form" className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-[var(--t-text)] mb-1">
                  {t('taskDetail.changesFeedbackLabel')}
                </label>
                <textarea
                  data-testid="feedback-textarea"
                  rows={4}
                  placeholder={t('taskDetail.changesPlaceholder')}
                  value={feedback}
                  onChange={(e) => {
                    setFeedback(e.target.value);
                    if (e.target.value.trim()) setFeedbackError(null);
                  }}
                  className="w-full text-xs rounded-lg border border-[var(--t-border)] p-2.5 bg-[var(--t-surface-2)] text-[var(--t-text)] focus:outline-none focus:ring-2 focus:ring-[var(--t-warn)]"
                />
                {feedbackError && (
                  <p data-testid="feedback-error" className="text-xs text-[var(--t-crit)] mt-1">
                    {feedbackError}
                  </p>
                )}
              </div>

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowChangesModal(false)}
                  className="px-4 py-2 rounded-lg text-xs font-medium border border-[var(--t-border)] hover:bg-[var(--t-surface-2)] cursor-pointer"
                >
                  {t('common.close')}
                </button>
                <button
                  type="submit"
                  data-testid="submit-feedback-btn"
                  disabled={!feedback.trim() || reviewMutation.isPending}
                  className="px-4 py-2 rounded-lg text-xs font-semibold bg-[color-mix(in_srgb,var(--t-warn)_15%,transparent)] hover:bg-[color-mix(in_srgb,var(--t-warn)_15%,transparent)] text-[var(--t-on-accent)] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {t('taskDetail.changesSubmitBtn')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Task Modal */}
      {capture && (
        <div className="fixed inset-0 bg-[var(--t-overlay)] flex items-center justify-center p-4" style={{ zIndex: UI_Z_INDEX.modal }}>
          <form onSubmit={(event) => { event.preventDefault(); captureMutation.mutate(); }} className="w-full max-w-2xl bg-[var(--t-surface)] rounded-xl border border-[var(--t-border)] p-6 space-y-4">
            <h2 className="text-lg font-semibold">{t('extra.captureTitle')}</h2>
            <p className="text-xs text-[var(--t-text-3)]">{t('extra.captureDesc')}</p>
            <label className="block text-xs font-semibold">{t('extra.captureFieldTitle')}<input value={captureTitle} onChange={(e) => setCaptureTitle(e.target.value)} className="mt-1 w-full rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] p-2 text-sm" /></label>
            <label className="block text-xs font-semibold">{t('createTask.slug')}<input value={captureSlug} onChange={(e) => setCaptureSlug(e.target.value)} className="mt-1 w-full rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] p-2 text-sm" /></label>
            <pre className="max-h-48 overflow-auto rounded-lg bg-[var(--t-log-bg)] text-[var(--t-log-text)] p-3 text-xs whitespace-pre-wrap">{capture.excerpt}</pre>
            {captureMutation.error && <p className="text-sm text-[var(--t-crit)]">{(captureMutation.error as Error).message}</p>}
            <div className="flex justify-end gap-2"><button type="button" onClick={() => setCapture(null)} className="px-3 py-1.5 rounded-lg border border-[var(--t-border)] cursor-pointer">{t('extra.cancel')}</button><button type="submit" disabled={captureMutation.isPending} className="px-3 py-1.5 rounded-lg bg-[var(--t-accent)] text-[var(--t-on-accent)] cursor-pointer disabled:opacity-50">{t('extra.captureSubmit')}</button></div>
          </form>
        </div>
      )}

      {showEditModal && (
        <div data-testid="edit-task-modal" className="fixed inset-0 flex items-center justify-center bg-[var(--t-overlay)] backdrop-blur-xs p-4" style={{ zIndex: UI_Z_INDEX.modal }}>
          <div className="bg-[var(--t-surface)] rounded-xl max-w-lg w-full p-6 space-y-4 border border-[var(--t-border)] shadow-xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-2 border-b border-[var(--t-border)]">
              <div>
                <h3 className="text-lg font-bold text-[var(--t-text)]">{t('taskDetail.editTitle')}</h3>
                <p className="text-xs text-[var(--t-text-3)]">{t('taskDetail.editDesc')}</p>
              </div>
              <button
                type="button"
                onClick={() => setShowEditModal(false)}
                className="text-[var(--t-text-3)] hover:text-[var(--t-text)] p-1 rounded-lg hover:bg-[var(--t-surface-2)] cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {editError && (
              <div data-testid="edit-error" className="p-3 rounded-lg bg-[color-mix(in_srgb,var(--t-crit)_15%,transparent)] text-[var(--t-crit)] text-xs border border-[var(--t-crit)]">
                {editError}
              </div>
            )}

            <form onSubmit={handleEditSubmit} data-testid="edit-task-form" className="space-y-4">
              {/* Model Chain */}
              <div className="space-y-2">
                <label className="block text-xs font-semibold text-[var(--t-text)] uppercase tracking-wider">
                  {t('taskDetail.modelChainLabel')}
                </label>
                <div className="flex gap-2">
                  <select
                    data-testid="add-model-select"
                    value={selectedModelToAdd}
                    onChange={(e) => setSelectedModelToAdd(e.target.value)}
                    className="flex-1 text-xs rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-2.5 py-1.5 text-[var(--t-text)] focus:outline-none focus:ring-2 focus:ring-[var(--t-accent)]"
                  >
                    {modelSuggestions.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    data-testid="add-model-btn"
                    onClick={addModel}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-[var(--t-accent)] hover:bg-[var(--t-accent-hover)] text-[var(--t-on-accent)] inline-flex items-center gap-1 cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>{t('taskDetail.addModelBtn')}</span>
                  </button>
                </div>

                {modelChain.length === 0 ? (
                  <p className="text-xs text-[var(--t-text-3)] italic py-1">{t('taskDetail.noModels')}</p>
                ) : (
                  <div className="space-y-1.5 max-h-40 overflow-y-auto p-2 rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)]">
                    {modelChain.map((model, idx) => (
                      <div
                        key={`${model}-${idx}`}
                        data-testid={`model-item-${idx}`}
                        className="flex items-center justify-between p-1.5 rounded bg-[var(--t-surface)] text-xs border border-[var(--t-border)]"
                      >
                        <span className="font-mono text-[var(--t-text)] truncate">{model}</span>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            title={t('taskDetail.moveUp')}
                            aria-label={t('taskDetail.moveUp')}
                            data-testid={`move-up-btn-${idx}`}
                            disabled={idx === 0}
                            onClick={() => moveModel(idx, -1)}
                            className="p-1 rounded hover:bg-[var(--t-surface-2)] text-[var(--t-text-3)] hover:text-[var(--t-text)] disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                          >
                            <ArrowUp className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            title={t('taskDetail.moveDown')}
                            aria-label={t('taskDetail.moveDown')}
                            data-testid={`move-down-btn-${idx}`}
                            disabled={idx === modelChain.length - 1}
                            onClick={() => moveModel(idx, 1)}
                            className="p-1 rounded hover:bg-[var(--t-surface-2)] text-[var(--t-text-3)] hover:text-[var(--t-text)] disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                          >
                            <ArrowDown className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            title={t('taskDetail.removeModel')}
                            aria-label={t('taskDetail.removeModel')}
                            data-testid={`remove-model-btn-${idx}`}
                            onClick={() => removeModel(idx)}
                            className="p-1 rounded text-[var(--t-crit)] hover:bg-[var(--t-surface-2)] cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Dependencies (dependsOn) */}
              <div className="space-y-2">
                <label className="block text-xs font-semibold text-[var(--t-text)] uppercase tracking-wider">
                  {t('taskDetail.depsLabel')}
                </label>
                {(() => {
                  const candidateTasks = projectTasks.filter(
                    (t) =>
                      t.id !== task.id &&
                      t.id !== task.id.replace('/', '~') &&
                      t.id.replace('~', '/') !== task.id.replace('~', '/'),
                  );
                  if (candidateTasks.length === 0) {
                    return <p className="text-xs text-[var(--t-text-3)] italic py-1">{t('taskDetail.noDepsInProject')}</p>;
                  }
                  return (
                    <div className="grid grid-cols-1 gap-1.5 max-h-36 overflow-y-auto p-2 rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)]">
                      {candidateTasks.map((t) => {
                        const normId = t.id.includes('~') ? t.id.replace('~', '/') : t.id;
                        const isChecked =
                          selectedDeps.includes(t.id) ||
                          selectedDeps.includes(normId) ||
                          selectedDeps.includes(t.id.replace('/', '~'));
                        return (
                          <label
                            key={t.id}
                            className="flex items-center gap-2 text-xs text-[var(--t-text)] cursor-pointer p-1 rounded hover:bg-[var(--t-surface)]"
                          >
                            <input
                              type="checkbox"
                              data-testid={`dep-checkbox-${t.slug}`}
                              checked={isChecked}
                              onChange={() => toggleDep(normId)}
                              className="rounded text-[var(--t-accent)] focus:ring-[var(--t-accent)]"
                            />
                            <span className="font-mono text-[var(--t-text-3)]">[{t.slug}]</span>
                            <span className="truncate">{t.title}</span>
                          </label>
                        );
                      })}
                    </div>
                  );
                })()}
              </div>

              {/* Complexity Level */}
              <div className="space-y-2">
                <label className="block text-xs font-semibold text-[var(--t-text)] uppercase tracking-wider">
                  {t('taskDetail.levelLabel')}
                </label>
                <div className="flex gap-4">
                  <label className="flex items-center gap-2 cursor-pointer text-xs">
                    <input
                      type="radio"
                      name="editLevel"
                      value="easy"
                      checked={editLevel === 'easy'}
                      onChange={() => setEditLevel('easy')}
                      className="text-[var(--t-accent)] focus:ring-[var(--t-accent)]"
                    />
                    <span>{t('taskDetail.easyDesc')}</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer text-xs">
                    <input
                      type="radio"
                      name="editLevel"
                      value="hard"
                      checked={editLevel === 'hard'}
                      onChange={() => setEditLevel('hard')}
                      className="text-[var(--t-accent)] focus:ring-[var(--t-accent)]"
                    />
                    <span>{t('taskDetail.hardDesc')}</span>
                  </label>
                </div>
              </div>

              {/* Footer */}
              <div className="flex justify-end gap-3 pt-3 border-t border-[var(--t-border)]">
                <button
                  type="button"
                  onClick={() => setShowEditModal(false)}
                  className="px-4 py-2 rounded-lg text-xs font-medium border border-[var(--t-border)] hover:bg-[var(--t-surface-2)] cursor-pointer"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="submit"
                  data-testid="save-edit-btn"
                  disabled={editMutation.isPending}
                  className="px-4 py-2 rounded-lg text-xs font-semibold bg-[var(--t-accent)] hover:bg-[var(--t-accent-hover)] text-[var(--t-on-accent)] cursor-pointer disabled:opacity-50"
                >
                  {editMutation.isPending ? t('taskDetail.saving') : t('taskDetail.btnSave')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
