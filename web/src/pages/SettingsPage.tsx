import React, { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getConfig, updateConfig, uploadBrandingLogo, getClaudeApiKeyStatus, setClaudeApiKey, getStatus, shutdownHub, getProfiles, getModelOptions } from '../api/client';
import type { ReviewerFallback, ReviewerOrderItem } from '../types/api';
import { Save, CheckCircle2, AlertCircle, Info, MessageSquare, Bell, ArrowUp, ArrowDown, Plus, Trash2 } from 'lucide-react';
import { useLocale } from '../context/LocaleContext';
import { TelegramCard } from '../components/TelegramCard';
import { deletePermissionRule, getPermissionRules } from '../api/chat';
import { useTour } from '../components/tour/TourContext';
import { InfoTooltip } from '../components/tour/InfoTooltip';
import { DataTable, SelectOrCustomInput, SortableModelList } from '../components/ui';
import {
  DEFAULT_CLAUDE_MODELS,
  DEFAULT_CODEX_MODELS,
  DEFAULT_VALID_MODELS,
  getModelsForProvider,
  validateModelSyntax,
  validateChatModelSyntax,
  validateReviewerModelSyntax,
} from '../utils/models';

export const SettingsPage: React.FC = () => {
  const { t } = useLocale();
  const { openTour } = useTour();
  const queryClient = useQueryClient();
  const [permissionPage, setPermissionPage] = useState(1);
  const [permissionCursors, setPermissionCursors] = useState<Record<number, string | undefined>>({});
  const permissionRules = useQuery({
    queryKey: ['permissionRules', permissionPage, permissionCursors[permissionPage - 1]],
    queryFn: () => getPermissionRules({ limit: 20, cursor: permissionCursors[permissionPage - 1] }),
  });
  useEffect(() => {
    if (permissionRules.data?.nextCursor) setPermissionCursors((current) => ({ ...current, [permissionPage]: permissionRules.data!.nextCursor || undefined }));
  }, [permissionPage, permissionRules.data?.nextCursor]);
  const deleteRule = useMutation({ mutationFn: deletePermissionRule, onSuccess: () => queryClient.invalidateQueries({ queryKey: ['permissionRules'] }) });
  const { data: profiles = [] } = useQuery({ queryKey: ['profiles'], queryFn: getProfiles });
  const codexProfiles = profiles.filter((p) => p.engine === 'codex' && Boolean(p.enabled));

  const [hardChainModels, setHardChainModels] = useState<string[]>([]);
  const [easyChainModels, setEasyChainModels] = useState<string[]>([]);
  const [timeoutHours, setTimeoutHours] = useState<number>(3);
  const [multiplePerProvider, setMultiplePerProvider] = useState<boolean>(true);
  const [claudeBin, setClaudeBin] = useState<string>('claude');
  const [allowFullMode, setAllowFullMode] = useState<boolean>(false);
  const [chatModel, setChatModel] = useState<string>('sonnet');
  const [chatModels, setChatModels] = useState<string[]>(['opus', 'sonnet', 'haiku']);
  const [newChatModel, setNewChatModel] = useState<string>('sonnet');
  const [reviewerModel, setReviewerModel] = useState<string>('');
  const [claudeFallback, setClaudeFallback] = useState<boolean>(true);
  const [claudeProfiles, setClaudeProfiles] = useState<string[]>([]);
  const [claudeModel, setClaudeModel] = useState<string>('sonnet');
  const [reviewOrder, setReviewOrder] = useState<ReviewerOrderItem[]>([]);
  const [reviewFallback, setReviewFallback] = useState<ReviewerFallback>({ onUnavailable: true, onBusyAfterMin: 10, onError: true });
  const [arbiter, setArbiter] = useState<{ engine: 'codex' | 'claude'; model: string }>({ engine: 'claude', model: 'opus' });
  const [draggedReviewer, setDraggedReviewer] = useState<number | null>(null);
  const [maxConcurrent, setMaxConcurrent] = useState<number>(2);
  const [autoCompactPercent, setAutoCompactPercent] = useState<number>(85);
  const [bucketGemini, setBucketGemini] = useState<number>(5_000_000);
  const [bucketClaude, setBucketClaude] = useState<number>(5_000_000);
  const [claudeFactor, setClaudeFactor] = useState<number>(0.9);
  const [claudeOverhead, setClaudeOverhead] = useState<number>(40_000);
  const [fallback, setFallback] = useState<NonNullable<NonNullable<import('../types/api').SystemConfig['brain']>['fallback']>>([]);
  const [desktopNotify, setDesktopNotify] = useState<boolean>(true);
  const [brainEngine, setBrainEngine] = useState<'claude' | 'codex'>('claude');
  const [codexProfile, setCodexProfile] = useState<string>('');
  const [desktopNotifyLevel, setDesktopNotifyLevel] = useState<'all' | 'important' | 'critical' | 'off'>('important');
  const [brainMode, setBrainMode] = useState<'off' | 'suggest' | 'auto'>('suggest');
  const [brainPermissions, setBrainPermissions] = useState<'standard' | 'trusted' | 'full'>('standard');
  const [brainMaxConcurrent, setBrainMaxConcurrent] = useState<number>(2);
  const [quietHoursEnabled, setQuietHoursEnabled] = useState<boolean>(false);
  const [quietHoursStart, setQuietHoursStart] = useState<string>('22:00');
  const [quietHoursEnd, setQuietHoursEnd] = useState<string>('07:00');
  const [digestEnabled, setDigestEnabled] = useState<boolean>(true);
  const [digestTime, setDigestTime] = useState<string>('18:00');
  const [apiKey, setApiKey] = useState('');
  const [apiKeyConfigured, setApiKeyConfigured] = useState(false);
  // 'none' | 'large' | 'all': how much of Claude's plan the user must approve
  const [approvalMode, setApprovalMode] = useState<'none' | 'large' | 'all'>('none');
  const [approvalMinTasks, setApprovalMinTasks] = useState<number>(5);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [brandingName, setBrandingName] = useState('AgentHub');
  const [brandingShortName, setBrandingShortName] = useState('AH');
  const [brandingTagline, setBrandingTagline] = useState('');
  const [brandingAccent, setBrandingAccent] = useState('');
  const [brandingLogoError, setBrandingLogoError] = useState<string | null>(null);
  const [shutdownOpen, setShutdownOpen] = useState(false);
  const [shutdownDisable, setShutdownDisable] = useState(false);
  const [shutdownDone, setShutdownDone] = useState(false);
  const hubStatus = useQuery({ queryKey: ['status'], queryFn: getStatus, staleTime: 3000 });
  const shutdownMutation = useMutation({ mutationFn: () => shutdownHub(shutdownDisable), onSuccess: () => { setShutdownOpen(false); setShutdownDone(true); } });

  const { data: config, isLoading, error } = useQuery({
    queryKey: ['config'],
    queryFn: getConfig,
  });

  const { data: allProfiles = [] } = useQuery({
    queryKey: ['profiles'],
    queryFn: getProfiles,
  });

  const { data: modelOptions } = useQuery({
    queryKey: ['model-options'],
    queryFn: getModelOptions,
  });

  const availableWorkerModels = useMemo(() => {
    const fromApi = modelOptions?.suggestions || DEFAULT_VALID_MODELS;
    const fromConfig = modelOptions?.configured || [];
    const set = new Set([...fromApi, ...fromConfig, ...hardChainModels, ...easyChainModels]);
    return Array.from(set).filter(Boolean);
  }, [modelOptions, hardChainModels, easyChainModels]);

  const availableClaudeProfiles = useMemo(
    () => allProfiles.filter((p) => p.engine === 'claude'),
    [allProfiles],
  );

  const allClaudeOptions = useMemo(() => {
    const fromProfiles = availableClaudeProfiles.map((p) => p.name);
    return Array.from(new Set([...fromProfiles, ...claudeProfiles]));
  }, [availableClaudeProfiles, claudeProfiles]);

  const fallbackProfileOptions = useMemo(() => {
    const fromProfiles = availableClaudeProfiles.map((p) => p.name);
    const fromFallback = fallback
      .filter((s): s is { type: 'profile'; profile?: string } => s.type === 'profile' && Boolean(s.profile))
      .map((s) => s.profile!.trim())
      .filter(Boolean);
    const activeNames = new Set(availableClaudeProfiles.map((p) => p.name));
    const allNames = Array.from(new Set([...fromProfiles, ...claudeProfiles, ...fromFallback]));
    return allNames.map((name) => {
      if (activeNames.has(name)) {
        return name;
      }
      return {
        value: name,
        label: `${name} (${t('settings.inactiveOrOld')})`,
      };
    });
  }, [availableClaudeProfiles, claudeProfiles, fallback, t]);

  const availableCodexReviewerModels = useMemo(() => {
    const sourceModels = modelOptions
      ? [...modelOptions.suggestions, ...modelOptions.configured]
      : DEFAULT_CODEX_MODELS.map((model) => `codex:${model}`);
    const reviewerModels = reviewOrder.filter((r) => r.engine === 'codex').map((r) => r.model);
    const arbiterModel = arbiter.engine === 'codex' && arbiter.model ? [arbiter.model] : [];
    const chainCodex = [...hardChainModels, ...easyChainModels];
    return getModelsForProvider([
      ...getModelsForProvider(sourceModels, 'codex'),
      ...reviewerModels,
      ...arbiterModel,
      ...chainCodex,
    ], 'codex');
  }, [modelOptions, reviewOrder, arbiter, hardChainModels, easyChainModels]);

  const availableClaudeReviewerModels = useMemo(() => {
    const fromChat = getModelsForProvider(chatModels, 'claude');
    const sourceModels = modelOptions
      ? [...modelOptions.suggestions, ...modelOptions.configured]
      : DEFAULT_CLAUDE_MODELS;
    const reviewerModels = reviewOrder.filter((r) => r.engine === 'claude').map((r) => r.model);
    const arbiterModel = arbiter.engine === 'claude' && arbiter.model ? [arbiter.model] : [];
    return getModelsForProvider([
      ...DEFAULT_CLAUDE_MODELS,
      ...fromChat,
      ...getModelsForProvider(sourceModels, 'claude'),
      ...reviewerModels,
      ...arbiterModel,
    ], 'claude');
  }, [modelOptions, reviewOrder, arbiter, chatModels]);

  useEffect(() => {
    if (config) {
      setBrandingName(config.branding?.name || 'AgentHub');
      setBrandingShortName(config.branding?.shortName || 'AH');
      setBrandingTagline(config.branding?.tagline || '');
      setBrandingAccent(config.branding?.accentColor || '');
      const hardList = config.modelChainHard || config.modelChains?.hard || [];
      const easyList = config.modelChainEasy || config.modelChains?.easy || [];
      const timeoutSec =
        config.defaultTimeout !== undefined
          ? config.defaultTimeout
          : config.runTimeoutHours
          ? config.runTimeoutHours * 3600
          : 10800;
      setHardChainModels(hardList);
      setEasyChainModels(easyList);
      setTimeoutHours(Math.max(1, Math.round(timeoutSec / 3600)));
      setMultiplePerProvider(config.multiplePerProvider !== false);
      setClaudeBin(config.chat?.claudeBin || 'claude');
      setAllowFullMode(Boolean(config.chat?.allowFullMode));
      setChatModel(config.chat?.model || 'sonnet');
      setChatModels(config.chat?.models?.length ? config.chat.models : ['opus', 'sonnet', 'haiku']);
      setReviewerModel(config.reviewer?.model || '');
      setClaudeFallback(config.reviewer?.claudeFallback !== false);
      setClaudeProfiles(config.reviewer?.claudeProfiles || []);
      setClaudeModel(config.reviewer?.claudeModel || 'sonnet');
      const defaultReviewOrder: ReviewerOrderItem[] = [];
      if (config.reviewer?.model) {
        defaultReviewOrder.push({
          engine: (config.reviewer.model.startsWith('claude') ? 'claude' : 'codex') as ReviewerOrderItem['engine'],
          model: config.reviewer.model.replace(/^codex:/, ''),
          profiles: [],
        });
      }
      if (config.reviewer?.claudeFallback !== false && config.reviewer?.claudeModel) {
        defaultReviewOrder.push({
          engine: 'claude',
          model: config.reviewer.claudeModel,
          profiles: config.reviewer?.claudeProfiles || [],
        });
      }
      setReviewOrder(config.reviewer?.order || defaultReviewOrder);
      setReviewFallback({
        onUnavailable: config.reviewer?.fallback?.onUnavailable ?? true,
        onBusyAfterMin: config.reviewer?.fallback?.onBusyAfterMin ?? config.reviewer?.claudeFallbackAfterMin ?? 10,
        onError: config.reviewer?.fallback?.onError ?? true,
      });
      setArbiter(config.reviewer?.arbiter || { engine: 'claude', model: 'opus' });
      setMaxConcurrent(config.chat?.maxConcurrent ?? 2);
      setAutoCompactPercent(config.chat?.autoCompactPercent ?? 85);
      setFallback(config.brain?.fallback || [{ type: 'engine', engine: 'codex' }]);
      const minTasks = config.planning?.approvalMinTasks ?? 0;
      setApprovalMode(config.planning?.requireApproval ? 'all' : minTasks > 0 ? 'large' : 'none');
      if (minTasks > 0) setApprovalMinTasks(minTasks);
      if (config.savings) {
        if (config.savings.bucketTokens?.gemini !== undefined) {
          setBucketGemini(config.savings.bucketTokens.gemini);
        }
        if (config.savings.bucketTokens?.claude !== undefined) {
          setBucketClaude(config.savings.bucketTokens.claude);
        }
        if (config.savings.claudeFactor !== undefined) {
          setClaudeFactor(config.savings.claudeFactor);
        }
        if (config.savings.claudeOverheadPerTask !== undefined) {
          setClaudeOverhead(config.savings.claudeOverheadPerTask);
        }
      }
      setDesktopNotify(config.notifications?.desktop ?? true);
      setBrainEngine(config.brain?.engine || 'claude');
      setCodexProfile(config.brain?.codexProfile || '');
      setDesktopNotifyLevel(config.notifications?.desktopLevel ?? 'important');
      setBrainMode(config.brain?.mode ?? 'suggest');
      setBrainPermissions(config.brain?.permissions ?? 'standard');
      setBrainMaxConcurrent(config.brain?.maxConcurrent ?? 2);
      setQuietHoursEnabled(Boolean(config.notifications?.quietHours?.enabled));
      setQuietHoursStart(config.notifications?.quietHours?.start || '22:00');
      setQuietHoursEnd(config.notifications?.quietHours?.end || '07:00');
      setDigestEnabled(config.brain?.digest?.enabled ?? true);
      setDigestTime(config.brain?.digest?.time || '18:00');
    }
  }, [config]);

  const { data: apiKeyStatus } = useQuery({ queryKey: ['claude-api-key'], queryFn: getClaudeApiKeyStatus });
  useEffect(() => setApiKeyConfigured(Boolean(apiKeyStatus?.configured)), [apiKeyStatus]);

  const mutation = useMutation({
    mutationFn: async (data: Partial<import('../types/api').SystemConfig>) => {
      const updated = await updateConfig(data);
      if (apiKey.trim()) await setClaudeApiKey(apiKey.trim());
      return updated;
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(['config'], updated);
      if (apiKey.trim()) {
        setApiKey('');
        setApiKeyConfigured(true);
      }
      setSaveSuccess(true);
      setSaveError(null);
      setTimeout(() => setSaveSuccess(false), 3000);
    },
    onError: (err: any) => {
      setSaveError(typeof err?.message === 'string' && err.message.trim() ? err.message : t('settings.saveError'));
      setSaveSuccess(false);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSaveSuccess(false);
    setSaveError(null);

    const hardModels = hardChainModels
      .map((s) => s.trim())
      .filter(Boolean);

    const easyModels = easyChainModels
      .map((s) => s.trim())
      .filter(Boolean);

    if (hardModels.length === 0) {
      setSaveError(t('settings.hardChainRequired'));
      return;
    }
    if (easyModels.length === 0) {
      setSaveError(t('settings.easyChainRequired'));
      return;
    }

    const invalidHard = hardModels.find((m) => validateModelSyntax(m, t));
    if (invalidHard) {
      setSaveError(`${t('settings.hardChainLabel')}: ${validateModelSyntax(invalidHard, t)} ("${invalidHard}")`);
      return;
    }
    const invalidEasy = easyModels.find((m) => validateModelSyntax(m, t));
    if (invalidEasy) {
      setSaveError(`${t('settings.easyChainLabel')}: ${validateModelSyntax(invalidEasy, t)} ("${invalidEasy}")`);
      return;
    }

    const invalidChat = validateChatModelSyntax(chatModel, t);
    if (invalidChat) {
      setSaveError(`${t('extra.chatModel')}: ${invalidChat} ("${chatModel}")`);
      return;
    }

    const invalidReviewer = reviewerModel.trim()
      ? validateReviewerModelSyntax(reviewerModel, reviewerModel.startsWith('claude') ? 'claude' : 'codex', t)
      : null;
    if (invalidReviewer) {
      setSaveError(`${t('extra.reviewerModel')}: ${invalidReviewer} ("${reviewerModel}")`);
      return;
    }

    for (let i = 0; i < reviewOrder.length; i++) {
      const err = validateReviewerModelSyntax(reviewOrder[i].model, reviewOrder[i].engine, t);
      if (err) {
        setSaveError(`${t('settings.reviewerOrder')} ${i + 1}: ${err} ("${reviewOrder[i].model}")`);
        return;
      }
    }

    const invalidArbiter = validateReviewerModelSyntax(arbiter.model, arbiter.engine, t);
    if (invalidArbiter) {
      setSaveError(`${t('settings.arbiter')}: ${invalidArbiter} ("${arbiter.model}")`);
      return;
    }

    const hours = Number(timeoutHours) || 3;
    const defaultTimeout = hours * 3600;

    mutation.mutate({
      modelChainHard: hardModels,
      modelChainEasy: easyModels,
      defaultTimeout,
      multiplePerProvider,
      modelChains: {
        hard: hardModels,
        easy: easyModels,
      },
      runTimeoutHours: hours,
      chat: {
        claudeBin: claudeBin.trim() || 'claude',
        allowFullMode,
        maxConcurrent: Number(maxConcurrent) || 2,
        model: chatModel,
        autoCompactPercent: Number(autoCompactPercent) || 85,
        models: chatModels,
      },
      reviewer: {
        model: reviewerModel.trim() || undefined,
        claudeFallback,
        claudeProfiles,
        claudeModel,
        order: reviewOrder,
        fallback: reviewFallback,
        arbiter,
      },
      savings: {
        bucketTokens: {
          gemini: Number(bucketGemini) || 5_000_000,
          claude: Number(bucketClaude) || 5_000_000,
        },
        claudeFactor: Number(claudeFactor) || 0.9,
        claudeOverheadPerTask: Number(claudeOverhead) || 40_000,
      },
      brain: {
        engine: brainEngine,
        codexProfile: codexProfile.trim() || undefined,
        mode: brainMode,
        permissions: brainPermissions,
        maxConcurrent: Number(brainMaxConcurrent) || 2,
        digest: {
          enabled: digestEnabled,
          time: digestTime.trim() || '18:00',
        },
        fallback,
      },
      ...(brainPermissions === 'full' ? { confirm: true } : {}),
      notifications: {
        desktop: desktopNotify,
        desktopLevel: desktopNotifyLevel,
        quietHours: {
          enabled: quietHoursEnabled,
          start: quietHoursStart.trim() || '22:00',
          end: quietHoursEnd.trim() || '07:00',
        },
      },
      planning: {
        requireApproval: approvalMode === 'all',
        approvalMinTasks: approvalMode === 'large' ? Math.max(1, Number(approvalMinTasks) || 5) : 0,
      },
      branding: {
        name: brandingName.trim() || 'AgentHub',
        shortName: brandingShortName.trim() || 'AH',
        ...(brandingTagline.trim() ? { tagline: brandingTagline.trim() } : {}),
        ...(brandingAccent.trim() ? { accentColor: brandingAccent.trim() } : {}),
      },
    });
  };

  const handleBrandingLogo = async (file: File | undefined) => {
    if (!file) return;
    setBrandingLogoError(null);
    try {
      await uploadBrandingLogo(file);
      await queryClient.invalidateQueries({ queryKey: ['config'] });
    } catch (error) {
      setBrandingLogoError(error instanceof Error ? error.message : t('settings.brandingLogoError'));
    }
  };

  const handleToggleFullMode = (e: React.ChangeEvent<HTMLInputElement>) => {
    const checked = e.target.checked;
    if (checked) {
      const confirmed = window.confirm(
        t('extra.fullModeConfirm'),
      );
      if (confirmed) {
        setAllowFullMode(true);
      } else {
        setAllowFullMode(false);
      }
    } else {
      setAllowFullMode(false);
    }
  };

  return (
    <div className="max-w-3xl space-y-6" data-tour="settings">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
        <h1 className="text-2xl font-bold tracking-tight">{t('settings.title')}</h1>
        <p className="text-sm text-[var(--t-text-3)]">
          {t('extra.settingsSubtitle')}
        </p>
        </div>
        <button type="button" onClick={() => openTour('intro')} className="rounded-lg border border-[var(--t-border)] px-3 py-2 text-xs text-[var(--t-text-2)] hover:bg-[var(--t-hover)]">{t('tour.replay')}</button>
      </div>

      <section className="rounded-xl border border-[var(--t-border)] bg-[var(--t-surface)] p-5 space-y-4">
        <div>
          <h2 className="font-semibold">{t('settings.brandingTitle')}</h2>
          <p className="text-sm text-[var(--t-text-3)]">{t('settings.brandingDescription')}</p>
        </div>
        <div className="grid sm:grid-cols-2 gap-4">
          <label className="text-sm space-y-1"><span>{t('settings.brandingName')}</span><input value={brandingName} onChange={(e) => setBrandingName(e.target.value)} className="w-full rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2" /></label>
          <label className="text-sm space-y-1"><span>{t('settings.brandingShortName')}</span><input value={brandingShortName} onChange={(e) => setBrandingShortName(e.target.value)} className="w-full rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2" /></label>
          <label className="text-sm space-y-1"><span>{t('settings.brandingTagline')}</span><input value={brandingTagline} onChange={(e) => setBrandingTagline(e.target.value)} className="w-full rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2" /></label>
          <label className="text-sm space-y-1"><span>{t('settings.brandingAccent')}</span><input value={brandingAccent} onChange={(e) => setBrandingAccent(e.target.value)} className="w-full rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2" /></label>
          <label className="text-sm space-y-1"><span>{t('settings.brandingLogo')}</span><input type="file" accept="image/png,image/svg+xml" onChange={(e) => void handleBrandingLogo(e.target.files?.[0])} className="w-full text-sm" /><span className="block text-xs text-[var(--t-text-3)]">{t('settings.brandingLogoHint')}</span></label>
        </div>
        {brandingLogoError && <p className="text-sm text-[var(--t-crit)]">{brandingLogoError}</p>}
      </section>

      {saveSuccess && (
        <div role="status" aria-live="polite" className="p-4 rounded-xl bg-[color-mix(in_srgb,var(--t-ok)_15%,transparent)] border border-[var(--t-ok)] text-[var(--t-ok)] text-sm flex items-center gap-2">
          <CheckCircle2 className="w-5 h-5 text-[var(--t-ok)] shrink-0" />
          <span>{t('settings.saveSuccess')}</span>
        </div>
      )}

      {saveError && (
        <div role="alert" aria-live="assertive" className="p-4 rounded-xl bg-[color-mix(in_srgb,var(--t-crit)_15%,transparent)] border border-[var(--t-crit)] text-[var(--t-crit)] text-sm flex items-center gap-2">
          <AlertCircle className="w-5 h-5 text-[var(--t-crit)] shrink-0" />
          <span>{saveError}</span>
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center p-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--t-accent)]" />
        </div>
      ) : error ? (
        <div className="p-8 text-center text-[var(--t-crit)] text-sm">{t('settings.loadError')}</div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-6">
          <div id="planning-approval" className="bg-[var(--t-surface)] rounded-xl border border-[var(--t-border)] p-6 space-y-3 shadow-xs" data-testid="planning-approval" data-tour="planning-approval">
            <h2 className="text-sm font-semibold">{t('extra.planningApprovalTitle')}</h2>
            <p className="text-xs text-[var(--t-text-3)]">{t('extra.planningApprovalHint')}</p>
            {(['none', 'large', 'all'] as const).map((mode) => (
              <label key={mode} className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="radio" name="approvalMode" value={mode} checked={approvalMode === mode} onChange={() => setApprovalMode(mode)} />
                <span>{t(mode === 'none' ? 'extra.planningApprovalNone' : mode === 'large' ? 'extra.planningApprovalLarge' : 'extra.planningApprovalAll')}</span>
                {mode === 'large' && (
                  <input type="number" min={1} max={100} aria-label={t('extra.planningApprovalMinTasks')} value={approvalMinTasks}
                    onChange={(e) => setApprovalMinTasks(Number(e.target.value))} disabled={approvalMode !== 'large'}
                    className="w-16 text-sm rounded border border-[var(--t-border)] bg-[var(--t-surface-2)] px-2 py-0.5" />
                )}
              </label>
            ))}
          </div>
          <div className="bg-[var(--t-surface)] rounded-xl border border-[var(--t-border)] p-6 space-y-6 shadow-xs" data-tour="brain-policy">
            <div className="space-y-2">
              <label className="text-xs font-semibold">{t('projects.brainPermissions')}</label>
              <select value={brainPermissions} onChange={(e) => { const value = e.target.value as typeof brainPermissions; if (value === 'full' && !window.confirm(t('extra.fullModeConfirm'))) return; setBrainPermissions(value); }} className="block rounded border p-2 bg-[var(--t-surface-2)]"><option value="standard">{t('projects.brainPermissionStandard')}</option><option value="trusted">{t('projects.brainPermissionTrusted')}</option><option value="full">{t('projects.brainPermissionFull')}</option></select>
              {brainPermissions === 'full' && <p className="text-xs text-[var(--t-crit)]">{t('extra.fullModeWarning')}</p>}
            </div>
            {/* Info notice */}
            <div className="p-4 rounded-lg bg-[var(--t-accent-bg)] border border-[var(--t-accent)] text-[var(--t-accent)] text-xs flex items-start gap-2.5">
              <Info className="w-4 h-4 shrink-0 mt-0.5" />
              <div>
                {t('settings.infoChain')}
              </div>
            </div>

            {/* Hard chain */}
            <SortableModelList
              dataTour="model-chain"
              dataTestId="hard-chain-list"
              title={t('settings.hardChainLabel')}
              hint={t('settings.hardChainHint')}
              infoTooltip={<InfoTooltip text={t('settings.hardChainInfo')} label={t('settings.hardChainLabel')} />}
              models={hardChainModels}
              onChange={setHardChainModels}
              availableOptions={availableWorkerModels}
              ariaLabel={t('settings.hardChainLabel')}
            />

            {/* Easy chain */}
            <SortableModelList
              dataTestId="easy-chain-list"
              title={t('settings.easyChainLabel')}
              hint={t('settings.easyChainHint')}
              models={easyChainModels}
              onChange={setEasyChainModels}
              availableOptions={availableWorkerModels}
              ariaLabel={t('settings.easyChainLabel')}
            />

            {/* Timeout */}
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-[var(--t-text)] mb-1">
                {t('settings.timeoutLabel')}
              </label>
              <input
                type="number"
                min={1}
                max={24}
                value={timeoutHours}
                onChange={(e) => setTimeoutHours(parseInt(e.target.value, 10) || 1)}
                className="w-32 text-sm rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2 text-[var(--t-text)] focus:outline-none focus:ring-2 focus:ring-[var(--t-accent)]"
              />
            </div>

            <div className="flex items-start justify-between gap-4 border-t border-[var(--t-border)] pt-4">
              <div>
                <label htmlFor="multiple-per-provider" className="text-sm font-semibold text-[var(--t-text)]">
                  {t('settings.multiplePerProviderLabel')}
                </label>
                <p className="mt-1 text-xs text-[var(--t-text-3)]">
                  {t('settings.multiplePerProviderHint')}
                </p>
              </div>
              <input
                id="multiple-per-provider"
                data-testid="multiple-per-provider-toggle"
                data-tour="multiple-accounts"
                type="checkbox"
                checked={multiplePerProvider}
                onChange={(e) => setMultiplePerProvider(e.target.checked)}
                className="mt-1 h-4 w-4 rounded border-[var(--t-border)]"
              />
            </div>

            {/* Claude Chat section */}
            <div className="pt-6 border-t border-[var(--t-border)] space-y-4">
              <div className="flex items-center gap-2">
                <MessageSquare className="w-4 h-4 text-[var(--t-accent)]" />
                <h3 className="text-sm font-semibold text-[var(--t-text)]">
                  {t('extra.chatSettings')}
                </h3>
              </div>

              {/* claudeBin field */}
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-[var(--t-text)] mb-1">
                  {t('extra.claudeBin')}
                </label>
                <input
                  type="text"
                  value={claudeBin}
                  onChange={(e) => setClaudeBin(e.target.value)}
                  placeholder={t('settings.claudeBinPlaceholder')}
                  className="w-full text-xs font-mono rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2 text-[var(--t-text)] focus:outline-none focus:ring-2 focus:ring-[var(--t-accent)]"
                />
                <p className="text-[11px] text-[var(--t-text-3)] mt-1">
                  {t('extra.claudeBinHint')}
                </p>
                <p className="text-[11px] text-[var(--t-text-3)] mt-1">
                  {t('extra.claudeVersion')}: {config?.chat?.claudeVersion || t('extra.unknown')}
                </p>
              </div>

              {/* maxConcurrent field */}
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-[var(--t-text)] mb-1">
                  {t('extra.maxConcurrent')}
                </label>
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={maxConcurrent}
                  onChange={(e) => setMaxConcurrent(parseInt(e.target.value, 10) || 1)}
                  className="w-32 text-sm rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2 text-[var(--t-text)] focus:outline-none focus:ring-2 focus:ring-[var(--t-accent)]"
                />
              </div>

              {/* autoCompactPercent field */}
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-[var(--t-text)] mb-1">
                  {t('extra.autoCompactPercent')}
                </label>
                <input
                  type="number"
                  min={10}
                  max={95}
                  value={autoCompactPercent}
                  onChange={(e) => setAutoCompactPercent(parseInt(e.target.value, 10) || 85)}
                  className="w-32 text-sm rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2 text-[var(--t-text)] focus:outline-none focus:ring-2 focus:ring-[var(--t-accent)]"
                />
                <p className="text-[11px] text-[var(--t-text-3)] mt-1">
                  {t('extra.autoCompactPercentHint')}
                </p>
              </div>

              {/* Chat model and models list */}
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-[var(--t-text-2)] mb-1">
                    {t('extra.chatModel')}
                  </label>
                  <SelectOrCustomInput
                    ariaLabel={t('extra.chatModel')}
                    value={chatModel}
                    onChange={setChatModel}
                    options={Array.from(new Set([...chatModels, ...DEFAULT_CLAUDE_MODELS]))}
                    validate={(m) => validateChatModelSyntax(m, t)}
                    placeholder="sonnet"
                    className="w-full max-w-sm"
                  />
                  <p className="text-[11px] text-[var(--t-text-3)] mt-1">
                    {t('extra.defaultChatModel')} {chatModels.join(', ')}
                  </p>
                </div>

                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-[var(--t-text-2)] mb-1">
                    {t('extra.chatModelsLabel')}
                  </label>
                  <div className="flex flex-wrap gap-1.5 mb-2" aria-label={t('extra.chatModelsLabel')}>
                    {chatModels.map((m) => (
                      <span
                        key={m}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs bg-[var(--t-surface-2)] border border-[var(--t-border)] text-[var(--t-text)]"
                      >
                        <span>{m}</span>
                        <button
                          type="button"
                          aria-label={`${t('common.remove')} ${m}`}
                          onClick={() => setChatModels(chatModels.filter((item) => item !== m))}
                          className="text-[var(--t-crit)] hover:opacity-80 cursor-pointer"
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                  <div className="flex items-center gap-2 max-w-sm">
                    <SelectOrCustomInput
                      value={newChatModel}
                      onChange={setNewChatModel}
                      options={DEFAULT_CLAUDE_MODELS.filter((m) => !chatModels.includes(m))}
                      validate={(m) => validateChatModelSyntax(m, t)}
                      placeholder="opus"
                      ariaLabel={t('extra.chatModelsLabel')}
                      className="flex-1"
                    />
                    <button
                      type="button"
                      disabled={!newChatModel.trim() || chatModels.includes(newChatModel.trim()) || Boolean(validateChatModelSyntax(newChatModel.trim(), t))}
                      onClick={() => {
                        const trimmed = newChatModel.trim();
                        if (trimmed && !chatModels.includes(trimmed)) {
                          setChatModels([...chatModels, trimmed]);
                        }
                      }}
                      className="px-3 py-2 text-xs font-medium rounded-lg border border-[var(--t-border)] bg-[var(--t-surface)] text-[var(--t-text)] hover:bg-[var(--t-surface-2)] disabled:opacity-40 cursor-pointer shrink-0"
                    >
                      {t('settings.addModel')}
                    </button>
                  </div>
                </div>
              </div>

              {/* allowFullMode toggle */}
              <div className="pt-2">
                <label className="flex items-start gap-3 p-3.5 rounded-xl border border-[var(--t-border)] bg-[var(--t-surface-2)] cursor-pointer hover:bg-[var(--t-surface-2)] transition-colors">
                  <input
                    type="checkbox"
                    checked={allowFullMode}
                    onChange={handleToggleFullMode}
                    className="mt-0.5 rounded text-[var(--t-crit)] focus:ring-[var(--t-crit)] w-4 h-4 cursor-pointer"
                  />
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-[var(--t-text)]">
                        {t('extra.allowFullMode')}
                      </span>
                      {allowFullMode && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-[color-mix(in_srgb,var(--t-crit)_15%,transparent)] text-[var(--t-crit)] font-bold border border-[var(--t-crit)]">
                          {t('extra.enabled')}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-[var(--t-crit)] mt-1">
                      {t('extra.fullModeWarning')}
                    </p>
                  </div>
                </label>
              </div>
            </div>
          </div>

          <div className="bg-[var(--t-surface)] rounded-xl border border-[var(--t-border)] p-6 space-y-4 shadow-xs" data-testid="reviewer-settings">
            <h2 className="text-base font-semibold text-[var(--t-text)]">{t('extra.reviewer')}</h2>
            <div className="space-y-3" data-testid="reviewer-order">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-[var(--t-text)]">{t('settings.reviewerOrder')}</h3>
                  <p className="text-xs text-[var(--t-text-3)]">{t('settings.reviewerOrderHint')}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setReviewOrder((current) => [...current, { engine: 'codex', model: availableCodexReviewerModels[0] || '', profiles: [] }])}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] text-[var(--t-text)] hover:bg-[var(--t-surface)] cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>{t('settings.addReviewer')}</span>
                </button>
              </div>
              {reviewOrder.map((item, index) => {
                const profiles = allProfiles.filter((profile) => profile.engine === item.engine);
                const activeProfileNames = new Set(profiles.map((p) => p.name));
                const missingProfiles = (item.profiles || []).filter((name) => !activeProfileNames.has(name));
                const engineModelOptions = item.engine === 'codex' ? availableCodexReviewerModels : availableClaudeReviewerModels;
                return (
                  <div
                    key={`${item.engine}-${index}`}
                    draggable
                    onDragStart={() => setDraggedReviewer(index)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={() => {
                      if (draggedReviewer === null || draggedReviewer === index) return;
                      setReviewOrder((current) => {
                        const next = [...current];
                        const [moved] = next.splice(draggedReviewer, 1);
                        next.splice(index, 0, moved);
                        return next;
                      });
                      setDraggedReviewer(null);
                    }}
                    className="rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] p-3 space-y-2 cursor-grab"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-[var(--t-text-3)]">{index + 1}.</span>
                      <select
                        aria-label={`${t('settings.reviewerOrder')} ${index + 1}`}
                        value={item.engine}
                        onChange={(event) => {
                          const newEngine = event.target.value as ReviewerOrderItem['engine'];
                          setReviewOrder((current) =>
                            current.map((row, rowIndex) =>
                              rowIndex === index
                                ? {
                                    ...row,
                                    engine: newEngine,
                                    model: newEngine === 'codex'
                                      ? (availableCodexReviewerModels[0] || '')
                                      : (availableClaudeReviewerModels[0] || ''),
                                    profiles: [],
                                  }
                                : row,
                            ),
                          );
                        }}
                        className="text-sm rounded border border-[var(--t-border)] bg-[var(--t-surface)] px-2 py-1.5 text-[var(--t-text)]"
                      >
                        <option value="codex">Codex</option>
                        <option value="claude">Claude</option>
                      </select>
                      <div className="min-w-0 flex-1">
                        <SelectOrCustomInput
                          ariaLabel={`${t('settings.reviewerModel')} ${index + 1}`}
                          value={item.model}
                          onChange={(val) => setReviewOrder((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, model: val } : row))}
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
                            setReviewOrder((current) => {
                              const next = [...current];
                              const [moved] = next.splice(index, 1);
                              next.splice(index - 1, 0, moved);
                              return next;
                            });
                          }}
                          aria-label={`${t('settings.moveUp')} ${index + 1}`}
                          className="p-1 rounded hover:bg-[var(--t-hover)] text-[var(--t-text-3)] hover:text-[var(--t-text)] disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                        >
                          <ArrowUp className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          disabled={index === reviewOrder.length - 1}
                          onClick={() => {
                            if (index === reviewOrder.length - 1) return;
                            setReviewOrder((current) => {
                              const next = [...current];
                              const [moved] = next.splice(index, 1);
                              next.splice(index + 1, 0, moved);
                              return next;
                            });
                          }}
                          aria-label={`${t('settings.moveDown')} ${index + 1}`}
                          className="p-1 rounded hover:bg-[var(--t-hover)] text-[var(--t-text-3)] hover:text-[var(--t-text)] disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                        >
                          <ArrowDown className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setReviewOrder((current) => current.filter((_, i) => i !== index))}
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
                      onChange={(event) => setReviewOrder((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, profiles: Array.from(event.target.selectedOptions).map((option) => option.value) } : row))}
                      className="w-full text-xs rounded border border-[var(--t-border)] bg-[var(--t-surface)] px-2 py-1 text-[var(--t-text)] min-h-[56px]"
                    >
                      {profiles.map((profile) => <option key={profile.name} value={profile.name}>{profile.name}</option>)}
                      {missingProfiles.map((name) => (
                        <option key={name} value={name}>
                          {name} ({t('settings.inactiveOrOld')})
                        </option>
                      ))}
                    </select>
                  </div>
                );
              })}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
                <label className="flex items-center gap-2"><input type="checkbox" checked={reviewFallback.onUnavailable} onChange={(event) => setReviewFallback((value) => ({ ...value, onUnavailable: event.target.checked }))} />{t('settings.fallbackUnavailable')}</label>
                <label className="flex items-center gap-2"><input type="checkbox" checked={reviewFallback.onError} onChange={(event) => setReviewFallback((value) => ({ ...value, onError: event.target.checked }))} />{t('settings.fallbackError')}</label>
                <label className="flex items-center gap-2">{t('settings.fallbackBusy')}<input type="number" min={0} max={1440} value={reviewFallback.onBusyAfterMin} onChange={(event) => setReviewFallback((value) => ({ ...value, onBusyAfterMin: Number(event.target.value) || 0 }))} className="w-16 rounded border border-[var(--t-border)] bg-[var(--t-surface)] px-1 py-1" /></label>
              </div>
              <div className="flex flex-wrap gap-2 items-center text-xs">
                <label className="font-semibold text-[var(--t-text)]">{t('settings.arbiter')}</label>
                <select value={arbiter.engine} onChange={(event) => setArbiter((value) => ({ ...value, engine: event.target.value as 'codex' | 'claude' }))} className="rounded border border-[var(--t-border)] bg-[var(--t-surface)] px-2 py-1.5 text-[var(--t-text)]">
                  <option value="claude">Claude</option>
                  <option value="codex">Codex</option>
                </select>
                <div className="w-48">
                  <SelectOrCustomInput
                    ariaLabel={`${t('settings.arbiter')} ${t('settings.reviewerModel')}`}
                    value={arbiter.model}
                    onChange={(val) => setArbiter((value) => ({ ...value, model: val }))}
                    options={arbiter.engine === 'codex' ? availableCodexReviewerModels : availableClaudeReviewerModels}
                    validate={(val) => validateReviewerModelSyntax(val, arbiter.engine, t)}
                    placeholder={arbiter.engine === 'codex' ? 'codex:model' : 'sonnet'}
                  />
                </div>
              </div>
            </div>
            <div>
              <label htmlFor="reviewer-model-input" className="block text-xs font-semibold text-[var(--t-text)] mb-1">{t('extra.reviewerModel')}</label>
              <SelectOrCustomInput
                id="reviewer-model-input"
                testId="reviewer-model-input"
                ariaLabel={t('extra.reviewerModel')}
                value={reviewerModel}
                onChange={setReviewerModel}
                options={availableCodexReviewerModels}
                validate={(val) => validateReviewerModelSyntax(val, val.startsWith('claude') ? 'claude' : 'codex', t)}
                placeholder="codex:model"
                className="w-full"
              />
            </div>

            <div className="pt-2 border-t border-[var(--t-border)] space-y-4">
              <div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    data-testid="claude-fallback-toggle"
                    checked={claudeFallback}
                    onChange={(e) => setClaudeFallback(e.target.checked)}
                    className="rounded border-[var(--t-border)] text-[var(--t-accent)] focus:ring-[var(--t-accent)] h-4 w-4 cursor-pointer"
                  />
                  <span className="text-sm font-medium text-[var(--t-text)]">
                    {t('settings.claudeFallback')}
                  </span>
                </label>
                <p className="text-xs text-[var(--t-text-3)] mt-1 ml-6">
                  {t('settings.claudeFallbackHint')}
                </p>
              </div>

              <div>
                <label htmlFor="claude-model-select" className="block text-xs font-semibold text-[var(--t-text)] mb-1">
                  {t('settings.claudeModel')}
                </label>
                <select
                  id="claude-model-select"
                  data-testid="claude-model-select"
                  value={claudeModel}
                  onChange={(e) => setClaudeModel(e.target.value)}
                  className="w-full text-sm rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2 text-[var(--t-text)]"
                >
                  <option value="sonnet">sonnet</option>
                  <option value="opus">opus</option>
                  <option value="haiku">haiku</option>
                </select>
              </div>

              <div>
                <label htmlFor="claude-profiles-select" className="block text-xs font-semibold text-[var(--t-text)] mb-1">
                  {t('settings.claudeProfiles')}
                </label>
                <p className="text-xs text-[var(--t-text-3)] mb-2">
                  {t('settings.claudeProfilesHint')}
                </p>
                <select
                  id="claude-profiles-select"
                  data-testid="claude-profiles-select"
                  multiple
                  value={claudeProfiles}
                  onChange={(e) => {
                    const selected = Array.from(e.target.selectedOptions).map((o) => o.value);
                    setClaudeProfiles(selected);
                  }}
                  className="w-full text-sm rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2 text-[var(--t-text)] min-h-[90px]"
                >
                  {allClaudeOptions.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>

                {claudeProfiles.length > 0 && (
                  <div className="mt-2 space-y-1.5" data-testid="claude-profiles-priority-list">
                    <span className="text-xs text-[var(--t-text-3)]">
                      {t('settings.claudeProfilesOrder')}:
                    </span>
                    <div className="flex flex-wrap gap-1.5">
                      {claudeProfiles.map((pName, idx) => (
                        <span
                          key={pName}
                          data-testid={`claude-profile-chip-${pName}`}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs bg-[var(--t-surface-2)] border border-[var(--t-border)] text-[var(--t-text)]"
                        >
                          <span className="font-semibold text-[var(--t-text-3)]">{idx + 1}.</span>
                          <span>{pName}</span>
                          {idx > 0 && (
                            <button
                              type="button"
                              title={t('common.moveUp')}
                              onClick={() => {
                                const next = [...claudeProfiles];
                                const tmp = next[idx - 1];
                                next[idx - 1] = next[idx];
                                next[idx] = tmp;
                                setClaudeProfiles(next);
                              }}
                              className="text-[var(--t-text-3)] hover:text-[var(--t-text)] cursor-pointer"
                            >
                              ↑
                            </button>
                          )}
                          {idx < claudeProfiles.length - 1 && (
                            <button
                              type="button"
                              title={t('common.moveDown')}
                              onClick={() => {
                                const next = [...claudeProfiles];
                                const tmp = next[idx + 1];
                                next[idx + 1] = next[idx];
                                next[idx] = tmp;
                                setClaudeProfiles(next);
                              }}
                              className="text-[var(--t-text-3)] hover:text-[var(--t-text)] cursor-pointer"
                            >
                              ↓
                            </button>
                          )}
                          <button
                            type="button"
                            title={t('common.remove')}
                            onClick={() => {
                              setClaudeProfiles(claudeProfiles.filter((name) => name !== pName));
                            }}
                            className="text-[var(--t-crit)] hover:opacity-80 ml-0.5 cursor-pointer"
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="bg-[var(--t-surface)] rounded-xl border border-[var(--t-border)] p-6 space-y-4 shadow-xs">
            <div>
              <h2 className="text-base font-semibold text-[var(--t-text)]">{t('extra.fallbackChain')}</h2>
              <p className="text-xs text-[var(--t-text-3)]">{t('extra.fallbackHint')}</p>
            </div>
            {fallback.map((step, index) => (
              <div key={`${step.type}-${index}`} draggable onDragStart={(event) => event.dataTransfer.setData('text/plain', String(index))} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { const from = Number(event.dataTransfer.getData('text/plain')); if (!Number.isInteger(from) || from === index) return; const next = [...fallback]; const [moved] = next.splice(from, 1); next.splice(index, 0, moved); setFallback(next); }} className="flex flex-wrap items-center gap-2 p-2.5 rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] cursor-grab">
                <span className="text-xs text-[var(--t-text-3)] shrink-0">⠿ {index + 1}.</span>
                <select value={step.type} onChange={(event) => { const next = [...fallback]; const type = event.target.value; next[index] = type === 'model' ? { type: 'model', model: 'sonnet' } : type === 'apiKey' ? { type: 'apiKey', dailyCapUSD: 5 } : type === 'profile' ? { type: 'profile', profile: '' } : type === 'wait' ? { type: 'wait' } : { type: 'engine', engine: 'codex' }; setFallback(next); }} className="text-xs rounded border border-[var(--t-border)] bg-[var(--t-surface)] p-1.5 text-[var(--t-text)] shrink-0">
                  <option value="profile">profile</option><option value="model">model</option><option value="apiKey">apiKey</option><option value="engine">engine: codex</option><option value="wait">wait</option>
                </select>
                {step.type === 'profile' && (
                  <div className="flex-1 min-w-[140px]">
                    <SelectOrCustomInput
                      value={step.profile || ''}
                      onChange={(val) => { const next = [...fallback]; next[index] = { ...step, profile: val }; setFallback(next); }}
                      options={fallbackProfileOptions}
                      placeholder="profile name"
                      ariaLabel={`Fallback profile ${index + 1}`}
                    />
                  </div>
                )}
                {step.type === 'model' && (
                  <div className="flex-1 min-w-[140px]">
                    <SelectOrCustomInput
                      value={step.model}
                      onChange={(val) => { const next = [...fallback]; next[index] = { ...step, model: val }; setFallback(next); }}
                      options={Array.from(new Set([...DEFAULT_CLAUDE_MODELS, ...chatModels, step.model].filter(Boolean)))}
                      validate={(m) => validateChatModelSyntax(m, t)}
                      placeholder="sonnet"
                      ariaLabel={`Fallback model ${index + 1}`}
                    />
                  </div>
                )}
                {step.type === 'apiKey' && <input type="number" min={0.01} step={0.01} value={step.dailyCapUSD} onChange={(event) => { const next = [...fallback]; next[index] = { ...step, dailyCapUSD: Number(event.target.value) }; setFallback(next); }} className="w-24 text-xs rounded border border-[var(--t-border)] bg-[var(--t-surface)] p-1.5 text-[var(--t-text)]" />}
                <div className="flex items-center gap-1 shrink-0 ml-auto">
                  <button
                    type="button"
                    disabled={index === 0}
                    onClick={() => {
                      if (index === 0) return;
                      const next = [...fallback];
                      const [moved] = next.splice(index, 1);
                      next.splice(index - 1, 0, moved);
                      setFallback(next);
                    }}
                    aria-label={`${t('settings.moveUp')} ${index + 1}`}
                    className="p-1 text-xs rounded hover:bg-[var(--t-hover)] text-[var(--t-text-3)] hover:text-[var(--t-text)] disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                  >
                    <ArrowUp className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    disabled={index === fallback.length - 1}
                    onClick={() => {
                      if (index === fallback.length - 1) return;
                      const next = [...fallback];
                      const [moved] = next.splice(index, 1);
                      next.splice(index + 1, 0, moved);
                      setFallback(next);
                    }}
                    aria-label={`${t('settings.moveDown')} ${index + 1}`}
                    className="p-1 text-xs rounded hover:bg-[var(--t-hover)] text-[var(--t-text-3)] hover:text-[var(--t-text)] disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                  >
                    <ArrowDown className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setFallback(fallback.filter((_, itemIndex) => itemIndex !== index))}
                    aria-label={`${t('extra.remove')} ${index + 1}`}
                    className="text-xs text-[var(--t-crit)] hover:opacity-80 p-1 cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
            <button
              type="button"
              onClick={() => setFallback([...fallback, { type: 'wait' }])}
              className="inline-flex items-center gap-1.5 text-xs px-3 py-2 rounded border border-[var(--t-border)] text-[var(--t-text)] hover:bg-[var(--t-surface-2)] cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{t('extra.addStep')}</span>
            </button>
            <div className="pt-3 border-t border-[var(--t-border)]">
              <label className="block text-xs font-semibold text-[var(--t-text)] mb-1">{t('extra.apiKey')}</label>
              <input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={apiKeyConfigured ? t('extra.configuredReplace') : 'sk-ant-…'} autoComplete="new-password" className="w-full text-xs font-mono rounded border border-[var(--t-border)] bg-[var(--t-surface-2)] p-2 text-[var(--t-text)]" />
            </div>
          </div>

          {/* Savings config block */}
          <div className="bg-[var(--t-surface)] rounded-xl border border-[var(--t-border)] p-6 space-y-6 shadow-xs">
            <div>
              <h2 className="text-base font-semibold text-[var(--t-text)]">
                {t('settings.savingsSectionTitle')}
              </h2>
              <p className="text-xs text-[var(--t-text-3)] mt-0.5">
                {t('extra.savingsSettings')}
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-[var(--t-text)] mb-1">
                  {t('settings.geminiBucketLabel')}
                </label>
                <input
                  type="number"
                  min={100_000}
                  step={100_000}
                  value={bucketGemini}
                  onChange={(e) => setBucketGemini(Number(e.target.value))}
                  className="w-full text-sm rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2 text-[var(--t-text)] focus:outline-none focus:ring-2 focus:ring-[var(--t-accent)] font-mono"
                />
                <p className="text-[11px] text-[var(--t-text-3)] mt-1">
                  {t('extra.geminiBucketHint')}
                </p>
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-[var(--t-text)] mb-1">
                  {t('settings.claudeBucketLabel')}
                </label>
                <input
                  type="number"
                  min={100_000}
                  step={100_000}
                  value={bucketClaude}
                  onChange={(e) => setBucketClaude(Number(e.target.value))}
                  className="w-full text-sm rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2 text-[var(--t-text)] focus:outline-none focus:ring-2 focus:ring-[var(--t-accent)] font-mono"
                />
                <p className="text-[11px] text-[var(--t-text-3)] mt-1">
                  {t('extra.claudeBucketHint')}
                </p>
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-[var(--t-text)] mb-1">
                  {t('extra.claudeFactor')}
                </label>
                <input
                  type="number"
                  min={0.1}
                  max={2.0}
                  step={0.05}
                  value={claudeFactor}
                  onChange={(e) => setClaudeFactor(parseFloat(e.target.value) || 0.9)}
                  className="w-full text-sm rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2 text-[var(--t-text)] focus:outline-none focus:ring-2 focus:ring-[var(--t-accent)] font-mono"
                />
                <p className="text-[11px] text-[var(--t-text-3)] mt-1">
                  {t('extra.claudeFactorHint')}
                </p>
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-[var(--t-text)] mb-1">
                  {t('extra.claudeOverhead')}
                </label>
                <input
                  type="number"
                  min={0}
                  step={5_000}
                  value={claudeOverhead}
                  onChange={(e) => setClaudeOverhead(Number(e.target.value) || 0)}
                  className="w-full text-sm rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2 text-[var(--t-text)] focus:outline-none focus:ring-2 focus:ring-[var(--t-accent)] font-mono"
                />
                <p className="text-[11px] text-[var(--t-text-3)] mt-1">
                  {t('extra.claudeOverheadHint')}
                </p>
              </div>
            </div>
          </div>

          <section data-testid="notifications-settings" data-tour="notifications" className="bg-[var(--t-surface)] rounded-xl border border-[var(--t-border)] p-6 space-y-6 shadow-xs">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-[color-mix(in_srgb,var(--t-accent)_15%,transparent)] text-[var(--t-accent)]">
                  <Bell className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="text-base font-semibold text-[var(--t-text)]">
                    {t('settings.notificationsTitle')}
                  </h2>
                  <p className="text-xs text-[var(--t-text-3)]">
                    {t('settings.notificationsDescription')}
                  </p>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between py-2 border-b border-[var(--t-border)]">
              <div>
                <label className="text-sm font-semibold text-[var(--t-text)]">
                  {t('settings.desktopNotifyLabel')}
                </label>
                <p className="text-xs text-[var(--t-text-3)]">
                  {t('settings.desktopNotifyHint')}
                </p>
              </div>
              <input
                type="checkbox"
                data-testid="desktop-notify-toggle"
                checked={desktopNotify}
                onChange={(e) => setDesktopNotify(e.target.checked)}
                className="rounded border-[var(--t-border)]"
              />
            </div>

            <div className="py-2 border-b border-[var(--t-border)] space-y-2">
              <label htmlFor="desktop-notify-level" className="text-sm font-semibold text-[var(--t-text)]">
                {t('settings.desktopNotifyLevelLabel')}
              </label>
              <select id="desktop-notify-level" data-testid="desktop-notify-level" value={desktopNotifyLevel} onChange={(e) => setDesktopNotifyLevel(e.target.value as typeof desktopNotifyLevel)} className="block rounded border border-[var(--t-border)] bg-[var(--t-surface-2)] p-2 text-sm">
                <option value="all">{t('settings.desktopNotifyLevelAll')}</option>
                <option value="important">{t('settings.desktopNotifyLevelImportant')}</option>
                <option value="critical">{t('settings.desktopNotifyLevelCritical')}</option>
                <option value="off">{t('settings.desktopNotifyLevelOff')}</option>
              </select>
            </div>

            <div className="py-2 border-b border-[var(--t-border)] space-y-2">
              <div>
                <label className="text-sm font-semibold text-[var(--t-text)]">
                  {t('settings.brainEngineLabel')}
                </label>
                <p className="text-xs text-[var(--t-text-3)]">
                  {t('settings.brainEngineHint')}
                </p>
              </div>
              <div className="flex gap-4">
                {(['claude', 'codex'] as const).map((eng) => (
                  <label key={eng} className="flex items-center gap-2 text-xs text-[var(--t-text)] cursor-pointer">
                    <input
                      type="radio"
                      name="brainEngine"
                      value={eng}
                      checked={brainEngine === eng}
                      onChange={() => setBrainEngine(eng)}
                    />
                    <span className="capitalize">{eng}</span>
                  </label>
                ))}
              </div>
              {brainEngine === 'codex' && (
                <div className="pt-2">
                  <label className="block text-xs font-semibold text-[var(--t-text)] mb-1">
                    {t('settings.codexProfileLabel')}
                  </label>
                  <select
                    value={codexProfile}
                    onChange={(e) => setCodexProfile(e.target.value)}
                    className="w-full max-w-xs rounded border border-[var(--t-border)] bg-[var(--t-surface-2)] p-2 text-xs"
                  >
                    <option value="">{t('settings.codexProfileAuto')}</option>
                    {codexProfiles.map((p) => (
                      <option key={p.name} value={p.name}>{p.name} {p.email ? `(${p.email})` : ''}</option>
                    ))}
                    {!codexProfiles.some((p) => p.name === codexProfile) && Boolean(codexProfile.trim()) && (
                      <option key={codexProfile} value={codexProfile}>
                        {(() => {
                          const matched = allProfiles.find((p) => p.name === codexProfile) || profiles.find((p) => p.name === codexProfile);
                          const emailSuffix = matched?.email ? ` (${matched.email})` : '';
                          return `${codexProfile}${emailSuffix} (${t('settings.inactiveOrOld')})`;
                        })()}
                      </option>
                    )}
                  </select>
                  <p className="text-xs text-[var(--t-text-3)] mt-1">
                    {t('settings.codexProfileHint')}
                  </p>
                </div>
              )}
            </div>

            <div className="py-2 border-b border-[var(--t-border)] space-y-2">
              <div>
                <label className="text-sm font-semibold text-[var(--t-text)]">
                  {t('settings.brainModeLabel')}
                </label>
                <p className="text-xs text-[var(--t-text-3)]">
                  {t('settings.brainModeHint')}
                </p>
              </div>
              <div className="flex gap-4">
                {(['off', 'suggest', 'auto'] as const).map((mode) => (
                  <label key={mode} className="flex items-center gap-2 text-xs text-[var(--t-text)] cursor-pointer">
                    <input
                      type="radio"
                      name="brainMode"
                      value={mode}
                      checked={brainMode === mode}
                      onChange={() => setBrainMode(mode)}
                    />
                    <span>{t(`settings.brainMode.${mode}`)}</span>
                  </label>
                ))}
              </div>
              <label className="flex items-center gap-3 text-xs text-[var(--t-text)]">
                <span>{t('settings.brainMaxConcurrent')}</span>
                <input data-testid="brain-max-concurrent" type="number" min={1} max={20} value={brainMaxConcurrent} onChange={(e) => setBrainMaxConcurrent(parseInt(e.target.value, 10) || 1)} className="w-24 rounded border border-[var(--t-border)] bg-[var(--t-surface-2)] p-2" />
              </label>
            </div>

            <div className="py-2 border-b border-[var(--t-border)] space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <label className="text-sm font-semibold text-[var(--t-text)]">
                    {t('settings.quietHoursTitle')}
                  </label>
                  <p className="text-xs text-[var(--t-text-3)]">
                    {t('settings.quietHoursHint')}
                  </p>
                </div>
                <input
                  type="checkbox"
                  data-testid="quiet-hours-toggle"
                  checked={quietHoursEnabled}
                  onChange={(e) => setQuietHoursEnabled(e.target.checked)}
                  className="rounded border-[var(--t-border)]"
                />
              </div>
              {quietHoursEnabled && (
                <div className="grid grid-cols-2 gap-4 pt-2">
                  <div>
                    <label className="block text-xs font-semibold text-[var(--t-text-2)] mb-1">
                      {t('settings.quietHoursStart')}
                    </label>
                    <input
                      type="time"
                      data-testid="quiet-hours-start"
                      value={quietHoursStart}
                      onChange={(e) => setQuietHoursStart(e.target.value)}
                      className="w-full text-sm rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2 text-[var(--t-text)] font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-[var(--t-text-2)] mb-1">
                      {t('settings.quietHoursEnd')}
                    </label>
                    <input
                      type="time"
                      data-testid="quiet-hours-end"
                      value={quietHoursEnd}
                      onChange={(e) => setQuietHoursEnd(e.target.value)}
                      className="w-full text-sm rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2 text-[var(--t-text)] font-mono"
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="py-2 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <label className="text-sm font-semibold text-[var(--t-text)]">
                    {t('settings.digestTitle')}
                  </label>
                  <p className="text-xs text-[var(--t-text-3)]">
                    {t('settings.digestHint')}
                  </p>
                </div>
                <input
                  type="checkbox"
                  data-testid="digest-toggle"
                  checked={digestEnabled}
                  onChange={(e) => setDigestEnabled(e.target.checked)}
                  className="rounded border-[var(--t-border)]"
                />
              </div>
              {digestEnabled && (
                <div className="pt-2 max-w-xs">
                  <label className="block text-xs font-semibold text-[var(--t-text-2)] mb-1">
                    {t('settings.digestTime')}
                  </label>
                  <input
                    type="time"
                    value={digestTime}
                    onChange={(e) => setDigestTime(e.target.value)}
                    className="w-full text-sm rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2 text-[var(--t-text)] font-mono"
                  />
                </div>
              )}
            </div>
          </section>

          <TelegramCard />

          <section className="bg-[var(--t-surface)] rounded-xl border border-[var(--t-border)] p-6 space-y-3" data-testid="shutdown-settings">
            <h2 className="text-sm font-semibold">{t('settings.shutdownTitle')}</h2>
            {shutdownDone ? <p className="text-sm text-[var(--t-ok)]">{t('settings.shutdownDone')} <code>agenthub start</code></p> : <>
              <p className="text-xs text-[var(--t-text-3)]">{t('settings.shutdownDescription', { count: String((hubStatus.data?.tasks?.running || 0) + (hubStatus.data?.tasks?.checking || 0)) })}</p>
              <button type="button" onClick={() => setShutdownOpen(true)} className="rounded-lg bg-[var(--t-crit)] px-4 py-2 text-xs font-semibold text-[var(--t-on-accent)]">{t('settings.shutdownButton')}</button>
            </>}
          </section>

          <section className="bg-[var(--t-surface)] rounded-xl border border-[var(--t-border)] p-6 space-y-3" data-testid="permission-rules">
            <h2 className="text-sm font-semibold">{t('extra.grantedPermissions')}</h2>
            <p className="text-xs text-[var(--t-text-3)]">{t('extra.grantedPermissionsDesc')}</p>
            <DataTable
              rows={permissionRules.data?.items || []}
              emptyTitle={t('extra.noPermissionRules')}
              columns={[
                { key: 'tool', title: t('extra.permissionTool'), sortable: true, sortValue: (rule) => `${rule.toolName} ${rule.pattern}`, render: (rule) => <code className="break-all">{rule.toolName} {rule.pattern}</code> },
                { key: 'scope', title: t('extra.permissionScope'), sortable: true, sortValue: (rule) => rule.scope, render: (rule) => <span>{rule.scope}</span> },
                { key: 'actions', title: t('extra.actions'), render: (rule) => <button type="button" onClick={() => deleteRule.mutate(rule.id)} className="text-[var(--t-crit)] shrink-0">{t('extra.remove')}</button> },
              ]}
              page={permissionPage}
              pageSize={20}
              total={permissionRules.data?.total || 0}
              onPageChange={setPermissionPage}
            />
          </section>

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={mutation.isPending}
              aria-busy={mutation.isPending}
              className="px-5 py-2 rounded-lg bg-[var(--t-accent)] hover:bg-[var(--t-accent-hover)] text-[var(--t-on-accent)] text-xs font-semibold inline-flex items-center gap-2 shadow-xs cursor-pointer disabled:opacity-50"
            >
              <Save className="w-4 h-4" />
              <span>{mutation.isPending ? t('settings.savingConfigBtn') : t('settings.saveConfigBtn')}</span>
            </button>
          </div>
        </form>
      )}
      {shutdownOpen && <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--t-overlay)] p-4" role="dialog" aria-modal="true">
        <div className="max-w-md rounded-xl bg-[var(--t-surface)] p-6 shadow-xl space-y-4">
          <h2 className="font-semibold">{t('settings.shutdownConfirmTitle')}</h2>
          <p className="text-sm text-[var(--t-text-2)]">{t('settings.shutdownConfirm', { count: String((hubStatus.data?.tasks?.running || 0) + (hubStatus.data?.tasks?.checking || 0)) })}</p>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={shutdownDisable} onChange={(e) => setShutdownDisable(e.target.checked)} />{t('settings.shutdownDisable')}</label>
          <div className="flex justify-end gap-2"><button type="button" onClick={() => setShutdownOpen(false)} className="rounded-lg border px-3 py-2 text-xs">{t('common.cancel')}</button><button type="button" onClick={() => shutdownMutation.mutate()} className="rounded-lg bg-[var(--t-crit)] px-3 py-2 text-xs text-[var(--t-on-accent)]">{t('settings.shutdownButton')}</button></div>
        </div>
      </div>}
    </div>
  );
};
