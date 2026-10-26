import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getConfig, getSetupStatus, updateConfig } from '../../api/client';

export type TourStep = {
  id: string;
  route?: string;
  selector: string;
  title: string;
  content: string;
  placement?: 'top' | 'bottom' | 'left' | 'right';
  /** Short hint shown when a target is temporarily unavailable. */
  note?: string;
};

export type TourDefinition = { id: string; steps: TourStep[] };

type TourContextValue = {
  active: TourDefinition | null;
  stepIndex: number;
  openTour: (id: string) => void;
  closeTour: (completed?: boolean) => void;
  next: () => void;
  previous: () => void;
  getPageTour: (pathname: string) => TourDefinition | null;
  suggestModalTour: (id: string) => void;
};

const fallbackKey = 'agenthub_tours_seen';

export const tourDefinitions: TourDefinition[] = [
  { id: 'intro', steps: [
    { id: 'overview', route: '/', selector: '[data-tour="overview"]', title: 'tour.steps.intro.overview.title', content: 'tour.steps.intro.overview.content', placement: 'bottom' },
    { id: 'connection', route: '/', selector: '[data-tour="connection-status"]', title: 'tour.steps.intro.connection.title', content: 'tour.steps.intro.connection.content', placement: 'bottom' },
    { id: 'resources', route: '/', selector: '[data-tour="resource-status"]', title: 'tour.steps.intro.resources.title', content: 'tour.steps.intro.resources.content', placement: 'bottom' },
    { id: 'brain', route: '/', selector: '[data-tour="brain"]', title: 'tour.steps.intro.brain.title', content: 'tour.steps.intro.brain.content', placement: 'bottom' },
    { id: 'projects', route: '/projects', selector: '[data-tour="projects"]', title: 'tour.steps.intro.projects.title', content: 'tour.steps.intro.projects.content', placement: 'right' },
    { id: 'tasks', route: '/tasks', selector: '[data-tour="tasks"]', title: 'tour.steps.intro.tasks.title', content: 'tour.steps.intro.tasks.content', placement: 'right' },
    { id: 'queue', route: '/tasks', selector: '[data-tour="task-filters"]', title: 'tour.steps.intro.queue.title', content: 'tour.steps.intro.queue.content', placement: 'bottom' },
    { id: 'plans', route: '/plans', selector: '[data-tour="plans"]', title: 'tour.steps.intro.plans.title', content: 'tour.steps.intro.plans.content', placement: 'right' },
    { id: 'lifecycle', route: '/tasks', selector: '[data-tour="task-lifecycle"]', title: 'tour.steps.intro.lifecycle.title', content: 'tour.steps.intro.lifecycle.content', placement: 'top' },
    { id: 'profiles', route: '/profiles', selector: '[data-tour="profiles"]', title: 'tour.steps.intro.profiles.title', content: 'tour.steps.intro.profiles.content', placement: 'right' },
    { id: 'settings', route: '/settings', selector: '[data-tour="settings"]', title: 'tour.steps.intro.settings.title', content: 'tour.steps.intro.settings.content', placement: 'right' },
    { id: 'setup', route: '/setup', selector: '[data-tour="setup"]', title: 'tour.steps.intro.setup.title', content: 'tour.steps.intro.setup.content', placement: 'right' },
    { id: 'help', route: '/', selector: '[data-tour="help"]', title: 'tour.steps.intro.help.title', content: 'tour.steps.intro.help.content', placement: 'bottom' },
  ] },
];

