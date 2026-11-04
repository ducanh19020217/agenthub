import React, { useState, useEffect, useMemo } from 'react';
import {
  FolderGit2,
  GitBranch,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  CheckCircle2,
  AlertCircle,
  X,
  Plus,
  Trash2,
  ChevronDown,
  RotateCcw,
  Sparkles,
  Terminal,
} from 'lucide-react';
import {
  Card,
  Button,
  Input,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  StatTile,
  SelectOrCustomInput,
  Field,
} from './ui';
import { Link } from 'react-router-dom';
import {
  DEFAULT_COMMON_BRANCHES,
  DEFAULT_CLAUDE_MODELS,
  getModelsForProvider,
  validateBranchSyntax,
  validateReviewerModelSyntax,
  validateReviewChainReviewerSyntax,
} from '../utils/models';
import { useLocale } from '../context/LocaleContext';
import { UI_Z_INDEX } from './ui/layers';
import { InfoTooltip } from './tour/InfoTooltip';
import { Department, Project, ProjectSettings, UpdateProjectInput, PresetLevel } from '../types/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  updateProject,
  rerunProjectDeploy,
  getProjectDeployStatus,
  getConfig,
  getModelOptions,
  getFocus,
  setFocus,
  getReviewChecklistPreview,
  createTask,
  getProfiles,
  getPresets,
  applyPreset,
  getEffectiveConfig,
  getDepartments,
  getOpenProjectSources, getGiteaStatus, syncGitea, saveGiteaToken, getRemoteDeployStatus, triggerRemoteDeploy, saveRemoteDeployEnv,
} from '../api/client';

export interface StructuredCheckItem {
  name: string;
  cmd: string;
  timeoutSec?: number;
}

export function parseChecksToStructured(checksJsonOrArray: any): StructuredCheckItem[] {
  let arr: any[] = [];
  if (Array.isArray(checksJsonOrArray)) {
    arr = checksJsonOrArray;
  } else if (typeof checksJsonOrArray === 'string' && checksJsonOrArray.trim()) {
    try {
      const parsed = JSON.parse(checksJsonOrArray);
      if (Array.isArray(parsed)) arr = parsed;
    } catch {
      return [];
    }
  }
  return arr.map((item) => ({
    name: typeof item.name === 'string' ? item.name : '',
    cmd: Array.isArray(item.cmd) ? item.cmd.join(' ') : (typeof item.cmd === 'string' ? item.cmd : ''),
    timeoutSec: typeof item.timeoutSec === 'number' ? item.timeoutSec : undefined,
  }));
}

export function structuredToChecksArray(list: StructuredCheckItem[]): Array<{ name: string; cmd: string[]; timeoutSec?: number }> {
  return list.map((item) => ({
    name: item.name.trim(),
    cmd: item.cmd.trim().split(/\s+/).filter(Boolean),
    ...(item.timeoutSec ? { timeoutSec: item.timeoutSec } : {}),
  }));
}

/** Split a command line without invoking a shell; supports quoted strings and backslash escapes. */
export function parseArgv(input: string): string[] {
  const result: string[] = [];
  let current = '';
  let quote = '';
  let escaped = false;
  let inToken = false;

  for (const char of input.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      inToken = true;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      inToken = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = '';
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      inToken = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (inToken) {
        result.push(current);
        current = '';
        inToken = false;
      }
    } else {
      current += char;
      inToken = true;
    }
  }
  if (escaped) current += '\\';
  if (inToken) result.push(current);
  return result;
}

/** Parse KEY=VALUE lines for deploy secrets, preserving any '=' in the value. */
export function parseDeployEnv(input: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of input.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1);
    if (key) result[key] = val;
  }
  return result;
}

export interface ProjectSettingsDrawerProps {
  project: Project | null;
  departments?: Department[];
  isOpen: boolean;
  onClose: () => void;
  onSaved?: () => void;
}

export const defaultProjectSettings = (): NonNullable<Project['settings']> => ({
  commitConvention: {
    branchTemplate: 'agenthub/{slug}',
    commitTemplate: '{type}: {summary}',
    mergeMessageTemplate: "Merge branch '{branch}' into {target}",
  },
  brain: { mode: 'inherit' },
  worktree: { install: 'auto', gitHooks: 'run' },
  integration: { enabled: false },
  ci: {},
  references: [],
  reviewChecklist: [],
  notifications: { telegramContent: 'full' },
  openproject: { enabled: false, sourceId: null, role: 'primary' },
  gitea: { enabled: false, schedule: ['12:00', '18:00'], weekdaysOnly: false, checks: [], unionMergeGlobs: [] },
  remoteDeploy: { enabled: false, trigger: 'manual', steps: [], healthChecks: [], waitMinutes: 15 },
});

function normalizeProjectSettings(settings?: Partial<NonNullable<Project['settings']>>): NonNullable<Project['settings']> {
  const defaults = defaultProjectSettings();
  return {
    ...defaults,
    ...settings,
    commitConvention: {
      branchTemplate: settings?.commitConvention?.branchTemplate || defaults.commitConvention!.branchTemplate,
      commitTemplate: settings?.commitConvention?.commitTemplate || defaults.commitConvention!.commitTemplate,
      commitRegex: settings?.commitConvention?.commitRegex,
      mergeMessageTemplate: settings?.commitConvention?.mergeMessageTemplate || defaults.commitConvention!.mergeMessageTemplate,
    },
    brain: { ...defaults.brain, ...settings?.brain },
    worktree: { ...defaults.worktree, ...settings?.worktree },
    integration: { ...defaults.integration, ...settings?.integration },
    openproject: { ...defaults.openproject, ...settings?.openproject, enabled: settings?.openproject?.enabled ?? false, sourceId: settings?.openproject?.sourceId ?? null, role: settings?.openproject?.role ?? 'primary' },
    gitea: { ...defaults.gitea, ...settings?.gitea, enabled: settings?.gitea?.enabled ?? false, schedule: settings?.gitea?.schedule ?? defaults.gitea!.schedule, weekdaysOnly: settings?.gitea?.weekdaysOnly ?? false, checks: settings?.gitea?.checks ?? [], unionMergeGlobs: settings?.gitea?.unionMergeGlobs ?? [] },
    remoteDeploy: { ...defaults.remoteDeploy, ...settings?.remoteDeploy, enabled: settings?.remoteDeploy?.enabled ?? false, trigger: settings?.remoteDeploy?.trigger ?? 'manual', steps: settings?.remoteDeploy?.steps ?? [], healthChecks: settings?.remoteDeploy?.healthChecks ?? [], waitMinutes: settings?.remoteDeploy?.waitMinutes ?? 15 },
    ci: { ...defaults.ci, ...settings?.ci },
    notifications: { ...defaults.notifications, ...settings?.notifications },
    references: settings?.references ?? defaults.references,
    reviewChecklist: settings?.reviewChecklist ?? defaults.reviewChecklist,
  };
}

export function getProjectHooksString(proj: Project): string {
  if (!proj.hooks) return '';
  if (typeof proj.hooks === 'string') {
    try {
      const parsed = JSON.parse(proj.hooks);
      return Array.isArray(parsed?.onWorktreeRemoved)
        ? parsed.onWorktreeRemoved.join('\n')
        : '';
    } catch {
      return '';
    }
  }
  return Array.isArray(proj.hooks.onWorktreeRemoved)
    ? proj.hooks.onWorktreeRemoved.join('\n')
    : '';
}

export function changedSettings(
  current: NonNullable<Project['settings']>,
  original: NonNullable<Project['settings']>,
): Partial<NonNullable<Project['settings']>> {
  const result: Partial<NonNullable<Project['settings']>> = {};
  const sections = [
    'commitConvention',
    'brain',
    'worktree',
    'integration',
    'openproject',
    'gitea',
    'remoteDeploy',
    'ci',
    'references',
    'reviewChecklist',
    'notifications',
  ] as const;
  sections.forEach((section) => {
    if (JSON.stringify(current[section]) !== JSON.stringify(original[section])) {
      if (
        section === 'brain' &&
        current.brain.permissions === 'inherit' &&
        !original.brain.permissions
      ) {
        const { permissions: _permissions, ...brain } = current.brain;
        (result as Record<string, unknown>)[section] = brain;
      } else {
        (result as Record<string, unknown>)[section] = current[section];
      }
    }
  });
  return result;
}

function parsePositiveInt(val: string): number | undefined {
  const trimmed = val.trim();
  if (!trimmed) return undefined;
  if (!/^\d+$/.test(trimmed)) return undefined;
  const num = parseInt(trimmed, 10);
  return num > 0 && Number.isSafeInteger(num) ? num : undefined;
}

const SAMPLE_CHECKS = JSON.stringify(
  [
    {
      name: 'lint',
      cmd: ['npm', 'run', 'lint'],
      timeoutSec: 120,
    },
  ],
  null,
  2,
);



const SAMPLE_ENV = JSON.stringify(
  {
    PORT: 3000,
    DATABASE_URL: 'postgres://localhost:5432/db_{slot}',
  },
  null,
  2,
);

