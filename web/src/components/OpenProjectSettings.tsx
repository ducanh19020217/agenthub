import React, { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, CheckCircle2, RotateCw } from 'lucide-react';
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
} from '../api/client';
import type { OpenProjectSourceInput, OpenProjectStatusDto } from '../types/api';

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
  dailyReport: { time: '18:00', weekdaysOnly: true, maxItems: 10, telegram: false },
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

export const OpenProjectSettings: React.FC = () => {
  const { t } = useLocale();
  const qc = useQueryClient();
  const { data: sources = [], isLoading } = useQuery({
    queryKey: ['openproject-sources'],
    queryFn: getOpenProjectSources,
  });

  const [draft, setDraft] = useState<OpenProjectSourceInput | null>(null);
  const [key, setKey] = useState('');
  const [message, setMessage] = useState('');
  const [manualInputs, setManualInputs] = useState<Partial<Record<'watchStatusIds' | 'reopenedStatusIds' | 'openStatusIds', string>>>({});

  useEffect(() => {
    if (!draft && sources[0]) {
      setDraft({ ...sources[0] });
      setManualInputs({});
    }
  }, [sources, draft]);

  const currentSource = sources.find((s) => s.id === draft?.id);
  const canFetchStatuses = Boolean(draft?.id && draft.url.trim() && currentSource?.keyConfigured);

  const {
    data: statuses,
    isLoading: isStatusesLoading,
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

  const save = useMutation({
    mutationFn: async () => {
      if (!draft) throw new Error('missing');
      let toSave: OpenProjectSourceInput = { ...draft };
      for (const field of ['watchStatusIds', 'reopenedStatusIds', 'openStatusIds'] as const) {
        if (manualInputs[field] !== undefined) {
          toSave = { ...toSave, [field]: parseIdList(manualInputs[field]!) };
        }
      }
      const saved = await saveOpenProjectSource(toSave.id, toSave);
      if (key.trim()) await saveOpenProjectKey(toSave.id, key.trim());
      return saved;
    },
    onSuccess: () => {
      setKey('');
      setManualInputs({});
      setMessage(t('integrations.saved'));
      qc.invalidateQueries({ queryKey: ['openproject-sources'] });
      if (draft?.id) {
        qc.invalidateQueries({ queryKey: ['openproject-statuses', draft.id] });
      }
    },
  });

  const remove = useMutation({
    mutationFn: deleteOpenProjectSource,
    onSuccess: () => {
      setDraft(null);
      setManualInputs({});
      qc.invalidateQueries({ queryKey: ['openproject-sources'] });
    },
  });

  const handleTestConnection = async () => {
    if (!draft) return;
    try {
      const res = await testOpenProjectConnection(draft.id);
      const name = res?.name;
      setMessage(name ? t('integrations.testOkWithName', { name }) : t('integrations.testOk'));
    } catch (e) {
      setMessage((e as Error).message);
    }
  };

  const handleSyncNow = async () => {
    if (!draft) return;
    try {
      const res = (await syncOpenProject(draft.id)) as { imported?: number } | undefined;
      const count = res?.imported ?? 0;
      setMessage(t('integrations.syncSuccess', { count }));
    } catch (e) {
      setMessage((e as Error).message);
    }
  };

  const handleDailyReport = async () => {
    if (!draft) return;
    try {
      await createOpenProjectDailyReport(draft.id);
      setMessage(t('integrations.dailyReportSuccess'));
    } catch (e) {
      setMessage((e as Error).message);
    }
  };

  const set = (patch: Partial<OpenProjectSourceInput>) =>
    setDraft((d) => (d ? { ...d, ...patch } : d));

  const selectSource = (source: OpenProjectSourceInput) => {
    setDraft({ ...source });
    setManualInputs({});
    setKey('');
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
                {!hasValidStatuses && !isStatusesLoading && (
                  <p className="text-xs text-[var(--t-text-3)]" data-testid="status-picker-hint">
                    {t('integrations.saveUrlAndKeyFirst')}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => refetchStatuses()}
                  disabled={isStatusesLoading}
                  className="rounded-lg border border-[var(--t-border)] px-2.5 py-1.5 text-xs hover:bg-[var(--t-surface-2)]"
                  data-testid="reload-statuses-button"
                >
                  <RotateCw className={`inline h-3 w-3 mr-1 ${isStatusesLoading ? 'animate-spin' : ''}`} />
                  {isStatusesLoading ? t('integrations.loadingStatuses') : t('integrations.reloadStatuses')}
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
              onClick={() => save.mutate()}
              className="rounded-lg bg-[var(--t-accent)] px-3 py-2 text-xs text-[var(--t-on-accent)]"
            >
              {t('common.save')}
            </button>
            <button
              type="button"
              onClick={handleTestConnection}
              className="rounded-lg border px-3 py-2 text-xs"
            >
              {t('integrations.testConnection')}
            </button>
            <button
              type="button"
              onClick={handleSyncNow}
              className="rounded-lg border px-3 py-2 text-xs"
            >
              {t('integrations.syncNow')}
            </button>
            <button
              type="button"
              onClick={handleDailyReport}
              className="rounded-lg border px-3 py-2 text-xs"
            >
              {t('integrations.dailyReport')}
            </button>
            <button
              type="button"
              onClick={() => remove.mutate(draft.id)}
              className="rounded-lg border border-[var(--t-crit)] px-3 py-2 text-xs text-[var(--t-crit)]"
            >
              <Trash2 className="inline h-3 w-3" /> {t('common.delete')}
            </button>
          </div>

          {message && (
            <p role="status" className="sm:col-span-2 text-xs text-[var(--t-text-2)]">
              <CheckCircle2 className="inline h-3 w-3" /> {message}
            </p>
          )}
        </div>
      )}
    </section>
  );
};