export const pageTours: Record<string, TourDefinition> = {
  '/': { id: 'page-dashboard', steps: [
    { id: 'overview', selector: '[data-tour="overview"]', title: 'tour.steps.page-dashboard.overview.title', content: 'tour.steps.page-dashboard.overview.content', placement: 'bottom' },
    { id: 'resources', selector: '[data-tour="resource-status"]', title: 'tour.steps.page-dashboard.resources.title', content: 'tour.steps.page-dashboard.resources.content', placement: 'bottom' },
    { id: 'brain', selector: '[data-tour="brain"]', title: 'tour.steps.page-dashboard.brain.title', content: 'tour.steps.page-dashboard.brain.content', placement: 'bottom' },
    { id: 'quotas', selector: '[data-tour="provider-quotas"]', title: 'tour.steps.page-dashboard.quotas.title', content: 'tour.steps.page-dashboard.quotas.content', placement: 'top' },
    { id: 'performance', selector: '[data-tour="performance"]', title: 'tour.steps.page-dashboard.performance.title', content: 'tour.steps.page-dashboard.performance.content', placement: 'top' },
    { id: 'checklist', selector: '[data-tour="checklist"]', title: 'tour.steps.page-dashboard.checklist.title', content: 'tour.steps.page-dashboard.checklist.content', placement: 'top' },
    { id: 'workers', selector: '[data-tour="workers"]', title: 'tour.steps.page-dashboard.workers.title', content: 'tour.steps.page-dashboard.workers.content', placement: 'top' },
  ] },
  '/projects': { id: 'page-projects', steps: [
    { id: 'projects', selector: '[data-tour="projects"]', title: 'tour.steps.page-projects.projects.title', content: 'tour.steps.page-projects.projects.content', placement: 'bottom' },
    { id: 'register', selector: '[data-tour="project-register"]', title: 'tour.steps.page-projects.register.title', content: 'tour.steps.page-projects.register.content', placement: 'bottom' },
    { id: 'project-card', selector: '[data-tour="project-card"]', title: 'tour.steps.page-projects.project-card.title', content: 'tour.steps.page-projects.project-card.content', placement: 'top' },
    { id: 'brain-settings', selector: '[data-tour="project-brain-settings"]', title: 'tour.steps.page-projects.brain-settings.title', content: 'tour.steps.page-projects.brain-settings.content', placement: 'left' },
    { id: 'worktree', selector: '[data-tour="project-worktree"]', title: 'tour.steps.page-projects.worktree.title', content: 'tour.steps.page-projects.worktree.content', placement: 'left' },
    { id: 'references', selector: '[data-tour="project-references"]', title: 'tour.steps.page-projects.references.title', content: 'tour.steps.page-projects.references.content', placement: 'left' },
    { id: 'checks', selector: '[data-tour="project-checks"]', title: 'tour.steps.page-projects.checks.title', content: 'tour.steps.page-projects.checks.content', placement: 'left' },
  ] },
  '/settings': { id: 'page-settings', steps: [
    { id: 'settings', selector: '[data-tour="settings"]', title: 'tour.steps.page-settings.settings.title', content: 'tour.steps.page-settings.settings.content', placement: 'bottom' },
    { id: 'model-chain', selector: '[data-tour="model-chain"]', title: 'tour.steps.page-settings.model-chain.title', content: 'tour.steps.page-settings.model-chain.content', placement: 'bottom' },
    { id: 'planning-approval', selector: '[data-tour="planning-approval"]', title: 'tour.steps.page-settings.planning-approval.title', content: 'tour.steps.page-settings.planning-approval.content', placement: 'bottom' },
    { id: 'brain-policy', selector: '[data-tour="brain-policy"]', title: 'tour.steps.page-settings.brain-policy.title', content: 'tour.steps.page-settings.brain-policy.content', placement: 'bottom' },
    { id: 'notifications', selector: '[data-tour="notifications"]', title: 'tour.steps.page-settings.notifications.title', content: 'tour.steps.page-settings.notifications.content', placement: 'top' },
    { id: 'telegram', selector: '[data-tour="telegram"]', title: 'tour.steps.page-settings.telegram.title', content: 'tour.steps.page-settings.telegram.content', placement: 'top' },
    { id: 'accounts', selector: '[data-tour="multiple-accounts"]', title: 'tour.steps.page-settings.accounts.title', content: 'tour.steps.page-settings.accounts.content', placement: 'top' },
    { id: 'updates', selector: '[data-tour="updates"]', title: 'tour.steps.page-settings.updates.title', content: 'tour.steps.page-settings.updates.content', placement: 'top' },
  ] },
  '/setup': { id: 'page-setup', steps: [
    { id: 'setup', selector: '[data-tour="setup"]', title: 'tour.steps.page-setup.setup.title', content: 'tour.steps.page-setup.setup.content', placement: 'right' },
    { id: 'tools', selector: '[data-tour="setup-tools"]', title: 'tour.steps.page-setup.tools.title', content: 'tour.steps.page-setup.tools.content', placement: 'right' },
    { id: 'profiles', selector: '[data-tour="setup-profiles"]', title: 'tour.steps.page-setup.profiles.title', content: 'tour.steps.page-setup.profiles.content', placement: 'right' },
    { id: 'setup-result', selector: '[data-tour="setup-result"]', title: 'tour.steps.page-setup.setup-result.title', content: 'tour.steps.page-setup.setup-result.content', placement: 'right' },
    { id: 'help', selector: '[data-tour="help"]', title: 'tour.steps.page-setup.help.title', content: 'tour.steps.page-setup.help.content', placement: 'bottom' },
  ] },
  '/profiles': { id: 'page-profiles', steps: [
    { id: 'profiles', selector: '[data-tour="profiles"]', title: 'tour.steps.page-profiles.profiles.title', content: 'tour.steps.page-profiles.profiles.content', placement: 'right' },
    { id: 'provider-quota', selector: '[data-tour="profile-quotas"]', title: 'tour.steps.page-profiles.provider-quota.title', content: 'tour.steps.page-profiles.provider-quota.content', placement: 'right' },
    { id: 'account-types', selector: '[data-tour="account-types"]', title: 'tour.steps.page-profiles.account-types.title', content: 'tour.steps.page-profiles.account-types.content', placement: 'right' },
    { id: 'add-account', selector: '[data-tour="add-account"]', title: 'tour.steps.page-profiles.add-account.title', content: 'tour.steps.page-profiles.add-account.content', placement: 'right' },
    { id: 'reauth', selector: '[data-tour="reauth"]', title: 'tour.steps.page-profiles.reauth.title', content: 'tour.steps.page-profiles.reauth.content', placement: 'right' },
    { id: 'help', selector: '[data-tour="help"]', title: 'tour.steps.page-profiles.help.title', content: 'tour.steps.page-profiles.help.content', placement: 'bottom' },
  ] },
  '/tasks': { id: 'page-tasks', steps: [
    { id: 'tasks', selector: '[data-tour="tasks"]', title: 'tour.steps.page-tasks.tasks.title', content: 'tour.steps.page-tasks.tasks.content', placement: 'right' },
    { id: 'filters', selector: '[data-tour="task-filters"]', title: 'tour.steps.page-tasks.filters.title', content: 'tour.steps.page-tasks.filters.content', placement: 'bottom' },
    { id: 'views', selector: '[data-tour="task-views"]', title: 'tour.steps.page-tasks.views.title', content: 'tour.steps.page-tasks.views.content', placement: 'bottom' },
    { id: 'lifecycle', selector: '[data-tour="task-lifecycle"]', title: 'tour.steps.page-tasks.lifecycle.title', content: 'tour.steps.page-tasks.lifecycle.content', placement: 'top' },
    { id: 'actions', selector: '[data-tour="task-actions"]', title: 'tour.steps.page-tasks.actions.title', content: 'tour.steps.page-tasks.actions.content', placement: 'top' },
    { id: 'columns', selector: '[data-tour="task-columns"]', title: 'tour.steps.page-tasks.columns.title', content: 'tour.steps.page-tasks.columns.content', placement: 'top' },
    { id: 'help', selector: '[data-tour="help"]', title: 'tour.steps.page-tasks.help.title', content: 'tour.steps.page-tasks.help.content', placement: 'bottom' },
  ] },
  '/tasks-detail': { id: 'page-task-detail', steps: [
    { id: 'tasks', selector: '[data-tour="tasks"]', title: 'tour.steps.page-task-detail.tasks.title', content: 'tour.steps.page-task-detail.tasks.content', placement: 'right' },
    { id: 'tabs', selector: '[data-tour="task-detail-tabs"]', title: 'tour.steps.page-task-detail.tabs.title', content: 'tour.steps.page-task-detail.tabs.content', placement: 'bottom' },
    { id: 'run-actions', selector: '[data-tour="task-run-actions"]', title: 'tour.steps.page-task-detail.run-actions.title', content: 'tour.steps.page-task-detail.run-actions.content', placement: 'bottom' },
    { id: 'review', selector: '[data-tour="task-review"]', title: 'tour.steps.page-task-detail.review.title', content: 'tour.steps.page-task-detail.review.content', placement: 'bottom' },
    { id: 'capture', selector: '[data-tour="task-capture"]', title: 'tour.steps.page-task-detail.capture.title', content: 'tour.steps.page-task-detail.capture.content', placement: 'top' },
    { id: 'task-summary', selector: '[data-tour="task-summary"]', title: 'tour.steps.page-task-detail.task-summary.title', content: 'tour.steps.page-task-detail.task-summary.content', placement: 'top' },
    { id: 'help', selector: '[data-tour="help"]', title: 'tour.steps.page-task-detail.help.title', content: 'tour.steps.page-task-detail.help.content', placement: 'bottom' },
  ] },
  '/plans': { id: 'page-plans', steps: [
    { id: 'plans', selector: '[data-tour="plans"]', title: 'tour.steps.page-plans.plans.title', content: 'tour.steps.page-plans.plans.content', placement: 'right' },
    { id: 'filters', selector: '[data-tour="plan-filters"]', title: 'tour.steps.page-plans.filters.title', content: 'tour.steps.page-plans.filters.content', placement: 'bottom' },
    { id: 'current', selector: '[data-tour="current-plan"]', title: 'tour.steps.page-plans.current.title', content: 'tour.steps.page-plans.current.content', placement: 'bottom' },
    { id: 'add-task', selector: '[data-tour="add-task"]', title: 'tour.steps.page-plans.add-task.title', content: 'tour.steps.page-plans.add-task.content', placement: 'top' },
    { id: 'approve-plan', selector: '[data-tour="approve-plan"]', title: 'tour.steps.page-plans.approve-plan.title', content: 'tour.steps.page-plans.approve-plan.content', placement: 'top' },
    { id: 'help', selector: '[data-tour="help"]', title: 'tour.steps.page-plans.help.title', content: 'tour.steps.page-plans.help.content', placement: 'bottom' },
  ] },
};