export const ProjectSettingsDrawer: React.FC<ProjectSettingsDrawerProps> = ({
  project,
  departments = [],
  isOpen,
  onClose,
  onSaved,
}) => {
  const { t, locale } = useLocale();
  const queryClient = useQueryClient();
  const { data: focus } = useQuery({ queryKey: ['focus'], queryFn: getFocus });
  const focusMutation = useMutation({
    mutationFn: (projectId: string | null) => setFocus(projectId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['focus'] });
      queryClient.invalidateQueries({ queryKey: ['status'] });
    },
  });

  const { data: remoteDepartments = [] } = useQuery({
    queryKey: ['departments'],
    queryFn: getDepartments,
    enabled: Boolean(isOpen && (!departments || departments.length === 0)),
  });
  const allDepartments = (departments && departments.length > 0) ? departments : remoteDepartments;

  const { data: effectiveConfig } = useQuery({
    queryKey: ['effective-config', project?.id],
    queryFn: () => getEffectiveConfig(project!.id),
    enabled: Boolean(isOpen && project?.id),
  });

  const { data: presets = [] } = useQuery({
    queryKey: ['presets'],
    queryFn: getPresets,
    enabled: Boolean(isOpen),
  });

  const { data: config } = useQuery({
    queryKey: ['config'],
    queryFn: getConfig,
    staleTime: 30_000,
  });
  const { data: openProjectSources = [] } = useQuery({ queryKey: ['openproject-sources'], queryFn: getOpenProjectSources, enabled: Boolean(isOpen) });

  const { data: allProfiles = [] } = useQuery({
    queryKey: ['profiles'],
    queryFn: getProfiles,
    staleTime: 30_000,
  });

  const { data: modelOptions } = useQuery({
    queryKey: ['model-options'],
    queryFn: getModelOptions,
    staleTime: 30_000,
  });

  const [draftSettings, setDraftSettings] = useState<ProjectSettings>(
    defaultProjectSettings(),
  );
  const [draftChecks, setDraftChecks] = useState<string>('');
  const [structuredChecks, setStructuredChecks] = useState<StructuredCheckItem[]>([]);
  const [showRawJsonReview, setShowRawJsonReview] = useState(false);
  const [draftHooks, setDraftHooks] = useState<string>('');
  const [draftReview, setDraftReview] = useState<string>('');
  const [draftReviewerOrder, setDraftReviewerOrder] = useState<string>('');
  const [draftReviewerFallback, setDraftReviewerFallback] = useState<string>('');
  const [draftEnvTemplate, setDraftEnvTemplate] = useState<string>('');
  const [draftDepartmentId, setDraftDepartmentId] = useState('chung');
  const [checklistDraft, setChecklistDraft] = useState('');
  const [showCommitExample, setShowCommitExample] = useState(false);
  const [giteaToken, setGiteaToken] = useState('');
  const [deployEnv, setDeployEnv] = useState('');
  const [savedDeployKeys, setSavedDeployKeys] = useState<string[]>([]);

  const [reviewerOrder, setReviewerOrder] = useState<
    Array<{ engine: 'codex' | 'claude'; model: string; profiles: string[] }>
  >([]);
  const [hasReviewerOrderOverride, setHasReviewerOrderOverride] = useState<boolean>(false);
  const [reviewerFallback, setReviewerFallback] = useState<{
    onUnavailable: boolean;
    onError: boolean;
    onBusyAfterMin: number;
  }>({
    onUnavailable: true,
    onError: true,
    onBusyAfterMin: 10,
  });
  const [hasReviewerFallbackOverride, setHasReviewerFallbackOverride] = useState<boolean>(false);
  const [reviewChain, setReviewChain] = useState<{
    chain: Array<{ reviewer: string; mode: 'gate' | 'final' }>;
    maxRounds: number;
  }>({ chain: [], maxRounds: 2 });
  const [hasReviewChainOverride, setHasReviewChainOverride] = useState<boolean>(false);

  const availableCodexReviewerModels = useMemo(() => {
    const fromApi = modelOptions?.suggestions || [];
    const fromConfigured = modelOptions?.configured || [];
    const fromConfigOrder = (config?.reviewer?.order || [])
      .filter((r) => r.engine === 'codex')
      .map((r) => r.model);
    const fromConfigReviewer = config?.reviewer?.model ? [config.reviewer.model] : [];
    const fromConfigArbiter = config?.reviewer?.arbiter?.engine === 'codex' && config.reviewer.arbiter.model
      ? [config.reviewer.arbiter.model]
      : [];
    const fromChains = [
      ...(config?.modelChainHard || []),
      ...(config?.modelChainEasy || []),
    ];
    const fromCurrentOrder = reviewerOrder
      .filter((r) => r.engine === 'codex')
      .map((r) => r.model);
    const fromProjectOrder = (project?.settings?.review?.order || [])
      .filter((r) => r.engine === 'codex')
      .map((r) => r.model);

    return getModelsForProvider([
        ...fromApi,
        ...fromConfigured,
        ...fromConfigOrder,
        ...fromConfigReviewer,
        ...fromConfigArbiter,
        ...fromChains,
        ...fromCurrentOrder,
        ...fromProjectOrder,
      ], 'codex');
  }, [modelOptions, config, reviewerOrder, project]);

  const availableClaudeReviewerModels = useMemo(() => {
    const fromChat = config?.chat?.models || [];
    const fromChatModel = config?.chat?.model ? [config.chat.model] : [];
    const fromClaudeModel = config?.reviewer?.claudeModel ? [config.reviewer.claudeModel] : [];
    const fromConfigOrder = (config?.reviewer?.order || [])
      .filter((r) => r.engine === 'claude')
      .map((r) => r.model);
    const fromConfigArbiter = config?.reviewer?.arbiter?.engine === 'claude' && config.reviewer.arbiter.model
      ? [config.reviewer.arbiter.model]
      : [];
    const fromApi = modelOptions?.suggestions || [];
    const fromConfigured = modelOptions?.configured || [];
    const fromCurrentOrder = reviewerOrder
      .filter((r) => r.engine === 'claude')
      .map((r) => r.model);
    const fromProjectOrder = (project?.settings?.review?.order || [])
      .filter((r) => r.engine === 'claude')
      .map((r) => r.model);

    return getModelsForProvider([
        ...DEFAULT_CLAUDE_MODELS,
        ...fromChat,
        ...fromChatModel,
        ...fromClaudeModel,
        ...fromConfigOrder,
        ...fromConfigArbiter,
        ...fromApi,
        ...fromConfigured,
        ...fromCurrentOrder,
        ...fromProjectOrder,
      ], 'claude');
  }, [modelOptions, config, reviewerOrder, project]);

  const availableReviewChainReviewers = useMemo(() => {
    const codexModels = availableCodexReviewerModels.map((m) =>
      m.startsWith('codex:') ? m : `codex:${m}`,
    );
    const fromCurrentChain = reviewChain.chain.map((s) => s.reviewer);
    let fromProjectChain: string[] = [];
    if (project?.review) {
      if (typeof project.review === 'object' && Array.isArray((project.review as any).chain)) {
        fromProjectChain = (project.review as any).chain.map((s: any) => s.reviewer).filter(Boolean);
      } else if (typeof project.review === 'string') {
        try {
          const parsed = JSON.parse(project.review);
          if (Array.isArray(parsed?.chain)) {
            fromProjectChain = parsed.chain.map((s: any) => s.reviewer).filter(Boolean);
          }
        } catch {
          // ignore
        }
      }
    }
    const chainReviewers = getModelsForProvider(
      [...fromCurrentChain, ...fromProjectChain],
      'codex',
    ).map((model) => (model.startsWith('codex:') ? model : `codex:${model}`));
    return Array.from(
      new Set([
        'claude',
        ...codexModels,
        ...chainReviewers,
      ]),
    ).filter(Boolean);
  }, [availableCodexReviewerModels, reviewChain.chain, project]);

  const [checksError, setChecksError] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewerOrderError, setReviewerOrderError] = useState<string | null>(null);
  const [reviewerFallbackError, setReviewerFallbackError] = useState<string | null>(null);
  const [envError, setEnvError] = useState<string | null>(null);
  const [refErrors, setRefErrors] = useState<Record<number, string | null>>({});

  const [apiError, setApiError] = useState<string | null>(null);
  const [sectionErrors, setSectionErrors] = useState<Record<string, string | null>>({});
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const resetDraftState = (targetProject: Project) => {
    setDraftSettings(normalizeProjectSettings(targetProject.settings));
    setChecklistDraft((targetProject.settings?.reviewChecklist || []).join('\n'));
    setStructuredChecks(parseChecksToStructured(targetProject.checks));
    setDraftDepartmentId(targetProject.departmentId || 'chung');
    setDraftChecks(
      typeof targetProject.checks === 'string'
        ? targetProject.checks
        : targetProject.checks
        ? JSON.stringify(targetProject.checks, null, 2)
        : '',
    );
    setDraftHooks(getProjectHooksString(targetProject));

    if (targetProject.settings?.review?.order && targetProject.settings.review.order.length > 0) {
      setReviewerOrder(targetProject.settings.review.order);
      setHasReviewerOrderOverride(true);
      setDraftReviewerOrder(JSON.stringify(targetProject.settings.review.order, null, 2));
    } else {
      setReviewerOrder([]);
      setHasReviewerOrderOverride(false);
      setDraftReviewerOrder('');
    }

    if (targetProject.settings?.review?.fallback) {
      setReviewerFallback({
        onUnavailable: targetProject.settings.review.fallback.onUnavailable ?? true,
        onError: targetProject.settings.review.fallback.onError ?? true,
        onBusyAfterMin: targetProject.settings.review.fallback.onBusyAfterMin ?? 10,
      });
      setHasReviewerFallbackOverride(true);
      setDraftReviewerFallback(JSON.stringify(targetProject.settings.review.fallback, null, 2));
    } else {
      setReviewerFallback({ onUnavailable: true, onError: true, onBusyAfterMin: 10 });
      setHasReviewerFallbackOverride(false);
      setDraftReviewerFallback('');
    }

    let parsedReview: any = null;
    if (typeof targetProject.review === 'object' && targetProject.review !== null) {
      parsedReview = targetProject.review;
    } else if (typeof targetProject.review === 'string' && targetProject.review.trim()) {
      try {
        parsedReview = JSON.parse(targetProject.review);
      } catch {
        parsedReview = null;
      }
    }

    if (parsedReview) {
      setReviewChain({
        chain: Array.isArray(parsedReview.chain) ? parsedReview.chain : [],
        maxRounds: typeof parsedReview.maxRounds === 'number' ? parsedReview.maxRounds : 2,
      });
      setHasReviewChainOverride(true);
      setDraftReview(JSON.stringify(parsedReview, null, 2));
    } else {
      setReviewChain({ chain: [], maxRounds: 2 });
      setHasReviewChainOverride(false);
      setDraftReview('');
    }

    setDraftEnvTemplate(targetProject.envTemplate ?? '');
    setChecksError(null);
    setReviewError(null);
    setReviewerOrderError(null);
    setReviewerFallbackError(null);
    setEnvError(null);
    setRefErrors({});
    setApiError(null);
    setSectionErrors({});
  };

  // Initialize draft when project changes
  useEffect(() => {
    if (project) {
      resetDraftState(project);
    }
  }, [project, isOpen]);

  const updateReviewerOrderState = (
    newOrder: Array<{ engine: 'codex' | 'claude'; model: string; profiles: string[] }>,
    isOverride: boolean,
  ) => {
    setReviewerOrder(newOrder);
    setHasReviewerOrderOverride(isOverride);
    const jsonStr = isOverride ? JSON.stringify(newOrder, null, 2) : '';
    setDraftReviewerOrder(jsonStr);
    setReviewerOrderError(null);
    setApiError(null);
  };

  const updateReviewerFallbackState = (
    newFallback: { onUnavailable: boolean; onError: boolean; onBusyAfterMin: number },
    isOverride: boolean,
  ) => {
    setReviewerFallback(newFallback);
    setHasReviewerFallbackOverride(isOverride);
    const jsonStr = isOverride ? JSON.stringify(newFallback, null, 2) : '';
    setDraftReviewerFallback(jsonStr);
    setReviewerFallbackError(null);
    setApiError(null);
  };

  const updateReviewChainState = (
    newChainConfig: {
      chain: Array<{ reviewer: string; mode: 'gate' | 'final' }>;
      maxRounds: number;
    },
    isOverride: boolean,
  ) => {
    setReviewChain(newChainConfig);
    setHasReviewChainOverride(isOverride);
    const jsonStr = isOverride ? JSON.stringify(newChainConfig, null, 2) : '';
    setDraftReview(jsonStr);
    setReviewError(null);
    setApiError(null);
  };

  // Validation functions
  const handleChecksChange = (val: string) => {
    setDraftChecks(val);
    setApiError(null);
    if (!val.trim()) {
      setChecksError(null);
      setStructuredChecks([]);
      return;
    }
    try {
      const parsed = JSON.parse(val);
      if (!Array.isArray(parsed)) {
        setChecksError('Checks must be a JSON array: [{ name, cmd }]');
      } else {
        setChecksError(null);
        setStructuredChecks(parseChecksToStructured(parsed));
      }
    } catch (err: any) {
      setChecksError(err.message);
    }
  };

  const updateStructuredCheck = (index: number, patch: Partial<StructuredCheckItem>) => {
    const updated = structuredChecks.map((item, idx) => (idx === index ? { ...item, ...patch } : item));
    setStructuredChecks(updated);
    const arr = structuredToChecksArray(updated);
    setDraftChecks(arr.length > 0 ? JSON.stringify(arr, null, 2) : '');
    setChecksError(null);
    setApiError(null);
  };

  const addStructuredCheck = () => {
    const updated = [...structuredChecks, { name: 'lint', cmd: 'npm run lint', timeoutSec: 120 }];
    setStructuredChecks(updated);
    const arr = structuredToChecksArray(updated);
    setDraftChecks(JSON.stringify(arr, null, 2));
    setChecksError(null);
    setApiError(null);
  };

  const removeStructuredCheck = (index: number) => {
    const updated = structuredChecks.filter((_, idx) => idx !== index);
    setStructuredChecks(updated);
    const arr = structuredToChecksArray(updated);
    setDraftChecks(arr.length > 0 ? JSON.stringify(arr, null, 2) : '');
    setChecksError(null);
    setApiError(null);
  };

  const applyPresetForProject = useMutation({
    mutationFn: async (preset: PresetLevel) => {
      return applyPreset({ scope: `project:${project!.id}`, preset, dryRun: false });
    },
    onSuccess: async (_result, preset) => {
      queryClient.invalidateQueries({ queryKey: ['effective-config', project?.id] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      setDraftSettings((prev) => ({
        ...prev,
        preset,
        review: { ...prev.review, autoMerge: preset === 'auto' },
        integration: { ...prev.integration, autoMerge: preset === 'auto' },
        autoFixOnFail: preset !== 'safe',
      }));
      if (preset === 'safe') {
        updateReviewChainState({ chain: [], maxRounds: 2 }, true);
      } else if (preset === 'balanced') {
        const codexModel = availableCodexReviewerModels[0] || 'codex:gpt-5.6-luna';
        const cleanCodex = codexModel.startsWith('codex:') ? codexModel : `codex:${codexModel}`;
        updateReviewChainState({
          chain: [
            { reviewer: cleanCodex, mode: 'gate' },
            { reviewer: 'claude', mode: 'final' },
          ],
          maxRounds: 2,
        }, true);
      } else if (preset === 'auto') {
        const codexModel = availableCodexReviewerModels[0] || 'codex:gpt-5.6-luna';
        const cleanCodex = codexModel.startsWith('codex:') ? codexModel : `codex:${codexModel}`;
        updateReviewChainState({
          chain: [{ reviewer: cleanCodex, mode: 'final' }],
          maxRounds: 3,
        }, true);
      }
      setToastMessage(t('settings.presetAppliedSuccess', { preset }));
    },
    onError: (err: any) => {
      setApiError(err?.message || t('settings.saveError'));
    },
  });

  const quickFixAutoMerge = () => {
    setDraftSettings((prev) => ({
      ...prev,
      review: { ...prev.review, autoMerge: true },
      integration: { ...prev.integration, autoMerge: true },
    }));
  };

  const quickFixChecks = () => {
    if (structuredChecks.length === 0) {
      addStructuredCheck();
    }
  };

  const quickFixChain = () => {
    const codexModel = availableCodexReviewerModels[0] || 'codex:gpt-5.6-luna';
    const cleanCodex = codexModel.startsWith('codex:') ? codexModel : `codex:${codexModel}`;
    if (reviewChain.chain.length === 0) {
      updateReviewChainState({ ...reviewChain, chain: [{ reviewer: cleanCodex, mode: 'final' }] }, true);
    } else {
      const updated = [...reviewChain.chain];
      updated[updated.length - 1] = { reviewer: cleanCodex, mode: 'final' };
      updateReviewChainState({ ...reviewChain, chain: updated }, true);
    }
  };

  const handleEnvChange = (val: string) => {
    setDraftEnvTemplate(val);
    setApiError(null);
    if (!val.trim()) {
      setEnvError(null);
      return;
    }
    try {
      const parsed = JSON.parse(val);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        setEnvError('envTemplate must be a JSON object');
      } else {
        setEnvError(null);
      }
    } catch (err: any) {
      setEnvError(err.message);
    }
  };

  const handleRefNameChange = (name: string, index: number) => {
    const updated = [...draftSettings.references];
    updated[index] = { ...updated[index], name };
    setDraftSettings((prev) => ({ ...prev, references: updated }));
    setApiError(null);

    const trimmed = name.trim();
    if (!trimmed) {
      setRefErrors((prev) => ({ ...prev, [index]: t('projects.nameRequired') }));
      return;
    }
    if (!/^[a-zA-Z0-9_.-]+$/.test(trimmed)) {
      setRefErrors((prev) => ({ ...prev, [index]: t('projects.invalidRefName') }));
      return;
    }
    const isDuplicate = updated.some(
      (r, i) => i !== index && r.name.trim() === trimmed,
    );
    if (isDuplicate) {
      setRefErrors((prev) => ({ ...prev, [index]: t('projects.duplicateRefName') }));
      return;
    }
    setRefErrors((prev) => ({ ...prev, [index]: null }));
  };

  const handleRefPathChange = (path: string, index: number) => {
    const updated = [...draftSettings.references];
    updated[index] = { ...updated[index], path };
    setDraftSettings((prev) => ({ ...prev, references: updated }));
    setApiError(null);
  };

  const handleRefInjectChange = (inject: boolean, index: number) => {
    const updated = [...draftSettings.references];
    updated[index] = { ...updated[index], inject };
    setDraftSettings((prev) => ({ ...prev, references: updated }));
    setApiError(null);
  };

  const handleAddRef = () => {
    setDraftSettings((prev) => ({
      ...prev,
      references: [...prev.references, { name: '', path: '', inject: false }],
    }));
  };

  const handleRemoveRef = (index: number) => {
    setDraftSettings((prev) => ({
      ...prev,
      references: prev.references.filter((_, i) => i !== index),
    }));
    setRefErrors((prev) => {
      const next = { ...prev };
      delete next[index];
      return next;
    });
  };

  // Change detection
  const origSettings = useMemo(
    () => normalizeProjectSettings(project?.settings),
    [project],
  );
  const origChecks = useMemo(() => {
    if (!project?.checks) return '';
    return typeof project.checks === 'string'
      ? project.checks
      : JSON.stringify(project.checks, null, 2);
  }, [project]);
  const origHooks = useMemo(
    () => (project ? getProjectHooksString(project) : ''),
    [project],
  );
  const origReview = useMemo(() => {
    if (!project?.review) return '';
    if (typeof project.review === 'object') {
      return JSON.stringify(project.review, null, 2);
    }
    if (typeof project.review === 'string' && project.review.trim()) {
      try {
        return JSON.stringify(JSON.parse(project.review), null, 2);
      } catch {
        return project.review;
      }
    }
    return '';
  }, [project]);
  const origEnv = useMemo(() => project?.envTemplate ?? '', [project]);

  const brainChanged = useMemo(
    () =>
      JSON.stringify(draftSettings.brain) !== JSON.stringify(origSettings.brain),
    [draftSettings.brain, origSettings.brain],
  );
  const worktreeChanged = useMemo(
    () =>
      JSON.stringify(draftSettings.worktree) !==
      JSON.stringify(origSettings.worktree),
    [draftSettings.worktree, origSettings.worktree],
  );
  const integrationChanged = useMemo(
    () =>
      JSON.stringify(draftSettings.integration) !==
      JSON.stringify(origSettings.integration),
    [draftSettings.integration, origSettings.integration],
  );
  const openprojectChanged = useMemo(
    () =>
      JSON.stringify(draftSettings.openproject) !==
      JSON.stringify(origSettings.openproject),
    [draftSettings.openproject, origSettings.openproject],
  );
  const giteaChanged = useMemo(
    () =>
      JSON.stringify(draftSettings.gitea) !==
      JSON.stringify(origSettings.gitea),
    [draftSettings.gitea, origSettings.gitea],
  );
  const remoteDeployChanged = useMemo(
    () =>
      JSON.stringify(draftSettings.remoteDeploy) !==
      JSON.stringify(origSettings.remoteDeploy),
    [draftSettings.remoteDeploy, origSettings.remoteDeploy],
  );
  const referencesChanged = useMemo(
    () =>
      JSON.stringify(draftSettings.references) !==
      JSON.stringify(origSettings.references),
    [draftSettings.references, origSettings.references],
  );
  const checklistChanged = useMemo(
    () => JSON.stringify(draftSettings.reviewChecklist || []) !== JSON.stringify(origSettings.reviewChecklist || []),
    [draftSettings.reviewChecklist, origSettings.reviewChecklist],
  );
  const checklistPreview = useQuery({
    queryKey: ['project-checklist-preview', project?.id, draftSettings.reviewChecklist],
    queryFn: () => getReviewChecklistPreview(project!.id),
    enabled: Boolean(isOpen && project?.id && (draftSettings.reviewChecklist || []).length),
  });
  const notificationsChanged = useMemo(
    () =>
      JSON.stringify(draftSettings.notifications) !==
      JSON.stringify(origSettings.notifications),
    [draftSettings.notifications, origSettings.notifications],
  );
  const checksChanged = useMemo(
    () => draftChecks.trim() !== origChecks.trim(),
    [draftChecks, origChecks],
  );
  const hooksChanged = useMemo(
    () => draftHooks.trim() !== origHooks.trim(),
    [draftHooks, origHooks],
  );
  const reviewChanged = useMemo(
    () => draftReview.trim() !== origReview.trim(),
    [draftReview, origReview],
  );
  const envChanged = useMemo(
    () => draftEnvTemplate.trim() !== origEnv.trim(),
    [draftEnvTemplate, origEnv],
  );
  const origReviewerOrderStr = useMemo(() => {
    return origSettings.review?.order && origSettings.review.order.length > 0
      ? JSON.stringify(origSettings.review.order, null, 2)
      : '';
  }, [origSettings.review?.order]);

  const origReviewerFallbackStr = useMemo(() => {
    return origSettings.review?.fallback
      ? JSON.stringify(origSettings.review.fallback, null, 2)
      : '';
  }, [origSettings.review?.fallback]);

  const orderChanged = useMemo(
    () => draftReviewerOrder.trim() !== origReviewerOrderStr.trim(),
    [draftReviewerOrder, origReviewerOrderStr],
  );

  const fallbackChanged = useMemo(
    () => draftReviewerFallback.trim() !== origReviewerFallbackStr.trim(),
    [draftReviewerFallback, origReviewerFallbackStr],
  );

  const reviewerOverrideChanged = useMemo(
    () => orderChanged || fallbackChanged,
    [orderChanged, fallbackChanged],
  );

  const changeCount = useMemo(() => {
    let count = 0;
    if (brainChanged) count++;
    if (JSON.stringify(draftSettings.commitConvention) !== JSON.stringify(origSettings.commitConvention)) count++;
    if (worktreeChanged) count++;
    if (integrationChanged) count++;
    if (openprojectChanged) count++;
    if (giteaChanged) count++;
    if (remoteDeployChanged) count++;
    if (referencesChanged) count++;
    if (checklistChanged) count++;
    if (notificationsChanged) count++;
    if (checksChanged) count++;
    if (hooksChanged) count++;
    if (reviewChanged) count++;
    if (envChanged) count++;
    if (draftDepartmentId !== (project?.departmentId ?? 'chung')) count++;
    if (reviewerOverrideChanged) count++;
    return count;
  }, [
    brainChanged,
    draftSettings.commitConvention,
    origSettings.commitConvention,
    worktreeChanged,
    integrationChanged,
    openprojectChanged,
    giteaChanged,
    remoteDeployChanged,
    referencesChanged,
    checklistChanged,
    notificationsChanged,
    checksChanged,
    hooksChanged,
    reviewChanged,
    envChanged,
    reviewerOverrideChanged,
  ]);

  const hasChanges = changeCount > 0;
  const hasValidationError = Boolean(
    checksError ||
      reviewError ||
      reviewerOrderError ||
      reviewerFallbackError ||
      envError ||
      Object.values(refErrors).some((err) => Boolean(err)),
  );

  // Deploy query
  const deployQuery = useQuery({
    queryKey: ['project-deploy', project?.id],
    queryFn: () => getProjectDeployStatus(project!.id),
    enabled: Boolean(isOpen && project?.id),
  });

  const deployMutation = useMutation({
    mutationFn: () => rerunProjectDeploy(project!.id),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['project-deploy', project?.id],
      });
      setToastMessage(t('projects.saveSuccessToast'));
      setTimeout(() => setToastMessage(null), 3000);
    },
  });

  const giteaStatus = useQuery({ queryKey: ['gitea-status', project?.id], queryFn: () => getGiteaStatus(project!.id), enabled: Boolean(isOpen && project?.id), refetchInterval: (query) => query.state.data?.running ? 3_000 : false });
  const remoteDeployStatus = useQuery({ queryKey: ['remote-deploy-status', project?.id], queryFn: () => getRemoteDeployStatus(project!.id), enabled: Boolean(isOpen && project?.id), refetchInterval: 10_000 });
  const giteaSyncMutation = useMutation({ mutationFn: () => syncGitea(project!.id), onSuccess: () => giteaStatus.refetch() });
  const deployNowMutation = useMutation({ mutationFn: () => triggerRemoteDeploy(project!.id), onSuccess: () => remoteDeployStatus.refetch() });
  const saveGiteaTokenMutation = useMutation({ mutationFn: () => saveGiteaToken(project!.id, giteaToken), onSuccess: () => setGiteaToken('') });
  const saveDeployEnvMutation = useMutation({
    mutationFn: () => saveRemoteDeployEnv(project!.id, parseDeployEnv(deployEnv)),
    onSuccess: (res) => {
      const parsedKeys = Object.keys(parseDeployEnv(deployEnv));
      const keys = Array.isArray(res) ? res : (res as any)?.keys || parsedKeys;
      setSavedDeployKeys(keys);
      setDeployEnv('');
    },
  });

  // Save Mutation
  const saveMutation = useMutation({
    mutationFn: (payload: UpdateProjectInput) =>
      updateProject(project!.id, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      setToastMessage(t('projects.saveSuccessToast'));
      setTimeout(() => setToastMessage(null), 3000);
      setApiError(null);
      setSectionErrors({});
      onSaved?.();
    },
    onError: (err: any) => {
      const msg = err.message || t('projects.saveSettingsError');
      setApiError(msg);
      if (
        msg.toLowerCase().includes('nhánh') ||
        msg.toLowerCase().includes('branch') ||
        msg.toLowerCase().includes('integration') ||
        msg.toLowerCase().includes('trùng') ||
        msg.toLowerCase().includes('duplicate')
      ) {
        setSectionErrors((prev) => ({ ...prev, integration: msg }));
      } else if (
        msg.toLowerCase().includes('quyền') ||
        msg.toLowerCase().includes('permission') ||
        msg.toLowerCase().includes('confirm')
      ) {
        setSectionErrors((prev) => ({ ...prev, brain: msg }));
      }
    },
  });

  const suggestChecksMutation = useMutation({
    mutationFn: () => createTask({
      project: project!.id,
      slug: `checklist-${Date.now()}`,
      title: t('projects.suggestChecksTaskTitle'),
      body: t('projects.suggestChecksTaskBody', {
        items: (draftSettings.reviewChecklist || []).map((item) => `- ${item}`).join('\n'),
      }),
      level: 'easy',
    }),
    onSuccess: () => setToastMessage(t('projects.draftChecksCreated')),
  });

  const handleDiscard = () => {
    if (!project) return;
    resetDraftState(project);
  };

  const handleSave = () => {
    if (!project || hasValidationError || saveMutation.isPending) return;

    if (draftSettings.integration.enabled) {
      if (draftSettings.integration.branch) {
        const err = validateBranchSyntax(draftSettings.integration.branch, t);
        if (err) {
          setSectionErrors((prev) => ({ ...prev, integration: `${t('projects.integrationBranch')}: ${err}` }));
          return;
        }
      }
      if (draftSettings.integration.baseRef) {
        const err = validateBranchSyntax(draftSettings.integration.baseRef, t);
        if (err) {
          setSectionErrors((prev) => ({ ...prev, integration: `${t('projects.integrationBaseRef')}: ${err}` }));
          return;
        }
      }
    }

    if (draftSettings.gitea?.enabled && draftSettings.gitea.schedule) {
      const timeRegex = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
      const invalid = draftSettings.gitea.schedule.some((slot) => !timeRegex.test(slot));
      if (invalid) {
        setSectionErrors((prev) => ({ ...prev, gitea: t('integrations.invalidScheduleTime') }));
        return;
      }
    }

    const payload: UpdateProjectInput = {};

    const partialSettings = changedSettings(draftSettings, origSettings);
    if (Object.keys(partialSettings).length > 0) {
      payload.settings = partialSettings;
    }

    if (checksChanged) {
      payload.checks = draftChecks.trim() ? JSON.parse(draftChecks) : null;
    }

    if (hooksChanged) {
      const lines = draftHooks
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      payload.hooks = lines.length > 0 ? { onWorktreeRemoved: lines } : null;
    }

    if (reviewChanged) {
      payload.review = draftReview.trim() ? JSON.parse(draftReview) : null;
    }

    if (reviewerOverrideChanged) {
      const reviewUpdate: Record<string, any> = {};
      if (orderChanged) {
        reviewUpdate.order = draftReviewerOrder.trim() ? JSON.parse(draftReviewerOrder) : null;
      }
      if (fallbackChanged) {
        reviewUpdate.fallback = draftReviewerFallback.trim() ? JSON.parse(draftReviewerFallback) : null;
      }
      payload.settings = {
        ...(payload.settings || {}),
        review: {
          ...(payload.settings?.review || {}),
          ...reviewUpdate,
        },
      };
    }

    if (envChanged) {
      payload.envTemplate = draftEnvTemplate.trim()
        ? draftEnvTemplate.trim()
        : null;
    }

    if (draftDepartmentId !== (project.departmentId ?? 'chung')) {
      payload.departmentId = draftDepartmentId;
    }

    if (draftSettings.brain.permissions === 'full') {
      payload.confirm = true;
    }

    saveMutation.mutate(payload);
  };

  const handleChecklistChange = (value: string) => {
    const paths = value.split('\n').map((item) => item.trim()).filter(Boolean).slice(0, 5);
    setChecklistDraft(value);
    setDraftSettings((prev) => ({ ...prev, reviewChecklist: paths }));
  };

  if (!isOpen || !project) return null;

  const brainModes = ['inherit', 'off', 'suggest', 'auto', 'external'] as const;
  const brainPerms = ['inherit', 'standard', 'trusted', 'full'] as const;

  const globalBudget = config?.brain?.dailyTokenBudget ?? 0;
  const globalMaxTurns = config?.brain?.maxTurnsPerHour ?? 20;

  return (
    <div
      className="fixed inset-0 overflow-hidden"
      style={{ zIndex: UI_Z_INDEX.modal }}
      data-testid="project-settings-drawer"
    >
      {/* Toast Notification */}
      {toastMessage && (
        <div
          role="status"
          className="fixed top-5 right-5 px-4 py-2.5 rounded-xl bg-[var(--t-ok)] text-[var(--t-on-accent)] font-medium text-xs shadow-xl flex items-center gap-2"
          style={{ zIndex: UI_Z_INDEX.toast }}
        >
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-[var(--t-overlay)] backdrop-blur-xs transition-opacity"
        onClick={onClose}
      />

      {/* Slide-over Drawer Panel */}
      <div className="fixed inset-y-0 right-0 w-full md:max-w-3xl bg-[var(--t-surface)] border-l border-[var(--t-border)] shadow-2xl flex flex-col">
        {/* Drawer Header */}
        <div
          className={
            'sticky top-0 px-6 py-4 z-20 flex items-start justify-between gap-4 ' +
            'border-b border-[var(--t-border)] bg-[var(--t-surface)]/95 backdrop-blur-xs'
          }
        >
          <div className="min-w-0">
            <h2 className="text-lg font-bold text-[var(--t-text)] flex items-center gap-2 truncate">
              <FolderGit2 className="w-5 h-5 text-[var(--t-accent)] shrink-0" />
              <span>{t('projects.settingsDrawerTitle', { name: project.name })}</span>
              <span className="text-xs font-mono font-normal text-[var(--t-text-3)]">
                ({project.id})
              </span>
            </h2>
            <p className="text-xs font-mono text-[var(--t-text-3)] mt-0.5 truncate">
              {project.path}
            </p>
          </div>

          <Button
            variant={focus?.projectId === project.id ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => focusMutation.mutate(focus?.projectId === project.id ? null : project.id)}
            disabled={focusMutation.isPending}
            className="shrink-0"
          >
            🎯 {focus?.projectId === project.id ? t('projects.unfocusProject') : t('projects.focusProject')}
          </Button>

          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            aria-label={t('projects.closeSettings')}
            className="shrink-0"
          >
            <X className="w-5 h-5" />
          </Button>
        </div>

        {/* Scrollable Settings Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6 pb-28">
          {/* General API error banner */}
          {apiError && (
            <div
              data-testid="settings-error-msg"
              className={
                'p-3.5 rounded-xl border border-[var(--t-crit)] text-[var(--t-crit)] ' +
                'text-xs flex items-center gap-2 bg-[color-mix(in_srgb,var(--t-crit)_15%,transparent)]'
              }
            >
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{apiError}</span>
            </div>
          )}

          {/* Section 1: Preset & Phòng ban */}
          <Card className="p-5 space-y-4" data-testid="project-preset-department">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-[var(--t-text)]">{t('projects.presetTitle')}</h3>
                <p className="text-xs text-[var(--t-text-3)]">{t('projects.presetSubtitle')}</p>
              </div>
              <span className="text-xs px-2 py-0.5 rounded bg-[var(--t-surface-2)] border border-[var(--t-border)] font-mono text-[var(--t-text-2)]">
                {t('projects.presetTitle')}: {draftSettings.preset || effectiveConfig?.preset || 'custom'}
              </span>
            </div>

            {/* Presets Cards */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5" data-testid="project-presets-list">
              {(['safe', 'balanced', 'auto'] as const).map((level) => {
                const pDef = presets.find((p) => p.id === level);
                const title = pDef?.name?.[locale as 'vi' | 'en'] || t(`settings.preset${level.charAt(0).toUpperCase() + level.slice(1)}`);
                const desc = pDef?.description?.[locale as 'vi' | 'en'] || t(`settings.preset${level.charAt(0).toUpperCase() + level.slice(1)}Desc`);
                const isCurrent = (draftSettings.preset || effectiveConfig?.preset) === level;
                return (
                  <div
                    key={level}
                    data-testid={`project-preset-card-${level}`}
                    className={`rounded-xl border p-3 space-y-2 transition-all flex flex-col justify-between ${
                      isCurrent
                        ? 'border-[var(--t-accent)] bg-[color-mix(in_srgb,var(--t-accent)_8%,transparent)] ring-1 ring-[var(--t-accent)]'
                        : 'border-[var(--t-border)] bg-[var(--t-surface-2)]'
                    }`}
                  >
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-xs text-[var(--t-text)]">{title}</span>
                        {isCurrent && (
                          <span className="text-[10px] text-[var(--t-accent)] font-semibold uppercase">✓</span>
                        )}
                      </div>
                      <p className="text-[11px] text-[var(--t-text-3)] line-clamp-2">{desc}</p>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant={isCurrent ? 'secondary' : 'primary'}
                      onClick={() => applyPresetForProject.mutate(level)}
                      disabled={applyPresetForProject.isPending}
                      className="w-full text-xs h-7 mt-1"
                    >
                      {applyPresetForProject.isPending && applyPresetForProject.variables === level
                        ? t('settings.presetApplying')
                        : isCurrent
                        ? t('common.details')
                        : t('settings.presetApplyBtn')}
                    </Button>
                  </div>
                );
              })}
            </div>

            {/* Department selector */}
            <div className="pt-2 border-t border-[var(--t-border)] space-y-1.5">
              <label className="text-xs font-semibold text-[var(--t-text)]" htmlFor="project-department">
                {t('departments.department')}
              </label>
              <select
                id="project-department"
                data-testid="project-department-select"
                value={draftDepartmentId}
                onChange={(event) => setDraftDepartmentId(event.target.value)}
                className="w-full rounded-lg border border-[var(--t-border)] p-2 bg-[var(--t-surface-2)] text-xs text-[var(--t-text)]"
              >
                {allDepartments.map((department) => (
                  <option key={department.id} value={department.id}>{department.name}</option>
                ))}
              </select>
            </div>
          </Card>

          {/* Section 2: Cấu hình hiệu lực */}
          <Card className="p-5 space-y-3" data-testid="effective-config-section">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-[var(--t-text)] flex items-center gap-2">
                  <Terminal className="w-4 h-4 text-[var(--t-accent)]" />
                  <span>{t('projects.effectiveConfigTitle')}</span>
                </h3>
                <p className="text-xs text-[var(--t-text-3)]">
                  {t('projects.presetSubtitle')}
                </p>
              </div>
              <span className="text-xs px-2 py-0.5 rounded bg-[var(--t-surface-2)] text-[var(--t-text-2)] font-mono">
                {effectiveConfig?.preset || 'custom'}
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
              {/* Brain Mode */}
              <div className="p-2.5 rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] flex items-center justify-between">
                <div>
                  <span className="text-[var(--t-text-3)] block">{t('projects.brainMode')}</span>
                  <span className="font-medium text-[var(--t-text)]">
                    {effectiveConfig?.brain?.mode?.value || draftSettings.brain.mode || 'inherit'}
                  </span>
                </div>
                <span
                  data-testid="effective-source-brainMode"
                  className={`text-[10px] px-2 py-0.5 rounded font-medium ${
                    effectiveConfig?.brain?.mode?.source === 'project'
                      ? 'bg-[color-mix(in_srgb,var(--t-accent)_15%,transparent)] text-[var(--t-accent)]'
                      : effectiveConfig?.brain?.mode?.source === 'department'
                      ? 'bg-[var(--t-surface)] text-[var(--t-accent)] border border-[var(--t-border)]'
                      : 'bg-[var(--t-border)] text-[var(--t-text-2)]'
                  }`}
                >
                  {effectiveConfig?.brain?.mode?.source
                    ? t(`projects.source${effectiveConfig.brain.mode.source.charAt(0).toUpperCase() + effectiveConfig.brain.mode.source.slice(1)}`)
                    : t('projects.sourceGlobal')}
                </span>
              </div>

              {/* Brain Permissions */}
              <div className="p-2.5 rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] flex items-center justify-between">
                <div>
                  <span className="text-[var(--t-text-3)] block">{t('projects.brainPermissions')}</span>
                  <span className="font-medium text-[var(--t-text)]">
                    {effectiveConfig?.brain?.permissions?.value || draftSettings.brain.permissions || 'standard'}
                  </span>
                </div>
                <span
                  data-testid="effective-source-permissions"
                  className={`text-[10px] px-2 py-0.5 rounded font-medium ${
                    effectiveConfig?.brain?.permissions?.source === 'project'
                      ? 'bg-[color-mix(in_srgb,var(--t-accent)_15%,transparent)] text-[var(--t-accent)]'
                      : effectiveConfig?.brain?.permissions?.source === 'department'
                      ? 'bg-[var(--t-surface)] text-[var(--t-accent)] border border-[var(--t-border)]'
                      : 'bg-[var(--t-border)] text-[var(--t-text-2)]'
                  }`}
                >
                  {effectiveConfig?.brain?.permissions?.source
                    ? t(`projects.source${effectiveConfig.brain.permissions.source.charAt(0).toUpperCase() + effectiveConfig.brain.permissions.source.slice(1)}`)
                    : t('projects.sourceGlobal')}
                </span>
              </div>

              {/* Brain Engine & Model */}
              <div className="p-2.5 rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] flex items-center justify-between">
                <div>
                  <span className="text-[var(--t-text-3)] block">{t('projects.brainEngine')}</span>
                  <span className="font-medium text-[var(--t-text)]">
                    {effectiveConfig?.brain?.engine?.value || 'claude'} ({effectiveConfig?.brain?.model?.value || 'sonnet'})
                  </span>
                </div>
                <span
                  data-testid="effective-source-engine"
                  className={`text-[10px] px-2 py-0.5 rounded font-medium ${
                    effectiveConfig?.brain?.engine?.source === 'project'
                      ? 'bg-[color-mix(in_srgb,var(--t-accent)_15%,transparent)] text-[var(--t-accent)]'
                      : effectiveConfig?.brain?.engine?.source === 'department'
                      ? 'bg-[var(--t-surface)] text-[var(--t-accent)] border border-[var(--t-border)]'
                      : 'bg-[var(--t-border)] text-[var(--t-text-2)]'
                  }`}
                >
                  {effectiveConfig?.brain?.engine?.source
                    ? t(`projects.source${effectiveConfig.brain.engine.source.charAt(0).toUpperCase() + effectiveConfig.brain.engine.source.slice(1)}`)
                    : t('projects.sourceGlobal')}
                </span>
              </div>

              {/* Review Chain */}
              <div className="p-2.5 rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] flex items-center justify-between">
                <div>
                  <span className="text-[var(--t-text-3)] block">{t('settings.reviewChainTitle')}</span>
                  <span className="font-medium text-[var(--t-text)]">
                    {(effectiveConfig?.review?.chain?.value || reviewChain.chain).length} {t('projects.reviewStepsCount')}
                  </span>
                </div>
                <span
                  data-testid="effective-source-chain"
                  className={`text-[10px] px-2 py-0.5 rounded font-medium ${
                    effectiveConfig?.review?.chain?.source === 'project'
                      ? 'bg-[color-mix(in_srgb,var(--t-accent)_15%,transparent)] text-[var(--t-accent)]'
                      : 'bg-[var(--t-border)] text-[var(--t-text-2)]'
                  }`}
                >
                  {effectiveConfig?.review?.chain?.source
                    ? t(`projects.source${effectiveConfig.review.chain.source.charAt(0).toUpperCase() + effectiveConfig.review.chain.source.slice(1)}`)
                    : t('projects.sourceGlobal')}
                </span>
              </div>
            </div>
          </Card>

          {/* Section 3: Review & Tự động merge */}
          <Card className="p-5 space-y-5" data-testid="project-review-automerge-section">
            {/* Khối Tự động merge & Checklist autoMergeReadiness */}
            <div className="rounded-xl border border-[var(--t-border)] bg-[var(--t-surface-2)] p-4 space-y-3" data-testid="automerge-checklist">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <h4 className="text-sm font-bold text-[var(--t-text)]">{t('projects.autoMergeSectionTitle')}</h4>
                  <span
                    data-testid="automerge-readiness-badge"
                    className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${
                      effectiveConfig?.autoMergeReadiness?.ready
                        ? 'bg-[color-mix(in_srgb,var(--t-ok)_15%,transparent)] text-[var(--t-ok)] border border-[var(--t-ok)]/30'
                        : 'bg-[color-mix(in_srgb,var(--t-crit)_15%,transparent)] text-[var(--t-crit)] border border-[var(--t-crit)]/30'
                    }`}
                  >
                    {effectiveConfig?.autoMergeReadiness?.ready
                      ? t('projects.autoMergeReady')
                      : t('projects.autoMergeNotReady')}
                  </span>
                </div>
                <label className="flex items-center gap-2 text-xs font-semibold cursor-pointer">
                  <input
                    type="checkbox"
                    data-testid="automerge-toggle-checkbox"
                    checked={Boolean(draftSettings.review?.autoMerge || draftSettings.integration?.autoMerge)}
                    onChange={(e) => {
                      setDraftSettings((prev) => ({
                        ...prev,
                        review: { ...prev.review, autoMerge: e.target.checked },
                        integration: { ...prev.integration, autoMerge: e.target.checked },
                      }));
                    }}
                  />
                  <span>{t('projects.reviewAutoMerge')}</span>
                </label>
              </div>

              {/* Checklist autoMergeReadiness */}
              <div className="space-y-2 pt-2 border-t border-[var(--t-border)]">
                <span className="text-xs font-semibold text-[var(--t-text-2)]">{t('projects.autoMergeReadinessTitle')}</span>

                {/* 1. Chain */}
                <div className="flex items-center justify-between text-xs p-2 rounded bg-[var(--t-surface)] border border-[var(--t-border)]">
                  <div className="flex items-center gap-2">
                    {reviewChain.chain.length > 0 && reviewChain.chain[reviewChain.chain.length - 1].reviewer.startsWith('codex:') ? (
                      <CheckCircle2 className="w-4 h-4 text-[var(--t-ok)] shrink-0" />
                    ) : (
                      <AlertCircle className="w-4 h-4 text-[var(--t-crit)] shrink-0" />
                    )}
                    <span>{t('projects.autoMergeRuleChain')}</span>
                  </div>
                  {(!reviewChain.chain.length || !reviewChain.chain[reviewChain.chain.length - 1].reviewer.startsWith('codex:')) && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      data-testid="automerge-fix-chain"
                      onClick={quickFixChain}
                      className="text-xs text-[var(--t-accent)] h-6 px-2"
                    >
                      {t('projects.autoMergeFixBtn')}
                    </Button>
                  )}
                </div>

                {/* 2. Checks */}
                <div className="flex items-center justify-between text-xs p-2 rounded bg-[var(--t-surface)] border border-[var(--t-border)]">
                  <div className="flex items-center gap-2">
                    {structuredChecks.length > 0 ? (
                      <CheckCircle2 className="w-4 h-4 text-[var(--t-ok)] shrink-0" />
                    ) : (
                      <AlertCircle className="w-4 h-4 text-[var(--t-crit)] shrink-0" />
                    )}
                    <span>{t('projects.autoMergeRuleChecks')}</span>
                  </div>
                  {structuredChecks.length === 0 && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      data-testid="automerge-fix-checks"
                      onClick={quickFixChecks}
                      className="text-xs text-[var(--t-accent)] h-6 px-2"
                    >
                      {t('projects.autoMergeFixBtn')}
                    </Button>
                  )}
                </div>

                {/* 3. AutoMerge enabled */}
                <div className="flex items-center justify-between text-xs p-2 rounded bg-[var(--t-surface)] border border-[var(--t-border)]">
                  <div className="flex items-center gap-2">
                    {Boolean(draftSettings.review?.autoMerge || draftSettings.integration?.autoMerge) ? (
                      <CheckCircle2 className="w-4 h-4 text-[var(--t-ok)] shrink-0" />
                    ) : (
                      <AlertCircle className="w-4 h-4 text-[var(--t-crit)] shrink-0" />
                    )}
                    <span>{t('projects.autoMergeRuleEnabled')}</span>
                  </div>
                  {!Boolean(draftSettings.review?.autoMerge || draftSettings.integration?.autoMerge) && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      data-testid="automerge-fix-automerge"
                      onClick={quickFixAutoMerge}
                      className="text-xs text-[var(--t-accent)] h-6 px-2"
                    >
                      {t('projects.autoMergeFixBtn')}
                    </Button>
                  )}
                </div>
              </div>

              {effectiveConfig?.autoMergeReadiness?.missing && effectiveConfig.autoMergeReadiness.missing.length > 0 && (
                <div className="p-2 rounded bg-[color-mix(in_srgb,var(--t-crit)_8%,transparent)] text-[11px] text-[var(--t-crit)] space-y-0.5">
                  {effectiveConfig.autoMergeReadiness.missing.map((msg: string, i: number) => (
                    <div key={i}>• {msg}</div>
                  ))}
                </div>
              )}
            </div>

            {/* Form Checks có cấu trúc */}
            <div className="space-y-3" data-testid="structured-checks-form">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-sm font-bold text-[var(--t-text)]">{t('projects.structuredChecksTitle')}</h4>
                  <p className="text-xs text-[var(--t-text-3)]">{t('projects.checksInfo')}</p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  data-testid="add-check-row-btn"
                  onClick={addStructuredCheck}
                  className="text-xs h-7 gap-1"
                >
                  <Plus className="w-3.5 h-3.5" />
                  {t('projects.addCheckBtn')}
                </Button>
              </div>

              {structuredChecks.length === 0 ? (
                <p className="text-xs text-[var(--t-text-3)] italic py-2">
                  {t('projects.noChecksConfigured')}
                </p>
              ) : (
                <div className="space-y-2">
                  {structuredChecks.map((item, idx) => (
                    <div
                      key={idx}
                      data-testid={`check-row-${idx}`}
                      className="p-3 rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] space-y-2"
                    >
                      <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-center">
                        <div className="sm:col-span-4 space-y-1">
                          <label className="text-[10px] uppercase font-semibold text-[var(--t-text-3)]">
                            {t('projects.checkNameLabel')}
                          </label>
                          <input
                            type="text"
                            data-testid={`check-name-${idx}`}
                            value={item.name}
                            onChange={(e) => updateStructuredCheck(idx, { name: e.target.value })}
                            placeholder="lint / test"
                            className="w-full text-xs rounded border border-[var(--t-border)] bg-[var(--t-surface)] px-2.5 py-1.5 text-[var(--t-text)]"
                          />
                        </div>
                        <div className="sm:col-span-5 space-y-1">
                          <label className="text-[10px] uppercase font-semibold text-[var(--t-text-3)]">
                            {t('projects.checkCmdLabel')}
                          </label>
                          <input
                            type="text"
                            data-testid={`check-cmd-${idx}`}
                            value={item.cmd}
                            onChange={(e) => updateStructuredCheck(idx, { cmd: e.target.value })}
                            placeholder="npm run lint"
                            className="w-full text-xs font-mono rounded border border-[var(--t-border)] bg-[var(--t-surface)] px-2.5 py-1.5 text-[var(--t-text)]"
                          />
                        </div>
                        <div className="sm:col-span-2 space-y-1">
                          <label className="text-[10px] uppercase font-semibold text-[var(--t-text-3)]">
                            {t('projects.checkTimeoutLabel')}
                          </label>
                          <input
                            type="number"
                            data-testid={`check-timeout-${idx}`}
                            value={item.timeoutSec ?? 120}
                            onChange={(e) => updateStructuredCheck(idx, { timeoutSec: Number(e.target.value) || undefined })}
                            className="w-full text-xs rounded border border-[var(--t-border)] bg-[var(--t-surface)] px-2 py-1.5 text-[var(--t-text)] font-mono"
                          />
                        </div>
                        <div className="sm:col-span-1 flex justify-end pt-4 sm:pt-0">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            data-testid={`delete-check-${idx}`}
                            onClick={() => removeStructuredCheck(idx)}
                            className="h-7 w-7 p-0 text-[var(--t-crit)] hover:bg-[color-mix(in_srgb,var(--t-crit)_10%,transparent)]"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Card>

          {/* Section 1: Bộ não (Brain) */}
          <Card className="p-5 space-y-5" data-tour="project-brain-settings">
            <div className="space-y-1">
              <h3 className="text-sm font-bold text-[var(--t-text)] flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-[var(--t-accent)]" />
                <span>{t('projects.sectionBrainTitle')}</span>
                <InfoTooltip text={t('projects.permissionsInfo')} label={t('projects.brainPermissions')} />
              </h3>
              <p className="text-xs text-[var(--t-text-3)]">
                {t('projects.sectionBrainDesc')}
              </p>
            </div>

            {sectionErrors.brain && (
              <div
                data-testid="brain-error-msg"
                className="p-2.5 rounded-lg bg-[color-mix(in_srgb,var(--t-crit)_15%,transparent)] text-[var(--t-crit)] text-xs flex items-center gap-1.5"
              >
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                <span>{sectionErrors.brain}</span>
              </div>
            )}

            {/* Brain Mode Radio Cards */}
            <div className="space-y-2">
              <label className="text-xs font-semibold text-[var(--t-text)]">
                {t('projects.brainMode')}
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                {brainModes.map((mode) => {
                  const isSelected = draftSettings.brain.mode === mode;
                  const labelKey = `brain${mode.charAt(0).toUpperCase() + mode.slice(1)}`;
                  return (
                    <label
                      key={mode}
                      className={`flex flex-col p-3 rounded-xl border text-xs cursor-pointer transition-all ${
                        isSelected
                          ? 'border-[var(--t-accent)] bg-[var(--t-surface-2)] shadow-xs ring-1 ring-[var(--t-accent)]'
                          : 'border-[var(--t-border)] hover:bg-[var(--t-hover)] bg-[var(--t-surface)]'
                      }`}
                    >
                      <div className="flex items-center gap-2 font-semibold text-[var(--t-text)] mb-1">
                        <input
                          type="radio"
                          name="brainMode"
                          value={mode}
                          checked={isSelected}
                          onChange={() => {
                            setSectionErrors((prev) => ({ ...prev, brain: null }));
                            setApiError(null);
                            setDraftSettings((prev) => ({
                              ...prev,
                              brain: { ...prev.brain, mode },
                            }));
                          }}
                          className="text-[var(--t-accent)] focus:ring-[var(--t-accent)]"
                        />
                        <span>{t(`projects.${labelKey}` as any)}</span>
                      </div>
                      <span className="text-[11px] text-[var(--t-text-3)] leading-relaxed pl-5">
                        {t(`projects.brainDesc${mode}` as any)}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>

            {/* Brain Permissions Radio Cards */}
            <div className="space-y-2 pt-2 border-t border-[var(--t-border)]">
              <label className="text-xs font-semibold text-[var(--t-text)]">
                {t('projects.brainPermissions')}
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
                {brainPerms.map((perm) => {
                  const currentPerm = draftSettings.brain.permissions ?? 'inherit';
                  const isSelected = currentPerm === perm;
                  const labelKey = `brainPermission${perm.charAt(0).toUpperCase() + perm.slice(1)}`;
                  const isFull = perm === 'full';

                  return (
                    <label
                      key={perm}
                      className={`flex flex-col p-3 rounded-xl border text-xs cursor-pointer transition-all ${
                        isSelected
                          ? isFull
                            ? 'border-[var(--t-crit)] bg-[color-mix(in_srgb,var(--t-crit)_8%,transparent)] ring-1 ring-[var(--t-crit)]'
                            : 'border-[var(--t-accent)] bg-[var(--t-surface-2)] shadow-xs ring-1 ring-[var(--t-accent)]'
                          : 'border-[var(--t-border)] hover:bg-[var(--t-hover)] bg-[var(--t-surface)]'
                      }`}
                    >
                      <div
                        className={`flex items-center gap-2 font-semibold mb-1 ${
                          isFull ? 'text-[var(--t-crit)]' : 'text-[var(--t-text)]'
                        }`}
                      >
                        <input
                          type="radio"
                          name="brainPermissions"
                          value={perm}
                          checked={isSelected}
                          onChange={() => {
                            if (isFull && !window.confirm(t('extra.fullModeConfirm'))) {
                              return;
                            }
                            setSectionErrors((prev) => ({ ...prev, brain: null }));
                            setApiError(null);
                            setDraftSettings((prev) => ({
                              ...prev,
                              brain: { ...prev.brain, permissions: perm },
                            }));
                          }}
                          className={
                            isFull
                              ? 'text-[var(--t-crit)] focus:ring-[var(--t-crit)]'
                              : 'text-[var(--t-accent)] focus:ring-[var(--t-accent)]'
                          }
                        />
                        <span>{t(`projects.${labelKey}` as any)}</span>
                      </div>
                      <span className="text-[11px] text-[var(--t-text-3)] leading-relaxed pl-5">
                        {t(`projects.brainPermissionDesc${perm}` as any)}
                      </span>
                    </label>
                  );
                })}
              </div>

              {draftSettings.brain.permissions === 'full' && (
                <div
                  role="alert"
                  className={
                    'p-3 rounded-lg border border-[var(--t-crit)] text-[var(--t-crit)] ' +
                    'text-xs flex items-start gap-2 mt-2 bg-[color-mix(in_srgb,var(--t-crit)_12%,transparent)]'
                  }
                >
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{t('projects.fullPermissionWarning')}</span>
                </div>
              )}
            </div>

            {/* Daily Token Budget & Max Turns Per Hour */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 border-t border-[var(--t-border)]">
              <div>
                <label className="block text-xs font-semibold text-[var(--t-text)] mb-1">
                  {t('projects.dailyTokenBudget')}
                </label>
                <div className="relative">
                  <Input
                    type="text"
                    inputMode="numeric"
                    aria-label={t('projects.dailyTokenBudget')}
                    placeholder={
                      globalBudget > 0
                        ? String(globalBudget)
                        : t('projects.unlimitedBudget')
                    }
                    value={draftSettings.brain.dailyTokenBudget ?? ''}
                    onChange={(e) => {
                      setApiError(null);
                      setDraftSettings((prev) => ({
                        ...prev,
                        brain: {
                          ...prev.brain,
                          dailyTokenBudget: parsePositiveInt(e.target.value),
                        },
                      }));
                    }}
                    className="pr-24"
                  />
                  <span className="absolute right-3 top-2 text-xs text-[var(--t-text-3)] pointer-events-none">
                    {t('projects.unitTokenPerDay')}
                  </span>
                </div>
                <p className="text-[11px] text-[var(--t-text-3)] mt-1">
                  {t('projects.tokenBudgetHint', {
                    value:
                      globalBudget > 0
                        ? `${globalBudget} tokens`
                        : t('projects.unlimitedBudget'),
                  })}
                </p>
              </div>

              <div>
                <label className="block text-xs font-semibold text-[var(--t-text)] mb-1">
                  {t('projects.maxTurnsPerHour')}
                </label>
                <div className="relative">
                  <Input
                    type="text"
                    inputMode="numeric"
                    aria-label={t('projects.maxTurnsPerHour')}
                    placeholder={String(globalMaxTurns)}
                    value={draftSettings.brain.maxTurnsPerHour ?? ''}
                    onChange={(e) => {
                      setApiError(null);
                      setDraftSettings((prev) => ({
                        ...prev,
                        brain: {
                          ...prev.brain,
                          maxTurnsPerHour: parsePositiveInt(e.target.value),
                        },
                      }));
                    }}
                    className="pr-24"
                  />
                  <span className="absolute right-3 top-2 text-xs text-[var(--t-text-3)] pointer-events-none">
                    {t('projects.unitTurnsPerHour')}
                  </span>
                </div>
                <p className="text-[11px] text-[var(--t-text-3)] mt-1">
                  {t('projects.maxTurnsHint', {
                    value: `${globalMaxTurns} ${t('projects.unitTurns')}`,
                  })}
                </p>
              </div>
            </div>
          </Card>

          {/* Section 2: Commit convention */}
          <Card className="p-5 space-y-4">
            <div className="space-y-1">
              <h3 className="text-sm font-bold text-[var(--t-text)]">{t('projects.commitConventionTitle')}</h3>
              <p className="text-xs text-[var(--t-text-3)]">{t('projects.commitConventionDesc')}</p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {([
                ['branchTemplate', 'projects.branchTemplate'],
                ['commitTemplate', 'projects.commitTemplate'],
                ['commitRegex', 'projects.commitRegex'],
                ['mergeMessageTemplate', 'projects.mergeMessageTemplate'],
              ] as const).map(([key, label]) => (
                <label key={key} className="text-xs space-y-1">
                  <span className="font-semibold">{t(label)}</span>
                  <Input
                    aria-label={t(label)}
                    value={draftSettings.commitConvention![key] ?? ''}
                    onChange={(e) => setDraftSettings((prev) => ({
                      ...prev,
                      commitConvention: { ...prev.commitConvention!, [key]: e.target.value || (key === 'commitRegex' ? undefined : '') },
                    }))}
                  />
                </label>
              ))}
            </div>
            <Button type="button" variant="secondary" size="sm" onClick={() => setShowCommitExample((value) => !value)}>
              {t('projects.commitConventionPreview')}
            </Button>
            {showCommitExample && (
              <pre className="rounded border p-3 text-xs whitespace-pre-wrap">{`Branch: ${draftSettings.commitConvention!.branchTemplate.replaceAll('{slug}', 'add-login').replaceAll('{ref}', 'PROJ-45')}\nCommit: ${draftSettings.commitConvention!.commitTemplate.replaceAll('{type}', 'feat').replaceAll('{scope}', 'auth').replaceAll('{ref}', 'PROJ-45').replaceAll('{summary}', 'add login')}\nMerge: ${draftSettings.commitConvention!.mergeMessageTemplate.replaceAll('{branch}', draftSettings.commitConvention!.branchTemplate.replaceAll('{slug}', 'add-login').replaceAll('{ref}', 'PROJ-45')).replaceAll('{target}', 'main')}`}</pre>
            )}
          </Card>

          {/* Section 3: Worktree */}
          <Card className="p-5 space-y-4" data-tour="project-worktree">
            <div className="space-y-1">
              <h3 className="text-sm font-bold text-[var(--t-text)] flex items-center gap-2">
                <Terminal className="w-4 h-4 text-[var(--t-accent)]" />
                <span>{t('projects.sectionWorktreeTitle')}</span>
              </h3>
              <p className="text-xs text-[var(--t-text-3)]">
                {t('projects.sectionWorktreeDesc')}
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2 p-3.5 rounded-xl border border-[var(--t-border)] bg-[var(--t-surface-2)] md:col-span-2">
                <label className="text-xs font-semibold text-[var(--t-text)] block">{t('projects.worktreeRoot')}</label>
                <Input
                  aria-label={t('projects.worktreeRoot')}
                  placeholder={t('projects.worktreeRootPlaceholder')}
                  value={draftSettings.worktree.root ?? ''}
                  onChange={(e) => setDraftSettings((prev) => ({
                    ...prev,
                    worktree: { ...prev.worktree, root: e.target.value || undefined },
                  }))}
                />
                <p className="text-[11px] text-[var(--t-text-3)]">{t('projects.worktreeRootDesc')}</p>
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={draftSettings.worktree.logsInRoot === true}
                    onChange={(e) => setDraftSettings((prev) => ({
                      ...prev,
                      worktree: { ...prev.worktree, logsInRoot: e.target.checked },
                    }))}
                  />
                  {t('projects.worktreeLogsInRoot')}
                </label>
              </div>
              {/* Dependency install */}
              <div className="space-y-2 p-3.5 rounded-xl border border-[var(--t-border)] bg-[var(--t-surface-2)]">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-[var(--t-text)]">
                    {t('projects.worktreeInstall')}
                  </span>
                  <div className="inline-flex rounded-lg border border-[var(--t-border)] p-0.5 bg-[var(--t-surface)]">
                    <button
                      type="button"
                      onClick={() =>
                        setDraftSettings((prev) => ({
                          ...prev,
                          worktree: { ...prev.worktree, install: 'auto' },
                        }))
                      }
                      className={`px-3 py-1 text-xs font-medium rounded-md cursor-pointer transition-colors ${
                        draftSettings.worktree.install === 'auto'
                          ? 'bg-[var(--t-accent)] text-[var(--t-on-accent)] shadow-xs'
                          : 'text-[var(--t-text-2)] hover:text-[var(--t-text)]'
                      }`}
                    >
                      {t('projects.worktreeAuto')}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setDraftSettings((prev) => ({
                          ...prev,
                          worktree: { ...prev.worktree, install: 'skip' },
                        }))
                      }
                      className={`px-3 py-1 text-xs font-medium rounded-md cursor-pointer transition-colors ${
                        draftSettings.worktree.install === 'skip'
                          ? 'bg-[var(--t-accent)] text-[var(--t-on-accent)] shadow-xs'
                          : 'text-[var(--t-text-2)] hover:text-[var(--t-text)]'
                      }`}
                    >
                      {t('projects.worktreeSkip')}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setDraftSettings((prev) => ({
                          ...prev,
                          worktree: { ...prev.worktree, install: 'worker' },
                        }))
                      }
                      className={`px-3 py-1 text-xs font-medium rounded-md cursor-pointer transition-colors ${
                        draftSettings.worktree.install === 'worker'
                          ? 'bg-[var(--t-accent)] text-[var(--t-on-accent)] shadow-xs'
                          : 'text-[var(--t-text-2)] hover:text-[var(--t-text)]'
                      }`}
                    >
                      {t('projects.worktreeWorker')}
                    </button>
                  </div>
                </div>
                <p className="text-[11px] text-[var(--t-text-3)] leading-relaxed">
                  {t('projects.worktreeInstallDesc')}
                </p>
              </div>

              {/* Git hooks */}
              <div className="space-y-2 p-3.5 rounded-xl border border-[var(--t-border)] bg-[var(--t-surface-2)]">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-[var(--t-text)]">
                    {t('projects.gitHooks')}
                  </span>
                  <div className="inline-flex rounded-lg border border-[var(--t-border)] p-0.5 bg-[var(--t-surface)]">
                    <button
                      type="button"
                      onClick={() =>
                        setDraftSettings((prev) => ({
                          ...prev,
                          worktree: { ...prev.worktree, gitHooks: 'run' },
                        }))
                      }
                      className={`px-3 py-1 text-xs font-medium rounded-md cursor-pointer transition-colors ${
                        draftSettings.worktree.gitHooks === 'run'
                          ? 'bg-[var(--t-accent)] text-[var(--t-on-accent)] shadow-xs'
                          : 'text-[var(--t-text-2)] hover:text-[var(--t-text)]'
                      }`}
                    >
                      {t('projects.gitHooksRun')}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setDraftSettings((prev) => ({
                          ...prev,
                          worktree: { ...prev.worktree, gitHooks: 'skip' },
                        }))
                      }
                      className={`px-3 py-1 text-xs font-medium rounded-md cursor-pointer transition-colors ${
                        draftSettings.worktree.gitHooks === 'skip'
                          ? 'bg-[var(--t-accent)] text-[var(--t-on-accent)] shadow-xs'
                          : 'text-[var(--t-text-2)] hover:text-[var(--t-text)]'
                      }`}
                    >
                      {t('projects.gitHooksSkip')}
                    </button>
                  </div>
                </div>
                <p className="text-[11px] text-[var(--t-text-3)] leading-relaxed">
                  {t('projects.gitHooksDesc')}
                </p>
              </div>
            </div>
          </Card>

          {/* Section 3: Nhánh tích hợp (Integration Branch) */}
          <Card className="p-5 space-y-4" data-tour="project-references">
            <div className="space-y-1">
              <h3 className="text-sm font-bold text-[var(--t-text)] flex items-center gap-2">
                <GitBranch className="w-4 h-4 text-[var(--t-accent)]" />
                <span>{t('projects.sectionIntegrationTitle')}</span>
              </h3>
              <p className="text-xs text-[var(--t-text-3)]">
                {t('projects.sectionIntegrationDesc')}
              </p>
            </div>

            {sectionErrors.integration && (
              <div
                data-testid="integration-error-msg"
                className="p-2.5 rounded-lg bg-[color-mix(in_srgb,var(--t-crit)_15%,transparent)] text-[var(--t-crit)] text-xs flex items-center gap-1.5"
              >
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                <span>{sectionErrors.integration}</span>
              </div>
            )}

            <div className="flex items-center gap-2">
              <input
                id="integration-toggle"
                type="checkbox"
                checked={draftSettings.integration.enabled}
                onChange={(e) => {
                  setSectionErrors((prev) => ({ ...prev, integration: null }));
                  setApiError(null);
                  setDraftSettings((prev) => ({
                    ...prev,
                    integration: {
                      ...prev.integration,
                      enabled: e.target.checked,
                    },
                  }));
                }}
                className="w-4 h-4 text-[var(--t-accent)] rounded border-[var(--t-border)]"
              />
              <label
                htmlFor="integration-toggle"
                className="text-xs font-semibold text-[var(--t-text)] cursor-pointer"
              >
                {t('projects.integrationEnabled')}
              </label>
            </div>

            {draftSettings.integration.enabled && (
              <div className="flex items-center gap-2">
                <input
                  id="integration-automerge"
                  type="checkbox"
                  checked={draftSettings.integration.autoMerge === true}
                  onChange={(e) => {
                    setApiError(null);
                    setDraftSettings((prev) => ({
                      ...prev,
                      integration: { ...prev.integration, autoMerge: e.target.checked },
                    }));
                  }}
                  className="w-4 h-4 text-[var(--t-accent)] rounded border-[var(--t-border)]"
                />
                <label htmlFor="integration-automerge" className="text-xs text-[var(--t-text)] cursor-pointer">
                  {t('projects.integrationAutoMerge')}
                </label>
              </div>
            )}

            {draftSettings.integration.enabled && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                <div>
                  <label className="block text-xs font-semibold text-[var(--t-text)] mb-1">
                    {t('projects.integrationBranch')} <InfoTooltip text={t('projects.integrationInfo')} label={t('projects.integrationBranch')} />
                  </label>
                  <SelectOrCustomInput
                    placeholder="integration"
                    value={draftSettings.integration.branch ?? ''}
                    onChange={(val) => {
                      setSectionErrors((prev) => ({ ...prev, integration: null }));
                      setApiError(null);
                      setDraftSettings((prev) => ({
                        ...prev,
                        integration: {
                          ...prev.integration,
                          branch: val || undefined,
                        },
                      }));
                    }}
                    options={DEFAULT_COMMON_BRANCHES}
                    validate={(val) => validateBranchSyntax(val, t)}
                    ariaLabel={t('projects.integrationBranch')}
                    allowEmpty={true}
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-[var(--t-text)] mb-1">
                    {t('projects.integrationBaseRef')}
                  </label>
                  <SelectOrCustomInput
                    placeholder="main"
                    value={draftSettings.integration.baseRef ?? ''}
                    onChange={(val) => {
                      setSectionErrors((prev) => ({ ...prev, integration: null }));
                      setApiError(null);
                      setDraftSettings((prev) => ({
                        ...prev,
                        integration: {
                          ...prev.integration,
                          baseRef: val || undefined,
                        },
                      }));
                    }}
                    options={DEFAULT_COMMON_BRANCHES}
                    validate={(val) => validateBranchSyntax(val, t)}
                    ariaLabel={t('projects.integrationBaseRef')}
                    allowEmpty={true}
                  />
                </div>
              </div>
            )}

            {/* integrationStatus StatTiles */}
            <div className="pt-2 border-t border-[var(--t-border)] space-y-2">
              <span className="text-xs font-semibold text-[var(--t-text-3)] block">
                {t('projects.integrationStatus')}
              </span>
              {project.integrationStatus ? (
                <div
                  data-testid="integration-status-tiles"
                  className="grid grid-cols-1 sm:grid-cols-2 gap-3"
                >
                  <StatTile
                    label={t('projects.integrationWorktreePath')}
                    value={
                      <span className="text-sm font-mono truncate block">
                        {project.integrationStatus.path}
                      </span>
                    }
                    subtext={
                      project.integrationStatus.exists
                        ? t('projects.statusExists')
                        : t('projects.statusNotExists')
                    }
                    icon={<FolderGit2 className="w-5 h-5" />}
                  />
                  <StatTile
                    label={t('projects.integrationCurrentBranchLabel')}
                    value={
                      <span className="text-sm font-mono truncate block">
                        {project.integrationStatus.currentBranch || '—'}
                      </span>
                    }
                    subtext={t('projects.targetBranch', {
                      branch: project.integrationStatus.branch,
                    })}
                    icon={<GitBranch className="w-5 h-5" />}
                  />
                  <StatTile
                    label={t('projects.integrationAheadBehind')}
                    value={`+${project.integrationStatus.ahead} / -${project.integrationStatus.behind}`}
                    subtext={`${project.integrationStatus.ahead} ahead, ${project.integrationStatus.behind} behind`}
                    icon={<ArrowUpDown className="w-5 h-5" />}
                  />
                  <StatTile
                    label={t('projects.integrationCleanStatus')}
                    value={
                      project.integrationStatus.dirty
                        ? t('projects.integrationDirty')
                        : t('projects.integrationClean')
                    }
                    subtext={
                      project.integrationStatus.dirty
                        ? t('projects.dirtyHint')
                        : t('projects.cleanHint')
                    }
                    iconColor={
                      project.integrationStatus.dirty
                        ? 'var(--t-warn)'
                        : 'var(--t-ok)'
                    }
                    icon={
                      project.integrationStatus.dirty ? (
                        <AlertCircle className="w-5 h-5" />
                      ) : (
                        <CheckCircle2 className="w-5 h-5" />
                      )
                    }
                  />
                </div>
              ) : (
                <div className="text-xs text-[var(--t-text-3)] p-3 rounded-lg bg-[var(--t-surface-2)]">
                  {t('projects.noIntegrationStatus')}
                </div>
              )}
            </div>
          </Card>

          <Card className="p-5 space-y-4" data-testid="project-openproject-section">
            <h3 className="text-sm font-bold text-[var(--t-text)]">{t('integrations.projectOpenProject')}</h3>
            <div className="space-y-1">
              <label className="flex items-center gap-2 text-xs text-[var(--t-text)] cursor-pointer">
                <input
                  type="checkbox"
                  checked={Boolean(draftSettings.openproject?.enabled)}
                  onChange={(e) =>
                    setDraftSettings((p) => ({
                      ...p,
                      openproject: { ...p.openproject!, enabled: e.target.checked },
                    }))
                  }
                />
                <span className="font-medium">{t('integrations.enabled')}</span>
              </label>
              <p className="text-xs text-[var(--t-text-3)]">{t('integrations.openProjectEnabledDesc')}</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label={t('integrations.source')}
                description={
                  openProjectSources.length === 0 ? (
                    <span>
                      {t('integrations.sourceDesc')}.{' '}
                      <Link to="/settings" className="text-[var(--t-accent)] hover:underline">
                        {t('integrations.goToSettings')}
                      </Link>
                    </span>
                  ) : (
                    t('integrations.sourceDesc')
                  )
                }
              >
                <select
                  value={draftSettings.openproject?.sourceId || ''}
                  onChange={(e) =>
                    setDraftSettings((p) => ({
                      ...p,
                      openproject: { ...p.openproject!, sourceId: e.target.value || null },
                    }))
                  }
                  className="w-full h-9 px-3 text-sm rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] text-[var(--t-text)] focus:border-[var(--t-accent)] focus:ring-2 focus:ring-[var(--t-accent)] focus:outline-hidden"
                >
                  <option value="">—</option>
                  {openProjectSources.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.id}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('integrations.role')}>
                <select
                  value={draftSettings.openproject?.role || 'primary'}
                  onChange={(e) =>
                    setDraftSettings((p) => ({
                      ...p,
                      openproject: {
                        ...p.openproject!,
                        role: e.target.value as 'primary' | 'secondary',
                      },
                    }))
                  }
                  className="w-full h-9 px-3 text-sm rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] text-[var(--t-text)] focus:border-[var(--t-accent)] focus:ring-2 focus:ring-[var(--t-accent)] focus:outline-hidden"
                >
                  <option value="primary">{t('integrations.rolePrimary')}</option>
                  <option value="secondary">{t('integrations.roleSecondary')}</option>
                </select>
              </Field>
            </div>
          </Card>

          <Card className="p-5 space-y-4" data-testid="project-gitea-section">
            <div className="space-y-1">
              <h3 className="text-sm font-bold text-[var(--t-text)]">Gitea</h3>
              <p className="text-xs text-[var(--t-text-3)]">{t('integrations.giteaDescription')}</p>
            </div>
            <label className="flex items-center gap-2 text-xs text-[var(--t-text)] cursor-pointer">
              <input
                type="checkbox"
                checked={Boolean(draftSettings.gitea?.enabled)}
                onChange={(e) => setDraftSettings((p) => ({ ...p, gitea: { ...p.gitea!, enabled: e.target.checked } }))}
              />
              <span className="font-medium">{t('integrations.enabled')}</span>
            </label>
            {sectionErrors.gitea && (
              <div className="rounded border border-[var(--t-crit)] bg-[color-mix(in_srgb,var(--t-crit)_10%,transparent)] p-2 text-xs text-[var(--t-crit)]">
                {sectionErrors.gitea}
              </div>
            )}
            <Field
              label={t('integrations.giteaUrl')}
              description={t('integrations.giteaUrlDesc')}
            >
              <Input
                value={draftSettings.gitea?.url || ''}
                onChange={(e) => setDraftSettings((p) => ({ ...p, gitea: { ...p.gitea!, url: e.target.value } }))}
                placeholder={t('integrations.giteaUrlPlaceholder')}
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label={t('integrations.sourceBranch')}
                description={t('integrations.sourceBranchDesc')}
              >
                <Input
                  value={draftSettings.gitea?.sourceBranch || ''}
                  onChange={(e) => setDraftSettings((p) => ({ ...p, gitea: { ...p.gitea!, sourceBranch: e.target.value } }))}
                  placeholder={t('integrations.sourceBranchPlaceholder')}
                />
              </Field>
              <Field
                label={t('integrations.targetBranch')}
                description={t('integrations.targetBranchDesc')}
              >
                <Input
                  value={draftSettings.gitea?.targetBranch || ''}
                  onChange={(e) => setDraftSettings((p) => ({ ...p, gitea: { ...p.gitea!, targetBranch: e.target.value } }))}
                  placeholder={t('integrations.targetBranchPlaceholder')}
                />
              </Field>
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-[var(--t-text)]">{t('integrations.schedule')}</span>
                <button
                  type="button"
                  data-testid="add-gitea-schedule-slot"
                  onClick={() => {
                    const next = [...(draftSettings.gitea?.schedule || []), '12:00'];
                    setDraftSettings((p) => ({ ...p, gitea: { ...p.gitea!, schedule: next } }));
                  }}
                  className="inline-flex items-center gap-1 rounded border border-dashed border-[var(--t-border)] px-2 py-0.5 text-xs text-[var(--t-accent)] hover:border-[var(--t-accent)] cursor-pointer"
                >
                  <Plus className="h-3 w-3" /> {t('integrations.addScheduleTime')}
                </button>
              </div>
              <p className="text-xs text-[var(--t-text-3)]">{t('integrations.scheduleDesc')}</p>
              <div className="rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] p-3" data-testid="gitea-schedule-section">
                <div className="flex flex-wrap gap-2" data-testid="gitea-schedule-list">
                  {(draftSettings.gitea?.schedule || []).map((slot, idx) => (
                    <div key={idx} className="flex items-center gap-1 rounded border border-[var(--t-border)] bg-[var(--t-surface)] px-2 py-1">
                      <input
                        type="time"
                        aria-label={`${t('integrations.scheduleSlot')} ${idx + 1}`}
                        value={slot}
                        onChange={(e) => {
                          const next = [...(draftSettings.gitea?.schedule || [])];
                          next[idx] = e.target.value;
                          setDraftSettings((p) => ({ ...p, gitea: { ...p.gitea!, schedule: next } }));
                        }}
                        className="bg-transparent text-xs font-mono text-[var(--t-text)] focus:outline-hidden"
                      />
                      <button
                        type="button"
                        aria-label={`${t('integrations.removeScheduleTime')} ${idx + 1}`}
                        onClick={() => {
                          const next = (draftSettings.gitea?.schedule || []).filter((_, i) => i !== idx);
                          setDraftSettings((p) => ({ ...p, gitea: { ...p.gitea!, schedule: next } }));
                        }}
                        className="p-0.5 text-[var(--t-text-3)] hover:text-[var(--t-crit)] cursor-pointer"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div className="space-y-1">
              <label className="flex items-center gap-2 text-xs text-[var(--t-text)] cursor-pointer">
                <input
                  type="checkbox"
                  checked={Boolean(draftSettings.gitea?.weekdaysOnly)}
                  onChange={(e) => setDraftSettings((p) => ({ ...p, gitea: { ...p.gitea!, weekdaysOnly: e.target.checked } }))}
                />
                <span className="font-medium">{t('integrations.weekdaysOnly')}</span>
              </label>
              <p className="text-xs text-[var(--t-text-3)]">{t('integrations.weekdaysOnlyDesc')}</p>
            </div>
            <Field
              label={t('integrations.checks')}
              description={t('integrations.checksDesc')}
            >
              <textarea
                value={(draftSettings.gitea?.checks || [])
                  .map((argv) => argv.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(' '))
                  .join('\n')}
                onChange={(e) =>
                  setDraftSettings((p) => ({
                    ...p,
                    gitea: { ...p.gitea!, checks: e.target.value.split('\n').map(parseArgv).filter((v) => v.length) },
                  }))
                }
                rows={3}
                placeholder={t('integrations.checksPlaceholder')}
                className="w-full rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] p-2 font-mono text-sm text-[var(--t-text)] focus:border-[var(--t-accent)] focus:ring-2 focus:ring-[var(--t-accent)] focus:outline-hidden"
              />
            </Field>
            <Field
              label={t('integrations.unionMergeGlobs')}
              description={t('integrations.unionMergeGlobsDesc')}
            >
              <Input
                value={(draftSettings.gitea?.unionMergeGlobs || []).join(', ')}
                onChange={(e) =>
                  setDraftSettings((p) => ({
                    ...p,
                    gitea: { ...p.gitea!, unionMergeGlobs: e.target.value.split(',').map((v) => v.trim()).filter(Boolean) },
                  }))
                }
                placeholder={t('integrations.unionMergeGlobsPlaceholder')}
              />
            </Field>
            <Field
              label={t('integrations.tokenGitea')}
              description={t('integrations.tokenGiteaDesc')}
              badge={
                giteaStatus.data?.tokenConfigured ? (
                  <span
                    data-testid="gitea-token-badge"
                    className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium bg-[color-mix(in_srgb,var(--t-ok)_15%,transparent)] text-[var(--t-ok)] border border-[var(--t-ok)]/30"
                  >
                    <CheckCircle2 className="h-3 w-3" />
                    {t('integrations.configured')}
                  </span>
                ) : (
                  <span
                    data-testid="gitea-token-badge"
                    className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium bg-[var(--t-surface-2)] text-[var(--t-text-3)] border border-[var(--t-border)]"
                  >
                    {t('integrations.noToken')}
                  </span>
                )
              }
            >
              {({ id }) => (
                <div className="flex gap-2">
                  <Input
                    id={id}
                    type="password"
                    value={giteaToken}
                    onChange={(e) => setGiteaToken(e.target.value)}
                    placeholder={t('integrations.tokenPlaceholder')}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    data-testid="save-gitea-token-button"
                    onClick={() => saveGiteaTokenMutation.mutate()}
                    disabled={!giteaToken}
                  >
                    {t('integrations.saveToken')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    data-testid="sync-gitea-button"
                    onClick={() => giteaSyncMutation.mutate()}
                    disabled={Boolean(giteaStatus.data?.running) || giteaSyncMutation.isPending}
                  >
                    {giteaStatus.data?.running
                      ? t('integrations.syncRunning', { step: giteaStatus.data.step || '…' })
                      : t('integrations.syncNow')}
                  </Button>
                </div>
              )}
            </Field>
            {giteaStatus.data?.remote && (
              <p className="text-xs text-[var(--t-text-3)]" data-testid="gitea-repo-info">
                {t('integrations.repo')}: {giteaStatus.data.remote.owner}/{giteaStatus.data.remote.repo} ({t('integrations.fromRemoteOrigin')})
              </p>
            )}
            {giteaStatus.data?.last ? (() => {
              const last = giteaStatus.data.last;
              const resultLabel = last.status === 'succeeded' ? t('integrations.syncSucceeded') : last.status === 'skipped' ? t('integrations.syncSkipped') : last.status === 'conflict' ? t('integrations.syncConflict') : t('integrations.syncFailed');
              return <p className="text-xs text-[var(--t-text-3)]" data-testid="gitea-last-sync">
                {t('integrations.lastSync')}: {new Date(last.finishedAt || '').toLocaleString()} — {resultLabel}
                {(last.reason || last.error) && <> ({last.reason || last.error})</>}
                {last.url && <> · <a className="underline" href={last.url} target="_blank" rel="noreferrer">{t('integrations.syncPr')} #{last.prNumber}</a></>}
              </p>;
            })() : <p className="text-xs text-[var(--t-text-3)]">{t('integrations.lastSync')}: —</p>}
          </Card>

          <Card className="p-5 space-y-4" data-testid="project-remote-deploy-section">
            <div className="space-y-1">
              <h3 className="text-sm font-bold text-[var(--t-text)]">{t('integrations.remoteDeploy')}</h3>
              <p className="text-xs text-[var(--t-text-3)]">{t('integrations.remoteDeployDescription')}</p>
            </div>
            <label className="flex items-center gap-2 text-xs text-[var(--t-text)] cursor-pointer">
              <input
                type="checkbox"
                checked={Boolean(draftSettings.remoteDeploy?.enabled)}
                onChange={(e) =>
                  setDraftSettings((p) => ({ ...p, remoteDeploy: { ...p.remoteDeploy!, enabled: e.target.checked } }))
                }
              />
              <span className="font-medium">{t('integrations.enabled')}</span>
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('integrations.trigger')}>
                <select
                  value={draftSettings.remoteDeploy?.trigger || 'manual'}
                  onChange={(e) =>
                    setDraftSettings((p) => ({
                      ...p,
                      remoteDeploy: { ...p.remoteDeploy!, trigger: e.target.value as 'manual' | 'after-gitea-sync' },
                    }))
                  }
                  className="w-full h-9 px-3 text-sm rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] text-[var(--t-text)] focus:border-[var(--t-accent)] focus:ring-2 focus:ring-[var(--t-accent)] focus:outline-hidden"
                >
                  <option value="manual">{t('integrations.triggerManual')}</option>
                  <option value="after-gitea-sync">{t('integrations.triggerAfterGiteaSync')}</option>
                </select>
              </Field>
              <Field
                label={t('integrations.waitMinutes')}
                description={t('integrations.waitMinutesDesc')}
              >
                <Input
                  type="number"
                  value={draftSettings.remoteDeploy?.waitMinutes ?? 15}
                  onChange={(e) =>
                    setDraftSettings((p) => ({
                      ...p,
                      remoteDeploy: { ...p.remoteDeploy!, waitMinutes: Number(e.target.value) },
                    }))
                  }
                />
              </Field>
            </div>
            <Field
              label={t('integrations.steps')}
              description={t('integrations.stepsDesc')}
            >
              <textarea
                value={(draftSettings.remoteDeploy?.steps || [])
                  .map((argv) => argv.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(' '))
                  .join('\n')}
                onChange={(e) =>
                  setDraftSettings((p) => ({
                    ...p,
                    remoteDeploy: {
                      ...p.remoteDeploy!,
                      steps: e.target.value.split('\n').map(parseArgv).filter((v) => v.length),
                    },
                  }))
                }
                rows={3}
                placeholder={t('integrations.stepsPlaceholder')}
                className="w-full rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] p-2 font-mono text-sm text-[var(--t-text)] focus:border-[var(--t-accent)] focus:ring-2 focus:ring-[var(--t-accent)] focus:outline-hidden"
              />
            </Field>
            <Field
              label={t('integrations.healthChecks')}
              description={t('integrations.healthChecksDesc')}
            >
              <textarea
                value={(draftSettings.remoteDeploy?.healthChecks || [])
                  .map((h) => `${h.url} ${h.expectStatusBelow}${h.contains ? ` ${JSON.stringify(h.contains)}` : ''}`)
                  .join('\n')}
                onChange={(e) =>
                  setDraftSettings((p) => ({
                    ...p,
                    remoteDeploy: {
                      ...p.remoteDeploy!,
                      healthChecks: e.target.value
                        .split('\n')
                        .filter(Boolean)
                        .map((line) => {
                          const a = parseArgv(line);
                          return {
                            url: a[0] || '',
                            expectStatusBelow: Number(a[1]) || 500,
                            ...(a[2] ? { contains: a[2] } : {}),
                          };
                        }),
                    },
                  }))
                }
                rows={2}
                className="w-full rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] p-2 font-mono text-sm text-[var(--t-text)] focus:border-[var(--t-accent)] focus:ring-2 focus:ring-[var(--t-accent)] focus:outline-hidden"
              />
            </Field>
            <Field
              label={t('integrations.deploySecrets')}
              description={t('integrations.deploySecretsDesc')}
            >
              {({ id }) => (
                <div className="flex gap-2">
                  <Input
                    id={id}
                    type="password"
                    value={deployEnv}
                    onChange={(e) => setDeployEnv(e.target.value)}
                    placeholder={t('integrations.deploySecretsPlaceholder')}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    data-testid="save-deploy-env-button"
                    onClick={() => saveDeployEnvMutation.mutate()}
                    disabled={!deployEnv.trim()}
                  >
                    {t('integrations.saveEnvSecrets')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    data-testid="deploy-now-button"
                    onClick={() => deployNowMutation.mutate()}
                  >
                    {t('integrations.deployNow')}
                  </Button>
                </div>
              )}
            </Field>
            {savedDeployKeys.length > 0 && (
              <p className="text-xs text-[var(--t-text-3)]" data-testid="saved-deploy-keys">
                {t('integrations.savedKeys')}: {savedDeployKeys.join(', ')}
              </p>
            )}
            <p className="text-xs text-[var(--t-text-3)]">{t('integrations.lastDeploy')}: {remoteDeployStatus.data?.status || '—'}</p>
          </Card>

          {/* Section 4: Tham chiếu chỉ đọc (Read-only References) */}
          <Card className="p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <h3 className="text-sm font-bold text-[var(--t-text)]">
                  {t('projects.sectionReferencesTitle')}
                </h3>
                <p className="text-xs text-[var(--t-text-3)]">
                  {t('projects.sectionReferencesDesc')}
                </p>
              </div>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={handleAddRef}
                className="gap-1"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>{t('projects.addReference')}</span>
              </Button>
            </div>

            {draftSettings.references.length === 0 ? (
              <p className="text-xs text-[var(--t-text-3)] italic py-2">
                {t('projects.noReferences')}
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-1/4">
                      {t('projects.refNameHeader')}
                    </TableHead>
                    <TableHead className="w-1/2">
                      {t('projects.refPathHeader')}
                    </TableHead>
                    <TableHead className="w-24 text-center">
                      {t('projects.refInjectHeader')} <InfoTooltip text={t('projects.referencesInfo')} label={t('projects.refInjectHeader')} />
                    </TableHead>
                    <TableHead className="w-16 text-center">
                      {t('projects.refActionsHeader')}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {draftSettings.references.map((ref, idx) => (
                    <TableRow key={idx}>
                      <TableCell className="align-top py-2">
                        <Input
                          placeholder={t('projects.refNamePlaceholder')}
                          value={ref.name}
                          onChange={(e) =>
                            handleRefNameChange(e.target.value, idx)
                          }
                          aria-label={`${t('projects.referenceName')} ${idx + 1}`}
                          className={`h-8 text-xs ${
                            refErrors[idx] ? 'border-[var(--t-crit)]' : ''
                          }`}
                        />
                        {refErrors[idx] && (
                          <span className="text-[11px] text-[var(--t-crit)] block mt-1">
                            {refErrors[idx]}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="align-top py-2">
                        <Input
                          placeholder={t('projects.refPathPlaceholder')}
                          value={ref.path}
                          onChange={(e) =>
                            handleRefPathChange(e.target.value, idx)
                          }
                          aria-label={`${t('projects.referencePath')} ${idx + 1}`}
                          className="h-8 text-xs"
                        />
                      </TableCell>
                      <TableCell className="align-middle text-center py-2">
                        <input
                          data-tour="reference-inject"
                          type="checkbox"
                          checked={ref.inject}
                          onChange={(e) =>
                            handleRefInjectChange(e.target.checked, idx)
                          }
                          className="w-4 h-4 text-[var(--t-accent)] rounded border-[var(--t-border)]"
                        />
                      </TableCell>
                      <TableCell className="align-middle text-center py-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleRemoveRef(idx)}
                          title={t('projects.deleteRef')}
                          aria-label={t('projects.deleteRef')}
                          className="text-[var(--t-crit)] hover:bg-[color-mix(in_srgb,var(--t-crit)_15%,transparent)] h-8 w-8 p-0"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Card>

          {/* Section 4b: Kiến thức & checklist */}
          <Card className="p-5 space-y-3">
            <div>
              <h3 className="text-sm font-bold text-[var(--t-text)]">{t('projects.knowledgeChecklistTitle')}</h3>
              <p className="text-xs text-[var(--t-text-3)]">{t('projects.knowledgeChecklistHint')}</p>
            </div>
            <textarea
              value={checklistDraft}
              onChange={(e) => handleChecklistChange(e.target.value)}
              placeholder={t('projects.knowledgeChecklistPlaceholder')}
              rows={3}
              className="w-full rounded border p-2 bg-[var(--t-surface-2)] text-xs font-mono"
              aria-label={t('projects.reviewChecklistLabel')}
            />
            {checklistPreview.data?.map((item) => (
              <div key={item.path} className="rounded border p-2 text-xs">
                <div className="flex justify-between"><span className="font-semibold">{item.path}</span><span>{item.size === null ? t('projects.checklistUnreadable') : `${item.size} bytes`}</span></div>
                {item.truncated && <div className="text-[var(--t-crit)]">{t('projects.checklistTooLarge')}</div>}
                {item.warning && <div className="text-[var(--t-crit)]">{item.warning}</div>}
                {item.content && <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap">{item.content.slice(0, 4000)}</pre>}
              </div>
            ))}
            <Button variant="secondary" size="sm" disabled={(draftSettings.reviewChecklist || []).length === 0 || suggestChecksMutation.isPending} onClick={() => suggestChecksMutation.mutate()}>
              {t('projects.suggestAutomaticChecks')}
            </Button>
          </Card>

          {/* Section 5: Thông báo (Notifications) */}
          <Card className="p-5 space-y-4">
            <div className="space-y-1">
              <h3 className="text-sm font-bold text-[var(--t-text)]">
                {t('projects.sectionNotificationsTitle')}
              </h3>
              <p className="text-xs text-[var(--t-text-3)]">
                {t('projects.sectionNotificationsDesc')}
              </p>
            </div>

            <div className="space-y-2 p-3.5 rounded-xl border border-[var(--t-border)] bg-[var(--t-surface-2)]">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-[var(--t-text)]">
                  {t('projects.telegramContent')}
                </span>
                <div className="inline-flex rounded-lg border border-[var(--t-border)] p-0.5 bg-[var(--t-surface)]">
                  <button
                    type="button"
                    onClick={() => {
                      setApiError(null);
                      setDraftSettings((prev) => ({
                        ...prev,
                        notifications: {
                          ...prev.notifications,
                          telegramContent: 'full',
                        },
                      }));
                    }}
                    className={`px-3 py-1 text-xs font-medium rounded-md cursor-pointer transition-colors ${
                      draftSettings.notifications.telegramContent === 'full'
                        ? 'bg-[var(--t-accent)] text-[var(--t-on-accent)] shadow-xs'
                        : 'text-[var(--t-text-2)] hover:text-[var(--t-text)]'
                    }`}
                  >
                    {t('projects.telegramFull')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setApiError(null);
                      setDraftSettings((prev) => ({
                        ...prev,
                        notifications: {
                          ...prev.notifications,
                          telegramContent: 'minimal',
                        },
                      }));
                    }}
                    className={`px-3 py-1 text-xs font-medium rounded-md cursor-pointer transition-colors ${
                      draftSettings.notifications.telegramContent === 'minimal'
                        ? 'bg-[var(--t-accent)] text-[var(--t-on-accent)] shadow-xs'
                        : 'text-[var(--t-text-2)] hover:text-[var(--t-text)]'
                    }`}
                  >
                    {t('projects.telegramMinimal')}
                  </button>
                </div>
              </div>
              <p className="text-[11px] text-[var(--t-text-3)] leading-relaxed">
                {t('projects.telegramContentDesc')}
              </p>
            </div>
          </Card>

          {/* Section 6: Kiểm tra & review (Advanced - Collapsed by default) */}
          <details
            data-testid="advanced-settings-section"
            data-tour="project-checks"
            className="border border-[var(--t-border)] rounded-xl bg-[var(--t-surface)] p-5 group space-y-4"
          >
            <summary className="cursor-pointer select-none flex items-center justify-between">
              <div className="space-y-0.5">
                <h3 className="text-sm font-bold text-[var(--t-text)]">
                  {t('projects.sectionAdvancedTitle')}
                </h3>
                <p className="text-xs text-[var(--t-text-3)]">
                  {t('projects.sectionAdvancedDesc')}
                </p>
              </div>
              <ChevronDown className="w-5 h-5 text-[var(--t-text-3)] transition-transform group-open:rotate-180 shrink-0 ml-2" />
            </summary>

            <div className="pt-4 space-y-5 border-t border-[var(--t-border)]">
              {/* checks JSON */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-semibold text-[var(--t-text)]">
                    {t('extra.checks')} <InfoTooltip text={t('projects.checksInfo')} label={t('extra.checks')} />
                  </label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => handleChecksChange(SAMPLE_CHECKS)}
                    className="h-6 px-2 text-[11px] text-[var(--t-accent)]"
                  >
                    {t('projects.insertExample')}
                  </Button>
                </div>
                <textarea
                  data-testid="checks-json-textarea"
                  rows={4}
                  value={draftChecks}
                  onChange={(e) => handleChecksChange(e.target.value)}
                  placeholder={'[{"name":"lint","cmd":["npm","run","lint"],"timeoutSec":120}]'}
                  className={`w-full text-xs font-mono rounded-lg border p-2.5 bg-[var(--t-surface-2)] text-[var(--t-text)] ${
                    checksError
                      ? 'border-[var(--t-crit)] focus:ring-[var(--t-crit)]'
                      : 'border-[var(--t-border)] focus:ring-[var(--t-accent)]'
                  } focus:outline-hidden focus:ring-2`}
                />
                {checksError && (
                  <p
                    data-testid="checks-error-msg"
                    className="text-xs text-[var(--t-crit)] flex items-center gap-1 mt-1"
                  >
                    <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                    <span>{checksError}</span>
                  </p>
                )}
              </div>

              {/* Raw JSON Review Chain (toggled) */}
              <div className="space-y-1.5 pt-2 border-t border-[var(--t-border)]">
                <label className="flex items-center gap-2 text-xs font-semibold cursor-pointer">
                  <input
                    type="checkbox"
                    checked={showRawJsonReview}
                    onChange={(e) => setShowRawJsonReview(e.target.checked)}
                  />
                  <span>{t('projects.rawJsonMode')} (Review Chain)</span>
                </label>
                {showRawJsonReview && (
                  <textarea
                    data-testid="review-chain-textarea"
                    rows={4}
                    value={draftReview}
                    onChange={(e) => {
                      setDraftReview(e.target.value);
                      try {
                        const parsed = JSON.parse(e.target.value);
                        if (parsed && typeof parsed === 'object') {
                          setReviewChain({
                            chain: Array.isArray(parsed.chain) ? parsed.chain : [],
                            maxRounds: typeof parsed.maxRounds === 'number' ? parsed.maxRounds : 2,
                          });
                          setHasReviewChainOverride(true);
                          setReviewError(null);
                        }
                      } catch (err: any) {
                        setReviewError(err.message);
                      }
                    }}
                    placeholder={'{"chain":[{"reviewer":"codex:gpt-5.6-luna","mode":"final"}],"maxRounds":2}'}
                    className="w-full text-xs font-mono rounded-lg border p-2.5 bg-[var(--t-surface-2)] text-[var(--t-text)] border-[var(--t-border)]"
                  />
                )}
                {reviewError && (
                  <p className="text-xs text-[var(--t-crit)] flex items-center gap-1 mt-1">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                    <span>{reviewError}</span>
                  </p>
                )}
              </div>

              {/* hooks multiline */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-[var(--t-text)]">
                  {t('extra.hooks')}
                </label>
                <textarea
                  data-testid="hooks-textarea"
                  rows={3}
                  value={draftHooks}
                  onChange={(e) => {
                    setDraftHooks(e.target.value);
                    setApiError(null);
                  }}
                  placeholder={'docker exec xfarm_postgres psql -U xfarm -d postgres -c "DROP DATABASE IF EXISTS xfarm_t_{slug_underscored}"'}
                  className={
                    'w-full text-xs font-mono rounded-lg border border-[var(--t-border)] p-2.5 ' +
                    'bg-[var(--t-surface-2)] text-[var(--t-text)] focus:ring-2 focus:ring-[var(--t-accent)]'
                  }
                />
              </div>

              {/* reviewer override */}
              <div className="space-y-3 rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] p-3" data-testid="project-reviewer-order">
                <div className="flex items-center justify-between">
                  <div>
                    <label className="text-xs font-semibold text-[var(--t-text)]">{t('projects.reviewerOverride')}</label>
                    <p className="text-[11px] text-[var(--t-text-3)]">{t('projects.reviewerOverrideHint')}</p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {hasReviewerOrderOverride ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => updateReviewerOrderState([], false)}
                        className="h-6 px-2 text-[10px] text-[var(--t-crit)]"
                      >
                        {t('settings.useSystemDefault')}
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          updateReviewerOrderState(
                            [{ engine: 'codex', model: availableCodexReviewerModels[0] || '', profiles: [] }],
                            true,
                          )
                        }
                        className="h-6 px-2 text-[10px] text-[var(--t-accent)]"
                      >
                        + {t('settings.overrideConfig')}
                      </Button>
                    )}
                  </div>
                </div>

                {!hasReviewerOrderOverride ? (
                  <p className="text-xs text-[var(--t-text-3)] italic py-1">
                    {t('settings.useSystemDefault')}
                  </p>
                ) : (
                  <div className="space-y-2">
                    {reviewerOrder.length === 0 && (
                      <p className="text-xs text-[var(--t-text-3)] italic py-1">
                        {t('settings.noReviewers')}
                      </p>
                    )}
                    {reviewerOrder.map((item, index) => {
                      const engineProfiles = allProfiles.filter((p) => p.engine === item.engine);
                      const activeProfileNames = new Set(engineProfiles.map((p) => p.name));
                      const missingProfiles = (item.profiles || []).filter((name) => !activeProfileNames.has(name));
                      const engineModelOptions = item.engine === 'codex' ? availableCodexReviewerModels : availableClaudeReviewerModels;

                      return (
                        <div
                          key={`proj-reviewer-${index}`}
                          className="rounded-lg border border-[var(--t-border)] bg-[var(--t-surface)] p-2.5 space-y-2"
                        >
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-bold text-[var(--t-text-3)]">{index + 1}.</span>
                            <select
                              aria-label={`${t('settings.reviewerOrder')} ${index + 1}`}
                              value={item.engine}
                              onChange={(e) => {
                                const newEngine = e.target.value as 'codex' | 'claude';
                                const next = reviewerOrder.map((row, i) =>
                                  i === index
                                    ? {
                                        ...row,
                                        engine: newEngine,
                                        model: newEngine === 'codex'
                                          ? (availableCodexReviewerModels[0] || '')
                                          : (availableClaudeReviewerModels[0] || ''),
                                        profiles: [],
                                      }
                                    : row,
                                );
                                updateReviewerOrderState(next, true);
                              }}
                              className="text-xs rounded border border-[var(--t-border)] bg-[var(--t-surface-2)] px-2 py-1.5 text-[var(--t-text)]"
                            >
                              <option value="codex">Codex</option>
                              <option value="claude">Claude</option>
                            </select>
                            <div className="min-w-0 flex-1">
                              <SelectOrCustomInput
                                ariaLabel={`${t('settings.reviewerModel')} ${index + 1}`}
                                value={item.model}
                                onChange={(val) => {
                                  const next = reviewerOrder.map((row, i) =>
                                    i === index ? { ...row, model: val } : row,
                                  );
                                  updateReviewerOrderState(next, true);
                                }}
                                options={engineModelOptions}
                                validate={(val) => validateReviewerModelSyntax(val, item.engine, t)}
                                placeholder={item.engine === 'codex' ? 'codex:model' : 'sonnet'}
                              />
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              <button
                                type="button"
                                disabled={index === 0}
                                onClick={() => {
                                  if (index === 0) return;
                                  const next = [...reviewerOrder];
                                  const [moved] = next.splice(index, 1);
                                  next.splice(index - 1, 0, moved);
                                  updateReviewerOrderState(next, true);
                                }}
                                aria-label={`${t('settings.moveUp')} ${index + 1}`}
                                className="p-1 rounded hover:bg-[var(--t-hover)] text-[var(--t-text-3)] hover:text-[var(--t-text)] disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                              >
                                <ArrowUp className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                disabled={index === reviewerOrder.length - 1}
                                onClick={() => {
                                  if (index === reviewerOrder.length - 1) return;
                                  const next = [...reviewerOrder];
                                  const [moved] = next.splice(index, 1);
                                  next.splice(index + 1, 0, moved);
                                  updateReviewerOrderState(next, true);
                                }}
                                aria-label={`${t('settings.moveDown')} ${index + 1}`}
                                className="p-1 rounded hover:bg-[var(--t-hover)] text-[var(--t-text-3)] hover:text-[var(--t-text)] disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                              >
                                <ArrowDown className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  const next = reviewerOrder.filter((_, i) => i !== index);
                                  updateReviewerOrderState(next, true);
                                }}
                                aria-label={`${t('common.remove')} ${index + 1}`}
                                className="p-1 rounded hover:bg-[var(--t-hover)] text-[var(--t-crit)] hover:opacity-80 cursor-pointer"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                          <select
                            aria-label={`${t('settings.claudeProfiles')} ${index + 1}`}
                            multiple
                            value={item.profiles}
                            onChange={(e) => {
                              const next = reviewerOrder.map((row, i) =>
                                i === index
                                  ? {
                                      ...row,
                                      profiles: Array.from(e.target.selectedOptions).map((opt) => opt.value),
                                    }
                                  : row,
                              );
                              updateReviewerOrderState(next, true);
                            }}
                            className="w-full text-xs rounded border border-[var(--t-border)] bg-[var(--t-surface-2)] px-2 py-1 text-[var(--t-text)] min-h-[48px]"
                          >
                            {engineProfiles.map((p) => (
                              <option key={p.name} value={p.name}>
                                {p.name}
                              </option>
                            ))}
                            {missingProfiles.map((name) => (
                              <option key={name} value={name}>
                                {name} ({t('settings.inactiveOrOld')})
                              </option>
                            ))}
                          </select>
                        </div>
                      );
                    })}

                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        updateReviewerOrderState(
                          [
                            ...reviewerOrder,
                            { engine: 'codex', model: availableCodexReviewerModels[0] || '', profiles: [] },
                          ],
                          true,
                        )
                      }
                      className="h-7 text-xs text-[var(--t-accent)]"
                    >
                      <Plus className="w-3.5 h-3.5 mr-1" />
                      {t('settings.addReviewer')}
                    </Button>
                  </div>
                )}

                {/* Reviewer fallback */}
                <div className="pt-2 border-t border-[var(--t-border)] space-y-2" data-testid="project-reviewer-fallback">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-semibold text-[var(--t-text)]">{t('projects.reviewerFallbackOverride')}</label>
                    {hasReviewerFallbackOverride ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => updateReviewerFallbackState(reviewerFallback, false)}
                        className="h-6 px-2 text-[10px] text-[var(--t-crit)]"
                      >
                        {t('settings.useSystemDefault')}
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => updateReviewerFallbackState(reviewerFallback, true)}
                        className="h-6 px-2 text-[10px] text-[var(--t-accent)]"
                      >
                        + {t('settings.overrideConfig')}
                      </Button>
                    )}
                  </div>
                  {hasReviewerFallbackOverride ? (
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={reviewerFallback.onUnavailable}
                          onChange={(e) =>
                            updateReviewerFallbackState(
                              { ...reviewerFallback, onUnavailable: e.target.checked },
                              true,
                            )
                          }
                        />
                        {t('settings.fallbackUnavailable')}
                      </label>
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={reviewerFallback.onError}
                          onChange={(e) =>
                            updateReviewerFallbackState(
                              { ...reviewerFallback, onError: e.target.checked },
                              true,
                            )
                          }
                        />
                        {t('settings.fallbackError')}
                      </label>
                      <label className="flex items-center gap-2">
                        {t('settings.fallbackBusy')}
                        <input
                          type="number"
                          min={0}
                          max={1440}
                          value={reviewerFallback.onBusyAfterMin}
                          onChange={(e) =>
                            updateReviewerFallbackState(
                              { ...reviewerFallback, onBusyAfterMin: Number(e.target.value) || 0 },
                              true,
                            )
                          }
                          className="w-16 rounded border border-[var(--t-border)] bg-[var(--t-surface)] px-1 py-1"
                        />
                      </label>
                    </div>
                  ) : (
                    <p className="text-xs text-[var(--t-text-3)] italic">
                      {t('settings.useSystemDefault')}
                    </p>
                  )}
                </div>
              </div>

              {/* review chain builder */}
              <div className="space-y-2 rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] p-3" data-testid="project-review-chain">
                <div className="flex items-center justify-between">
                  <div>
                    <label className="text-xs font-semibold text-[var(--t-text)]">{t('settings.reviewChainTitle')}</label>
                    <p className="text-[11px] text-[var(--t-text-3)]">{t('settings.reviewChainHint')}</p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        updateReviewChainState(
                          {
                            chain: [
                              {
                                reviewer:
                                  availableReviewChainReviewers.find((r) => r.startsWith('codex:')) ||
                                  '',
                                mode: 'gate',
                              },
                              { reviewer: 'claude', mode: 'final' },
                            ],
                            maxRounds: 2,
                          },
                          true,
                        )
                      }
                      className="h-6 px-2 text-[10px] text-[var(--t-accent)]"
                    >
                      {t('projects.insertExample')}
                    </Button>
                    {hasReviewChainOverride ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => updateReviewChainState({ chain: [], maxRounds: 2 }, false)}
                        className="h-6 px-2 text-[10px] text-[var(--t-crit)]"
                      >
                        {t('settings.useSystemDefault')}
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          updateReviewChainState(
                            {
                              chain: [
                                {
                                  reviewer:
                                    availableReviewChainReviewers.find((r) => r.startsWith('codex:')) ||
                                    '',
                                  mode: 'gate',
                                },
                                { reviewer: 'claude', mode: 'final' },
                              ],
                              maxRounds: 2,
                            },
                            true,
                          )
                        }
                        className="h-6 px-2 text-[10px] text-[var(--t-accent)]"
                      >
                        + {t('settings.overrideConfig')}
                      </Button>
                    )}
                  </div>
                </div>

                {!hasReviewChainOverride ? (
                  <p className="text-xs text-[var(--t-text-3)] italic py-1">
                    {t('settings.useSystemDefault')}
                  </p>
                ) : (
                  <div className="space-y-2">
                    {reviewChain.chain.length === 0 && (
                      <p className="text-xs text-[var(--t-text-3)] italic py-1">
                        {t('settings.noReviewSteps')}
                      </p>
                    )}
                    {reviewChain.chain.map((step, index) => (
                      <div
                        key={`review-step-${index}`}
                        className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--t-border)] bg-[var(--t-surface)] p-2"
                      >
                        <span className="text-xs font-bold text-[var(--t-text-3)] w-5 text-center">
                          {index + 1}.
                        </span>
                        <div className="flex-1 min-w-[180px]">
                          <SelectOrCustomInput
                            value={step.reviewer}
                            onChange={(val) => {
                              const nextChain = reviewChain.chain.map((s, i) =>
                                i === index ? { ...s, reviewer: val } : s,
                              );
                              updateReviewChainState({ ...reviewChain, chain: nextChain }, true);
                            }}
                            options={availableReviewChainReviewers}
                            validate={(val) => validateReviewChainReviewerSyntax(val, t)}
                            ariaLabel={`${t('settings.reviewStep')} ${index + 1}`}
                            placeholder={t('settings.reviewerPlaceholder')}
                          />
                        </div>
                        <select
                          aria-label={`${t('settings.stepMode')} ${index + 1}`}
                          value={step.mode}
                          onChange={(e) => {
                            const nextChain = reviewChain.chain.map((s, i) =>
                              i === index ? { ...s, mode: e.target.value as 'gate' | 'final' } : s,
                            );
                            updateReviewChainState({ ...reviewChain, chain: nextChain }, true);
                          }}
                          className="text-xs rounded border border-[var(--t-border)] bg-[var(--t-surface-2)] px-2 py-1.5 text-[var(--t-text)]"
                        >
                          <option value="gate">gate</option>
                          <option value="final">final</option>
                        </select>
                        <div className="flex items-center gap-1 shrink-0 ml-auto">
                          <button
                            type="button"
                            disabled={index === 0}
                            onClick={() => {
                              if (index === 0) return;
                              const next = [...reviewChain.chain];
                              const [moved] = next.splice(index, 1);
                              next.splice(index - 1, 0, moved);
                              updateReviewChainState({ ...reviewChain, chain: next }, true);
                            }}
                            aria-label={`${t('settings.moveUp')} ${index + 1}`}
                            className="p-1 rounded hover:bg-[var(--t-hover)] text-[var(--t-text-3)] hover:text-[var(--t-text)] disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                          >
                            <ArrowUp className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            disabled={index === reviewChain.chain.length - 1}
                            onClick={() => {
                              if (index === reviewChain.chain.length - 1) return;
                              const next = [...reviewChain.chain];
                              const [moved] = next.splice(index, 1);
                              next.splice(index + 1, 0, moved);
                              updateReviewChainState({ ...reviewChain, chain: next }, true);
                            }}
                            aria-label={`${t('settings.moveDown')} ${index + 1}`}
                            className="p-1 rounded hover:bg-[var(--t-hover)] text-[var(--t-text-3)] hover:text-[var(--t-text)] disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                          >
                            <ArrowDown className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              const next = reviewChain.chain.filter((_, i) => i !== index);
                              updateReviewChainState({ ...reviewChain, chain: next }, true);
                            }}
                            aria-label={`${t('settings.removeReviewStep')} ${index + 1}`}
                            className="p-1 rounded hover:bg-[var(--t-hover)] text-[var(--t-crit)] hover:opacity-80 cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    ))}

                    <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          updateReviewChainState(
                            {
                              ...reviewChain,
                              chain: [...reviewChain.chain, { reviewer: 'claude', mode: 'final' }],
                            },
                            true,
                          )
                        }
                        className="h-7 text-xs text-[var(--t-accent)]"
                      >
                        <Plus className="w-3.5 h-3.5 mr-1" />
                        {t('settings.addReviewStep')}
                      </Button>
                      <label className="text-xs flex items-center gap-1.5 text-[var(--t-text-2)]">
                        <span>{t('settings.maxReviewRounds')}:</span>
                        <input
                          type="number"
                          min={1}
                          max={10}
                          value={reviewChain.maxRounds}
                          onChange={(e) =>
                            updateReviewChainState(
                              {
                                ...reviewChain,
                                maxRounds: Math.min(10, Math.max(1, Number(e.target.value) || 2)),
                              },
                              true,
                            )
                          }
                          className="w-14 rounded border border-[var(--t-border)] bg-[var(--t-surface)] px-1.5 py-1 text-center font-mono text-xs text-[var(--t-text)]"
                        />
                      </label>
                    </div>
                  </div>
                )}
              </div>

              {/* envTemplate JSON */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-semibold text-[var(--t-text)]">
                    {t('projects.envLabel')} <InfoTooltip text={t('projects.envInfo')} label={t('projects.envLabel')} />
                  </label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => handleEnvChange(SAMPLE_ENV)}
                    className="h-6 px-2 text-[11px] text-[var(--t-accent)]"
                  >
                    {t('projects.insertExample')}
                  </Button>
                </div>
                <textarea
                  data-testid="env-template-textarea"
                  rows={4}
                  value={draftEnvTemplate}
                  onChange={(e) => handleEnvChange(e.target.value)}
                  placeholder={'{\n  "PORT": 3000,\n  "DATABASE_URL": "postgres://..."\n}'}
                  className={`w-full text-xs font-mono rounded-lg border p-2.5 bg-[var(--t-surface-2)] text-[var(--t-text)] ${
                    envError
                      ? 'border-[var(--t-crit)] focus:ring-[var(--t-crit)]'
                      : 'border-[var(--t-border)] focus:ring-[var(--t-accent)]'
                  } focus:outline-hidden focus:ring-2`}
                />
                {envError && (
                  <p
                    data-testid="env-error-msg"
                    className="text-xs text-[var(--t-crit)] flex items-center gap-1 mt-1"
                  >
                    <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                    <span>{envError}</span>
                  </p>
                )}
              </div>
            </div>
          </details>

          {/* Section 7: Triển khai (Deploy - Read-only) */}
          <Card className="p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <h3 className="text-sm font-bold text-[var(--t-text)]">
                  {t('projects.sectionDeployTitle')}
                </h3>
                <p className="text-xs text-[var(--t-text-3)]">
                  {t('projects.sectionDeployDesc')}
                </p>
              </div>

              <Button
                variant="primary"
                size="sm"
                onClick={() => deployMutation.mutate()}
                loading={deployMutation.isPending}
                className="gap-1.5"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>
                  {deployMutation.isPending
                    ? t('projects.deployingBtn')
                    : t('projects.deployRerunBtn')}
                </span>
              </Button>
            </div>

            {/* afterMerge config */}
            <div className="p-3.5 rounded-xl border border-[var(--t-border)] bg-[var(--t-surface-2)] space-y-2">
              {project.afterMerge ? (
                <div className="space-y-1.5 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-[var(--t-text)]">
                      {t('projects.deploySteps')}
                    </span>
                    <span className="text-[var(--t-text-3)] font-mono">
                      {t('projects.deployTimeout', {
                        sec: project.afterMerge.timeoutSec,
                      })}
                    </span>
                  </div>
                  <pre className="p-2 rounded bg-[var(--t-surface)] font-mono text-[11px] text-[var(--t-text)] overflow-x-auto">
                    {project.afterMerge.steps
                      .map((step) => step.join(' '))
                      .join('\n')}
                  </pre>
                  <div className="flex items-center gap-4 text-[11px] text-[var(--t-text-3)] pt-1">
                    <span>
                      {t('projects.deployRestart', {
                        val: project.afterMerge.restartHub
                          ? t('common.yes')
                          : t('common.no'),
                      })}
                    </span>
                    {project.afterMerge.push && (
                      <span>
                        {t('projects.deployPush', {
                          from: project.afterMerge.push.from,
                          to: project.afterMerge.push.to,
                          remote: project.afterMerge.push.remote,
                        })}
                      </span>
                    )}
                  </div>
                </div>
              ) : (
                <p className="text-xs text-[var(--t-text-3)] italic">
                  {t('projects.noDeployConfig')}
                </p>
              )}
            </div>

            {/* Latest Deploy Run Status */}
            <div className="pt-2 border-t border-[var(--t-border)] space-y-1.5">
              <span className="text-xs font-semibold text-[var(--t-text-3)]">
                {t('projects.deployLatestStatus')}
              </span>
              {deployQuery.data ? (
                <div className="flex items-center gap-2 text-xs">
                  <span
                    className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full font-semibold ${
                      deployQuery.data.status === 'succeeded'
                        ? 'bg-[color-mix(in_srgb,var(--t-ok)_15%,transparent)] text-[var(--t-ok)] border border-[var(--t-ok)]'
                        : deployQuery.data.status === 'failed'
                        ? 'bg-[color-mix(in_srgb,var(--t-crit)_15%,transparent)] text-[var(--t-crit)] border border-[var(--t-crit)]'
                        : 'bg-[color-mix(in_srgb,var(--t-warn)_15%,transparent)] text-[var(--t-warn)] border border-[var(--t-warn)]'
                    }`}
                  >
                    {deployQuery.data.status}
                  </span>
                  {deployQuery.data.commit && (
                    <span className="font-mono text-[var(--t-text-3)]">
                      {deployQuery.data.commit.slice(0, 7)}
                    </span>
                  )}
                  {deployQuery.data.error && (
                    <span className="text-[var(--t-crit)] truncate">
                      {deployQuery.data.error}
                    </span>
                  )}
                </div>
              ) : (
                <p className="text-xs text-[var(--t-text-3)] italic">
                  {t('projects.deployNoRuns')}
                </p>
              )}
            </div>
          </Card>
        </div>

        {/* Fixed Bottom Save Bar (Appears when there are unsaved changes) */}
        {hasChanges && (
          <div
            data-testid="unsaved-changes-bar"
            className={
              'absolute bottom-0 inset-x-0 border-t border-[var(--t-border)] px-6 py-3.5 ' +
              'shadow-2xl z-40 flex items-center justify-between gap-4 animate-fade-in bg-[var(--t-surface)]'
            }
          >
            <div className="flex items-center gap-2 text-xs text-[var(--t-text)] font-medium">
              <span className="w-2 h-2 rounded-full bg-[var(--t-accent)] animate-pulse" />
              <span>{t('projects.unsavedChangesBar', { count: changeCount })}</span>
            </div>

            <div className="flex items-center gap-2.5">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={handleDiscard}
                disabled={saveMutation.isPending}
              >
                {t('projects.discardChanges')}
              </Button>
              <Button
                type="button"
                variant="primary"
                size="sm"
                data-testid="save-changes-button"
                onClick={handleSave}
                loading={saveMutation.isPending}
                disabled={hasValidationError || saveMutation.isPending}
              >
                {saveMutation.isPending
                  ? t('projects.savingChanges')
                  : t('projects.saveChanges')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
