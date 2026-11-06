import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  addProjectKnowledge,
  createNewProject,
  createProject,
  getConfig,
  inspectProject,
  getProjectContextSummary,
  summarizeProjectContext,
  writeProjectGuidance,
} from '../api/client';
import { useLocale } from '../context/LocaleContext';
import type { Project, ProjectInspection, ProjectSettings } from '../types/api';
import { Button, Card } from './ui';
import {
  emptyDraft,
  StepBrain,
  StepContext,
  StepInspect,
  StepMode,
  StepPath,
  StepSuggestions,
  StepSummary,
} from './wizard';
import type { WizardDraft } from './wizard';

const DRAFT_KEY = 'agenthub.projectWizard';

function restoredDraft(): WizardDraft {
  try {
    const saved = JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}') as Partial<WizardDraft>;
    return { ...emptyDraft(), ...saved };
  } catch {
    return emptyDraft();
  }
}

function projectSettings(draft: WizardDraft): ProjectSettings {
  const projectRoot = draft.path.replace(/\/[^/]+\/?$/, '') || draft.path;
  const effectivePreset = draft.sensitive ? 'safe' : (draft.preset || 'balanced');
  const isSafe = draft.sensitive || effectivePreset === 'safe';
  return {
    ...draft.settings,
    preset: effectivePreset,
    brain: isSafe
      ? { ...draft.settings.brain, permissions: 'standard' }
      : draft.settings.brain,
    worktree: {
      ...draft.settings.worktree,
      ...(isSafe ? { logsInRoot: true } : {}),
      ...(isSafe ? { root: `${projectRoot}/.agenthub-worktrees` } : {}),
      install: draft.skipInstall ? 'skip' : 'auto',
      gitHooks: draft.skipHooks ? 'skip' : 'run',
    },
    integration: {
      ...draft.settings.integration,
      enabled: draft.integration,
      branch: draft.integration
        ? `agenthub/${draft.name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-')}-integration`
        : undefined,
      baseRef: draft.branch,
    },
    references: draft.references.filter((reference) => reference.name && reference.path),
    notifications: isSafe
      ? { ...draft.settings.notifications, telegramContent: 'minimal' }
      : draft.settings.notifications,
  };
}

export function sanitizeErrorMessage(raw: unknown, fallback = ''): string {
  if (!raw) return fallback;
  let str = typeof raw === 'string' ? raw : (raw instanceof Error ? raw.message : String(raw));
  const lines = str.split('\n');
  const filtered = lines.filter((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('at ')) return false;
    if (/\b(?:node_modules|\w+\.(?:ts|js|mjs|tsx|jsx)):\d+:\d+\b/.test(trimmed)) return false;
    if (/^\s*\^+\s*$/.test(trimmed)) return false;
    return true;
  });
  str = filtered.join('\n').trim();
  str = str.replace(/^Error:\s*/, '');
  return str || fallback;
}