export const modalTourDefinitions: TourDefinition[] = [
  { id: 'modal-add-account', steps: [
    { id: 'provider', selector: '[data-tour="account-provider"]', title: 'tour.steps.modal-add-account.provider.title', content: 'tour.steps.modal-add-account.provider.content' },
    { id: 'login-method', selector: '[data-tour="account-login-method"]', title: 'tour.steps.modal-add-account.login-method.title', content: 'tour.steps.modal-add-account.login-method.content' },
    { id: 'account-name', selector: '[data-tour="account-name"]', title: 'tour.steps.modal-add-account.account-name.title', content: 'tour.steps.modal-add-account.account-name.content' },
  ] },
  { id: 'modal-register-project', steps: [
    { id: 'path', selector: '[data-tour="modal-register-project"]', title: 'tour.steps.modal-register-project.path.title', content: 'tour.steps.modal-register-project.path.content' },
    { id: 'branch', selector: '[data-tour="project-default-branch"]', title: 'tour.steps.modal-register-project.branch.title', content: 'tour.steps.modal-register-project.branch.content' },
    { id: 'advanced', selector: '[data-tour="project-register-advanced"]', title: 'tour.steps.modal-register-project.advanced.title', content: 'tour.steps.modal-register-project.advanced.content' },
  ] },
  { id: 'modal-project-wizard', steps: [{ id: 'modal', selector: '[data-tour="modal-project-wizard"]', title: 'tour.steps.modal-project-wizard.modal.title', content: 'tour.steps.modal-project-wizard.modal.content' }] },
  { id: 'modal-create-task', steps: [
    { id: 'task', selector: '[data-tour="modal-create-task"]', title: 'tour.steps.modal-create-task.task.title', content: 'tour.steps.modal-create-task.task.content' },
    { id: 'difficulty', selector: '[data-tour="task-difficulty"]', title: 'tour.steps.modal-create-task.difficulty.title', content: 'tour.steps.modal-create-task.difficulty.content' },
  ] },
  { id: 'modal-new-session', steps: [
    { id: 'project', selector: '[data-tour="modal-new-session"]', title: 'tour.steps.modal-new-session.project.title', content: 'tour.steps.modal-new-session.project.content' },
    { id: 'mode', selector: '[data-tour="session-mode"]', title: 'tour.steps.modal-new-session.mode.title', content: 'tour.steps.modal-new-session.mode.content' },
  ] },
  { id: 'modal-full-permission', steps: [{ id: 'confirm', selector: '[data-tour="modal-full-permission"]', title: 'tour.steps.modal-full-permission.confirm.title', content: 'tour.steps.modal-full-permission.confirm.content' }] },
];

