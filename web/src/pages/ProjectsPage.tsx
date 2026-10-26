import React, { useEffect, useState } from 'react';
import { Link, useSearchParams, useParams, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  addProjectKnowledge,
  createProject,
  deleteProject,
  restoreProject,
  deleteProjectKnowledge,
  getProjectKnowledgePage,
  getCiRunsPage,
  getArchivedProjects,
  getProjects,
  getDepartments,
  getFocus,
  setFocus,
  getTasks,
  updateProjectKnowledge,
  getProfiles,
} from '../api/client';
import {
  FolderGit2,
  Plus,
  Trash2,
  CheckCircle2,
  AlertCircle,
  BookOpen,
  Pin,
  ChevronDown,
  Settings2,
  Clock,
  ExternalLink,
  GitBranch,
} from 'lucide-react';
import { Card, Button, Input, DataTable, SelectOrCustomInput } from '../components/ui';
import { DEFAULT_COMMON_BRANCHES, validateBranchSyntax } from '../utils/models';
import { useLocale } from '../context/LocaleContext';
import { UI_Z_INDEX } from '../components/ui/layers';
import { useTour } from '../components/tour/TourContext';
import { Project } from '../types/api';
import {
  ProjectSettingsDrawer,
  defaultProjectSettings,
} from '../components/ProjectSettingsDrawer';
import { ProjectWizard } from '../components/ProjectWizard';

function parsePositiveInt(val: string): number | undefined {
  const trimmed = val.trim();
  if (!trimmed) return undefined;
  if (!/^\d+$/.test(trimmed)) return undefined;
  const num = parseInt(trimmed, 10);
  return num > 0 && Number.isSafeInteger(num) ? num : undefined;
}

