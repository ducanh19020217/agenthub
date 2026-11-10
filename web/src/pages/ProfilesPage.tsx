import React, { lazy, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Check,
  Clock,
  ExternalLink,
  KeyRound,
  MoreVertical,
  Plus,
  RefreshCw,
  Trash2,
  UserRound,
  X,
} from 'lucide-react';
import {
  apiFetch,
  checkProfile,
  createProfile,
  deleteProfile,
  deleteQuota,
  getProfiles,
  getConfig,
  getStatus,
  importAgyTokens,
  ImportTokensResult,
  loginProfile,
  refreshProfileUsage,
  renameProfile,
  updateProfile,
  wakeupProfile,
  updateConfig,
} from '../api/client';
import { subscribeToEvents } from '../api/sse';
import { DailyUsageTable } from '../components/DailyUsageTable';
import { QuotaUsage } from '../components/QuotaUsage';
import { useLocale } from '../context/LocaleContext';
import { ToastViewport, useToasts, type ToastKind } from '../components/ui/Toast';
import { Profile } from '../types/api';
import { formatReset, formatTime, formatTimeTitle, formatIsoTitle } from '../lib/time';
import { useTour } from '../components/tour/TourContext';
import { AgentIcon } from '../components/AgentIcon';
import { CockpitSyncModal } from '../components/CockpitSyncModal';
import { UI_Z_INDEX } from '../components/ui/layers';

const LoginTerminal = lazy(() => import('../components/LoginTerminal').then((m) => ({ default: m.LoginTerminal })));

type Provider = 'agy' | 'codex' | 'claude';
const providers: Array<{ id: Provider; title: string; subtitleKey: string; color: string }> = [
  {
    id: 'agy',
    title: 'Antigravity (Gemini)',
    subtitleKey: 'profiles.antigravitySubtitle',
    color: 'var(--t-accent)',
  },
  {
    id: 'codex',
    title: 'Codex (OpenAI)',
    subtitleKey: 'profiles.codexSubtitle',
    color: 'var(--t-ok)',
  },
  { id: 'claude', title: 'Claude', subtitleKey: 'profiles.claudeSubtitle', color: 'var(--t-warn)' },
];

function StatusBadge({ profile }: { profile: Profile }) {
  const { t } = useLocale();
  const loggedIn = profile.loggedIn ?? Boolean(profile.email);
  const state =
    profile.authState === 'needs_verification'
      ? 'verify'
      : profile.authState === 'error'
        ? 'error'
        : !loggedIn
          ? 'off'
          : 'on';
  const labels = {
    on: t('profiles.loggedIn'),
    off: t('profiles.notLoggedIn'),
    verify: t('profiles.needsVerification'),
    error: t('profiles.error'),
  };
  const colors = {
    on: 'text-[var(--t-ok)] border-[var(--t-ok)]',
    off: 'text-[var(--t-text-3)] border-[var(--t-border)]',
    verify: 'text-[var(--t-warn)] border-[var(--t-warn)]',
    error: 'text-[var(--t-crit)] border-[var(--t-crit)]',
  };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${colors[state]}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {labels[state]}
    </span>
  );
}
function usageText(profile: Profile) {
  const { t } = useLocale();
  if (profile.claudeTokens)
    return t('profiles.claudeUsage', { today: profile.claudeTokens.today.toLocaleString(), week: profile.claudeTokens.week.toLocaleString() });
  const five = profile.usage?.find((u) => u.window === '5h');
  const week = profile.usage?.find((u) => u.window === 'week');
  return five || week
    ? t('profiles.quotaUsage', { five: five ? `${five.remainingPct}% / 5h` : '—', week: week ? `${week.remainingPct}% / ${t('profiles.week')}` : '—' })
    // Quota Codex đọc từ log phiên của Codex CLI, nên chỉ có sau lần chạy đầu tiên của hồ sơ.
    : t(profile.engine === 'codex' ? 'profiles.noCodexQuotaYet' : 'profiles.noQuotaData');
}

