import React, { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, CheckCircle2, RotateCw, Loader2, AlertCircle } from 'lucide-react';
import { useLocale } from '../context/LocaleContext';
import {
  deleteOpenProjectSource,
  getOpenProjectSources,
  getOpenProjectStatuses,
  getOpenProjectTypes,
  saveOpenProjectKey,
  saveOpenProjectSource,
  syncOpenProject,
  testOpenProjectConnection,
  createOpenProjectDailyReport,
  getOpenProjectTimeEntryActivities,
  previewOpenProjectTimesheet,
  runOpenProjectTimesheet,
} from '../api/client';
import type { OpenProjectSource, OpenProjectSourceInput, OpenProjectStatusDto } from '../types/api';

type TimesheetPreview = {
  date?: string;
  hours?: number;
  overMinimum?: boolean;
  entries?: Array<{ displayId?: string; subject?: string; run?: number; wait?: number; chat?: number; level?: number; weight?: number; hours?: number; rawHours?: number; estimateHours?: number }>;
  withoutTicket?: Array<{ taskId?: string; subject?: string }>;
  estimateSkipped?: Array<{ wpId?: number; displayId?: string; reason?: string }>;
};

const blank = (id: string): OpenProjectSourceInput => ({
  id,
  url: '',
  project: '',
  pollIntervalSec: 120,
  watchStatusIds: [],
  reopenedStatusIds: [],
  createTypeId: null,
  createStatusId: null,
  resolvedStatusId: null,
  reviewStatusId: null,
  openStatusIds: [],
  minTicketNumber: 0,
  autoStart: true,
  autoResolve: true,
  triage: 'off',
  triageModelChain: [],
  feedbackStatusId: null,
  language: 'vi',
  split: { typeIds: [], keyword: '[chia]', workerMayRequest: true, maxParts: 5, createChildTickets: true },
  dailyReport: { enabled: false, time: '18:00', weekdaysOnly: true, maxItems: 10, telegram: false },
  timesheet: { enabled: false, time: '17:30', weekdaysOnly: true, hours: 8, activityId: null, minEntryHours: 0.5, roundTo: 0.25, writeEstimate: true },
});

export const parseIdList = (value: string): number[] =>
  value
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0)
    .map((v) => Number(v))
    .filter((v) => Number.isInteger(v));

export const nullableNumber = (value: string): number | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const num = Number(trimmed);
  return Number.isInteger(num) ? num : null;
};

export const matchStatusIds = (statuses: OpenProjectStatusDto[], targetNames: string[]): number[] => {
  const targets = new Set(targetNames.map((n) => n.trim().toLowerCase()));
  return statuses
    .filter((s) => targets.has(s.name.trim().toLowerCase()))
    .map((s) => s.id);
};

const normalizeSplit = (source: OpenProjectSource | OpenProjectSourceInput): OpenProjectSourceInput => ({
  ...source,
  split: source.split || { typeIds: [], keyword: '[chia]', workerMayRequest: true, maxParts: 5, createChildTickets: true },
  timesheet: source.timesheet || { enabled: false, time: '17:30', weekdaysOnly: true, hours: 8, activityId: null, minEntryHours: 0.5, roundTo: 0.25, writeEstimate: true },
});