function ProjectSettingsForm({
  value,
  onChange,
  compact = false,
}: {
  value: NonNullable<Project['settings']>;
  onChange: (value: NonNullable<Project['settings']>) => void;
  compact?: boolean;
}) {
  const { t } = useLocale();
  const { suggestModalTour } = useTour();
  const [confirmFullPermission, setConfirmFullPermission] = useState(false);
  const { data: profiles = [] } = useQuery({ queryKey: ['profiles'], queryFn: getProfiles });
  const codexProfileOptions = profiles.filter((p) => p.engine === 'codex').map((p) => p.name);

  const update = (section: keyof NonNullable<Project['settings']>, patch: object) =>
    onChange({ ...value, [section]: { ...value[section], ...patch } });
  const addReference = () =>
    onChange({
      ...value,
      references: [...value.references, { name: '', path: '', inject: false }],
    });

  return (
    <div className="space-y-4" data-testid="project-settings-form" data-tour="project-register">
      <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
        <label className="text-xs space-y-1">
          <span className="font-semibold">{t('projects.brainEngine')}</span>
          <select
            value={value.brain.engine ?? 'inherit'}
            onChange={(e) => update('brain', { engine: e.target.value })}
            className="w-full rounded border p-2 bg-[var(--t-surface-2)]"
          >
            <option value="inherit">{t('projects.brainEngineInherit')}</option>
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
          </select>
        </label>

        <label className="text-xs space-y-1 block">
          <span className="font-semibold block">{t('projects.codexProfile')}</span>
          <SelectOrCustomInput
            value={value.brain.codexProfile ?? ''}
            onChange={(val) => update('brain', { codexProfile: val.trim() || undefined })}
            options={codexProfileOptions}
            allowEmpty={true}
            emptyLabel={t('projects.codexProfileAuto')}
            placeholder={t('projects.codexProfileAuto')}
            ariaLabel={t('projects.codexProfile')}
          />
        </label>

        <label className="text-xs space-y-1">
          <span className="font-semibold">{t('projects.brainMode')}</span>
          <select
            value={value.brain.mode}
            onChange={(e) => update('brain', { mode: e.target.value })}
            className="w-full rounded border p-2 bg-[var(--t-surface-2)]"
          >
            <option value="inherit">{t('projects.brainInherit')}</option>
            <option value="off">{t('projects.brainOff')}</option>
            <option value="suggest">{t('projects.brainSuggest')}</option>
            <option value="auto">{t('projects.brainAuto')}</option>
            <option value="external">{t('projects.brainExternal')}</option>
          </select>
          <span className="text-[var(--t-text-3)] block mt-0.5">
            {t(`projects.brainDesc${value.brain.mode}` as any)}
          </span>
        </label>

        <label className="text-xs space-y-1">
          <span className="font-semibold">{t('projects.brainPermissions')}</span>
          <select
            value={value.brain.permissions ?? 'inherit'}
            onChange={(e) => {
              const permissions = e.target.value;
              if (permissions === 'full') {
                setConfirmFullPermission(true);
                suggestModalTour('modal-full-permission');
                return;
              }
              update('brain', { permissions });
            }}
            className="w-full rounded border p-2 bg-[var(--t-surface-2)]"
          >
            <option value="inherit">{t('projects.brainPermissionInherit')}</option>
            <option value="standard">{t('projects.brainPermissionStandard')}</option>
            <option value="trusted">{t('projects.brainPermissionTrusted')}</option>
            <option value="full">{t('projects.brainPermissionFull')}</option>
          </select>
          <span
            className={`block mt-0.5 ${
              value.brain.permissions === 'full'
                ? 'text-[var(--t-crit)]'
                : 'text-[var(--t-text-3)]'
            }`}
          >
            {t(`projects.brainPermissionDesc${value.brain.permissions ?? 'inherit'}` as any)}
          </span>
        </label>

        <label className="text-xs space-y-1">
          <span className="font-semibold">{t('projects.dailyTokenBudget')}</span>
          <input
            type="text"
            inputMode="numeric"
            aria-label={t('projects.dailyTokenBudget')}
            value={value.brain.dailyTokenBudget ?? ''}
            onChange={(e) =>
              update('brain', {
                dailyTokenBudget: parsePositiveInt(e.target.value),
              })
            }
            className="w-full rounded border p-2 bg-[var(--t-surface-2)]"
          />
        </label>

        <label className="text-xs space-y-1">
          <span className="font-semibold">{t('projects.maxTurnsPerHour')}</span>
          <input
            type="text"
            inputMode="numeric"
            aria-label={t('projects.maxTurnsPerHour')}
            value={value.brain.maxTurnsPerHour ?? ''}
            onChange={(e) =>
              update('brain', {
                maxTurnsPerHour: parsePositiveInt(e.target.value),
              })
            }
            className="w-full rounded border p-2 bg-[var(--t-surface-2)]"
          />
        </label>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
        <label className="space-y-1">
          <span className="font-semibold block">{t('projects.worktreeInstall')}</span>
          <select
            value={value.worktree.install}
            onChange={(e) => update('worktree', { install: e.target.value })}
            className="w-full rounded border p-2 bg-[var(--t-surface-2)]"
          >
            <option value="auto">{t('projects.worktreeAuto')}</option>
            <option value="skip">{t('projects.worktreeSkip')}</option>
            <option value="worker">{t('projects.worktreeWorker')}</option>
          </select>
        </label>

        <label className="space-y-1">
          <span className="font-semibold block">{t('projects.gitHooks')}</span>
          <select
            value={value.worktree.gitHooks}
            onChange={(e) => update('worktree', { gitHooks: e.target.value })}
            className="w-full rounded border p-2 bg-[var(--t-surface-2)]"
          >
            <option value="run">{t('projects.gitHooksRun')}</option>
            <option value="skip">{t('projects.gitHooksSkip')}</option>
          </select>
        </label>
      </div>

      <div className="space-y-2 text-xs">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={value.integration.enabled}
            onChange={(e) =>
              update('integration', { enabled: e.target.checked })
            }
          />
          <span className="font-semibold">{t('projects.integrationEnabled')}</span>
        </label>
        {value.integration.enabled && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <SelectOrCustomInput
              ariaLabel={t('projects.integrationBranch')}
              placeholder={t('projects.integrationBranch')}
              value={value.integration.branch ?? ''}
              onChange={(val) =>
                update('integration', { branch: val || undefined })
              }
              options={DEFAULT_COMMON_BRANCHES}
              validate={(val) => validateBranchSyntax(val, t)}
              allowEmpty={true}
              className="flex-1"
            />
            <SelectOrCustomInput
              ariaLabel={t('projects.integrationBaseRef')}
              placeholder={t('projects.integrationBaseRef')}
              value={value.integration.baseRef ?? ''}
              onChange={(val) =>
                update('integration', { baseRef: val || undefined })
              }
              options={DEFAULT_COMMON_BRANCHES}
              validate={(val) => validateBranchSyntax(val, t)}
              allowEmpty={true}
              className="flex-1"
            />
          </div>
        )}
      </div>

      <div className="space-y-2 text-xs">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={value.review?.autoMerge ?? false}
            onChange={(e) => update('review', { autoMerge: e.target.checked })}
          />
          <span className="font-semibold">{t('projects.reviewAutoMerge')}</span>
        </label>
      </div>

      <div className="space-y-2 text-xs">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={value.ci?.enabled ?? false}
            onChange={(e) => update('ci', { enabled: e.target.checked })}
          />
          <span className="font-semibold">{t('projects.ciEnabled')}</span>
        </label>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          <SelectOrCustomInput
            ariaLabel={t('projects.ciBranch')}
            placeholder={t('projects.ciBranch')}
            value={value.ci?.branch ?? ''}
            onChange={(val) =>
              update('ci', { branch: val || undefined })
            }
            options={DEFAULT_COMMON_BRANCHES}
            validate={(val) => validateBranchSyntax(val, t)}
            allowEmpty={true}
            className="flex-1"
          />
        </div>
      </div>

      <div className="space-y-2 text-xs">
        <div className="flex justify-between items-center">
          <span className="font-semibold">{t('projects.references')}</span>
          <button
            type="button"
            onClick={addReference}
            className="text-[var(--t-accent)]"
          >
            + {t('projects.addReference')}
          </button>
        </div>
        {value.references.map((ref, index) => (
          <div
            key={index}
            className="grid grid-cols-[1fr_2fr_auto_auto] gap-2 items-center"
          >
            <input
              aria-label={`${t('projects.referenceName')} ${index + 1}`}
              placeholder={t('projects.referenceName')}
              value={ref.name}
              onChange={(e) => {
                const refs = [...value.references];
                refs[index] = { ...ref, name: e.target.value };
                onChange({ ...value, references: refs });
              }}
              className="rounded border p-2 bg-[var(--t-surface-2)]"
            />
            <input
              aria-label={`${t('projects.referencePath')} ${index + 1}`}
              placeholder={t('projects.referencePath')}
              value={ref.path}
              onChange={(e) => {
                const refs = [...value.references];
                refs[index] = { ...ref, path: e.target.value };
                onChange({ ...value, references: refs });
              }}
              className="rounded border p-2 bg-[var(--t-surface-2)]"
            />
            <label className="flex gap-1 items-center">
              <input
                type="checkbox"
                checked={ref.inject}
                onChange={(e) => {
                  const refs = [...value.references];
                  refs[index] = { ...ref, inject: e.target.checked };
                  onChange({ ...value, references: refs });
                }}
              />
              {t('projects.inject')}
            </label>
            <button
              type="button"
              onClick={() =>
                onChange({
                  ...value,
                  references: value.references.filter((_, i) => i !== index),
                })
              }
              className="text-[var(--t-crit)]"
            >
              ×
            </button>
          </div>
        ))}
      </div>

      <label className="text-xs space-y-1 block">
        <span className="font-semibold">{t('projects.telegramContent')}</span>
        <select
          value={value.notifications.telegramContent}
          onChange={(e) =>
            update('notifications', { telegramContent: e.target.value })
          }
          className="w-full rounded border p-2 bg-[var(--t-surface-2)]"
        >
          <option value="full">{t('projects.telegramFull')}</option>
          <option value="minimal">{t('projects.telegramMinimal')}</option>
        </select>
      </label>

      {!compact && (
        <p className="text-[11px] text-[var(--t-text-3)]">
          {t('projects.settingsPartialHint')}
        </p>
      )}
      {confirmFullPermission && (
        <div className="fixed inset-0 flex items-center justify-center bg-[var(--t-overlay)] p-4" style={{ zIndex: UI_Z_INDEX.modal }} role="dialog" aria-modal="true" data-tour="modal-full-permission">
          <div className="w-full max-w-md rounded-xl border border-[var(--t-border)] bg-[var(--t-surface)] p-5 shadow-2xl">
            <h2 className="text-base font-semibold">{t('common.confirm')}</h2>
            <p className="mt-2 text-sm text-[var(--t-text-2)]">{t('extra.fullModeConfirm')}</p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="button-secondary" onClick={() => setConfirmFullPermission(false)}>{t('common.cancel')}</button>
              <button type="button" className="button-primary" onClick={() => { update('brain', { permissions: 'full' }); setConfirmFullPermission(false); }}>{t('common.confirm')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export const ProjectsPage: React.FC = () => {
  const { t } = useLocale();
  const { suggestModalTour } = useTour();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const { id: urlProjectId } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [showAddForm, setShowAddForm] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [showWizard, setShowWizard] = useState(false);
  const [drawerProject, setDrawerProject] = useState<Project | null>(null);

  useEffect(() => {
    if (searchParams.get('new') === '1') {
      setShowAddForm(true);
    }
  }, [searchParams]);

  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('main');
  const [maxParallel, setMaxParallel] = useState(3);
  const [departmentId, setDepartmentId] = useState('chung');
  const [envTemplate, setEnvTemplate] = useState('');
  const [checksJson, setChecksJson] = useState('');
  const [hooksText, setHooksText] = useState('');
  const [newSettings, setNewSettings] = useState(defaultProjectSettings());
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [knowledgeProject, setKnowledgeProject] = useState<string | null>(null);
  const [knowledgeDraft, setKnowledgeDraft] = useState('');
  const [knowledgePage, setKnowledgePage] = useState(1);
  const knowledgePageSize = 20;
  const [ciProject, setCiProject] = useState<string | null>(null);
  const [ciPage, setCiPage] = useState(1);
  const ciPageSize = 20;
  useEffect(() => {
    if (showAddForm) suggestModalTour('modal-register-project');
  }, [showAddForm, suggestModalTour]);

  const { data: projects = [], isLoading, error } = useQuery({
    queryKey: ['projects'],
    queryFn: getProjects,
  });
  const { data: departments = [] } = useQuery({
    queryKey: ['departments'],
    queryFn: getDepartments,
  });
  const { data: focus } = useQuery({ queryKey: ['focus'], queryFn: getFocus });
  const focusMutation = useMutation({
    mutationFn: (projectId: string | null) => setFocus(projectId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['focus'] });
      queryClient.invalidateQueries({ queryKey: ['status'] });
    },
  });
  const { data: projectTasks = [] } = useQuery({
    queryKey: ['tasks'],
    queryFn: () => getTasks(),
    refetchInterval: 10_000,
  });
  const { data: archivedProjects = [] } = useQuery({
    queryKey: ['projects', 'archived'],
    queryFn: getArchivedProjects,
    enabled: showArchived,
  });

  // Keep drawer project in sync with latest query data or URL param
  useEffect(() => {
    if (urlProjectId && projects.length > 0) {
      const match = projects.find((p) => p.id === urlProjectId);
      if (match) {
        setDrawerProject(match);
      }
    }
  }, [urlProjectId, projects]);

  useEffect(() => {
    if (drawerProject && projects.length > 0) {
      const match = projects.find((p) => p.id === drawerProject.id);
      if (match) {
        setDrawerProject(match);
      }
    }
  }, [projects]);

  const createMutation = useMutation({
    mutationFn: createProject,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      setShowAddForm(false);
      resetForm();
    },
    onError: (err: any) => {
      setFormError(err.message || t('projects.createError'));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: ({ id, purge, confirm }: { id: string; purge?: boolean; confirm?: string }) => deleteProject(id, { purge, confirm }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      if (result.warnings?.length) window.alert(result.warnings.join('\n'));
    },
  });
  const restoreMutation = useMutation({
    mutationFn: restoreProject,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  });

  const knowledgeQuery = useQuery({
    queryKey: ['project-knowledge', knowledgeProject, knowledgePage],
    queryFn: () => getProjectKnowledgePage(knowledgeProject!, { limit: knowledgePageSize, offset: (knowledgePage - 1) * knowledgePageSize }),
    enabled: knowledgeProject !== null,
  });
  const ciRunsQuery = useQuery({
    queryKey: ['ci-runs', ciProject, ciPage],
    queryFn: () => getCiRunsPage(ciProject!, { limit: ciPageSize, offset: (ciPage - 1) * ciPageSize }),
    enabled: ciProject !== null,
  });

  const addKnowledgeMutation = useMutation({
    mutationFn: () =>
      addProjectKnowledge(knowledgeProject!, { content: knowledgeDraft.trim() }),
    onSuccess: () => {
      setKnowledgeDraft('');
      queryClient.invalidateQueries({
        queryKey: ['project-knowledge', knowledgeProject],
      });
    },
  });

  const updateKnowledgeMutation = useMutation({
    mutationFn: ({
      id,
      content,
      pinned,
    }: {
      id: number;
      content?: string;
      pinned?: boolean;
    }) => updateProjectKnowledge(knowledgeProject!, id, { content, pinned }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['project-knowledge', knowledgeProject],
      });
    },
  });

  const deleteKnowledgeMutation = useMutation({
    mutationFn: (id: number) =>
      deleteProjectKnowledge(knowledgeProject!, id),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['project-knowledge', knowledgeProject],
      });
    },
  });

  const resetForm = () => {
    setName('');
    setPath('');
    setDefaultBranch('main');
    setMaxParallel(3);
    setDepartmentId('chung');
    setEnvTemplate('');
    setChecksJson('');
    setHooksText('');
    setNewSettings(defaultProjectSettings());
    setJsonError(null);
    setFormError(null);
  };

  const handleEnvTemplateChange = (val: string) => {
    setEnvTemplate(val);
    if (!val.trim()) {
      setJsonError(null);
      return;
    }
    try {
      JSON.parse(val);
      setJsonError(null);
    } catch (err: any) {
      setJsonError(t('projects.invalidJson', { error: err.message }));
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (!name.trim()) {
      setFormError(t('projects.nameRequired'));
      return;
    }
    if (!path.trim()) {
      setFormError(t('projects.pathRequired'));
      return;
    }

    if (envTemplate.trim()) {
      try {
        JSON.parse(envTemplate);
      } catch (err: any) {
        setJsonError(t('projects.invalidJson', { error: err.message }));
        return;
      }
    }
    let checks: unknown = null;
    if (checksJson.trim()) {
      try {
        checks = JSON.parse(checksJson);
        if (!Array.isArray(checks)) throw new Error('checks must be an array');
      } catch (err: any) {
        setFormError(t('projects.invalidChecks', { error: err.message }));
        return;
      }
    }

    const hookLines = hooksText
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    createMutation.mutate({
      name: name.trim(),
      path: path.trim(),
      defaultBranch: defaultBranch.trim() || 'main',
      maxParallel: Number(maxParallel) || 3,
      ...(departmentId !== 'chung' ? { departmentId } : {}),
      envTemplate: envTemplate.trim() ? envTemplate.trim() : null,
      checks: checks as any,
      ...(JSON.stringify(newSettings) !== JSON.stringify(defaultProjectSettings())
        ? { settings: newSettings }
        : {}),
      ...(hookLines.length > 0
        ? { hooks: { onWorktreeRemoved: hookLines } }
        : {}),
    });
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            {t('projects.title')}
          </h1>
          <p className="text-sm text-[var(--t-text-3)]">
            {t('projects.subtitle')}
          </p>
        </div>

        <Button
          type="button"
          onClick={() => {
            resetForm();
            setShowAddForm(!showAddForm);
          }}
          className="gap-1.5 self-start sm:self-auto"
        >
          <Plus className="w-4 h-4" />
          <span>
            {showAddForm
              ? t('projects.closeFormBtn')
              : t('projects.registerBtn')}
          </span>
        </Button>
        <Button type="button" variant="secondary" onClick={() => { resetForm(); setShowWizard(true); }} className="gap-1.5 self-start sm:self-auto">
          <span>{t('projects.wizardOpen')}</span>
        </Button>
      </div>

      {showWizard && <ProjectWizard onClose={() => setShowWizard(false)} />}

      <div>
        <Button type="button" variant="ghost" size="sm" onClick={() => setShowArchived((value) => !value)}>
          {t('projects.archivedTitle')}
        </Button>
      </div>

      {archivedProjects.length > 0 && (
        <Card className="p-4 space-y-2">
          <h2 className="font-semibold">{t('projects.archivedTitle')}</h2>
          {archivedProjects.map((project) => (
            <div key={project.id} className="flex items-center justify-between text-sm">
              <span>{project.name} <span className="font-mono text-xs">({project.id})</span></span>
              <Button size="sm" variant="secondary" onClick={() => restoreMutation.mutate(project.id)}>{t('projects.restore')}</Button>
            </div>
          ))}
        </Card>
      )}

      {/* Registration Form */}
      {showAddForm && (
        <Card data-tour="modal-register-project" className="p-6 space-y-4">
          <h2 className="text-base font-bold">{t('projects.formTitle')}</h2>

          {formError && (
            <div
              data-testid="form-error-msg"
              className={
                'p-3 rounded-lg bg-[color-mix(in_srgb,var(--t-crit)_15%,transparent)] ' +
                'text-[var(--t-crit)] text-xs'
              }
            >
              {formError}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-[var(--t-text)] mb-1">
                  {t('projects.nameLabel')}
                </label>
                <p className="text-xs text-[var(--t-text-3)] mb-1.5">
                  {t('projects.nameHint')}
                </p>
                <Input
                  type="text"
                  placeholder={t('projects.namePlaceholder')}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-[var(--t-text)] mb-1">
                  {t('departments.department')}
                </label>
                <select
                  value={departmentId}
                  onChange={(e) => setDepartmentId(e.target.value)}
                  className="w-full rounded-lg border border-[var(--t-border)] p-2.5 bg-[var(--t-surface-2)] text-sm"
                >
                  {departments.map((department) => (
                    <option key={department.id} value={department.id}>{department.name}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-[var(--t-text)] mb-1">
                  {t('projects.pathLabel')}
                </label>
                <p className="text-xs text-[var(--t-text-3)] mb-1.5">
                  {t('projects.pathHint')}
                </p>
                <Input
                  type="text"
                  placeholder={t('projects.pathPlaceholder')}
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                />
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-[var(--t-text)] mb-1">
                  {t('projects.branchLabel')}
                </label>
                <p className="text-xs text-[var(--t-text-3)] mb-1.5">
                  {t('projects.branchHint')}
                </p>
                <div data-tour="project-default-branch">
                  <SelectOrCustomInput
                    placeholder="main"
                    value={defaultBranch}
                    onChange={setDefaultBranch}
                    options={DEFAULT_COMMON_BRANCHES}
                    validate={(val) => validateBranchSyntax(val, t)}
                    ariaLabel={t('projects.branchLabel')}
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-[var(--t-text)] mb-1">
                  {t('projects.maxParallelLabel')}
                </label>
                <p className="text-xs text-[var(--t-text-3)] mb-1.5">
                  {t('projects.maxParallelHint')}
                </p>
                <Input
                  type="number"
                  min={1}
                  max={10}
                  value={maxParallel}
                  onChange={(e) =>
                    setMaxParallel(parseInt(e.target.value, 10) || 1)
                  }
                />
              </div>
            </div>

            {/* Advanced Section (collapsible, collapsed by default) */}
            <details
              data-tour="project-register-advanced"
              data-testid="advanced-section"
              className="border border-[var(--t-border)] rounded-lg p-3 group"
            >
              <summary
                className="text-xs font-semibold uppercase tracking-wider text-[var(--t-text)] cursor-pointer select-none flex items-center justify-between"
              >
                <span>{t('projects.advanced')}</span>
                <ChevronDown className="w-4 h-4 transition-transform group-open:rotate-180" />
              </summary>
              <div className="mt-4 space-y-4">
                <ProjectSettingsForm
                  value={newSettings}
                  onChange={(val) => {
                    setFormError(null);
                    setNewSettings(val);
                  }}
                  compact
                />
                {/* envTemplate JSON with Validation */}
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-xs font-semibold uppercase tracking-wider text-[var(--t-text)]">
                      {t('projects.envLabel')}
                    </label>
                    {envTemplate.trim() && !jsonError && (
                      <span className="text-xs text-[var(--t-ok)] font-medium flex items-center gap-1">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        {t('projects.validJson')}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-[var(--t-text-3)] mb-1.5">
                    {t('projects.envHint')}
                  </p>
                  <textarea
                    data-testid="env-template-textarea"
                    rows={4}
                    placeholder={'{\n  "PORT": 3000,\n  "DATABASE_URL": "postgres://..."\n}'}
                    value={envTemplate}
                    onChange={(e) => handleEnvTemplateChange(e.target.value)}
                    className={`w-full text-xs font-mono rounded-lg border p-2.5 bg-[var(--t-surface-2)] text-[var(--t-text)] ${
                      jsonError
                        ? 'border-[var(--t-crit)] focus:ring-[var(--t-crit)]'
                        : 'border-[var(--t-border)] focus:ring-[var(--t-accent)]'
                    } focus:outline-hidden focus:ring-2`}
                  />
                  {jsonError && (
                    <p
                      data-testid="json-error-msg"
                      className="text-xs text-[var(--t-crit)] mt-1 flex items-center gap-1"
                    >
                      <AlertCircle className="w-3.5 h-3.5" />
                      {jsonError}
                    </p>
                  )}
                </div>

                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-[var(--t-text)] mb-1">
                    {t('extra.checks')}
                  </label>
                  <p className="text-xs text-[var(--t-text-3)] mb-1.5">
                    {t('projects.checksHint')}
                  </p>
                  <textarea
                    rows={3}
                    value={checksJson}
                    onChange={(e) => setChecksJson(e.target.value)}
                    placeholder={'[{"name":"lint","cmd":["npm","run","lint"]}]'}
                    className="w-full text-xs font-mono rounded-lg border border-[var(--t-border)] p-2.5 bg-[var(--t-surface-2)]"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-[var(--t-text)] mb-1">
                    {t('extra.hooks')}
                  </label>
                  <p className="text-xs text-[var(--t-text-3)] mb-1.5">
                    {t('projects.hooksHint')}
                  </p>
                  <textarea
                    rows={3}
                    value={hooksText}
                    onChange={(e) => setHooksText(e.target.value)}
                    placeholder={'docker exec xfarm_postgres psql -U xfarm -d postgres -c "DROP DATABASE IF EXISTS xfarm_t_{slug_underscored}"'}
                    className="w-full text-xs font-mono rounded-lg border border-[var(--t-border)] p-2.5 bg-[var(--t-surface-2)]"
                  />
                </div>
              </div>
            </details>

            <div className="flex justify-end gap-3 pt-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setShowAddForm(false)}
              >
                {t('common.cancel')}
              </Button>
              <Button
                type="submit"
                variant="primary"
                size="sm"
                disabled={Boolean(jsonError) || createMutation.isPending}
                loading={createMutation.isPending}
              >
                {createMutation.isPending
                  ? t('projects.savingBtn')
                  : t('projects.saveBtn')}
              </Button>
            </div>
          </form>
        </Card>
      )}

      {/* Projects List */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {isLoading ? (
          <div className="col-span-2 flex items-center justify-center p-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--t-accent)]" />
          </div>
        ) : error ? (
          <div className="col-span-2 p-8 text-center space-y-3">
            <p className="text-[var(--t-crit)] text-sm">{t('projects.loadError')}</p>
            <button
              type="button"
              onClick={() => queryClient.invalidateQueries({ queryKey: ['projects'] })}
              className="px-3 py-1.5 rounded-lg border border-[var(--t-border)] text-xs font-medium hover:bg-[var(--t-surface-2)] cursor-pointer"
            >
              {t('common.retry')}
            </button>
          </div>
        ) : projects.length === 0 ? (
          <div
            data-testid="projects-empty-guide"
            className="col-span-2 bg-[var(--t-surface)] rounded-xl border border-[var(--t-border)] p-6 shadow-xs space-y-5"
          >
            <div className="flex items-start gap-4">
              <div className="p-3 rounded-lg bg-[var(--t-surface-2)] text-[var(--t-accent)] shrink-0">
                <FolderGit2 className="w-6 h-6" />
              </div>
              <div className="space-y-1">
                <h3 className="text-base font-bold text-[var(--t-text)]">
                  {t('projects.emptyTitle')}
                </h3>
                <p className="text-sm text-[var(--t-text-3)] leading-relaxed">
                  {t('projects.emptyDesc')}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-1">
              <div className="p-3.5 rounded-lg bg-[var(--t-surface-2)] border border-[var(--t-border)] space-y-2">
                <div className="w-6 h-6 rounded-full bg-[var(--t-accent)] text-[var(--t-on-accent)] text-xs flex items-center justify-center font-bold">
                  1
                </div>
                <p className="text-xs text-[var(--t-text-2)] leading-relaxed">
                  {t('projects.emptyStep1')}
                </p>
              </div>

              <div className="p-3.5 rounded-lg bg-[var(--t-surface-2)] border border-[var(--t-border)] space-y-2">
                <div className="w-6 h-6 rounded-full bg-[var(--t-accent)] text-[var(--t-on-accent)] text-xs flex items-center justify-center font-bold">
                  2
                </div>
                <p className="text-xs text-[var(--t-text-2)] leading-relaxed">
                  {t('projects.emptyStep2')}
                </p>
              </div>

              <div className="p-3.5 rounded-lg bg-[var(--t-surface-2)] border border-[var(--t-border)] space-y-2">
                <div className="w-6 h-6 rounded-full bg-[var(--t-accent)] text-[var(--t-on-accent)] text-xs flex items-center justify-center font-bold">
                  3
                </div>
                <p className="text-xs text-[var(--t-text-2)] leading-relaxed">
                  {t('projects.emptyStep3')}
                </p>
              </div>
            </div>

            {!showAddForm && (
              <div className="pt-1">
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  onClick={() => {
                    resetForm();
                    setShowAddForm(true);
                  }}
                  className="gap-1.5"
                >
                  <Plus className="w-4 h-4" />
                  <span>{t('projects.registerFirstBtn')}</span>
                </Button>
              </div>
            )}
          </div>
        ) : (
          projects.map((proj) => (
            <Card
              key={proj.id}
              className="p-5 flex flex-col justify-between gap-4 hover:border-[var(--t-border-focus)] transition-colors"
              data-testid={`project-card-${proj.id}`}
              data-tour="project-card"
            >
              <div className="space-y-3">
                {/* Header: Title + Path + Quick Action Buttons */}
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="text-base font-bold text-[var(--t-text)] flex items-center gap-2 truncate">
                      <FolderGit2 className="w-4 h-4 text-[var(--t-accent)] shrink-0" />
                      <span className="truncate">{proj.name}</span>
                      <span className="text-xs font-mono font-normal text-[var(--t-text-3)] shrink-0">
                        ({proj.id})
                      </span>
                    </h3>
                    <p className="text-xs font-mono text-[var(--t-text-3)] mt-1 truncate">
                      {proj.path}
                    </p>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setDrawerProject(proj);
                        navigate(`/projects/${proj.id}/settings`);
                      }}
                      className="gap-1.5"
                    >
                      <Settings2 className="w-3.5 h-3.5" />
                      <span>{t('projects.settings')}</span>
                    </Button>
                    <Button
                      variant={focus?.projectId === proj.id ? 'primary' : 'ghost'}
                      size="sm"
                      onClick={() => focusMutation.mutate(focus?.projectId === proj.id ? null : proj.id)}
                      disabled={focusMutation.isPending}
                      className="gap-1.5"
                    >
                      <span aria-hidden="true">🎯</span>
                      <span>{focus?.projectId === proj.id ? t('projects.unfocusProject') : t('projects.focusProject')}</span>
                    </Button>

                    <Button
                      variant="ghost"
                      size="sm"
                      title={t('extra.deleteProject')}
                      aria-label={t('extra.deleteProject')}
                      onClick={() => {
                        if (window.confirm(t('projects.archiveConfirm', { name: proj.name }))) {
                          deleteMutation.mutate({ id: proj.id });
                          return;
                        }
                        const typed = window.prompt(t('projects.purgeConfirm', { id: proj.id }));
                        if (typed === proj.id) {
                          deleteMutation.mutate({ id: proj.id, purge: true, confirm: typed });
                        }
                      }}
                      className="p-1.5 text-[var(--t-text-3)] hover:text-[var(--t-crit)]"
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>

                {/* Compact badges and metadata row */}
                <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-[var(--t-border)] text-xs">
                  {/* Default Branch */}
                  <div
                    className={
                      'inline-flex items-center gap-1 px-2.5 py-1 rounded-lg ' +
                      'bg-[var(--t-surface-2)] text-[var(--t-text)] border border-[var(--t-border)]'
                    }
                  >
                    <GitBranch className="w-3.5 h-3.5 text-[var(--t-text-3)]" />
                    <span className="text-[var(--t-text-3)]">
                      {t('projects.cardBranch')}
                    </span>
                    <span className="font-mono font-medium">
                      {proj.defaultBranch}
                    </span>
                  </div>

                  {/* Integration Branch Badge */}
                  <div
                    className={
                      'inline-flex items-center gap-1 px-2.5 py-1 rounded-lg ' +
                      'bg-[var(--t-surface-2)] text-[var(--t-text)] border border-[var(--t-border)]'
                    }
                  >
                    <span className="text-[var(--t-text-3)]">
                      {t('projects.cardIntegration')}
                    </span>
                    {proj.settings?.integration?.enabled ? (
                      <span className="font-medium text-[var(--t-accent)] flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-[var(--t-accent)]" />
                        <span>
                          {t('projects.integrationEnabledBadge', {
                            branch:
                              proj.settings.integration.branch || 'integration',
                          })}
                        </span>
                      </span>
                    ) : (
                      <span className="text-[var(--t-text-3)]">
                        {t('projects.integrationDisabled')}
                      </span>
                    )}
                  </div>

                  {/* Brain Permission Badge */}
                  <div
                    className={
                      'inline-flex items-center gap-1 px-2.5 py-1 rounded-lg ' +
                      'bg-[var(--t-surface-2)] text-[var(--t-text)] border border-[var(--t-border)]'
                    }
                  >
                    <span className="text-[var(--t-text-3)]">
                      {t('projects.cardBrain')}
                    </span>
                    {proj.settings?.brain?.permissions === 'full' ? (
                      <span className="font-semibold text-[var(--t-crit)] flex items-center gap-1">
                        <AlertCircle className="w-3 h-3" />
                        <span>{t('projects.brainPermissionFull')}</span>
                      </span>
                    ) : proj.settings?.brain?.permissions === 'trusted' ? (
                      <span className="font-medium text-[var(--t-accent)]">
                        {t('projects.brainPermissionTrusted')}
                      </span>
                    ) : proj.settings?.brain?.permissions === 'standard' ? (
                      <span className="text-[var(--t-text-2)]">
                        {t('projects.brainPermissionStandard')}
                      </span>
                    ) : (
                      <span className="text-[var(--t-text-3)]">
                        {t('projects.brainPermissionInherit')}
                      </span>
                    )}
                  </div>

                  {/* CI Badge if available */}
                  {proj.ciStatus && (
                    <div
                      data-testid={`project-ci-${proj.id}`}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-xs"
                    >
                      {proj.ciStatus.status !== 'completed' ? (
                        <span className="inline-flex items-center gap-1 font-medium text-[var(--t-warn)]">
                          <Clock className="w-3.5 h-3.5 animate-spin" />
                          <span>{t('projects.ciStatusRunning')}</span>
                        </span>
                      ) : proj.ciStatus.conclusion === 'success' ? (
                        <span className="inline-flex items-center gap-1 font-medium text-[var(--t-ok)]">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          <span>{t('projects.ciStatusPassed')}</span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 font-medium text-[var(--t-crit)]">
                          <AlertCircle className="w-3.5 h-3.5" />
                          <span>{t('projects.ciStatusFailed')}</span>
                        </span>
                      )}
                      {proj.ciStatus.url && (
                        <a
                          href={proj.ciStatus.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[var(--t-accent)] hover:underline inline-flex items-center gap-0.5 ml-1"
                        >
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      )}
                    </div>
                  )}
                  {proj.ciStatus && (
                    <button type="button" className="text-xs text-[var(--t-accent)] hover:underline" onClick={() => { setCiProject(ciProject === proj.id ? null : proj.id); setCiPage(1); }}>
                      {t('projects.ciLabel')}
                    </button>
                  )}
                </div>
              </div>

              {/* Card Footer: Knowledge button */}
              <div className="pt-2 border-t border-[var(--t-border)] space-y-2">
                {(() => {
                  const activeCount = projectTasks.filter((task) => task.projectId === proj.id && ['running', 'queued', 'waiting_quota'].includes(task.status)).length;
                  return <Link to={`/tasks?project=${encodeURIComponent(proj.id)}`} className="flex items-center justify-between rounded-lg border border-[var(--t-border)] px-2.5 py-2 text-xs hover:border-[var(--t-accent)] transition-colors" data-testid={`project-task-summary-${proj.id}`}><span className="text-[var(--t-text-2)]">{t('projects.activeTasks')}</span><span className="font-semibold text-[var(--t-accent)]">{activeCount} · {t('projects.viewTasks')}</span></Link>;
                })()}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setKnowledgeProject(knowledgeProject === proj.id ? null : proj.id);
                    setKnowledgePage(1);
                  }}
                  className="inline-flex items-center gap-1 text-xs text-[var(--t-accent)] px-2 h-7"
                >
                  <BookOpen className="w-3.5 h-3.5" />
                  <span>{t('projects.knowledge')}</span>
                </Button>

                {knowledgeProject === proj.id && (
                  <div className="pt-2 border-t border-[var(--t-border)] space-y-2">
                    <div className="flex gap-2">
                      <Input
                        value={knowledgeDraft}
                        onChange={(e) => setKnowledgeDraft(e.target.value)}
                        placeholder={t('projects.addKnowledgePlaceholder')}
                        className="text-xs h-8"
                      />
                      <Button
                        type="button"
                        variant="primary"
                        size="sm"
                        disabled={
                          !knowledgeDraft.trim() ||
                          addKnowledgeMutation.isPending
                        }
                        onClick={() => addKnowledgeMutation.mutate()}
                        className="h-8"
                      >
                        {t('projects.addKnowledgeBtn')}
                      </Button>
                    </div>
                    <DataTable
                      rows={knowledgeQuery.data?.items || []}
                      loading={knowledgeQuery.isLoading}
                      error={knowledgeQuery.error instanceof Error ? knowledgeQuery.error.message : null}
                      emptyTitle={t('common.empty')}
                      page={knowledgePage}
                      pageSize={knowledgePageSize}
                      total={knowledgeQuery.data?.total || 0}
                      onPageChange={setKnowledgePage}
                      columns={[{
                        key: 'content',
                        title: t('extra.knowledge'),
                        sortable: true,
                        sortValue: (entry) => entry.content,
                        render: (entry) => <div className="flex items-start gap-2 text-xs">
                        <button
                          type="button"
                          title={
                            entry.pinned
                              ? t('projects.unpinKnowledge')
                              : t('projects.pinKnowledge')
                          }
                          aria-label={
                            entry.pinned
                              ? t('projects.unpinKnowledge')
                              : t('projects.pinKnowledge')
                          }
                          onClick={() =>
                            updateKnowledgeMutation.mutate({
                              id: entry.id,
                              pinned: !entry.pinned,
                            })
                          }
                          className={`cursor-pointer ${
                            entry.pinned
                              ? 'text-[var(--t-accent)]'
                              : 'text-[var(--t-text-3)]'
                          }`}
                        >
                          <Pin className="w-3.5 h-3.5 mt-0.5" />
                        </button>
                        <textarea
                          defaultValue={entry.content}
                          onBlur={(e) => {
                            if (e.target.value !== entry.content) {
                              updateKnowledgeMutation.mutate({
                                id: entry.id,
                                content: e.target.value,
                              });
                            }
                          }}
                          rows={2}
                          className="min-w-0 flex-1 rounded border border-[var(--t-border)] p-1.5 bg-[var(--t-surface-2)] text-xs font-mono"
                        />
                        <button
                          type="button"
                          onClick={() =>
                            deleteKnowledgeMutation.mutate(entry.id)
                          }
                          aria-label={t('common.delete')}
                          title={t('common.delete')}
                          className="text-[var(--t-crit)] cursor-pointer"
                        >
                          ×
                        </button>
                        </div>,
                      }, {
                        key: 'createdAt',
                        title: t('common.createdAt'),
                        sortable: true,
                        sortValue: (entry) => entry.createdAt,
                        render: (entry) => <span className="whitespace-nowrap text-xs text-[var(--t-text-3)]">{entry.createdAt}</span>,
                      }]}
                    />
                  </div>
                )}
                {ciProject === proj.id && (
                  <div className="pt-2 border-t border-[var(--t-border)]">
                    <DataTable
                      rows={ciRunsQuery.data?.items || []}
                      loading={ciRunsQuery.isLoading}
                      error={ciRunsQuery.error instanceof Error ? ciRunsQuery.error.message : null}
                      emptyTitle={t('common.empty')}
                      columns={[
                        { key: 'runId', title: 'Run', sortable: true, sortValue: (row) => row.runId, render: (row) => <span className="font-mono">#{row.runId}</span> },
                        { key: 'workflow', title: 'Workflow', render: (row) => row.workflow },
                        { key: 'status', title: 'Status', render: (row) => row.conclusion || row.status },
                        { key: 'sha', title: 'SHA', render: (row) => <span className="font-mono">{row.sha.slice(0, 8)}</span> },
                      ]}
                      page={ciPage}
                      pageSize={ciPageSize}
                      total={ciRunsQuery.data?.total || 0}
                      onPageChange={setCiPage}
                    />
                  </div>
                )}
              </div>
            </Card>
          ))
        )}
      </div>

      {/* Project Settings Drawer */}
      <ProjectSettingsDrawer
        project={drawerProject}
        departments={departments}
        isOpen={drawerProject !== null}
        onClose={() => {
          setDrawerProject(null);
          if (urlProjectId) {
            navigate('/projects');
          }
        }}
        onSaved={() => {
          queryClient.invalidateQueries({ queryKey: ['projects'] });
        }}
      />
    </div>
  );
};