const noOpTourContext: TourContextValue = {
  active: null,
  stepIndex: 0,
  openTour: () => {},
  closeTour: () => {},
  next: () => {},
  previous: () => {},
  getPageTour: () => null,
  suggestModalTour: () => {},
};

const TourContext = createContext<TourContextValue>(noOpTourContext);

export const TourProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: config } = useQuery({ queryKey: ['config'], queryFn: getConfig, staleTime: 30_000 });
  const { data: setup } = useQuery({ queryKey: ['setup-status'], queryFn: getSetupStatus, staleTime: 10_000 });
  const [activeId, setActiveId] = useState<string | null>(null);
  const [stepIndex, setStepIndex] = useState(0);

  const seen = config?.ui?.tours || {};
  const getPageTour = useCallback((pathname: string) => {
    if (pathname.startsWith('/tasks/') && pathname !== '/tasks/new') return pageTours['/tasks-detail'];
    const key = Object.keys(pageTours).find((candidate) => candidate === pathname || (candidate !== '/' && pathname.startsWith(`${candidate}/`)));
    return key ? pageTours[key] : null;
  }, []);
  const active = useMemo(() => {
    const tour = tourDefinitions.find((item) => item.id === activeId)
      || Object.values(pageTours).find((item) => item.id === activeId)
      || modalTourDefinitions.find((item) => item.id === activeId)
      || null;
    return tour;
  }, [activeId, config?.branding?.name]);

  const markSeen = useCallback(async (id: string) => {
    try {
      const old = JSON.parse(localStorage.getItem(fallbackKey) || '{}');
      localStorage.setItem(fallbackKey, JSON.stringify({ ...old, [id]: true }));
      if (id.startsWith('modal-')) localStorage.setItem(`${fallbackKey}:${id}`, '1');
    } catch { /* storage is optional */ }
    try {
      await updateConfig({ ui: { tours: { ...seen, [id]: true } } });
      await queryClient.invalidateQueries({ queryKey: ['config'] });
    } catch {
    }
  }, [queryClient, seen]);

  const openTour = useCallback((id: string) => {
    const tour = tourDefinitions.find((item) => item.id === id) || Object.values(pageTours).find((item) => item.id === id) || modalTourDefinitions.find((item) => item.id === id);
    if (!tour) return;
    setActiveId(tour.id);
    setStepIndex(0);
    if (tour.steps[0]?.route && location.pathname !== tour.steps[0].route) navigate(tour.steps[0].route);
  }, [location.pathname, navigate]);

  const suggestModalTour = useCallback((id: string) => {
    let seenModal = false;
    try { seenModal = localStorage.getItem(`${fallbackKey}:${id}`) === '1'; } catch { /* optional storage */ }
    if (!seenModal) openTour(id);
  }, [openTour]);

  const closeTour = useCallback((completed = true) => {
    if (active) void markSeen(active.id);
    setActiveId(null);
    setStepIndex(0);
    void completed;
  }, [active, markSeen]);

  const next = useCallback(() => {
    if (!active) return;
    if (stepIndex >= active.steps.length - 1) { closeTour(true); return; }
    const nextIndex = stepIndex + 1;
    setStepIndex(nextIndex);
    const nextStep = active.steps[nextIndex];
    if (nextStep.route && location.pathname !== nextStep.route) navigate(nextStep.route);
  }, [active, closeTour, location.pathname, navigate, stepIndex]);

  const previous = useCallback(() => {
    if (!active || stepIndex === 0) return;
    const previousIndex = stepIndex - 1;
    setStepIndex(previousIndex);
    const previousStep = active.steps[previousIndex];
    if (previousStep.route && location.pathname !== previousStep.route) navigate(previousStep.route);
  }, [active, location.pathname, navigate, stepIndex]);

  useEffect(() => {
    if (!setup || activeId || !(setup.setupCompletedAt || setup.setupSkippedAt)) return;
    let localSeen: Record<string, boolean> = {};
    try { localSeen = JSON.parse(localStorage.getItem(fallbackKey) || '{}'); } catch { /* ignore */ }
    if (!seen.intro && !localSeen.intro) openTour('intro');
  }, [activeId, openTour, seen.intro, setup]);

  return <TourContext.Provider value={{ active, stepIndex, openTour, closeTour, next, previous, getPageTour, suggestModalTour }}>{children}</TourContext.Provider>;
};

export function useTour(): TourContextValue {
  return useContext(TourContext);
}