export const OpenProjectSettings: React.FC = () => {
  const { t } = useLocale();
  const qc = useQueryClient();
  const { data: sources = [], isLoading } = useQuery({
    queryKey: ['openproject-sources'],
    queryFn: getOpenProjectSources,
  });

  const [draft, setDraft] = useState<OpenProjectSourceInput | null>(null);
  const [key, setKey] = useState('');
  const [message, setMessage] = useState<{ type: 'ok' | 'error'; text: string } | null>(null);
  const [timesheetPreview, setTimesheetPreview] = useState<TimesheetPreview | null>(null);
  const [manualInputs, setManualInputs] = useState<Partial<Record<'watchStatusIds' | 'reopenedStatusIds' | 'openStatusIds', string>>>({});

  useEffect(() => {
    if (!draft && sources[0]) {
      setDraft(normalizeSplit(sources[0]));
      setManualInputs({});
    }
  }, [sources, draft]);

  const currentSource = sources.find((s) => s.id === draft?.id);
  const isSaved = sources.some((s) => s.id === draft?.id);
  const isUnsaved = !isSaved;
  const canFetchStatuses = Boolean(draft?.id && draft.url.trim() && currentSource?.keyConfigured);

  const {
    data: statuses,
    isFetching: isStatusesFetching,
    isError: isStatusesError,
    refetch: refetchStatuses,
  } = useQuery({
    queryKey: ['openproject-statuses', draft?.id],
    queryFn: () => getOpenProjectStatuses(draft!.id),
    enabled: canFetchStatuses,
    retry: false,
  });

  const hasValidStatuses = Boolean(!isStatusesError && statuses && statuses.length > 0);
  const { data: types = [] } = useQuery({
    queryKey: ['openproject-types', draft?.id],
    queryFn: () => getOpenProjectTypes(draft!.id),
    enabled: canFetchStatuses,
    retry: false,
  });
  const { data: activities = [] } = useQuery({ queryKey: ['openproject-time-entry-activities', draft?.id], queryFn: () => getOpenProjectTimeEntryActivities(draft!.id), enabled: canFetchStatuses, retry: false });

  const saveMutation = useMutation({
    mutationFn: async (sourceDraft: OpenProjectSourceInput) => {
      let toSave: OpenProjectSourceInput = { ...sourceDraft };
      for (const field of ['watchStatusIds', 'reopenedStatusIds', 'openStatusIds'] as const) {
        if (manualInputs[field] !== undefined) {
          toSave = { ...toSave, [field]: parseIdList(manualInputs[field]!) };
        }
      }
      const saved = await saveOpenProjectSource(toSave.id, toSave);
      if (key.trim()) {
        try {
          await saveOpenProjectKey(toSave.id, key.trim());
        } catch (keyErr: any) {
          const err = new Error(keyErr?.message || String(keyErr));
          (err as any).isKeyError = true;
          throw err;
        }
      }
      return saved;
    },
    onSuccess: () => {
      setKey('');
      setManualInputs({});
      setMessage({ type: 'ok', text: t('integrations.saved') });
      qc.invalidateQueries({ queryKey: ['openproject-sources'] });
      if (draft?.id) {
        qc.invalidateQueries({ queryKey: ['openproject-statuses', draft.id] });
      }
    },
    onError: (err: any) => {
      if (err?.isKeyError) {
        qc.invalidateQueries({ queryKey: ['openproject-sources'] });
        setMessage({
          type: 'error',
          text: t('integrations.saveKeyError', { error: err.message }),
        });
      } else {
        setMessage({
          type: 'error',
          text: err?.message || t('integrations.saveError'),
        });
      }
    },
  });

  const removeMutation = useMutation({
    mutationFn: deleteOpenProjectSource,
    onSuccess: () => {
      setDraft(null);
      setManualInputs({});
      setMessage(null);
      qc.invalidateQueries({ queryKey: ['openproject-sources'] });
    },
    onError: (err: any) => {
      setMessage({
        type: 'error',
        text: err?.message || t('common.error'),
      });
    },
  });

  const testConnectionMutation = useMutation({
    mutationFn: (sourceId: string) => testOpenProjectConnection(sourceId),
    onSuccess: (res) => {
      const name = res?.name;
      setMessage({
        type: 'ok',
        text: name ? t('integrations.testOkWithName', { name }) : t('integrations.testOk'),
      });
    },
    onError: (err: any) => {
      setMessage({
        type: 'error',
        text: err?.message || t('common.error'),
      });
    },
  });

  const syncMutation = useMutation({
    mutationFn: (sourceId: string) => syncOpenProject(sourceId),
    onSuccess: (res) => {
      if (res && typeof res.baseline === 'number' && res.baseline > 0) {
        if (typeof res.watched === 'number') {
          setMessage({
            type: 'ok',
            text: t('integrations.syncBaselineWatchedSuccess', { count: res.baseline, watched: res.watched }),
          });
        } else {
          setMessage({
            type: 'ok',
            text: t('integrations.syncBaselineSuccess', { count: res.baseline }),
          });
        }
      } else if (res && typeof res.watched === 'number') {
        const count = res?.imported ?? 0;
        if (typeof res.baseline === 'number') {
          setMessage({
            type: 'ok',
            text: t('integrations.syncDetailsSuccess', { count, watched: res.watched, baseline: res.baseline }),
          });
        } else {
          setMessage({
            type: 'ok',
            text: t('integrations.syncWatchedSuccess', { count, watched: res.watched }),
          });
        }
      } else {
        const count = res?.imported ?? 0;
        setMessage({
          type: 'ok',
          text: t('integrations.syncSuccess', { count }),
        });
      }
    },
    onError: (err: any) => {
      setMessage({
        type: 'error',
        text: err?.message || t('common.error'),
      });
    },
  });

  const dailyReportMutation = useMutation({
    mutationFn: (sourceId: string) => createOpenProjectDailyReport(sourceId),
    onSuccess: () => {
      setMessage({
        type: 'ok',
        text: t('integrations.dailyReportSuccess'),
      });
    },
    onError: (err: any) => {
      setMessage({
        type: 'error',
        text: err?.message || t('common.error'),
      });
    },
  });
  const timesheetPreviewMutation = useMutation({ mutationFn: (id: string) => previewOpenProjectTimesheet(id), onSuccess: (data) => { setTimesheetPreview(data as TimesheetPreview); setMessage({ type: 'ok', text: t('integrations.timesheetPreviewSuccess') }); }, onError: (err: any) => setMessage({ type: 'error', text: err?.message || t('common.error') }) });
  const timesheetRunMutation = useMutation({ mutationFn: (id: string) => runOpenProjectTimesheet(id), onSuccess: (data) => { setTimesheetPreview(data as TimesheetPreview); setMessage({ type: 'ok', text: t('integrations.timesheetRunSuccess') }); }, onError: (err: any) => setMessage({ type: 'error', text: err?.message || t('common.error') }) });

  const set = (patch: Partial<OpenProjectSourceInput>) =>
    setDraft((d) => (d ? { ...d, ...patch } : d));

  const selectSource = (source: OpenProjectSource | OpenProjectSourceInput) => {
    setDraft(normalizeSplit(source));
    setManualInputs({});
    setKey('');
    setMessage(null);
  };

  const handleSuggestByName = () => {
    if (!statuses || !statuses.length || !draft) return;
    const patch: Partial<OpenProjectSourceInput> = {};
    if (draft.watchStatusIds.length === 0) {
      patch.watchStatusIds = matchStatusIds(statuses, ['new', 'reopened']);
    }
    if (draft.reopenedStatusIds.length === 0) {
      patch.reopenedStatusIds = matchStatusIds(statuses, ['reopened']);
    }
    if (draft.resolvedStatusId === null) {
      const resolved = statuses.find((s) => s.name.trim().toLowerCase() === 'resolved');
      if (resolved) patch.resolvedStatusId = resolved.id;
    }
    if (draft.openStatusIds.length === 0) {
      patch.openStatusIds = matchStatusIds(statuses, ['new', 'reopened', 'in progress']);
    }
    set(patch);
  };

  if (isLoading) {
    return (
      <section className="rounded-xl border border-[var(--t-border)] bg-[var(--t-surface)] p-5">
        {t('common.loading')}
      </section>
    );
  }

  return (
    <section
      className="rounded-xl border border-[var(--t-border)] bg-[var(--t-surface)] p-5 space-y-4"
      data-testid="openproject-global-settings"
    >
      <div>
        <h2 className="font-semibold">{t('integrations.openProjectTitle')}</h2>
        <p className="text-sm text-[var(--t-text-3)]">{t('integrations.openProjectDescription')}</p>
      </div>

      <div className="flex flex-wrap gap-2">
        {sources.map((source) => (
          <button
            key={source.id}
            type="button"
            onClick={() => selectSource(source)}
            className={`rounded-lg border px-3 py-2 text-xs ${
              draft?.id === source.id ? 'border-[var(--t-accent)]' : 'border-[var(--t-border)]'
            }`}
          >
            {source.id}
          </button>
        ))}
        <button
          type="button"
          className="rounded-lg border border-[var(--t-border)] px-3 py-2 text-xs"
          onClick={() => selectSource(blank(`openproject-${Date.now()}`))}
        >
          <Plus className="inline h-3 w-3" /> {t('integrations.addSource')}
        </button>
      </div>

      {draft && (
        <div className="grid gap-3 sm:grid-cols-2 text-sm">
          {(['id', 'url', 'project', 'language'] as const).map((field) => (
            <label key={field} className="space-y-1">
              <span>{t(`integrations.${field}`)}</span>
              <input
                value={draft[field]}
                disabled={field === 'id'}
                onChange={(e) => set({ [field]: e.target.value } as Partial<OpenProjectSourceInput>)}
                className="w-full rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2"
              />
            </label>
          ))}

          <label className="space-y-1">
            <span>{t('integrations.pollInterval')}</span>
            <input
              type="number"
              value={draft.pollIntervalSec}
              onChange={(e) => set({ pollIntervalSec: Number(e.target.value) })}
              className="w-full rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2"
            />
          </label>
          <div className="sm:col-span-2 rounded-lg border border-[var(--t-border)] p-3 space-y-3">
            <strong className="text-xs">{t('integrations.splitTitle')}</strong>
            <label className="block space-y-1 text-xs">
              <span>{t('integrations.splitTypeIds')}</span>
              <div className="flex flex-wrap gap-2">
                {(types || []).map((item) => (
                  <label key={item.id} className="inline-flex items-center gap-1">
                    <input type="checkbox" checked={draft.split.typeIds.includes(item.id)} onChange={(e) => set({ split: { ...draft.split, typeIds: e.target.checked ? [...draft.split.typeIds, item.id] : draft.split.typeIds.filter((id) => id !== item.id) } })} />
                    {item.name} ({item.id})
                  </label>
                ))}
              </div>
            </label>
            <label className="block space-y-1 text-xs"><span>{t('integrations.splitKeyword')}</span><input value={draft.split.keyword || ''} onChange={(e) => set({ split: { ...draft.split, keyword: e.target.value || null } })} className="w-full rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2" /></label>
            <label className="block space-y-1 text-xs"><span>{t('integrations.splitMaxParts')}</span><input type="number" min={2} max={5} value={draft.split.maxParts} onChange={(e) => set({ split: { ...draft.split, maxParts: Math.min(5, Math.max(2, Number(e.target.value))) } })} className="w-full rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2" /></label>
            <label className="flex gap-2 items-center text-xs"><input type="checkbox" checked={draft.split.workerMayRequest} onChange={(e) => set({ split: { ...draft.split, workerMayRequest: e.target.checked } })} />{t('integrations.splitWorkerMayRequest')}</label>
            <label className="flex gap-2 items-center text-xs"><input type="checkbox" checked={draft.split.createChildTickets} onChange={(e) => set({ split: { ...draft.split, createChildTickets: e.target.checked } })} />{t('integrations.splitCreateChildren')}</label>
          </div>

          <label className="space-y-1">
            <span>{t('integrations.minTicket')}</span>
            <input
              type="number"
              value={draft.minTicketNumber}
              onChange={(e) => set({ minTicketNumber: Number(e.target.value) })}
              className="w-full rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2"
            />
          </label>

          {/* Status Configuration Section */}
          <div className="sm:col-span-2 rounded-lg border border-[var(--t-border)] p-3 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--t-border)] pb-2">
              <div>
                <strong className="text-xs font-semibold">{t('integrations.statusMappingTitle')}</strong>
                {!hasValidStatuses && !isStatusesFetching && (
                  <p className="text-xs text-[var(--t-text-3)]" data-testid="status-picker-hint">
                    {t('integrations.saveUrlAndKeyFirst')}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => refetchStatuses()}
                  disabled={isStatusesFetching}
                  aria-busy={isStatusesFetching ? true : undefined}
                  className="rounded-lg border border-[var(--t-border)] px-2.5 py-1.5 text-xs hover:bg-[var(--t-surface-2)] disabled:opacity-50 disabled:cursor-not-allowed"
                  data-testid="reload-statuses-button"
                >
                  {isStatusesFetching ? (
                    <Loader2 className="inline h-3 w-3 mr-1 animate-spin" />
                  ) : (
                    <RotateCw className="inline h-3 w-3 mr-1" />
                  )}
                  {isStatusesFetching ? t('integrations.loadingStatuses') : t('integrations.reloadStatuses')}
                </button>
                {hasValidStatuses && (
                  <button
                    type="button"
                    onClick={handleSuggestByName}
                    className="rounded-lg border border-[var(--t-border)] px-2.5 py-1.5 text-xs hover:bg-[var(--t-surface-2)]"
                    data-testid="suggest-statuses-button"
                  >
                    {t('integrations.suggestByName')}
                  </button>
                )}
              </div>
            </div>

            {hasValidStatuses && statuses ? (
              <div className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  {(['createTypeId', 'createStatusId'] as const).map((field) => (
                    <label key={field} className="space-y-1 text-xs">
                      <span className="font-medium text-[var(--t-text-2)]">{t(`integrations.${field}`)}</span>
                      <select
                        value={draft[field] ?? ''}
                        onChange={(e) => set({ [field]: e.target.value === '' ? null : Number(e.target.value) })}
                        className="w-full rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2 text-xs"
                      >
                        <option value="">{t('integrations.noChange')}</option>
                        {(field === 'createTypeId' ? types : statuses).map((item) => (
                          <option key={item.id} value={item.id}>{item.name} ({item.id})</option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
                {(['watchStatusIds', 'reopenedStatusIds', 'openStatusIds'] as const).map((field) => {
                  const knownIds = new Set(statuses.map((s) => s.id));
                  const extraIds = draft[field].filter((id) => !knownIds.has(id));
                  const allOptions = [
                    ...statuses.map((s) => ({
                      id: s.id,
                      label: `${s.name} (${s.id})`,
                    })),
                    ...extraIds.map((id) => ({
                      id,
                      label: `${t('integrations.unknownStatus')} (${id})`,
                    })),
                  ];

                  return (
                    <div key={field} className="space-y-1.5" data-testid={`status-picker-${field}`}>
                      <span className="block text-xs font-medium text-[var(--t-text-2)]">
                        {t(`integrations.${field}`)}
                      </span>
                      <div className="flex flex-wrap gap-1.5 p-2 rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)]">
                        {allOptions.map((opt) => {
                          const isChecked = draft[field].includes(opt.id);
                          return (
                            <label
                              key={opt.id}
                              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs cursor-pointer border transition-colors ${
                                isChecked
                                  ? 'border-[var(--t-accent)] bg-[var(--t-surface)] font-medium text-[var(--t-text-1)]'
                                  : 'border-[var(--t-border)] bg-[var(--t-surface)] text-[var(--t-text-3)] hover:text-[var(--t-text-2)]'
                              }`}
                              data-testid={`status-chip-${field}-${opt.id}`}
                            >
                              <input
                                type="checkbox"
                                checked={isChecked}
                                onChange={(e) => {
                                  const current = draft[field];
                                  const updated = e.target.checked
                                    ? [...current, opt.id]
                                    : current.filter((id) => id !== opt.id);
                                  set({ [field]: updated } as Partial<OpenProjectSourceInput>);
                                }}
                                className="rounded border-[var(--t-border)] text-[var(--t-accent)]"
                              />
                              <span>{opt.label}</span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}

                <div className="grid gap-3 sm:grid-cols-2 pt-1">
                  {(['resolvedStatusId', 'reviewStatusId'] as const).map((field) => {
                    const currentVal = draft[field];
                    const isUnknown = currentVal !== null && !statuses.some((s) => s.id === currentVal);
                    return (
                      <label key={field} className="space-y-1 text-xs">
                        <span className="font-medium text-[var(--t-text-2)]">{t(`integrations.${field}`)}</span>
                        <select
                          value={currentVal ?? ''}
                          onChange={(e) =>
                            set({
                              [field]: e.target.value === '' ? null : Number(e.target.value),
                            } as Partial<OpenProjectSourceInput>)
                          }
                          className="w-full rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2 text-xs"
                          data-testid={`status-select-${field}`}
                        >
                          <option value="">{t('integrations.noChange')}</option>
                          {isUnknown && currentVal !== null && (
                            <option value={currentVal}>
                              {t('integrations.unknownStatus')} ({currentVal})
                            </option>
                          )}
                          {statuses.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.name} ({s.id})
                            </option>
                          ))}
                        </select>
                      </label>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                {(['watchStatusIds', 'reopenedStatusIds', 'openStatusIds'] as const).map((field) => {
                  const inputValue =
                    manualInputs[field] !== undefined ? manualInputs[field]! : draft[field].join(', ');
                  return (
                    <label key={field} className="space-y-1 block text-xs">
                      <span>{t(`integrations.${field}`)}</span>
                      <input
                        value={inputValue}
                        onChange={(e) =>
                          setManualInputs((prev) => ({ ...prev, [field]: e.target.value }))
                        }
                        onBlur={() => {
                          const raw = manualInputs[field];
                          if (raw !== undefined) {
                            const parsed = parseIdList(raw);
                            set({ [field]: parsed } as Partial<OpenProjectSourceInput>);
                            setManualInputs((prev) => {
                              const copy = { ...prev };
                              delete copy[field];
                              return copy;
                            });
                          }
                        }}
                        className="w-full rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2"
                        data-testid={`manual-input-${field}`}
                      />
                    </label>
                  );
                })}

                <div className="grid gap-3 sm:grid-cols-2">
                  {(['resolvedStatusId', 'reviewStatusId'] as const).map((field) => (
                    <label key={field} className="space-y-1 text-xs">
                      <span>{t(`integrations.${field}`)}</span>
                      <input
                        type="number"
                        value={draft[field] ?? ''}
                        onChange={(e) =>
                          set({
                            [field]: nullableNumber(e.target.value),
                          } as Partial<OpenProjectSourceInput>)
                        }
                        className="w-full rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2"
                        data-testid={`manual-input-${field}`}
                      />
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>

          <label className="flex gap-2 items-center">
            <input
              type="checkbox"
              checked={draft.autoStart}
              onChange={(e) => set({ autoStart: e.target.checked })}
            />
            {t('integrations.autoStart')}
          </label>
          <label className="space-y-1">
            <span>{t('integrations.triage')}</span>
            <select value={draft.triage || 'off'} onChange={(e) => set({ triage: e.target.value as OpenProjectSourceInput['triage'] })} className="w-full rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2" data-testid="triage-select">
              <option value="off">{t('integrations.triageOff')}</option><option value="approve">{t('integrations.triageApprove')}</option><option value="auto">{t('integrations.triageAuto')}</option>
            </select>
          </label>
          <label className="space-y-1">
            <span>{t('integrations.feedbackStatus')}</span>
            {hasValidStatuses && statuses ? (
              <select value={draft.feedbackStatusId ?? ''} onChange={(e) => set({ feedbackStatusId: e.target.value === '' ? null : Number(e.target.value) })} className="w-full rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2" data-testid="status-select-feedbackStatusId">
                <option value="">{t('integrations.noChange')}</option>{statuses.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.id})</option>)}
              </select>
            ) : <input type="number" value={draft.feedbackStatusId ?? ''} onChange={(e) => set({ feedbackStatusId: nullableNumber(e.target.value) })} className="w-full rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2" />}
          </label>
          <label className="flex gap-2 items-center">
            <input
              type="checkbox"
              checked={draft.autoResolve}
              onChange={(e) => set({ autoResolve: e.target.checked })}
            />
            {t('integrations.autoResolve')}
          </label>

          <div className="sm:col-span-2 grid gap-3 rounded-lg border border-[var(--t-border)] p-3 sm:grid-cols-2">
            <strong className="sm:col-span-2 text-xs">{t('integrations.dailyReportConfig')}</strong>
            <label className="space-y-1 text-xs">
              <span>{t('integrations.reportTime')}</span>
              <input
                type="time"
                value={draft.dailyReport?.time || '18:00'}
                onChange={(e) =>
                  set({
                    dailyReport: {
                      ...(draft.dailyReport || { weekdaysOnly: true, maxItems: 10, telegram: false }),
                      time: e.target.value,
                    },
                  })
                }
                className="w-full rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2"
              />
            </label>
            <label className="space-y-1 text-xs">
              <span>{t('integrations.reportDirectory')}</span>
              <input
                value={draft.dailyReport?.dir || ''}
                onChange={(e) =>
                  set({
                    dailyReport: {
                      ...(draft.dailyReport || {
                        time: '18:00',
                        weekdaysOnly: true,
                        maxItems: 10,
                        telegram: false,
                      }),
                      dir: e.target.value,
                    },
                  })
                }
                className="w-full rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2"
              />
            </label>
            <label className="space-y-1 text-xs">
              <span>{t('integrations.maxReportItems')}</span>
              <input
                type="number"
                value={draft.dailyReport?.maxItems ?? 10}
                onChange={(e) =>
                  set({
                    dailyReport: {
                      ...(draft.dailyReport || {
                        time: '18:00',
                        weekdaysOnly: true,
                        maxItems: 10,
                        telegram: false,
                      }),
                      maxItems: Number(e.target.value),
                    },
                  })
                }
                className="w-full rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2"
              />
            </label>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={draft.dailyReport?.weekdaysOnly ?? true}
                onChange={(e) =>
                  set({
                    dailyReport: {
                      ...(draft.dailyReport || { time: '18:00', maxItems: 10, telegram: false }),
                      weekdaysOnly: e.target.checked,
                    },
                  })
                }
              />
              {t('integrations.weekdaysOnly')}
            </label>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={draft.dailyReport?.telegram ?? false}
                onChange={(e) =>
                  set({
                    dailyReport: {
                      ...(draft.dailyReport || { time: '18:00', weekdaysOnly: true, maxItems: 10 }),
                      telegram: e.target.checked,
                    },
                  })
                }
              />
              Telegram
            </label>
          </div>

          <div className="sm:col-span-2 grid gap-3 rounded-lg border border-[var(--t-border)] p-3 sm:grid-cols-2">
            <strong className="sm:col-span-2 text-xs">{t('integrations.timesheetConfig')}</strong>
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={draft.timesheet?.enabled ?? false} onChange={(e) => set({ timesheet: { ...(draft.timesheet || blank(draft.id).timesheet), enabled: e.target.checked } })} />{t('integrations.timesheetEnabled')}</label>
            <label className="space-y-1 text-xs"><span>{t('integrations.timesheetTime')}</span><input type="time" value={draft.timesheet?.time || '17:30'} onChange={(e) => set({ timesheet: { ...(draft.timesheet || blank(draft.id).timesheet), time: e.target.value } })} className="w-full rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2" /></label>
            <label className="space-y-1 text-xs"><span>{t('integrations.timesheetActivity')}</span><select value={draft.timesheet?.activityId ?? ''} onChange={(e) => set({ timesheet: { ...(draft.timesheet || blank(draft.id).timesheet), activityId: e.target.value ? Number(e.target.value) : null } })} className="w-full rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2"><option value="">{activities.length ? t('integrations.timesheetActivityManual') : t('integrations.timesheetActivityFallback')}</option>{activities.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.id})</option>)}</select>{!activities.length && <input aria-label={t('integrations.timesheetActivity')} type="number" min={1} value={draft.timesheet?.activityId ?? ''} onChange={(e) => set({ timesheet: { ...(draft.timesheet || blank(draft.id).timesheet), activityId: e.target.value ? Number(e.target.value) : null } })} placeholder={t('integrations.timesheetActivityId')} className="w-full rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2" />}</label>
            <label className="space-y-1 text-xs"><span>{t('integrations.timesheetHours')}</span><input type="number" min={8} step={0.25} value={draft.timesheet?.hours ?? 8} onChange={(e) => set({ timesheet: { ...(draft.timesheet || blank(draft.id).timesheet), hours: Number(e.target.value) } })} className="w-full rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2" /></label>
            <label className="space-y-1 text-xs"><span>{t('integrations.timesheetMin')}</span><input type="number" min={0.25} step={0.25} value={draft.timesheet?.minEntryHours ?? 0.5} onChange={(e) => set({ timesheet: { ...(draft.timesheet || blank(draft.id).timesheet), minEntryHours: Number(e.target.value) } })} className="w-full rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2" /></label>
            <label className="space-y-1 text-xs"><span>{t('integrations.timesheetRound')}</span><input type="number" min={0.25} step={0.25} value={draft.timesheet?.roundTo ?? 0.25} onChange={(e) => set({ timesheet: { ...(draft.timesheet || blank(draft.id).timesheet), roundTo: Number(e.target.value) } })} className="w-full rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2" /></label>
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={draft.timesheet?.weekdaysOnly ?? true} onChange={(e) => set({ timesheet: { ...(draft.timesheet || blank(draft.id).timesheet), weekdaysOnly: e.target.checked } })} />{t('integrations.weekdaysOnly')}</label>
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={draft.timesheet?.writeEstimate ?? true} onChange={(e) => set({ timesheet: { ...(draft.timesheet || blank(draft.id).timesheet), writeEstimate: e.target.checked } })} />{t('integrations.timesheetWriteEstimate')}</label>
          </div>

          <label className="sm:col-span-2 space-y-1">
            <span>{t('integrations.apiKey')}</span>
            <input
              type="password"
              value={key}
              placeholder={
                sources.find((s) => s.id === draft.id)?.keyConfigured
                  ? t('integrations.configured')
                  : ''
              }
              onChange={(e) => setKey(e.target.value)}
              className="w-full rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2"
            />
          </label>

          <div className="sm:col-span-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                if (draft) saveMutation.mutate(draft);
              }}
              disabled={saveMutation.isPending || removeMutation.isPending || !draft}
              aria-busy={saveMutation.isPending ? true : undefined}
              className="rounded-lg bg-[var(--t-accent)] px-3 py-2 text-xs text-[var(--t-on-accent)] disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
            >
              {saveMutation.isPending && <Loader2 className="inline h-3 w-3 animate-spin" />}
              {saveMutation.isPending ? t('integrations.saving') : t('common.save')}
            </button>
            <button
              type="button"
              onClick={() => testConnectionMutation.mutate(draft.id)}
              disabled={isUnsaved || testConnectionMutation.isPending || removeMutation.isPending}
              aria-busy={testConnectionMutation.isPending ? true : undefined}
              title={isUnsaved ? t('integrations.saveSourceFirst') : undefined}
              className="rounded-lg border px-3 py-2 text-xs disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
            >
              {testConnectionMutation.isPending && <Loader2 className="inline h-3 w-3 animate-spin" />}
              {testConnectionMutation.isPending ? t('integrations.testingConnection') : t('integrations.testConnection')}
            </button>
            <button
              type="button"
              onClick={() => syncMutation.mutate(draft.id)}
              disabled={isUnsaved || syncMutation.isPending || removeMutation.isPending}
              aria-busy={syncMutation.isPending ? true : undefined}
              title={isUnsaved ? t('integrations.saveSourceFirst') : undefined}
              className="rounded-lg border px-3 py-2 text-xs disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
            >
              {syncMutation.isPending && <Loader2 className="inline h-3 w-3 animate-spin" />}
              {syncMutation.isPending ? t('integrations.syncing') : t('integrations.syncNow')}
            </button>
            <button
              type="button"
              onClick={() => dailyReportMutation.mutate(draft.id)}
              disabled={isUnsaved || dailyReportMutation.isPending || removeMutation.isPending}
              aria-busy={dailyReportMutation.isPending ? true : undefined}
              title={isUnsaved ? t('integrations.saveSourceFirst') : undefined}
              className="rounded-lg border px-3 py-2 text-xs disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
            >
              {dailyReportMutation.isPending && <Loader2 className="inline h-3 w-3 animate-spin" />}
              {dailyReportMutation.isPending ? t('integrations.creatingDailyReport') : t('integrations.dailyReport')}
            </button>
            <button type="button" onClick={() => timesheetPreviewMutation.mutate(draft.id)} disabled={isUnsaved || timesheetPreviewMutation.isPending} className="rounded-lg border px-3 py-2 text-xs disabled:opacity-50">{timesheetPreviewMutation.isPending ? t('integrations.timesheetLoading') : t('integrations.timesheetPreview')}</button>
            <button type="button" onClick={() => timesheetRunMutation.mutate(draft.id)} disabled={isUnsaved || timesheetRunMutation.isPending} className="rounded-lg border px-3 py-2 text-xs disabled:opacity-50">{timesheetRunMutation.isPending ? t('integrations.timesheetLoading') : t('integrations.timesheetRun')}</button>
            <button
              type="button"
              onClick={() => {
                if (isUnsaved) {
                  setDraft(null);
                  setManualInputs({});
                } else if (draft?.id) {
                  removeMutation.mutate(draft.id);
                }
              }}
              disabled={removeMutation.isPending || saveMutation.isPending}
              aria-busy={removeMutation.isPending ? true : undefined}
              className="rounded-lg border border-[var(--t-crit)] px-3 py-2 text-xs text-[var(--t-crit)] disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
            >
              {removeMutation.isPending ? (
                <Loader2 className="inline h-3 w-3 animate-spin" />
              ) : (
                <Trash2 className="inline h-3 w-3" />
              )}
              {removeMutation.isPending ? t('integrations.deleting') : t('common.delete')}
            </button>
          </div>

          {timesheetPreview && (
            <div className="sm:col-span-2 overflow-x-auto rounded-lg border border-[var(--t-border)] p-3 text-xs" data-testid="timesheet-preview">
              <p className="mb-2">{timesheetPreview.date || ''} · {timesheetPreview.hours ?? 0}h</p>
              <table className="w-full text-left"><thead><tr><th>Ticket</th><th>Subject</th><th>run</th><th>wait</th><th>chat</th><th>level</th><th>weight</th><th>{t('integrations.timesheetEstimateCol')}</th><th>{t('integrations.timesheetActualCol')}</th></tr></thead>
                <tbody>{(timesheetPreview.entries || []).map((entry) => <tr key={entry.displayId}><td>[{entry.displayId || '?'}]</td><td>{entry.subject || ''}</td><td>{entry.run ?? 0}</td><td>{entry.wait ?? 0}</td><td>{entry.chat ?? 0}</td><td>{entry.level ?? 0}</td><td>{entry.weight ?? 0}</td><td>{entry.estimateHours ?? entry.rawHours ?? 0}h</td><td>{entry.hours ?? 0}h</td></tr>)}</tbody>
              </table>
              {timesheetPreview.withoutTicket && timesheetPreview.withoutTicket.length > 0 && <p className="mt-2">{timesheetPreview.withoutTicket.map((item) => `${item.taskId || '?'} ${item.subject || ''}`).join(', ')}</p>}
              {timesheetPreview.estimateSkipped && timesheetPreview.estimateSkipped.length > 0 && <p className="mt-2 text-[var(--t-warn)]">{timesheetPreview.estimateSkipped.map((item) => `[${item.displayId || '?'}] ${item.reason || ''}`).join(', ')}</p>}
              {timesheetPreview.overMinimum && <p className="mt-2 text-[var(--t-crit)]">{t('integrations.timesheetOverMinimum')}</p>}
            </div>
          )}

          {message && (
            <p
              role="status"
              data-testid="openproject-status-message"
              className={`sm:col-span-2 text-xs flex items-center gap-1.5 ${
                message.type === 'ok' ? 'text-[var(--t-ok)]' : 'text-[var(--t-crit)]'
              }`}
            >
              {message.type === 'ok' ? (
                <CheckCircle2 className="inline h-3 w-3 shrink-0" />
              ) : (
                <AlertCircle className="inline h-3 w-3 shrink-0" />
              )}
              <span>{message.text}</span>
            </p>
          )}
        </div>
      )}
    </section>
  );
};
