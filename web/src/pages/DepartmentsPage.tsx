import React, { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Plus, Trash2 } from 'lucide-react';
import { Card, Button, Input } from '../components/ui';
import { createDepartment, deleteDepartment, getDepartments, getModelOptions, getProfiles, updateDepartment, updateDepartmentProfiles } from '../api/client';
import { Department, Profile } from '../types/api';
import { useLocale } from '../context/LocaleContext';
import { DEFAULT_CLAUDE_MODELS, DEFAULT_CODEX_MODELS } from '../utils/models';

export const DepartmentsPage: React.FC = () => {
  const { t } = useLocale();
  const client = useQueryClient();
  const { data = [], isLoading: isLoadingDepartments } = useQuery({ queryKey: ['departments'], queryFn: getDepartments });
  const { data: profiles = [], isLoading: isLoadingProfiles } = useQuery({ queryKey: ['profiles'], queryFn: getProfiles });
  const { data: modelOptions } = useQuery({ queryKey: ['model-options'], queryFn: getModelOptions });
  const isLoading = isLoadingDepartments || isLoadingProfiles;
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [brainEngines, setBrainEngines] = useState<Record<string, 'claude' | 'codex'>>({});
  const refresh = () => client.invalidateQueries({ queryKey: ['departments'] });
  const create = useMutation({ mutationFn: createDepartment, onSuccess: () => { setName(''); refresh(); } });
  const update = useMutation({ mutationFn: ({ id, data }: { id: string; data: object }) => updateDepartment(id, data), onSuccess: refresh });
  const updateProfiles = useMutation({ mutationFn: ({ id, profiles }: { id: string; profiles: { profileName: string; share: null }[] }) => updateDepartmentProfiles(id, profiles), onSuccess: refresh });
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
        <div className="space-y-2 text-sm text-[var(--t-text-2)]">
          <div>{t('departments.projects')}: {department.projects.map((project) => project.name).join(', ') || '—'}</div>
          <div>
            <div>{t('departments.profiles')}: {department.profiles.map((profile) => profile.profileName).join(', ') || '—'}</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1 mt-1">
              {profiles.map((profile) => {
                const checked = department.profiles.some((item) => item.profileName === profile.name);
                return <label key={profile.name} className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={checked} onChange={(event) => {
                    const selected = new Set(department.profiles.map((item) => item.profileName));
                    if (event.target.checked) selected.add(profile.name); else selected.delete(profile.name);
                    updateProfiles.mutate({ id: department.id, profiles: [...selected].map((profileName) => ({ profileName, share: null })) });
                  }} />
                  {profile.name}
                </label>;
              })}
            </div>
          </div>
        </div>
        <details className="border-t border-[var(--t-border)] pt-3">
          <summary className="cursor-pointer text-sm font-semibold">{t('departments.brainSettings')}</summary>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-3 text-xs">
            <label>{t('departments.brainEngine')}<select value={brainEngines[department.id] ?? department.brainEngine ?? 'claude'} onChange={(e) => { const brainEngine = e.target.value as 'claude' | 'codex'; setBrainEngines((current) => ({ ...current, [department.id]: brainEngine })); update.mutate({ id: department.id, data: { brainEngine } }); }} className="w-full rounded border p-2 bg-[var(--t-surface-2)]"><option value="claude">Claude</option><option value="codex">Codex</option></select></label>
            <label>{t('departments.brainModel')}<select value={department.brainModel ?? ''} onChange={(e) => update.mutate({ id: department.id, data: { brainModel: e.target.value } })} className="w-full rounded border p-2 bg-[var(--t-surface-2)]"><option value="" disabled>{t('departments.chooseModel')}</option>{Array.from(new Set([...modelOptionsByEngine[brainEngines[department.id] ?? department.brainEngine ?? 'claude'], ...(department.brainModel ? [department.brainModel] : [])])).map((model) => <option key={model} value={model}>{model}</option>)}</select></label>
            {(brainEngines[department.id] ?? department.brainEngine) === 'codex' && <label><span className="font-semibold">{t('departments.brainCodexProfile')}</span><span className="block text-[var(--t-text-3)]">{t('departments.brainCodexProfileHint')}</span><select value={department.brainCodexProfile ?? ''} onChange={(e) => update.mutate({ id: department.id, data: { brainCodexProfile: e.target.value || null } })} className="w-full rounded border p-2 bg-[var(--t-surface-2)]" aria-label={t('departments.brainCodexProfile')}><option value="">{t('departments.brainCodexProfileAuto')}</option>{profiles.filter((profile) => profile.engine === 'codex' && isProfileEnabled(profile)).map((profile) => <option key={profile.name} value={profile.name}>{profile.name}</option>)}{department.brainCodexProfile && !profiles.some((profile) => profile.name === department.brainCodexProfile) && <option value={department.brainCodexProfile}>{department.brainCodexProfile} ({t('departments.inactiveProfile')})</option>}</select></label>}
            <label>{t('departments.brainMode')}<select defaultValue={department.brainMode ?? 'inherit'} onChange={(e) => update.mutate({ id: department.id, data: { brainMode: e.target.value as 'inherit' | 'off' | 'suggest' | 'auto' } })} className="w-full rounded border p-2 bg-[var(--t-surface-2)]"><option value="inherit">{t('departments.inherit')}</option><option value="off">{t('departments.off')}</option><option value="suggest">{t('departments.suggest')}</option><option value="auto">{t('departments.auto')}</option></select></label>
            <label>{t('departments.brainPermissions')}<select defaultValue={department.brainPermissions ?? 'inherit'} onChange={(e) => update.mutate({ id: department.id, data: { brainPermissions: e.target.value as 'inherit' | 'standard' | 'trusted' | 'full' } })} className="w-full rounded border p-2 bg-[var(--t-surface-2)]"><option value="inherit">{t('departments.inherit')}</option><option value="standard">Standard</option><option value="trusted">Trusted</option><option value="full">Full</option></select></label>
          </div>
        </details>
      </Card>)}
    </div>}
  </div>;
};

export default DepartmentsPage;
