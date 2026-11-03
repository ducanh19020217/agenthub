import React, { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Plus, Trash2 } from 'lucide-react';
import { Card, Button, Input } from '../components/ui';
import {
  createDepartment,
  deleteDepartment,
  getDepartments,
  getModelOptions,
  getProfiles,
  getProjects,
  updateDepartment,
  updateDepartmentProfiles,
  updateDepartmentProjects,
  updateProject,
} from '../api/client';
import { Department, Profile } from '../types/api';
import { useLocale } from '../context/LocaleContext';
import { DEFAULT_CLAUDE_MODELS, DEFAULT_CODEX_MODELS } from '../utils/models';

export const DepartmentsPage: React.FC = () => {
  const { t } = useLocale();
  const client = useQueryClient();
  const { data = [], isLoading: isLoadingDepartments } = useQuery({ queryKey: ['departments'], queryFn: getDepartments });
  const { data: profiles = [], isLoading: isLoadingProfiles } = useQuery({ queryKey: ['profiles'], queryFn: getProfiles });
  const { data: modelOptions } = useQuery({ queryKey: ['model-options'], queryFn: getModelOptions });
  const { data: allProjects = [] } = useQuery({ queryKey: ['projects'], queryFn: getProjects });

  const isLoading = isLoadingDepartments || isLoadingProfiles;
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [brainEngines, setBrainEngines] = useState<Record<string, 'inherit' | 'claude' | 'codex'>>({});
  const [projectToAssign, setProjectToAssign] = useState<Record<string, string>>({});

  const refresh = () => {
    client.invalidateQueries({ queryKey: ['departments'] });
    client.invalidateQueries({ queryKey: ['projects'] });
  };

  const create = useMutation({ mutationFn: createDepartment, onSuccess: () => { setName(''); refresh(); } });
  const update = useMutation({ mutationFn: ({ id, data }: { id: string; data: object }) => updateDepartment(id, data), onSuccess: refresh });
  const updateProfiles = useMutation({
    mutationFn: ({ id, profiles }: { id: string; profiles: { profileName: string; share: number | null }[] }) =>
      updateDepartmentProfiles(id, profiles),
    onSuccess: refresh,
  });
  const assignProjectMutation = useMutation({
    mutationFn: ({ departmentId, projectId }: { departmentId: string; projectId: string }) =>
      updateDepartmentProjects(departmentId, { projectId }),
    onSuccess: refresh,
  });
  const transferProjectMutation = useMutation({
    mutationFn: ({ projectId, targetDepartmentId }: { projectId: string; targetDepartmentId: string }) =>
      updateProject(projectId, { departmentId: targetDepartmentId }),
    onSuccess: refresh,
  });
  const remove = useMutation({ mutationFn: deleteDepartment, onSuccess: refresh });

  const isProfileEnabled = (p: Profile): boolean => p.enabled !== false && p.enabled !== 0 && (p as any).enabled !== null;
  const assignedProfileNames = new Set(data.flatMap((dept) => dept.profiles.map((p) => p.profileName)));
  const hasGlobalProfiles = profiles.some((p) => isProfileEnabled(p) && !assignedProfileNames.has(p.name));
  const hasUsableProfile = (department: Department): boolean => {
    if (isLoadingProfiles) return true;
    if (hasGlobalProfiles) return true;
    return department.profiles.some((dp) => {
      const p = profiles.find((item) => item.name === dp.profileName);
      return Boolean(p && isProfileEnabled(p));
    });
  };
  const modelOptionsByEngine = useMemo(() => {
    const configured = [...(modelOptions?.suggestions || []), ...(modelOptions?.configured || [])];
    const claude = configured.filter((model) => DEFAULT_CLAUDE_MODELS.includes(model) || model.startsWith('claude-'));
    const codex = configured
      .map((model) => model.startsWith('codex:') ? model.slice('codex:'.length) : model)
      .filter((model) => DEFAULT_CODEX_MODELS.includes(model) || model.startsWith('gpt-'));
    return {
      claude: Array.from(new Set([...DEFAULT_CLAUDE_MODELS, ...claude])),
      codex: Array.from(new Set([...DEFAULT_CODEX_MODELS, ...codex])),
    };
  }, [modelOptions]);

  return <div className="p-6 max-w-6xl mx-auto space-y-6">
    <div><h2 className="text-xl font-semibold flex items-center gap-2"><Building2 size={22} />{t('departments.title')}</h2><p className="text-sm text-[var(--t-text-2)] mt-1">{t('departments.subtitle')}</p></div>
    <Card className="p-4 flex flex-col sm:flex-row gap-2">
      <Input className="flex-1 min-w-0" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('departments.name')} aria-label={t('departments.name')} />
      <Button className="shrink-0 whitespace-nowrap" disabled={!name.trim() || create.isPending} onClick={() => create.mutate({ name: name.trim() })}><Plus size={16} />{t('departments.create')}</Button>
    </Card>
    {isLoading ? <p>{t('common.loading')}</p> : data.length === 0 ? <p>{t('departments.empty')}</p> : <div className="grid gap-4 md:grid-cols-2">
      {data.map((department) => <Card key={department.id} className="p-4 space-y-3">
        {department.projects.length > 0 && !hasUsableProfile(department) && <div role="alert" className="rounded border border-[var(--t-crit)] bg-[var(--t-crit)]/10 px-3 py-2 text-sm text-[var(--t-crit)]">{t('departments.noUsableProfiles')}</div>}
        {editing === department.id ? <Input autoFocus defaultValue={department.name} onBlur={(e) => { update.mutate({ id: department.id, data: { name: e.target.value } }); setEditing(null); }} aria-label={t('departments.name')} /> : <div className="flex items-center justify-between"><h3 className="font-semibold cursor-pointer" onClick={() => setEditing(department.id)}>{department.name}</h3>{department.id !== 'chung' && <Button variant="ghost" onClick={() => { if (window.confirm(t('departments.confirmDelete'))) remove.mutate(department.id); }} aria-label={t('departments.delete')}><Trash2 size={16} /></Button>}</div>}
        <div className="grid grid-cols-3 gap-2 text-sm"><label>{t('departments.priority')}<Input type="number" defaultValue={department.priority} onBlur={(e) => update.mutate({ id: department.id, data: { priority: Number(e.target.value) } })} /></label><label>{t('departments.maxParallel')}<Input type="number" min="0" defaultValue={department.maxParallel} onBlur={(e) => update.mutate({ id: department.id, data: { maxParallel: Number(e.target.value) } })} /><span className="text-xs text-[var(--t-text-3)]">{t('departments.maxParallelHint')}</span></label><label>{t('departments.budget')}<Input type="number" min="0" defaultValue={department.claudeDailyTokenBudget} onBlur={(e) => update.mutate({ id: department.id, data: { claudeDailyTokenBudget: Number(e.target.value) } })} /></label></div>

        {/* Profiles Allocation with Share */}
        <div className="space-y-1.5 text-sm text-[var(--t-text-2)] border-t border-[var(--t-border)] pt-2.5">
          <div className="font-semibold text-xs text-[var(--t-text)]">{t('departments.profiles')}:</div>
          <div className="space-y-1.5">
            {profiles.map((profile) => {
              const assigned = department.profiles.find((item) => item.profileName === profile.name);
              const checked = Boolean(assigned);
              return <div key={profile.name} className="flex items-center justify-between text-xs p-1.5 rounded bg-[var(--t-surface-2)]">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    aria-label={profile.name}
                    checked={checked}
                    onChange={(event) => {
                      let nextProfiles: Array<{ profileName: string; share: number | null }> = [];
                      if (event.target.checked) {
                        nextProfiles = [...department.profiles.map((p) => ({ profileName: p.profileName, share: p.share })), { profileName: profile.name, share: null }];
                      } else {
                        nextProfiles = department.profiles.filter((p) => p.profileName !== profile.name).map((p) => ({ profileName: p.profileName, share: p.share }));
                      }
                      updateProfiles.mutate({ id: department.id, profiles: nextProfiles });
                    }}
                  />
                  <span>{profile.name}</span>
                </label>
                {checked && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-[var(--t-text-3)]">{t('departments.profileShare')}:</span>
                    <input
                      type="number"
                      min="0"
                      max="1"
                      step="0.05"
                      placeholder="1.0"
                      aria-label={`${profile.name} share`}
                      defaultValue={assigned?.share ?? ''}
                      onBlur={(e) => {
                        const rawVal = e.target.value.trim();
                        const num = rawVal === '' ? null : Number(rawVal);
                        const nextProfiles = department.profiles.map((p) =>
                          p.profileName === profile.name ? { profileName: p.profileName, share: num } : { profileName: p.profileName, share: p.share }
                        );
                        updateProfiles.mutate({ id: department.id, profiles: nextProfiles });
                      }}
                      className="w-16 text-xs p-1 rounded border border-[var(--t-border)] bg-[var(--t-surface)] text-right font-mono"
                    />
                  </div>
                )}
              </div>;
            })}
          </div>
        </div>

        {/* Projects in department + assign/transfer */}
        <div className="space-y-2 text-xs border-t border-[var(--t-border)] pt-2.5">
          <div className="font-semibold text-xs text-[var(--t-text)]">{t('departments.departmentProjectsTitle')}</div>
          {department.projects.length === 0 ? (
            <p className="text-[11px] text-[var(--t-text-3)] italic">{t('departments.noProjectsInDept')}</p>
          ) : (
            <div className="space-y-1">
              {department.projects.map((proj) => (
                <div key={proj.id} className="flex items-center justify-between p-1.5 rounded bg-[var(--t-surface-2)]">
                  <span className="font-medium text-[var(--t-text)]">{proj.name}</span>
                  <div className="flex items-center gap-1">
                    <select
                      aria-label={`Transfer ${proj.name}`}
                      defaultValue=""
                      onChange={(e) => {
                        if (e.target.value) {
                          transferProjectMutation.mutate({ projectId: proj.id, targetDepartmentId: e.target.value });
                        }
                      }}
                      className="text-[11px] p-1 rounded border border-[var(--t-border)] bg-[var(--t-surface)] text-[var(--t-text)]"
                    >
                      <option value="" disabled>{t('departments.transferProjectBtn')}</option>
                      {data.filter((d) => d.id !== department.id).map((d) => (
                        <option key={d.id} value={d.id}>{d.name}</option>
                      ))}
                    </select>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Assign project to department */}
          {(() => {
            const unassignedOrOther = allProjects.filter((p) => (p.departmentId || 'chung') !== department.id);
            return (
              <div className="flex items-center gap-1.5 pt-1">
                <select
                  aria-label={t('departments.selectProjectToAssign')}
                  value={projectToAssign[department.id] || ''}
                  onChange={(e) => setProjectToAssign((prev) => ({ ...prev, [department.id]: e.target.value }))}
                  className="flex-1 text-[11px] p-1.5 rounded border border-[var(--t-border)] bg-[var(--t-surface-2)] text-[var(--t-text)]"
                >
                  <option value="">-- {t('departments.selectProjectToAssign')} --</option>
                  {unassignedOrOther.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={!projectToAssign[department.id] || assignProjectMutation.isPending}
                  onClick={() => {
                    const pId = projectToAssign[department.id];
                    if (pId) {
                      assignProjectMutation.mutate({ departmentId: department.id, projectId: pId });
                      setProjectToAssign((prev) => ({ ...prev, [department.id]: '' }));
                    }
                  }}
                  className="text-[11px] h-7 whitespace-nowrap"
                >
                  {t('departments.assignProjectBtn')}
                </Button>
              </div>
            );
          })()}
        </div>

        {/* Brain Settings with Inherit option */}
        <details className="border-t border-[var(--t-border)] pt-3">
          <summary className="cursor-pointer text-sm font-semibold">{t('departments.brainSettings')}</summary>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-3 text-xs">
            <label>{t('departments.brainEngine')}<select aria-label={t('departments.brainEngine')} value={brainEngines[department.id] ?? department.brainEngine ?? 'inherit'} onChange={(e) => { const brainEngine = e.target.value as 'inherit' | 'claude' | 'codex'; setBrainEngines((current) => ({ ...current, [department.id]: brainEngine })); update.mutate({ id: department.id, data: { brainEngine } }); }} className="w-full rounded border p-2 bg-[var(--t-surface-2)]"><option value="inherit">{t('departments.inherit')}</option><option value="claude">Claude</option><option value="codex">Codex</option></select></label>
            <label>{t('departments.brainModel')}<select aria-label={t('departments.brainModel')} value={department.brainModel ?? 'inherit'} onChange={(e) => update.mutate({ id: department.id, data: { brainModel: e.target.value } })} className="w-full rounded border p-2 bg-[var(--t-surface-2)]"><option value="inherit">{t('departments.inherit')}</option><option value="" disabled>{t('departments.chooseModel')}</option>{Array.from(new Set([...(modelOptionsByEngine[(brainEngines[department.id] ?? department.brainEngine) === 'codex' ? 'codex' : 'claude'] || []), ...(department.brainModel && department.brainModel !== 'inherit' ? [department.brainModel] : [])])).map((model) => <option key={model} value={model}>{model}</option>)}</select></label>
            {(brainEngines[department.id] ?? department.brainEngine) === 'codex' && <label><span className="font-semibold">{t('departments.brainCodexProfile')}</span><span className="block text-[var(--t-text-3)]">{t('departments.brainCodexProfileHint')}</span><select value={department.brainCodexProfile ?? ''} onChange={(e) => update.mutate({ id: department.id, data: { brainCodexProfile: e.target.value || null } })} className="w-full rounded border p-2 bg-[var(--t-surface-2)]" aria-label={t('departments.brainCodexProfile')}><option value="">{t('departments.brainCodexProfileAuto')}</option>{profiles.filter((profile) => profile.engine === 'codex' && isProfileEnabled(profile)).map((profile) => <option key={profile.name} value={profile.name}>{profile.name}</option>)}{department.brainCodexProfile && !profiles.some((profile) => profile.name === department.brainCodexProfile) && <option value={department.brainCodexProfile}>{department.brainCodexProfile} ({t('departments.inactiveProfile')})</option>}</select></label>}
            <label>{t('departments.brainMode')}<select aria-label={t('departments.brainMode')} defaultValue={department.brainMode ?? 'inherit'} onChange={(e) => update.mutate({ id: department.id, data: { brainMode: e.target.value as 'inherit' | 'off' | 'suggest' | 'auto' } })} className="w-full rounded border p-2 bg-[var(--t-surface-2)]"><option value="inherit">{t('departments.inherit')}</option><option value="off">{t('departments.off')}</option><option value="suggest">{t('departments.suggest')}</option><option value="auto">{t('departments.auto')}</option></select></label>
            <label>{t('departments.brainPermissions')}<select aria-label={t('departments.brainPermissions')} defaultValue={department.brainPermissions ?? 'inherit'} onChange={(e) => update.mutate({ id: department.id, data: { brainPermissions: e.target.value as 'inherit' | 'standard' | 'trusted' | 'full' } })} className="w-full rounded border p-2 bg-[var(--t-surface-2)]"><option value="inherit">{t('departments.inherit')}</option><option value="standard">Standard</option><option value="trusted">Trusted</option><option value="full">Full</option></select></label>
            <label>{t('departments.brainDailyTokenBudget')}<Input type="number" min="0" defaultValue={department.brainDailyTokenBudget ?? 0} onBlur={(e) => update.mutate({ id: department.id, data: { brainDailyTokenBudget: Number(e.target.value) || 0 } })} aria-label={t('departments.brainDailyTokenBudget')} /></label>
            <label>{t('departments.brainMaxTurnsPerHour')}<Input type="number" min="0" defaultValue={department.brainMaxTurnsPerHour ?? 0} onBlur={(e) => update.mutate({ id: department.id, data: { brainMaxTurnsPerHour: Number(e.target.value) || 0 } })} aria-label={t('departments.brainMaxTurnsPerHour')} /></label>
          </div>
        </details>
      </Card>)}
    </div>}
  </div>;
};

export default DepartmentsPage;