export const ProfilesPage: React.FC = () => {
  const { t } = useLocale();
  const { suggestModalTour } = useTour();
  const { hash } = useLocation();
  const queryClient = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [showCockpit, setShowCockpit] = useState(false);
  const [activeLogin, setActiveLogin] = useState<{ name: string; engine: Provider; sessionId: string } | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [editing, setEditing] = useState<Profile | null>(null);
  const [renaming, setRenaming] = useState<Profile | null>(null);
  const [deleting, setDeleting] = useState<Profile | null>(null);
  const [tokenLogin, setTokenLogin] = useState<Profile | null>(null);
  const [checking, setChecking] = useState<Record<string, boolean>>({});
  const [refreshing, setRefreshing] = useState<Record<string, boolean>>({});
  // 'all', 'none' (chưa biết gói) hoặc một id gói như 'pro'.
  const [planFilter, setPlanFilter] = useState<string>('all');
  const checkTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const scrolledHash = useRef<string | null>(null);
  const [showFab, setShowFab] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setShowFab(window.scrollY > 120);
    };
    handleScroll();
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);
  const {
    data: profiles = [],
    isLoading,
    error,
  } = useQuery({ queryKey: ['profiles'], queryFn: getProfiles, refetchInterval: 5000 });

  useEffect(() => {
    if (!hash || isLoading || profiles.length === 0 || scrolledHash.current === hash) return;
    const target = document.getElementById(decodeURIComponent(hash.slice(1)));
    if (target && typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      scrolledHash.current = hash;
    }
  }, [hash, isLoading, profiles]);
  const { data: systemConfig } = useQuery({ queryKey: ['config'], queryFn: getConfig });
  const { data: status } = useQuery({
    queryKey: ['status'],
    queryFn: getStatus,
    refetchInterval: 5000,
  });
  const runningByProfile = new Map((status?.running || []).map((run) => [run.profileName, run]));
  useEffect(() => {
    if (showAdd) suggestModalTour('modal-add-account');
  }, [showAdd, suggestModalTour]);
  const { toasts, push: pushToast, update: updateToast, dismiss: dismissToast } = useToasts();
  /** Thông báo ngắn: tiêu đề + chi tiết tuỳ chọn. */
  const toast = (title: string, kind: ToastKind = 'success', message?: string) => pushToast({ title, kind, message });
  useEffect(
    () =>
      subscribeToEvents((event) => {
        if (event.type !== 'profile.check') return;
        const name = String((event.payload as any)?.name || '');
        if (!name) return;
        clearTimeout(checkTimers.current[name]);
        setChecking((old) => ({ ...old, [name]: false }));
        const ok = Boolean((event.payload as any)?.ok);
        const detail = (event.payload as any)?.message || (ok ? t('profiles.checkSuccess') : t('profiles.checkFailed'));
        const duration = (event.payload as any)?.durationMs ? ` · ${(event.payload as any).durationMs}ms` : '';
        toast(t(ok ? 'profiles.checkOkTitle' : 'profiles.checkFailTitle', { name }), ok ? 'success' : 'error', `${detail}${duration}`);
        queryClient.invalidateQueries({ queryKey: ['profiles'] });
        void refreshProfileUsage(name);
      }),
    [queryClient],
  );
  const runLogin = async (name: string, engine: Provider) => {
    try {
      setActiveLogin({ name, engine, sessionId: (await loginProfile(name)).sessionId });
    } catch (err: any) {
      toast(t('profiles.loginOpenFailed'), 'error', err?.message);
    }
  };
  const runRefresh = async (profile: Profile, silent = false) => {
    setRefreshing((old) => ({ ...old, [profile.name]: true }));
    try {
      const updated = await refreshProfileUsage(profile.name);
      if (silent) return;
      const note = updated?.avatarMessage || updated?.refreshMessage;
      toast(t('profiles.refreshDone', { name: profile.label || profile.name }), 'success', note || undefined);
    } catch (err: any) {
      toast(t('profiles.refreshFailed'), 'error', err?.message);
    } finally {
      setRefreshing((old) => ({ ...old, [profile.name]: false }));
      queryClient.invalidateQueries({ queryKey: ['profiles'] });
    }
  };
  const runWakeup = async (profile: Profile) => {
    const label = profile.label || profile.name;
    const id = pushToast({ kind: 'loading', title: t('profiles.wakeupStarted', { name: label }), message: t('profiles.wakeupStartedHint') });
    try {
      const result = await wakeupProfile(profile.name);
      if (result.skipped) {
        updateToast(id, { kind: 'warning', title: t('profiles.wakeupSkipped', { name: label }), message: result.skipped });
      } else {
        const detail = result.results.map((item) => `${item.ok ? '✓' : '✗'} ${item.target}`).join(' · ');
        updateToast(id, { kind: result.ok ? 'success' : 'error', title: t(result.ok ? 'profiles.wakeupDone' : 'profiles.wakeupFailed', { name: label }), message: detail });
      }
    } catch (err: any) {
      updateToast(id, { kind: 'error', title: t('profiles.wakeupFailed', { name: label }), message: err?.message });
    } finally {
      queryClient.invalidateQueries({ queryKey: ['profiles'] });
    }
  };
  const runToggle = async (profile: Profile, enabled: boolean) => {
    try {
      await updateProfile(profile.name, { enabled });
      toast(t(enabled ? 'profiles.toggledOn' : 'profiles.toggledOff', { name: profile.label || profile.name }));
    } catch (err: any) {
      toast(t('profiles.toggleFailed'), 'error', err?.message);
    } finally {
      queryClient.invalidateQueries({ queryKey: ['profiles'] });
    }
  };
  /** Bật trạng thái đang kiểm tra; sự kiện profile.check (SSE) sẽ tắt nó và hiện kết quả. */
  const watchCheck = (name: string) => {
    clearTimeout(checkTimers.current[name]);
    setChecking((old) => ({ ...old, [name]: true }));
    checkTimers.current[name] = setTimeout(
      () => {
        setChecking((old) => ({ ...old, [name]: false }));
        toast(t('profiles.checkTimeout'), 'warning');
      },
      75_000,
    );
  };
  const runCheck = async (name: string) => {
    watchCheck(name);
    try {
      await checkProfile(name);
    } catch (err: any) {
      clearTimeout(checkTimers.current[name]);
      setChecking((old) => ({ ...old, [name]: false }));
      if (err?.status === 409) toast(t('profiles.checkAlreadyRunning'), 'warning');
      else toast(t('profiles.checkFailTitle', { name }), 'error', err?.message);
    }
  };

  return (
    <div className="space-y-6" onClick={() => menu && setMenu(null)} data-tour="account-types">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('profiles.title')}</h1>
          <p className="text-sm text-[var(--t-text-3)]">
            {t('profiles.subtitle')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-tour="sync-cockpit"
            onClick={(e) => {
              e.stopPropagation();
              setShowCockpit(true);
            }}
            className="inline-flex items-center gap-2 rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2 text-sm font-semibold text-[var(--t-text)] hover:bg-[var(--t-hover)] cursor-pointer"
          >
            <RefreshCw className="h-4 w-4" />
            {t('profiles.syncCockpitBtn')}
          </button>
          <button
            type="button"
            data-tour="add-account"
            onClick={(e) => {
              e.stopPropagation();
              setShowAdd(true);
            }}
            className="inline-flex items-center gap-2 rounded-lg bg-[var(--t-accent)] px-4 py-2 text-sm font-semibold text-[var(--t-on-accent)] cursor-pointer"
          >
            <Plus className="h-4 w-4" />
            {t('profiles.addBtn')}
          </button>
        </div>
      </div>
      <ToastViewport toasts={toasts} onDismiss={dismissToast} closeLabel={t('common.close')} />
      {isLoading ? (
        <div className="p-12 text-center">{t('profiles.loading')}</div>
      ) : error ? (
        <div className="p-8 text-center space-y-3 text-[var(--t-crit)]">
          <p className="text-sm">{t('profiles.loadError')}</p>
          <button
            type="button"
            onClick={() => queryClient.invalidateQueries({ queryKey: ['profiles'] })}
            className="px-3 py-1.5 rounded-lg border border-[var(--t-border)] text-xs font-medium hover:bg-[var(--t-surface-2)] cursor-pointer text-[var(--t-text)]"
          >
            {t('common.retry')}
          </button>
        </div>
      ) : (
        <div className="space-y-8">
          <PlanFilter profiles={profiles} value={planFilter} onChange={setPlanFilter} />
          {providers.map((provider) => {
            const grouped = profiles.filter((profile) => profile.engine === provider.id && matchesPlan(profile, planFilter));
            return (
              <section key={provider.id} aria-labelledby={`provider-${provider.id}`} data-tour="profile-quotas">
                <div className="mb-3 flex items-center gap-3">
                  <div className="h-8 w-1 rounded-full" style={{ background: provider.color }} />
                  <div>
                    <h2 id={`provider-${provider.id}`} className="text-lg font-semibold flex items-center gap-2">
                      <AgentIcon provider={provider.id} className="h-5 w-5 shrink-0" />
                      <span>{provider.title}</span>
                    </h2>
                    <p className="text-xs text-[var(--t-text-3)]">{t(provider.subtitleKey)}</p>
                  </div>
                  <span className="rounded-full bg-[var(--t-surface-2)] px-2 py-0.5 text-xs text-[var(--t-text-3)]">
                    {grouped.length}
                  </span>
                </div>
                {systemConfig?.multiplePerProvider && grouped.filter((profile) => profile.accountType === 'personal').length > 1 && (
                  <div className="mb-3 rounded-lg border border-[var(--t-warn)] bg-[var(--t-warn)]/10 p-3 text-sm text-[var(--t-warn)]">
                    {t('profiles.multiplePersonalWarning')}
                  </div>
                )}
                {grouped.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-[var(--t-border)] p-6 text-sm text-[var(--t-text-3)]">
                    {t('profiles.emptyProvider', { provider: provider.title })}
                  </div>
                ) : (
                  <div className="grid gap-3.5 sm:gap-4 md:grid-cols-2 xl:grid-cols-3">
                    {grouped.map((profile) => (
                      <div key={profile.name} id={`profile-${profile.name}`}>
                      <ProfileCard
                        profile={profile}
                        run={runningByProfile.get(profile.name)}
                        menu={menu}
                        setMenu={setMenu}
                        checking={Boolean(checking[profile.name])}
                        refreshing={Boolean(refreshing[profile.name])}
                        onLogin={runLogin}
                        onTokenLogin={setTokenLogin}
                        onWakeup={runWakeup}
                        onCheck={runCheck}
                        onEdit={setEditing}
                        onRename={setRenaming}
                        onDelete={setDeleting}
                        onToggle={(enabled) => void runToggle(profile, enabled)}
                        onRefresh={(silent) => void runRefresh(profile, silent)}
                        onQuotaRemoved={(family) => toast(t('profiles.removeQuotaSuccess', { family, name: profile.name }))}
                      />
                      </div>
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
      <DailyUsageTable />
      {showAdd && (
        <div data-tour="modal-add-account">
        <AddProfileModal
          onClose={() => {
            setShowAdd(false);
            queryClient.invalidateQueries({ queryKey: ['profiles'] });
          }}
          onCreated={async (name, engine) => {
            setShowAdd(false);
            toast(t('profiles.createdProfile', { name }));
            queryClient.invalidateQueries({ queryKey: ['profiles'] });
            await runLogin(name, engine);
          }}
          onImported={(result) => {
            toast(
              t('profiles.importDone', { success: result.successCount, total: result.total }),
              result.successCount === 0 ? 'error' : result.failedCount > 0 ? 'warning' : 'success',
              result.successCount > 0 ? t('profiles.importCheckingHint') : undefined,
            );
            // Backend tự chạy Check bằng agy cho các tài khoản vừa nhập.
            result.results.filter((item) => item.status === 'ok').forEach((item) => watchCheck(item.name));
            queryClient.invalidateQueries({ queryKey: ['profiles'] });
          }}
        />
        </div>
      )}
      {editing && (
        <EditProfileModal
          profile={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            toast(t('profiles.savedProfile', { name: editing.name }));
            setEditing(null);
            queryClient.invalidateQueries({ queryKey: ['profiles'] });
          }}
        />
      )}
      {renaming && (
        <RenameModal
          profile={renaming}
          onClose={() => setRenaming(null)}
          onSaved={(newName) => {
            toast(t('profiles.renamedProfile', { from: renaming.name, to: newName }));
            setRenaming(null);
            queryClient.invalidateQueries({ queryKey: ['profiles'] });
          }}
        />
      )}
      {deleting && (
        <DeleteModal
          profile={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            toast(t('profiles.deletedProfile', { name: deleting.name }));
            setDeleting(null);
            queryClient.invalidateQueries({ queryKey: ['profiles'] });
          }}
        />
      )}
      {tokenLogin && (
        <TokenLoginModal
          profile={tokenLogin}
          onClose={() => setTokenLogin(null)}
          onDone={(email) => {
            setTokenLogin(null);
            toast(t('profiles.tokenLoginSuccess', { name: tokenLogin.name }), 'success', `${email} · ${t('profiles.importCheckingHint')}`);
            watchCheck(tokenLogin.name);
            queryClient.invalidateQueries({ queryKey: ['profiles'] });
          }}
        />
      )}
      {activeLogin && (
        <LoginWizard
          profileName={activeLogin.name}
          engine={activeLogin.engine}
          sessionId={activeLogin.sessionId}
          onClose={() => {
            setActiveLogin(null);
            queryClient.invalidateQueries({ queryKey: ['profiles'] });
          }}
        />
      )}
      {showCockpit && (
        <CockpitSyncModal
          isOpen={showCockpit}
          onClose={() => setShowCockpit(false)}
          onProfilesUpdated={() => {
            queryClient.invalidateQueries({ queryKey: ['profiles'] });
          }}
        />
      )}
      {/* Floating Action Button (FAB) khi cuộn trang */}
      <button
        type="button"
        data-testid="fab-add-account"
        aria-label={t('profiles.addBtn')}
        onClick={(e) => {
          e.stopPropagation();
          setShowAdd(true);
        }}
        className={`fixed bottom-8 right-8 z-30 flex items-center gap-2 rounded-full bg-[var(--t-accent)] p-3 sm:px-4 sm:py-3 text-sm font-semibold text-[var(--t-on-accent)] shadow-xl shadow-[var(--t-accent)]/30 ring-1 ring-[var(--t-on-accent)]/20 transition-all duration-300 ease-out hover:scale-105 hover:shadow-2xl hover:shadow-[var(--t-accent)]/45 active:scale-95 cursor-pointer ${
          showFab
            ? 'translate-y-0 opacity-100 pointer-events-auto'
            : 'translate-y-6 opacity-0 pointer-events-none'
        }`}
      >
        <Plus className="h-5 w-5" />
        <span className="hidden sm:inline">{t('profiles.addBtn')}</span>
      </button>
    </div>
  );
};

function getAvatarGradient(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h1 = Math.abs(hash) % 360;
  const h2 = (h1 + 45) % 360;
  return `linear-gradient(135deg, hsl(${h1}, 65%, 45%), hsl(${h2}, 75%, 35%))`;
}

function ProfileAvatar({ profile }: { profile: Profile }) {
  const [imgError, setImgError] = useState(false);
  const avatarUrl = profile.avatarUrl;

  useEffect(() => {
    setImgError(false);
  }, [avatarUrl]);

  if (avatarUrl && !imgError) {
    return (
      <div className="relative shrink-0">
        <img
          src={avatarUrl}
          alt={profile.label || profile.name}
          referrerPolicy="no-referrer"
          onError={() => setImgError(true)}
          className="h-9 w-9 rounded-xl object-cover shadow-xs ring-1 ring-[var(--t-border)]"
        />
      </div>
    );
  }

  const displayName = profile.label || profile.email || profile.name;
  const initial = displayName.trim().charAt(0).toUpperCase();

  if (initial) {
    return (
      <div
        className="flex h-9 w-9 shrink-0 select-none items-center justify-center rounded-xl font-bold text-[var(--t-on-accent)] shadow-xs"
        style={{ background: getAvatarGradient(profile.email || profile.name) }}
      >
        <span className="text-sm tracking-wider drop-shadow-xs">{initial}</span>
      </div>
    );
  }

  return (
    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--t-surface-2)] text-[var(--t-accent)] shadow-xs ring-1 ring-[var(--t-border)]">
      <UserRound className="h-4.5 w-4.5" />
    </div>
  );
}

const PLAN_LABELS: Record<string, string> = {
  free: 'FREE', plus: 'PLUS', pro: 'PRO', team: 'TEAM', business: 'BUSINESS', enterprise: 'ENTERPRISE',
  edu: 'EDU', max: 'MAX', max_5x: 'MAX 5X', max_20x: 'MAX 20X', ultra: 'ULTRA',
};

function matchesPlan(profile: Profile, filter: string): boolean {
  if (filter === 'all') return true;
  const plan = profile.plan && PLAN_LABELS[profile.plan] ? profile.plan : null;
  return filter === 'none' ? plan === null : plan === filter;
}

/** Bộ lọc theo gói (FREE/PLUS/PRO…) kèm số hồ sơ; ẩn khi chưa hồ sơ nào biết gói. */
function PlanFilter({ profiles, value, onChange }: { profiles: Profile[]; value: string; onChange: (value: string) => void }) {
  const { t } = useLocale();
  const counts = new Map<string, number>();
  for (const profile of profiles) {
    const key = profile.plan && PLAN_LABELS[profile.plan] ? profile.plan : 'none';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const known = Object.keys(PLAN_LABELS).filter((plan) => counts.has(plan));
  if (known.length === 0) return null;
  const options = [
    { id: 'all', label: t('profiles.planAll'), count: profiles.length },
    ...known.map((plan) => ({ id: plan, label: PLAN_LABELS[plan], count: counts.get(plan) ?? 0 })),
    ...(counts.has('none') ? [{ id: 'none', label: t('profiles.planUnknown'), count: counts.get('none') ?? 0 }] : []),
  ];
  return (
    <div role="group" aria-label={t('profiles.planFilterAria')} className="flex flex-wrap items-center gap-2">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
          className={`rounded-full border px-3 py-1 text-xs font-medium ${
            value === option.id
              ? 'border-[var(--t-accent)] bg-[var(--t-accent-bg)] text-[var(--t-accent)]'
              : 'border-[var(--t-border)] text-[var(--t-text-3)] hover:text-[var(--t-text)]'
          }`}
        >
          {option.label} <span className="opacity-70">({option.count})</span>
        </button>
      ))}
    </div>
  );
}

/** Tag gói tài khoản kiểu Cockpit: màu theo hạng, ẩn khi chưa biết gói. */
function PlanBadge({ plan }: { plan?: string | null }) {
  if (!plan || !PLAN_LABELS[plan]) return null;
  const color = plan === 'free'
    ? 'var(--t-text-3)'
    : plan === 'plus'
      ? 'var(--t-ok)'
      : plan === 'pro'
        ? 'var(--t-accent)'
        : plan.startsWith('max') || plan === 'ultra'
          ? 'var(--t-purple)'
          : 'var(--t-warn)';
  return (
    <span
      data-testid="plan-badge"
      className="rounded-full border px-2 py-0.5 text-[10px] font-bold tracking-wide"
      style={{ color, borderColor: color }}
    >
      {PLAN_LABELS[plan]}
    </span>
  );
}

function ProfileCard({
  profile,
  run,
  menu,
  setMenu,
  checking,
  refreshing,
  onLogin,
  onTokenLogin,
  onWakeup,
  onCheck,
  onEdit,
  onRename,
  onDelete,
  onToggle,
  onRefresh,
  onQuotaRemoved,
}: {
  profile: Profile;
  run?: any;
  menu: string | null;
  setMenu: (name: string | null) => void;
  checking: boolean;
  refreshing: boolean;
  onLogin: (name: string, engine: Provider) => void;
  onTokenLogin: (profile: Profile) => void;
  onWakeup: (profile: Profile) => void;
  onCheck: (name: string) => void;
  onEdit: (profile: Profile) => void;
  onRename: (profile: Profile) => void;
  onDelete: (profile: Profile) => void;
  onToggle: (enabled: boolean) => void;
  /** silent: tải lại ngầm sau thao tác khác (đã có thông báo riêng). */
  onRefresh: (silent?: boolean) => void;
  onQuotaRemoved: (family: string) => void;
}) {
  const { t, locale } = useLocale();
  const logged = profile.loggedIn ?? Boolean(profile.email);
  const canLogin = profile.kind !== 'keyring' || profile.engine === 'claude';
  // Refresh token chỉ ghi được vào HOME riêng của hồ sơ agy isolated.
  const canTokenLogin = profile.engine === 'agy' && profile.kind === 'isolated';
  const busy = Boolean(profile.busy || profile.isBusy);
  const activeMarks = (profile.quotaMarks || []).filter((mark) => mark.until > Math.floor(Date.now() / 1000));
  return (
    <article
      className="relative rounded-xl border border-[var(--t-border)] bg-[var(--t-surface)] p-3.5 sm:p-4 shadow-xs hover:border-[var(--t-border-strong)] transition-colors"
      data-testid={`profile-card-${profile.name}`}
    >
      <div className="flex items-start justify-between gap-2.5">
        <div className="flex min-w-0 items-start gap-2.5">
          <ProfileAvatar profile={profile} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <h3 className="truncate text-sm font-semibold leading-tight">{profile.label || profile.name}</h3>
              {profile.label && (
                <span className="font-mono text-[11px] text-[var(--t-text-3)]">({profile.name})</span>
              )}
              <PlanBadge plan={profile.plan} />
              {busy && (
                <span className="rounded bg-[var(--t-accent-bg)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--t-accent)]">
                  {t('profiles.busyTag')}
                </span>
              )}
              {profile.coolingUntil && profile.coolingUntil > Math.floor(Date.now() / 1000) && (
                <span
                  className="rounded bg-[var(--t-warn)]/15 px-1.5 py-0.5 text-[10px] font-bold text-[var(--t-warn)]"
                  title={formatIsoTitle(profile.coolingUntil * 1000)}
                >
                  {t('profiles.coolingUntil', {
                    time: formatTime(profile.coolingUntil * 1000, locale),
                  })}
                </span>
              )}
            </div>
            <p className="truncate text-xs text-[var(--t-text-3)] mt-0.5" title={logged ? (profile.email || '') : ''}>
              {logged
                ? profile.email || (profile.engine === 'codex' ? 'Codex (ChatGPT)' : t('profiles.authenticated'))
                : t('profiles.noEmail')}
            </p>
          </div>
        </div>
        <div className="relative shrink-0">
          <button
            type="button"
            aria-label={t('profiles.actionsAria', { name: profile.name })}
            onClick={(e) => {
              e.stopPropagation();
              setMenu(menu === profile.name ? null : profile.name);
            }}
            className="rounded-lg p-1.5 text-[var(--t-text-3)] hover:bg-[var(--t-surface-2)]"
          >
            <MoreVertical className="h-4 w-4" />
          </button>
          {menu === profile.name && (
            <div
              onClick={(e) => e.stopPropagation()}
              className="absolute right-0 top-10 w-44 rounded-lg border border-[var(--t-border)] bg-[var(--t-surface)] p-1 shadow-xl"
              style={{ zIndex: UI_Z_INDEX.popover }}
            >
              <button
                type="button"
                className="menu-item"
                onClick={() => {
                  setMenu(null);
                  onLogin(profile.name, profile.engine);
                }}
              >
                {logged ? t('extra.reLogin') : t('profiles.loginNow')}
              </button>
              {canTokenLogin && (
                <button
                  type="button"
                  className="menu-item"
                  onClick={() => {
                    setMenu(null);
                    onTokenLogin(profile);
                  }}
                >
                  {t('profiles.tokenLogin')}
                </button>
              )}
              <button
                type="button"
                className="menu-item"
                onClick={() => {
                  setMenu(null);
                  onCheck(profile.name);
                }}
              >
                {t('profiles.checkBtn')}
              </button>
              {['agy', 'codex', 'claude'].includes(profile.engine) && logged && (
                <button
                  type="button"
                  className="menu-item"
                  title={t('profiles.wakeupTip')}
                  onClick={() => {
                    setMenu(null);
                    onWakeup(profile);
                  }}
                >
                  {t('profiles.wakeupBtn')}
                </button>
              )}
              <button
                type="button"
                className="menu-item"
                onClick={() => {
                  setMenu(null);
                  onEdit(profile);
                }}
              >
                {t('common.edit')}
              </button>
              <button
                type="button"
                className="menu-item"
                onClick={() => {
                  setMenu(null);
                  onRename(profile);
                }}
              >
                {t('profiles.rename')}
              </button>
              {profile.kind !== 'system' && (
                <button
                  type="button"
                  className="menu-item text-[var(--t-crit)]"
                  onClick={() => {
                    setMenu(null);
                    onDelete(profile);
                  }}
                >
                  {t('extra.deleteProfile')}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <StatusBadge profile={profile} />
        {profile.duplicateWarning && (
          <span title={t('profiles.duplicateTip')} className="inline-flex items-center gap-1 rounded-full border border-[var(--t-crit)] px-2 py-0.5 text-[10px] font-semibold text-[var(--t-crit)]">
            <AlertTriangle className="h-3 w-3" />
            {profile.duplicateEmailWith?.length
              ? t('profiles.duplicateEmail', { emails: profile.duplicateEmailWith.join(', ') })
              : t('profiles.duplicateEmailNoProfiles')}
          </span>
        )}
        <span className="text-[11px] text-[var(--t-text-3)]">{t('profiles.priority', { value: profile.priority ?? 0 })}</span>
        <span className="rounded-full bg-[var(--t-surface-2)] px-2 py-0.5 text-[10px] text-[var(--t-text-3)]">
          {t(`profiles.accountTypes.${profile.accountType || 'personal'}`)}
        </span>
      </div>
      {profile.authState === 'needs_verification' && profile.verifyUrl && (
        <a
          href={profile.verifyUrl}
          target="_blank"
          rel="noopener"
          className="mt-1.5 inline-flex items-center gap-1 text-xs text-[var(--t-warn)] hover:underline"
        >
          <ExternalLink className="h-3 w-3" />
          {t('profiles.openVerification')}
        </a>
      )}
      {profile.authState === 'needs_verification' && (
        <p className="mt-1 text-xs text-[var(--t-text-3)]">{t('profiles.verificationTip')}</p>
      )}
      <div className="mt-2.5 rounded-lg bg-[var(--t-surface-2)] p-2.5">
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium text-[11px] text-[var(--t-text-2)]">{t('profiles.quotaTitle')}</span>
          <span className="text-[11px] text-[var(--t-text-3)]">{usageText(profile)}</span>
        </div>
        <div className="mt-1.5">
          <QuotaUsage usage={profile.usage} onRefresh={() => onRefresh()} refreshing={refreshing} />
        </div>
        {activeMarks.map((mark) => (
          <div key={mark.family} data-testid={`quota-mark-${mark.family}`} title={mark.reason || undefined} className="mt-2 flex items-center justify-between rounded border border-[var(--t-warn)] px-2 py-1 text-xs text-[var(--t-warn)]">
            <span title={formatTimeTitle(mark.until, locale, mark.reason || 'quota mark')}>{t('profiles.quotaLocked', { family: mark.family, time: formatReset(mark.until, Date.now(), locale) })}</span>
            <button type="button" onClick={() => { if (window.confirm(t('profiles.confirmRemoveQuota', { family: mark.family, name: profile.name }))) void deleteQuota(profile.name, mark.family).then(() => { onRefresh(true); onQuotaRemoved(mark.family); }); }} className="ml-2 underline">{t('profiles.removeQuota')}</button>
          </div>
        ))}
      </div>
      {profile.engine === 'claude' && Boolean(profile.limitedSessions && profile.limitedSessions.length > 0) && (
        <div className="mt-4 rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)]/60 p-3" data-testid={`claude-limited-section-${profile.name}`}>
          <div className="flex items-center justify-between text-xs font-semibold">
            <span className="flex items-center gap-1.5 text-[var(--t-warn)]">
              <Clock className="h-3.5 w-3.5" />
              {t('profiles.limitedSessions')}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  void apiFetch('/api/claude/sessions/clean-reset', { method: 'POST' }).then(() => {
                    onRefresh(true);
                  });
                }}
                className="text-[11px] font-normal text-[var(--t-accent)] hover:underline cursor-pointer"
                data-testid={`clean-reset-sessions-${profile.name}`}
              >
                {t('profiles.cleanResetSessions')}
              </button>
              <span className="rounded-full bg-[var(--t-warn)]/10 px-2 py-0.5 text-[10px] text-[var(--t-warn)] font-bold">
                {profile.limitedSessions?.length || 0}
              </span>
            </div>
          </div>
          <div className="mt-2 space-y-2.5">
            {profile.limitedSessions?.map((session) => {
              const isWaitingReset = session.limitResetAt * 1000 > Date.now();
              return (
                <div
                  key={session.sessionId}
                  className="rounded-md border border-[var(--t-border)] bg-[var(--t-surface)] p-2.5 text-xs shadow-2xs space-y-1.5"
                  data-testid={`limited-session-${session.sessionId}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-semibold text-[var(--t-text)] truncate max-w-[220px]" title={session.title || session.sessionId}>
                      {session.title || (session.sessionId.length > 8 ? session.sessionId.slice(0, 8) : session.sessionId)}
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          void apiFetch(`/api/claude/sessions/${encodeURIComponent(session.sessionId)}/dismiss-limit`, { method: 'POST' }).then(() => {
                            onRefresh(true);
                          });
                        }}
                        className="text-[var(--t-text-3)] hover:text-[var(--t-warn)] hover:underline whitespace-nowrap text-[11px] cursor-pointer"
                        data-testid={`dismiss-limit-${session.sessionId}`}
                      >
                        {t('profiles.dismissLimit')}
                      </button>
                      <Link
                        to={`/claude-sessions/${encodeURIComponent(session.sessionId)}`}
                        className="text-[var(--t-accent)] hover:underline whitespace-nowrap text-[11px]"
                      >
                        {t('profiles.viewDetails')} →
                      </Link>
                    </div>
                  </div>
                  <div className="font-mono text-[11px] text-[var(--t-text-3)] truncate" title={session.cwd}>
                    {session.cwd}
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--t-border)] pt-1.5 text-[11px]">
                    <span className="text-[var(--t-warn)]">
                      {isWaitingReset ? (
                        <span title={formatTimeTitle(session.limitResetAt, locale, 'Claude session limit')}>
                          {t('profiles.waitingForReset')}: {formatReset(session.limitResetAt, Date.now(), locale)}
                        </span>
                      ) : (
                        <span>{t('profiles.waitingAutoResume')}</span>
                      )}
                    </span>
                    <label className="flex items-center gap-1.5 cursor-pointer text-[var(--t-text-2)] hover:text-[var(--t-text)]">
                      <input
                        type="checkbox"
                        checked={session.autoResumeEnabled}
                        onChange={(e) => {
                          const nextVal = e.target.checked;
                          void apiFetch(`/api/claude/sessions/${encodeURIComponent(session.sessionId)}/auto-resume`, {
                            method: 'PATCH',
                            body: JSON.stringify({ enabled: nextVal }),
                          }).then(() => {
                            onRefresh(true);
                          });
                        }}
                        className="rounded border-[var(--t-border)]"
                      />
                      <span>{t('profiles.autoResumeLimit')}</span>
                    </label>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <div className="mt-2.5 flex items-center gap-1.5 text-xs text-[var(--t-text-3)]">
        {run ? (
          <>
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--t-ok)] shrink-0" />
            <span className="truncate">{t('profiles.runningTask')}: <strong className="font-medium text-[var(--t-text)]">{run.title || run.taskId}</strong></span>
          </>
        ) : (
          <>
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--t-text-3)] shrink-0" />
            <span>{t('profiles.idleTask')}</span>
          </>
        )}
      </div>
      {profile.notes && (
        <p className="mt-1.5 border-l-2 border-[var(--t-border)] pl-2 text-xs text-[var(--t-text-3)] line-clamp-2">
          {profile.notes}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--t-border)] pt-2.5">
        <label className="flex items-center gap-1.5 text-xs text-[var(--t-text-3)] cursor-pointer select-none">
          <button type="button" aria-label={t('profiles.toggleAria', { name: profile.name })} disabled={profile.kind === 'system'} onClick={() => onToggle(!Boolean(profile.enabled))} className={`h-4.5 w-8 rounded-full p-0.5 ${profile.enabled ? 'bg-[var(--t-accent)]' : 'bg-[var(--t-surface-2)]'} transition-colors cursor-pointer`}>
            <span className={`block h-3.5 w-3.5 rounded-full bg-[var(--t-surface)] transition-transform ${profile.enabled ? 'translate-x-3.5' : ''}`} />
          </button>
          <span>{t('profiles.enable')}</span>
        </label>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => onCheck(profile.name)}
            disabled={checking}
            className="inline-flex items-center gap-1 rounded border border-[var(--t-border)] px-2 py-1 text-xs hover:bg-[var(--t-hover)] transition-colors disabled:opacity-50 cursor-pointer"
          >
            {checking ? (
              <RefreshCw className="h-3 w-3 animate-spin" />
            ) : (
              <Check className="h-3 w-3" />
            )}
            <span>{checking ? t('profiles.checkingBtn') : t('profiles.checkBtn')}</span>
          </button>
          {canTokenLogin && (
            <button
              type="button"
              onClick={() => onTokenLogin(profile)}
              className="inline-flex items-center gap-1 rounded border border-[var(--t-border)] px-2 py-1 text-xs hover:bg-[var(--t-hover)] transition-colors cursor-pointer"
            >
              <KeyRound className="h-3 w-3" />
              <span>{t('profiles.tokenLoginShort')}</span>
            </button>
          )}
          {canLogin && (
            <button
              type="button"
              aria-label={logged ? t('extra.reLogin') : t('profiles.loginBtn')}
              onClick={() => onLogin(profile.name, profile.engine)}
              className="rounded bg-[var(--t-accent-bg)] px-2 py-1 text-xs font-medium text-[var(--t-accent)] hover:opacity-90 transition-opacity cursor-pointer"
            >
              {logged ? t('extra.reLogin') : t('profiles.loginNow')}
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

function Modal({
  title,
  onClose,
  children,
  maxWidth = 'max-w-md',
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  maxWidth?: string;
}) {
  const { t } = useLocale();
  return (
    <div
      className="fixed inset-0 flex items-center justify-center bg-[var(--t-overlay)] p-4"
      style={{ zIndex: UI_Z_INDEX.modal }}
      role="dialog"
      aria-modal="true"
    >
      <div className={`w-full ${maxWidth} rounded-xl border border-[var(--t-border)] bg-[var(--t-surface)] p-6 shadow-2xl max-h-[90vh] overflow-y-auto`}>
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button type="button" onClick={onClose} aria-label={t('extra.closeProfile')}>
            <X className="h-5 w-5" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function AddProfileModal({
  onClose,
  onCreated,
  onImported,
}: {
  onClose: () => void;
  onCreated: (name: string, engine: Provider) => void;
  onImported: (result: ImportTokensResult) => void;
}) {
  const { t } = useLocale();
  const [engine, setEngine] = useState<Provider>('agy');
  const [method, setMethod] = useState<'terminal' | 'cockpit'>('terminal');
  // Nhập token có cho Antigravity (refresh token kiểu Cockpit) và Codex (JSON id/access/refresh token).
  const supportsTokenImport = engine === 'agy' || engine === 'codex';

  // Terminal state
  const [name, setName] = useState('');
  const [accountType, setAccountType] = useState<'personal' | 'team' | 'api'>('personal');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Cockpit token state
  const [cockpitJson, setCockpitJson] = useState('');
  const [cockpitAccountType, setCockpitAccountType] = useState<'personal' | 'team' | 'api'>('personal');
  const [cockpitError, setCockpitError] = useState('');
  const [cockpitLoading, setCockpitLoading] = useState(false);
  const [cockpitResult, setCockpitResult] = useState<ImportTokensResult | null>(null);

  const handleCreateTerminal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError(t('profiles.accountNameRequired'));
      return;
    }
    setLoading(true);
    setError('');
    try {
      await createProfile({ name: name.trim(), engine, accountType });
      onCreated(name.trim(), engine);
    } catch (err: any) {
      setError(err?.message || t('profiles.createFailed'));
    } finally {
      setLoading(false);
    }
  };

  const handleImportCockpit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cockpitJson.trim()) {
      setCockpitError(t('profiles.cockpitJsonRequired'));
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(cockpitJson);
    } catch {
      setCockpitError(t('profiles.invalidJson'));
      return;
    }
    setCockpitLoading(true);
    setCockpitError('');
    try {
      const result = await importAgyTokens({
        engine: engine === 'codex' ? 'codex' : 'agy',
        tokens: parsed,
        accountType: cockpitAccountType,
      });
      setCockpitResult(result);
      // Không giữ refresh token trong state khi đã nhập xong; giữ lại để sửa nếu có mục lỗi.
      if (result.failedCount === 0) setCockpitJson('');
      onImported(result);
    } catch (err: any) {
      setCockpitError(err?.message || t('profiles.importFailed'));
    } finally {
      setCockpitLoading(false);
    }
  };

  const enableAndRetryImport = async () => {
    setCockpitLoading(true);
    setCockpitError('');
    try {
      const parsed = JSON.parse(cockpitJson);
      await updateConfig({ multiplePerProvider: true });
      const result = await importAgyTokens({ tokens: parsed, accountType: cockpitAccountType });
      setCockpitResult(result);
      if (result.failedCount === 0) setCockpitJson('');
      onImported(result);
    } catch (err: any) {
      setCockpitError(err?.message || t('profiles.importFailed'));
    } finally {
      setCockpitLoading(false);
    }
  };

  return (
    <Modal
      title={t('profiles.addBtn')}
      onClose={onClose}
      maxWidth="max-w-lg"
    >
      <div className="space-y-4">
        <label className="block text-sm">
          {t('profiles.provider')}
          <select
            data-tour="account-provider"
            value={engine}
            onChange={(e) => {
              const next = e.target.value as Provider;
              setEngine(next);
              if (next !== 'agy' && next !== 'codex') {
                setMethod('terminal');
              }
              // Dữ liệu token của engine này không dùng được cho engine khác.
              setCockpitJson('');
              setCockpitResult(null);
              setCockpitError('');
            }}
            className="field mt-1"
          >
            <option value="agy">Antigravity (Gemini)</option>
            <option value="codex">Codex (OpenAI)</option>
            <option value="claude">Claude</option>
          </select>
        </label>

        {supportsTokenImport && (
          <div>
            <span className="block text-xs font-medium text-[var(--t-text-3)] mb-1.5">
              {t('profiles.authMethod')}
            </span>
            <div data-tour="account-login-method" className="grid grid-cols-2 gap-2 rounded-lg border border-[var(--t-border)] p-1 bg-[var(--t-surface-2)]">
              <button
                type="button"
                onClick={() => {
                  setMethod('terminal');
                  setCockpitError('');
                }}
                className={`rounded-md py-1.5 text-center text-xs font-semibold transition-all cursor-pointer ${
                  method === 'terminal'
                    ? 'bg-[var(--t-surface)] text-[var(--t-text)] border border-[var(--t-border)] shadow-xs'
                    : 'text-[var(--t-text-2)] hover:text-[var(--t-text)] hover:bg-[var(--t-hover)] border border-transparent'
                }`}
              >
                {t('profiles.tabTerminalLogin')}
              </button>
              <button
                type="button"
                onClick={() => {
                  setMethod('cockpit');
                  setError('');
                }}
                className={`rounded-md py-1.5 text-center text-xs font-semibold transition-all cursor-pointer ${
                  method === 'cockpit'
                    ? 'bg-[var(--t-surface)] text-[var(--t-text)] border border-[var(--t-border)] shadow-xs'
                    : 'text-[var(--t-text-2)] hover:text-[var(--t-text)] hover:bg-[var(--t-hover)] border border-transparent'
                }`}
              >
                {t(engine === 'codex' ? 'profiles.tabImportCodex' : 'profiles.tabImportCockpit')}
              </button>
            </div>
          </div>
        )}

        {!supportsTokenImport || method === 'terminal' ? (
          <form onSubmit={handleCreateTerminal} className="space-y-4">
            <p className="text-xs text-[var(--t-text-3)]">
              {t('profiles.addDescription')}
            </p>
            {error && (
              <p className="rounded bg-[var(--t-crit)]/10 p-2 text-xs text-[var(--t-crit)]">
                {error}
              </p>
            )}
            <label data-tour="account-name" className="block text-sm">
              {t('profiles.accountName')}
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('profiles.accountNamePlaceholder')}
                className="field mt-1"
              />
            </label>
            <label className="block text-sm">
              {t('profiles.accountType')}
              <select
                value={accountType}
                onChange={(e) => setAccountType(e.target.value as typeof accountType)}
                className="field mt-1"
              >
                <option value="personal">{t('profiles.personal')}</option>
                <option value="team">{t('profiles.team')}</option>
                <option value="api">{t('profiles.api')}</option>
              </select>
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={onClose} className="button-secondary">
                {t('common.cancel')}
              </button>
              <button type="submit" disabled={loading} className="button-primary">
                {loading ? t('profiles.creating') : t('profiles.createAndGuide')}
              </button>
            </div>
          </form>
        ) : (
          <div className="space-y-4">
            {cockpitResult ? (
              <div className="space-y-3">
                <div className="rounded-lg border border-[var(--t-border)] p-3 bg-[var(--t-surface-2)]">
                  <p className="text-sm font-medium">
                    {t('profiles.importResultTitle', {
                      success: cockpitResult.successCount,
                      total: cockpitResult.total,
                    })}
                  </p>
                </div>
                <div className="max-h-60 overflow-y-auto space-y-2 pr-1">
                  {cockpitResult.results.map((res, i) => (
                    <div
                      key={i}
                      className={`flex items-start gap-2.5 rounded-lg border p-2.5 text-xs ${
                        res.status === 'ok'
                          ? 'border-[var(--t-ok)]/30 bg-[var(--t-ok)]/10 text-[var(--t-text)]'
                          : 'border-[var(--t-crit)]/30 bg-[var(--t-crit)]/10 text-[var(--t-crit)]'
                      }`}
                    >
                      <span className="mt-0.5 font-bold">
                        {res.status === 'ok' ? '✓' : '✗'}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          {res.name && <span className="font-semibold">{res.name}</span>}
                          {res.email && (
                            <span className="text-[var(--t-text-3)] truncate">({res.email})</span>
                          )}
                        </div>
                        {res.message && (
                          <p className="mt-0.5 opacity-90">{res.message}</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="flex justify-end gap-2 pt-2">
                  {cockpitResult.failedCount > 0 && (
                    <button type="button" onClick={() => setCockpitResult(null)} className="button-secondary">
                      {t('profiles.importBack')}
                    </button>
                  )}
                  {cockpitResult.results.some((item) => item.status === 'error' && (item.message?.includes('Cho phép nhiều tài khoản') || item.message?.includes('Allow multiple accounts'))) && (
                    <button type="button" disabled={cockpitLoading} onClick={enableAndRetryImport} className="button-secondary">
                      {cockpitLoading ? t('profiles.importingTokens') : t('profiles.enableMultipleAndRetry')}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={onClose}
                    className="button-primary"
                  >
                    {t('profiles.doneAndClose')}
                  </button>
                </div>
              </div>
            ) : (
              <form onSubmit={handleImportCockpit} className="space-y-4">
                <p className="text-xs text-[var(--t-text-3)]">
                  {t(engine === 'codex' ? 'profiles.codexImportDesc' : 'profiles.cockpitImportDesc')}
                </p>
                {cockpitError && (
                  <p className="rounded bg-[var(--t-crit)]/10 p-2 text-xs text-[var(--t-crit)]">
                    {cockpitError}
                  </p>
                )}
                <label className="block text-sm">
                  {t('profiles.cockpitJsonLabel')}
                  <textarea
                    data-tour="account-token"
                    autoFocus
                    spellCheck={false}
                    autoComplete="off"
                    value={cockpitJson}
                    onChange={(e) => setCockpitJson(e.target.value)}
                    placeholder={t(engine === 'codex' ? 'profiles.codexJsonPlaceholder' : 'profiles.cockpitJsonPlaceholder')}
                    rows={6}
                    className="field mt-1 font-mono text-xs leading-relaxed"
                  />
                </label>
                <label className="block text-sm">
                  {t('profiles.accountType')}
                  <select
                    value={cockpitAccountType}
                    onChange={(e) => setCockpitAccountType(e.target.value as typeof cockpitAccountType)}
                    className="field mt-1"
                  >
                    <option value="personal">{t('profiles.personal')}</option>
                    <option value="team">{t('profiles.team')}</option>
                    <option value="api">{t('profiles.api')}</option>
                  </select>
                </label>
                <div className="flex justify-end gap-2 pt-2">
                  <button type="button" onClick={onClose} className="button-secondary">
                    {t('common.cancel')}
                  </button>
                  <button
                    type="submit"
                    disabled={cockpitLoading}
                    className="button-primary"
                  >
                    {cockpitLoading ? t('profiles.importingTokens') : t('profiles.importTokensBtn')}
                  </button>
                </div>
              </form>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
function TokenLoginModal({
  profile,
  onClose,
  onDone,
}: {
  profile: Profile;
  onClose: () => void;
  onDone: (email: string) => void;
}) {
  const { t } = useLocale();
  const [email, setEmail] = useState(profile.email || '');
  const [refreshToken, setRefreshToken] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  return (
    <Modal title={t('profiles.tokenLoginTitle', { name: profile.label || profile.name })} onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!email.trim() || !refreshToken.trim()) {
            setError(t('profiles.tokenLoginRequired'));
            return;
          }
          setLoading(true);
          setError('');
          try {
            const result = await importAgyTokens({
              tokens: [{ name: profile.name, email: email.trim(), refresh_token: refreshToken.trim() }],
              accountType: profile.accountType,
            });
            const item = result.results[0];
            if (item?.status === 'ok') {
              setRefreshToken('');
              onDone(item.email);
            } else {
              setError(item?.message || t('profiles.importFailed'));
            }
          } catch (err: any) {
            setError(err?.message || t('profiles.importFailed'));
          } finally {
            setLoading(false);
          }
        }}
      >
        <p className="text-xs text-[var(--t-text-3)]">{t('profiles.tokenLoginDesc')}</p>
        {error && (
          <p className="rounded bg-[var(--t-crit)]/10 p-2 text-xs text-[var(--t-crit)]">{error}</p>
        )}
        <label className="block text-sm">
          {t('profiles.email')}
          <input
            type="email"
            autoFocus={!email}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="user@gmail.com"
            className="field mt-1"
          />
        </label>
        <label className="block text-sm">
          {t('profiles.refreshToken')}
          <textarea
            autoFocus={Boolean(email)}
            spellCheck={false}
            autoComplete="off"
            rows={3}
            value={refreshToken}
            onChange={(e) => setRefreshToken(e.target.value)}
            placeholder="1//..."
            className="field mt-1 font-mono text-xs"
          />
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="button-secondary">
            {t('common.cancel')}
          </button>
          <button type="submit" disabled={loading} className="button-primary">
            {loading ? t('profiles.tokenLoginVerifying') : t('profiles.tokenLoginBtn')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function EditProfileModal({
  profile,
  onClose,
  onSaved,
}: {
  profile: Profile;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useLocale();
  const [label, setLabel] = useState(profile.label || '');
  const [notes, setNotes] = useState(profile.notes || '');
  const [priority, setPriority] = useState(String(profile.priority ?? 0));
  const [enabled, setEnabled] = useState(Boolean(profile.enabled));
  const [error, setError] = useState('');
  return (
    <Modal title={t('extra.editProfileTitle', { name: profile.name })} onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await updateProfile(profile.name, {
              label: label || null,
              notes: notes || null,
              priority: Number(priority) || 0,
              enabled,
            });
            onSaved();
          } catch (err: any) {
            setError(err?.message || t('extra.saveProfileError'));
          }
        }}
      >
        <label className="block text-sm">
          {t('extra.displayName')}
          <input className="field mt-1" value={label} onChange={(e) => setLabel(e.target.value)} />
        </label>
        <label className="block text-sm">
          {t('extra.notes')}
          <textarea
            className="field mt-1"
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>
        <label className="block text-sm">
          {t('extra.priority')}
          <input
            className="field mt-1"
            type="number"
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          {t('extra.enableProfile')}
        </label>
        {error && <p className="text-xs text-[var(--t-crit)]">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="button-secondary" onClick={onClose}>
            {t('extra.cancel')}
          </button>
          <button className="button-primary">{t('extra.save')}</button>
        </div>
      </form>
    </Modal>
  );
}
function RenameModal({
  profile,
  onClose,
  onSaved,
}: {
  profile: Profile;
  onClose: () => void;
  onSaved: (newName: string) => void;
}) {
  const { t } = useLocale();
  const [name, setName] = useState(profile.name);
  const [error, setError] = useState('');
  return (
    <Modal title={t('extra.renameProfileTitle', { name: profile.name })} onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await renameProfile(profile.name, name.trim());
            onSaved(name.trim());
          } catch (err: any) {
            setError(err?.message || t('extra.renameError'));
          }
        }}
      >
        <label className="block text-sm">
          {t('extra.displayName')}
          <input
            className="field mt-1"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </label>
        {error && <p className="text-xs text-[var(--t-crit)]">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="button-secondary" onClick={onClose}>
            {t('extra.cancel')}
          </button>
          <button className="button-primary">{t('extra.rename')}</button>
        </div>
      </form>
    </Modal>
  );
}
function DeleteModal({
  profile,
  onClose,
  onDeleted,
}: {
  profile: Profile;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { t } = useLocale();
  const [typed, setTyped] = useState('');
  const [purge, setPurge] = useState(false);
  const [error, setError] = useState('');
  return (
    <Modal title={t('extra.deleteProfileTitle', { name: profile.name })} onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (typed !== profile.name) {
            setError(t('extra.nameMismatch'));
            return;
          }
          try {
            await deleteProfile(profile.name, purge && profile.kind !== 'keyring');
            onDeleted();
          } catch (err: any) {
            setError(err?.message || t('extra.deleteError'));
          }
        }}
      >
        <p className="text-sm text-[var(--t-text-3)]">
          {t('profiles.confirmDeletePrompt', { name: profile.name })}
        </p>
        <input
          className="field"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoFocus
          placeholder={profile.name}
        />
        {profile.kind === 'keyring' ? (
          <p className="rounded bg-[var(--t-warn)]/10 p-2 text-xs text-[var(--t-warn)]">{t('profiles.deleteKeyringNote')}</p>
        ) : (
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={purge} onChange={(e) => setPurge(e.target.checked)} />
            {t('profiles.deletePurgeData')}
          </label>
        )}
        {error && <p className="text-xs text-[var(--t-crit)]">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="button-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button disabled={typed !== profile.name} className="button-danger">
            <Trash2 className="h-3 w-3" />
            {t('profiles.deleteProfile')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function LoginWizard({
  profileName,
  engine,
  sessionId,
  onClose,
}: {
  profileName: string;
  engine: Provider;
  sessionId: string;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const [currentSessionId, setCurrentSessionId] = useState(sessionId);
  const provider = engine === 'codex'
    ? 'Codex'
    : engine === 'claude'
      ? 'Claude'
      : 'Antigravity';
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-[var(--t-overlay)] p-3" style={{ zIndex: UI_Z_INDEX.modal }}>
      <div className="flex h-[90vh] w-[96vw] max-w-[1400px] flex-col overflow-hidden rounded-xl border border-[var(--t-border)] bg-[var(--t-surface)] shadow-2xl">
        <div className="border-b border-[var(--t-border)] p-4">
          <h2 className="text-lg font-semibold">
            {t('profiles.loginGuideTitle', { provider, profileName })}
          </h2>
          <div className="mt-3 grid gap-2 text-xs text-[var(--t-text-3)] sm:grid-cols-4">
            <Step
              n="1"
              text={
                provider === 'Antigravity'
                  ? t('profiles.stepGoogleOAuth')
                  : provider === 'Codex'
                    ? t('profiles.stepDeviceAuth')
                    : t('profiles.stepSendLogin')
              }
            />
            <Step n="2" text={t('profiles.stepOpenLink')} />
            <Step n="3" text={t('profiles.stepCopyCode')} />
            <Step n="4" text={t('profiles.stepPasteCode')} />
          </div>
        </div>
        <div className="min-h-0 flex-1">
          <LoginTerminal
            profileName={profileName}
            sessionId={currentSessionId}
            onClose={onClose}
            onReconnect={async () => {
              const next = await loginProfile(profileName);
              setCurrentSessionId(next.sessionId);
              return next.sessionId;
            }}
          />
        </div>
      </div>
    </div>
  );
}
function Step({ n, text }: { n: string; text: string }) {
  return (
    <div className="rounded-lg bg-[var(--t-surface-2)] p-2">
      <b className="mr-1 text-[var(--t-accent)]">{n}.</b>
      {text}
    </div>
  );
}
