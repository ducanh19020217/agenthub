import React, { useEffect, Suspense, lazy } from 'react';
import { BrowserRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from './context/ThemeContext';
import { LocaleProvider } from './context/LocaleContext';
import { AuthGate } from './components/AuthGate';
import { Layout } from './components/Layout';
import { connectSSE } from './api/sse';
import { useQuery } from '@tanstack/react-query';
import { getConfig, getSetupStatus } from './api/client';
import { BrandingProvider } from './context/BrandingContext';
import { TourProvider } from './components/tour/TourContext';
import { TourOverlay } from './components/tour/TourOverlay';

const DashboardPage = lazy(() => import('./pages/DashboardPage').then((m) => ({ default: m.DashboardPage })));
const TasksPage = lazy(() => import('./pages/TasksPage').then((m) => ({ default: m.TasksPage })));
const CreateTaskPage = lazy(() => import('./pages/CreateTaskPage').then((m) => ({ default: m.CreateTaskPage })));
const TaskDetailPage = lazy(() => import('./pages/TaskDetailPage').then((m) => ({ default: m.TaskDetailPage })));
const ProfilesPage = lazy(() => import('./pages/ProfilesPage').then((m) => ({ default: m.ProfilesPage })));
const ProjectsPage = lazy(() => import('./pages/ProjectsPage').then((m) => ({ default: m.ProjectsPage })));
const DepartmentsPage = lazy(() => import('./pages/DepartmentsPage').then((m) => ({ default: m.DepartmentsPage })));
const PlansPage = lazy(() => import('./pages/PlansPage').then((m) => ({ default: m.PlansPage })));
const SettingsPage = lazy(() => import('./pages/SettingsPage').then((m) => ({ default: m.SettingsPage })));
const SavingsPage = lazy(() => import('./pages/SavingsPage').then((m) => ({ default: m.SavingsPage })));
const ClaudeSessionsPage = lazy(() => import('./pages/ClaudeSessionsPage').then((m) => ({ default: m.ClaudeSessionsPage })));
const SetupPage = lazy(() => import('./pages/SetupPage').then((m) => ({ default: m.SetupPage })));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 3000,
    },
  },
});

const SetupRedirect: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { data } = useQuery({ queryKey: ['setup-status'], queryFn: getSetupStatus, staleTime: 10_000 });
  useEffect(() => {
    if (location.pathname !== '/' || !data || data.setupCompletedAt || data.setupSkippedAt) return;
    if (data.tools.some((tool) => !tool.installed) || data.profiles.some((profile) => !profile.loggedIn)) navigate('/setup', { replace: true });
  }, [data, location.pathname, navigate]);
  return null;
};

export const App: React.FC = () => {
  return (
    <QueryClientProvider client={queryClient}>
      <AppShell />
    </QueryClientProvider>
  );
};

/** Everything that reads queries (branding config included) must render inside QueryClientProvider. */
const AppShell: React.FC = () => {
  const { data: config } = useQuery({ queryKey: ['config'], queryFn: getConfig, staleTime: 30_000 });
  useEffect(() => {
    if (!config) return;
    // Do not consume notification events until the persisted notification and brain policies are loaded.
    return connectSSE(queryClient);
  }, [config]);
  return (
      <ThemeProvider>
        <LocaleProvider appName={config?.branding?.name}>
          <BrandingProvider branding={config?.branding}>
          <AuthGate>
          <BrowserRouter>
            <TourProvider>
              <SetupRedirect />
              <Suspense
              fallback={
                <div className="flex items-center justify-center p-12">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--t-accent)]" />
                </div>
              }
            >
              <Routes>
                <Route path="/" element={<Layout />}>
                  <Route index element={<DashboardPage />} />
                  <Route path="setup" element={<SetupPage />} />
                  <Route path="claude-sessions" element={<ClaudeSessionsPage />} />
                  <Route path="claude-sessions/:sessionId" element={<ClaudeSessionsPage />} />
                  <Route path="plans" element={<PlansPage />} />
                  <Route path="plans/:batchId" element={<PlansPage />} />
                  <Route path="tasks" element={<TasksPage />} />
                  <Route path="tasks/new" element={<CreateTaskPage />} />
                  <Route path="tasks/:id" element={<TaskDetailPage />} />
                  <Route path="savings" element={<SavingsPage />} />
                  <Route path="profiles" element={<ProfilesPage />} />
                  <Route path="projects" element={<ProjectsPage />} />
                  <Route path="projects/:id/settings" element={<ProjectsPage />} />
                  <Route path="departments" element={<DepartmentsPage />} />
                  <Route path="settings" element={<SettingsPage />} />
                </Route>
              </Routes>
              </Suspense>
              <TourOverlay />
            </TourProvider>
          </BrowserRouter>
          </AuthGate>
          </BrandingProvider>
        </LocaleProvider>
      </ThemeProvider>
  );
};
