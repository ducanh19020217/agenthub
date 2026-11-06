import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import Markdown from 'react-markdown';
import { createTask, getProjects, getTasks, getConfig, getModelOptions, getOpenProjectSources } from '../api/client';
import { TaskLevel } from '../types/api';
import { ArrowLeft, Eye, Edit3, Plus } from 'lucide-react';
import { useLocale } from '../context/LocaleContext';
import { useTour } from '../components/tour/TourContext';

export const CreateTaskPage: React.FC = () => {
  const { t } = useLocale();
  const { suggestModalTour } = useTour();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [projectId, setProjectId] = useState('');
  const [slug, setSlug] = useState('');
  const [title, setTitle] = useState('');
  const [externalRef, setExternalRef] = useState('');
  const [level, setLevel] = useState<TaskLevel>('easy');
  const [body, setBody] = useState('');
  const [selectedDeps, setSelectedDeps] = useState<string[]>([]);
  const [startImmediately, setStartImmediately] = useState(false);
  const [modelChain, setModelChain] = useState<string[]>([]);
  const [createTicket, setCreateTicket] = useState(false);
  const [activeTab, setActiveTab] = useState<'edit' | 'preview'>('edit');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [mergeWarning, setMergeWarning] = useState<string | null>(null);
  const [createdTaskId, setCreatedTaskId] = useState<string | null>(null);
  React.useEffect(() => {
    suggestModalTour('modal-create-task');
  }, [suggestModalTour]);

  const { data: projects = [] } = useQuery({
    queryKey: ['projects'],
    queryFn: getProjects,
  });

  const { data: allTasks = [] } = useQuery({
    queryKey: ['tasks'],
    queryFn: () => getTasks(),
  });
  const { data: config } = useQuery({ queryKey: ['config'], queryFn: getConfig });
  const { data: modelOptions } = useQuery({ queryKey: ['model-options'], queryFn: getModelOptions });
  const { data: openProjectSources = [] } = useQuery({ queryKey: ['openproject-sources'], queryFn: getOpenProjectSources });
  const selectedProject = projects.find((project) => project.id === projectId);
  const openProject = selectedProject?.settings?.openproject;
  const openProjectSource = openProject?.sourceId ? openProjectSources.find((source) => source.id === openProject.sourceId) : undefined;
  const modelSuggestions = modelOptions?.suggestions?.length
    ? modelOptions.suggestions
    : [...new Set([...(config?.modelChainHard || []), ...(config?.modelChainEasy || [])])];

  // Set default project when loaded
  React.useEffect(() => {
    setCreateTicket(false);
  }, [projectId]);

  React.useEffect(() => {
    if (projects.length > 0 && !projectId) {
      setProjectId(projects[0].id);
    }
  }, [projects, projectId]);

  const mutation = useMutation({
    mutationFn: createTask,
    onSuccess: (newTask) => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      queryClient.invalidateQueries({ queryKey: ['status'] });
      if (newTask.mergeWarning) {
        setMergeWarning(newTask.mergeWarning);
        setCreatedTaskId(newTask.id);
      } else {
        navigate(`/tasks/${encodeURIComponent(newTask.id.replace('/', '~'))}`);
      }
    },
    onError: (err: any) => {
      setErrorMsg(err.message || t('createTask.createError'));
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setMergeWarning(null);
    setCreatedTaskId(null);

    if (!projectId) {
      setErrorMsg(t('createTask.selectProjectError'));
      return;
    }
    if (!slug.trim()) {
      setErrorMsg(t('createTask.slugError'));
      return;
    }
    if (!title.trim()) {
      setErrorMsg(t('createTask.titleError'));
      return;
    }

    mutation.mutate({
      project: projectId,
      slug: slug.trim(),
      title: title.trim(),
      externalRef: externalRef.trim() || undefined,
      level,
      body: body.trim(),
      dependsOn: selectedDeps,
      modelChain: modelChain.length > 0 ? modelChain : undefined,
      start: startImmediately,
      createTicket: createTicket ? (openProject?.sourceId ? { sourceId: openProject.sourceId } : {}) : undefined,
    });
  };

  const toggleDep = (depId: string) => {
    setSelectedDeps((prev) =>
      prev.includes(depId) ? prev.filter((id) => id !== depId) : [...prev, depId],
    );
  };

  return (
    <div data-tour="modal-create-task" className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={() => navigate('/tasks')}
          aria-label={t('common.back')}
          title={t('common.back')}
          className="p-2 rounded-lg text-[var(--t-text-3)] hover:text-[var(--t-text)] hover:bg-[var(--t-surface-2)] cursor-pointer"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('createTask.title')}</h1>
          <p className="text-sm text-[var(--t-text-3)]">
            {t('createTask.subtitle')}
          </p>
        </div>
      </div>

      {errorMsg && (
        <div className="p-4 rounded-lg bg-[color-mix(in_srgb,var(--t-crit)_15%,transparent)] text-[var(--t-crit)] text-sm border border-[var(--t-crit)]">
          {errorMsg}
        </div>
      )}
      {mergeWarning && createdTaskId && (
        <div role="alert" className="p-4 rounded-lg bg-[color-mix(in_srgb,var(--t-warn)_15%,transparent)] text-[var(--t-warn)] text-sm border border-[var(--t-warn)]">
          <p className="font-semibold">{t('createTask.mergeWarningTitle')}</p>
          <p className="mt-1">{mergeWarning}</p>
          <button
            type="button"
            onClick={() => navigate(`/tasks/${encodeURIComponent(createdTaskId.replace('/', '~'))}`)}
            className="mt-2 underline cursor-pointer"
          >
            {t('createTask.openCreatedTask')}
          </button>
        </div>
      )}

      {/* Form */}
      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="bg-[var(--t-surface)] rounded-xl border border-[var(--t-border)] p-6 space-y-6 shadow-xs">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Project */}
            <div>
              <label className="block text-xs font-semibold text-[var(--t-text)] uppercase tracking-wider mb-2">
                {t('createTask.projectLabel')}
              </label>
              <select
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                className="w-full text-sm rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2 text-[var(--t-text)] focus:outline-none focus:ring-2 focus:ring-[var(--t-accent)]"
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.id})
                  </option>
                ))}
              </select>
            </div>

            {/* Slug */}
            <div>
              <label className="block text-xs font-semibold text-[var(--t-text)] uppercase tracking-wider mb-2">
                {t('createTask.slugLabel')}
              </label>
              <input
                type="text"
                placeholder={t('createTask.slugPlaceholder')}
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                className="w-full text-sm rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2 text-[var(--t-text)] focus:outline-none focus:ring-2 focus:ring-[var(--t-accent)]"
              />
            </div>
          </div>

          {/* Title */}
          <div>
            <label className="block text-xs font-semibold text-[var(--t-text)] uppercase tracking-wider mb-2">
                {t('createTask.titleLabel')}
            </label>
            <input
              type="text"
                placeholder={t('createTask.titlePlaceholder')}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full text-sm rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2 text-[var(--t-text)] focus:outline-none focus:ring-2 focus:ring-[var(--t-accent)]"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-[var(--t-text)] uppercase tracking-wider mb-2">
              {t('createTask.externalRefLabel')}
            </label>
            <input
              type="text"
              placeholder={t('createTask.externalRefPlaceholder')}
              value={externalRef}
              onChange={(e) => setExternalRef(e.target.value)}
              className="w-full text-sm rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2 text-[var(--t-text)] focus:outline-none focus:ring-2 focus:ring-[var(--t-accent)]"
            />
          </div>

          {/* Level */}
          <div data-tour="task-difficulty">
            <label className="block text-xs font-semibold text-[var(--t-text)] uppercase tracking-wider mb-2">
                {t('createTask.complexityLabel')}
            </label>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 cursor-pointer text-sm">
                <input
                  type="radio"
                  name="level"
                  value="easy"
                  checked={level === 'easy'}
                  onChange={() => setLevel('easy')}
                  className="text-[var(--t-accent)] focus:ring-[var(--t-accent)]"
                />
                <span>{t('createTask.easyDesc')}</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer text-sm">
                <input
                  type="radio"
                  name="level"
                  value="hard"
                  checked={level === 'hard'}
                  onChange={() => setLevel('hard')}
                  className="text-[var(--t-accent)] focus:ring-[var(--t-accent)]"
                />
                <span>{t('createTask.hardDesc')}</span>
              </label>
            </div>
          </div>

          {/* Dependencies (dependsOn) */}
          <div>
            <label className="block text-xs font-semibold text-[var(--t-text)] uppercase tracking-wider mb-2">{t('createTask.modelChainLabel')}</label>
            <input
              aria-label={t('createTask.modelChainLabel')}
              value={modelChain.join(', ')}
              onChange={(e) => setModelChain(e.target.value.split(',').map((model) => model.trim()).filter(Boolean))}
              list="create-task-model-suggestions"
              placeholder={(level === 'hard' ? config?.modelChainHard : config?.modelChainEasy)?.join(', ') || 'gemini-3.8-flash-medium, codex:gpt-5.6-luna'}
              className="w-full text-sm font-mono rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2 text-[var(--t-text)]"
            />
            <datalist id="create-task-model-suggestions">{modelSuggestions.map((model) => <option key={model} value={model} />)}</datalist>
            <p className="text-[11px] text-[var(--t-text-3)] mt-1">{t('createTask.modelChainHint')}</p>
          </div>

          {/* Dependencies (dependsOn) */}
          <div>
            <label className="block text-xs font-semibold text-[var(--t-text)] uppercase tracking-wider mb-2">
              {t('createTask.depsLabel')}
            </label>
            {allTasks.length === 0 ? (
              <p className="text-xs text-[var(--t-text-3)]">{t('createTask.noDepsAvailable')}</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-48 overflow-y-auto p-3 rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)]">
                {allTasks.map((t) => (
                  <label
                    key={t.id}
                    className="flex items-center gap-2 text-xs text-[var(--t-text)] cursor-pointer p-1.5 rounded hover:bg-[var(--t-surface-2)]"
                  >
                    <input
                      type="checkbox"
                      checked={selectedDeps.includes(t.id)}
                      onChange={() => toggleDep(t.id)}
                      className="rounded text-[var(--t-accent)] focus:ring-[var(--t-accent)]"
                    />
                    <span className="font-mono text-[var(--t-text-3)]">[{t.projectId}]</span>
                    <span className="font-medium truncate">{t.title}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* Body with Markdown Live Preview */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="block text-xs font-semibold text-[var(--t-text)] uppercase tracking-wider">
                {t('createTask.bodyLabel')}
              </label>
              <div className="flex items-center gap-1 bg-[var(--t-surface-2)] p-0.5 rounded-lg text-xs font-medium">
                <button
                  type="button"
                  onClick={() => setActiveTab('edit')}
                  className={`flex items-center gap-1 px-2.5 py-1 rounded-md transition-colors cursor-pointer ${
                    activeTab === 'edit'
                      ? 'bg-[var(--t-surface-2)] text-[var(--t-text)] shadow-xs'
                      : 'text-[var(--t-text-3)]'
                  }`}
                >
                  <Edit3 className="w-3.5 h-3.5" />
                  <span>{t('createTask.tabEdit')}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('preview')}
                  className={`flex items-center gap-1 px-2.5 py-1 rounded-md transition-colors cursor-pointer ${
                    activeTab === 'preview'
                      ? 'bg-[var(--t-surface-2)] text-[var(--t-text)] shadow-xs'
                      : 'text-[var(--t-text-3)]'
                  }`}
                >
                  <Eye className="w-3.5 h-3.5" />
                  <span>{t('createTask.tabPreview')}</span>
                </button>
              </div>
            </div>

            {activeTab === 'edit' ? (
              <textarea
                rows={10}
                placeholder={t('createTask.bodyPlaceholder')}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                className="w-full text-sm font-mono rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] p-3 text-[var(--t-text)] focus:outline-none focus:ring-2 focus:ring-[var(--t-accent)]"
              />
            ) : (
              <div className="min-h-[240px] p-4 rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] prose prose-invert max-w-none text-sm">
                {body.trim() ? (
                  <Markdown>{body}</Markdown>
                ) : (
                  <p className="text-[var(--t-text-3)] italic">{t('createTask.bodyEmptyPreview')}</p>
                )}
              </div>
            )}
          </div>

          {/* Start immediately option */}
          <div className="pt-2">
            <label className="flex items-center gap-2 cursor-pointer text-sm">
              <input
                type="checkbox"
                checked={startImmediately}
                onChange={(e) => setStartImmediately(e.target.checked)}
                className="rounded text-[var(--t-accent)] focus:ring-[var(--t-accent)]"
              />
              <span className="font-medium text-[var(--t-text)]">
                {t('createTask.startImmediately')}
              </span>
            </label>
          </div>
          {openProject?.enabled && openProjectSource && (
            <label className="flex items-center gap-2 cursor-pointer text-sm">
              <input type="checkbox" checked={createTicket} onChange={(e) => setCreateTicket(e.target.checked)} className="rounded text-[var(--t-accent)] focus:ring-[var(--t-accent)]" />
              <span className="font-medium text-[var(--t-text)]">{t('createTask.createOpenProjectTicket')} ({openProjectSource.id})</span>
            </label>
          )}
        </div>

        {/* Action Buttons */}
        <div className="flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={() => navigate('/tasks')}
            className="px-4 py-2 text-sm font-medium rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] text-[var(--t-text)] hover:bg-[var(--t-surface-2)] cursor-pointer"
          >
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            disabled={mutation.isPending}
            className="px-5 py-2 text-sm font-medium rounded-lg bg-[var(--t-accent)] hover:bg-[var(--t-accent-hover)] text-[var(--t-on-accent)] shadow-xs inline-flex items-center gap-2 cursor-pointer disabled:opacity-50"
          >
            {mutation.isPending ? (
              t('createTask.creatingBtn')
            ) : (
              <>
                <Plus className="w-4 h-4" />
                <span>{t('createTask.createBtn')}</span>
              </>
            )}
          </button>
        </div>
      </form>
    </div>
  );
};