export function ProjectWizard({
  onClose,
  summaryTimeoutMs = 30000,
  summaryPollIntervalMs = 1000,
}: {
  onClose: () => void;
  summaryTimeoutMs?: number;
  summaryPollIntervalMs?: number;
}) {
  const { t } = useLocale();
  const queryClient = useQueryClient();
  const [step, setStep] = useState(0);
  const [inspection, setInspection] = useState<ProjectInspection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<WizardDraft>(restoredDraft);
  const [createdProject, setCreatedProject] = useState<Project | null>(null);
  const [summaryPhase, setSummaryPhase] = useState<'idle' | 'summarizing' | 'review' | 'error'>('idle');
  const [contextSummary, setContextSummary] = useState('');
  const [summaryTaskId, setSummaryTaskId] = useState<string | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  // Start from the preset last applied globally, so new projects follow the hub-wide choice.
  const { data: hubConfig } = useQuery({ queryKey: ['config'], queryFn: getConfig });
  useEffect(() => {
    const preset = hubConfig?.defaultProjectPreset;
    if (preset) setDraft((current) => (current.preset || current.sensitive ? current : { ...current, preset }));
  }, [hubConfig?.defaultProjectPreset]);

  const update = (patch: Partial<WizardDraft>) => {
    setError(null);
    setDraft((current) => ({ ...current, ...patch }));
  };

  const inspectMutation = useMutation({
    mutationFn: () => inspectProject(draft.path),
    onSuccess: (value) => {
      setInspection(value);
      const isSensitive = value.suggestedSettings.sensitiveProject;
      setDraft((current) => ({
        ...current,
        branch: value.currentBranch || value.branches[0] || current.branch,
        checks: value.suggestedSettings.checks,
        skipInstall: value.suggestedSettings.skipInstall,
        skipHooks: value.suggestedSettings.skipGitHooks,
        integration: value.isGitRepo,
        sensitive: isSensitive,
        preset: isSensitive ? 'safe' : (current.preset || 'balanced'),
      }));
      setStep(2);
    },
    onError: (cause: Error) => setError(sanitizeErrorMessage(cause.message, t('projects.wizardSummaryErrorUnknown'))),
  });

  const summarizeMutation = useMutation({
    mutationFn: async (params: { projectId: string; sessions: string[]; selections: WizardDraft['selectedContextItems'] }) => {
      return summarizeProjectContext(params.projectId, {
        sessions: params.sessions,
        ...(params.selections.length ? { selections: params.selections } : {}),
      });
    },
    onSuccess: (result) => {
      setSummaryTaskId(result.taskId);
      if (result.summary) {
        setContextSummary(result.summary);
        setSummaryPhase('review');
      }
    },
    onError: (cause: Error) => {
      setSummaryError(sanitizeErrorMessage(cause.message, t('projects.wizardSummaryErrorUnknown')));
      setSummaryPhase('error');
    },
  });

  const summaryQuery = useQuery({
    queryKey: ['project-context-summary', createdProject?.id, summaryTaskId],
    queryFn: () => getProjectContextSummary(createdProject!.id, summaryTaskId!),
    enabled: summaryPhase === 'summarizing' && !summarizeMutation.isPending && Boolean(createdProject?.id && summaryTaskId),
    refetchInterval: summaryPollIntervalMs,
    refetchIntervalInBackground: true,
  });

  useEffect(() => {
    if (summaryPhase !== 'summarizing' || summarizeMutation.isPending) return;

    if (summaryQuery.isError) {
      setSummaryError(sanitizeErrorMessage(summaryQuery.error?.message, t('projects.wizardSummaryErrorUnknown')));
      setSummaryPhase('error');
      return;
    }

    if (!summaryQuery.data) return;
    if (summaryTaskId && summaryQuery.data.taskId && summaryQuery.data.taskId !== summaryTaskId) return;

    if (summaryQuery.data.summary || summaryQuery.data.status === 'done') {
      setContextSummary(summaryQuery.data.summary || '');
      setSummaryPhase('review');
    } else if (['failed', 'blocked', 'cancelled'].includes(summaryQuery.data.status)) {
      const msg = (summaryQuery.data as any).error || t('projects.wizardSummaryFailed', { status: summaryQuery.data.status });
      setSummaryError(sanitizeErrorMessage(msg, t('projects.wizardSummaryErrorUnknown')));
      setSummaryPhase('error');
    }
  }, [summaryPhase, summarizeMutation.isPending, summaryTaskId, summaryQuery.data, summaryQuery.isError, summaryQuery.error, t]);

  useEffect(() => {
    if (summaryPhase !== 'summarizing') return;
    const timer = setTimeout(() => {
      setSummaryError(t('projects.wizardSummaryTimeout'));
      setSummaryPhase('error');
    }, summaryTimeoutMs);
    return () => clearTimeout(timer);
  }, [summaryPhase, summaryTimeoutMs, t]);

  const pinSummaryMutation = useMutation({
    mutationFn: async (params: { projectId: string; content: string }) => {
      return addProjectKnowledge(params.projectId, { content: params.content, pinned: true });
    },
    onSuccess: () => {
      localStorage.removeItem(DRAFT_KEY);
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      onClose();
    },
    onError: (cause: Error) => setError(sanitizeErrorMessage(cause.message, t('projects.wizardSummaryErrorUnknown'))),
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const input = {
        name: draft.name,
        path: draft.path,
        defaultBranch: draft.branch,
        departmentId: draft.departmentId || 'chung',
        checks: draft.checks,
        settings: projectSettings(draft),
      };
      return draft.mode === 'new' ? createNewProject(input) : createProject(input);
    },
    onSuccess: async (project) => {
      setCreatedProject(project);
      queryClient.invalidateQueries({ queryKey: ['projects'] });

      if (draft.contextApproved) {
        if (draft.pinMemory && inspection?.memoryPreview) {
          try {
            await addProjectKnowledge(project.id, { content: inspection.memoryPreview, pinned: true });
          } catch {
            // Non-blocking best-effort
          }
        }
      }
      if (draft.agentsDraft && draft.agentsApproved && draft.agentsContent.trim()) {
        try {
          await writeProjectGuidance(project.id, draft.agentsContent.trim());
        } catch {
          // Non-blocking best-effort
        }
      }
      localStorage.removeItem(DRAFT_KEY);
      if (draft.contextApproved && draft.selectedSessions.length > 0) {
        setSummaryPhase('summarizing');
        setSummaryError(null);
        summarizeMutation.mutate({ projectId: project.id, sessions: draft.selectedSessions, selections: draft.selectedContextItems });
      } else {
        onClose();
      }
    },
    onError: (cause: Error) => setError(sanitizeErrorMessage(cause.message, t('projects.wizardSummaryErrorUnknown'))),
  });

  useEffect(() => {
    if (createdProject || summaryPhase !== 'idle') return;
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  }, [draft, createdProject, summaryPhase]);

  const canNext = useMemo(
    () => step !== 1 || Boolean(draft.name.trim() && draft.path.trim()),
    [step, draft.name, draft.path],
  );

  const next = () => {
    setError(null);
    if (step === 1 && draft.mode === 'existing') {
      inspectMutation.mutate();
      return;
    }
    if (step === 1) setInspection(null);
    setStep((current) => Math.min(6, current + 1));
  };

  const handleFinishAndClose = () => {
    localStorage.removeItem(DRAFT_KEY);
    queryClient.invalidateQueries({ queryKey: ['projects'] });
    onClose();
  };

  const handleClose = () => {
    if (summaryPhase !== 'idle' || createdProject) {
      handleFinishAndClose();
    } else {
      onClose();
    }
  };

  const handleRetry = () => {
    if (!createdProject) return;
    setSummaryError(null);
    queryClient.removeQueries({ queryKey: ['project-context-summary', createdProject.id] });
    setSummaryTaskId(null);
    setSummaryPhase('summarizing');
    summarizeMutation.mutate({
      projectId: createdProject.id,
      sessions: draft.selectedSessions,
      selections: draft.selectedContextItems,
    });
  };

  return (
    <Card data-testid="project-wizard" data-tour="modal-project-wizard" className="space-y-5 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-bold">{t('projects.wizardTitle')}</h2>
          <p className="text-sm text-[var(--t-text-3)]">{t(`projects.wizardWhy${step}`)}</p>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={handleClose}
          disabled={createMutation.isPending}
        >
          {t('common.close')}
        </Button>
      </div>
      <div className="flex gap-1" aria-label={t('projects.wizardProgress')}>
        {[0, 1, 2, 3, 4, 5, 6].map((item) => (
          <div key={item} className={`h-1 flex-1 rounded ${item <= step || summaryPhase !== 'idle' ? 'bg-[var(--t-accent)]' : 'bg-[var(--t-border)]'}`} />
        ))}
      </div>
      {error && <div role="alert" className="rounded-lg p-3 text-sm text-[var(--t-crit)]">{error}</div>}
      {summaryPhase === 'summarizing' && (
        <div className="space-y-4 py-4" data-testid="wizard-summarizing">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold">{t('projects.wizardSummarizingTitle')}</h3>
              <p className="text-sm text-[var(--t-text-3)]">{t('projects.wizardSummarizingProgress')}</p>
            </div>
            <span className="rounded bg-[var(--t-surface-2)] px-2 py-0.5 text-xs font-medium text-[var(--t-accent)]">
              {t('projects.wizardSummaryStatusRunning')}
            </span>
          </div>
          {summaryQuery.data?.status === 'waiting_quota' && (
            <div role="status" className="rounded-lg bg-[var(--t-surface-2)] p-3 text-xs text-[var(--t-text-2)]">
              {t('projects.wizardSummaryWaitingQuota')}
            </div>
          )}
          <div className="space-y-1 text-xs">
            {draft.selectedSessions.map((s) => (
              <div key={s} className="font-mono text-[var(--t-text-3)]">· {s}</div>
            ))}
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded bg-[var(--t-border)]">
            <div className="h-full w-2/3 animate-pulse rounded bg-[var(--t-accent)]" />
          </div>
          <div className="flex justify-end pt-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={handleFinishAndClose}
            >
              {t('projects.wizardSummaryBackground')}
            </Button>
          </div>
        </div>
      )}
      {summaryPhase === 'error' && (
        <div className="space-y-4 py-4" data-testid="wizard-summary-error">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold">{t('projects.wizardSummaryErrorTitle')}</h3>
              <p className="text-xs text-[var(--t-text-3)]">{t('projects.wizardProjectCreated')}</p>
            </div>
            <span className="rounded bg-[var(--t-surface-2)] px-2 py-0.5 text-xs font-medium text-[var(--t-crit)]">
              {t('projects.wizardSummaryStatusError')}
            </span>
          </div>
          <p className="text-sm text-[var(--t-text-2)]">{t('projects.wizardSummaryErrorDesc')}</p>
          {summaryError && (
            <div role="alert" className="rounded-lg border border-[var(--t-crit)]/30 bg-[var(--t-surface-2)] p-3 text-xs text-[var(--t-crit)]">
              {summaryError}
            </div>
          )}
          <div className="flex justify-between gap-2 pt-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={handleFinishAndClose}
            >
              {t('projects.wizardSummaryBackground')}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={handleRetry}
              loading={summarizeMutation.isPending}
              disabled={summarizeMutation.isPending}
            >
              {t('projects.wizardSummaryRetry')}
            </Button>
          </div>
        </div>
      )}
      {summaryPhase === 'review' && (
        <div className="space-y-4 py-2" data-testid="wizard-summary-review">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold">{t('projects.wizardSummaryReviewTitle')}</h3>
              <p className="text-xs text-[var(--t-text-3)]">{t('projects.wizardSummaryReviewDesc')}</p>
            </div>
            <span className="rounded bg-[var(--t-surface-2)] px-2 py-0.5 text-xs font-medium text-[var(--t-accent)]">
              {t('projects.wizardSummaryStatusSuccess')}
            </span>
          </div>
          <textarea
            aria-label={t('projects.wizardSummaryReviewTitle')}
            className="min-h-48 w-full rounded border bg-[var(--t-surface-2)] p-2 font-mono text-xs"
            value={contextSummary}
            onChange={(e) => setContextSummary(e.target.value)}
          />
          <div className="flex justify-between gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={handleFinishAndClose}
            >
              {t('projects.wizardSkipPin')}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => {
                if (createdProject && contextSummary.trim()) {
                  pinSummaryMutation.mutate({ projectId: createdProject.id, content: contextSummary.trim() });
                }
              }}
              loading={pinSummaryMutation.isPending}
            >
              {t('projects.wizardApproveAndPin')}
            </Button>
          </div>
        </div>
      )}
      {summaryPhase === 'idle' && (
        <>
          {step === 0 && <StepMode draft={draft} update={update} t={t} />}
          {step === 1 && <StepPath draft={draft} update={update} t={t} />}
          {step === 2 && <StepInspect inspection={inspection} draft={draft} update={update} t={t} />}
          {step === 3 && <StepSuggestions inspection={inspection} draft={draft} update={update} t={t} />}
          {step === 4 && <StepContext inspection={inspection} draft={draft} update={update} t={t} />}
          {step === 5 && <StepBrain draft={draft} update={update} t={t} />}
          {step === 6 && <StepSummary draft={draft} inspection={inspection} t={t} />}
          <div className="flex justify-between">
            <Button type="button" variant="secondary" size="sm" disabled={step === 0} onClick={() => setStep((current) => Math.max(0, current - 1))}>{t('projects.wizardBack')}</Button>
            {step < 6 ? (
              <Button type="button" size="sm" onClick={next} disabled={!canNext || inspectMutation.isPending} loading={inspectMutation.isPending}>{t('projects.wizardNext')}</Button>
            ) : (
              <Button type="button" size="sm" onClick={() => createMutation.mutate()} loading={createMutation.isPending}>{t('projects.wizardCreate')}</Button>
            )}
          </div>
        </>
      )}
    </Card>
  );
}

export { projectSettings };
