import React, { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  Check,
  AlertCircle,
  Download,
  ExternalLink,
  FileText,
  Loader2,
  Wrench,
} from 'lucide-react';
import {
  completeSetup,
  getProjects,
  getSetupLog,
  getSetupStatus,
  installSetupMcp,
  installSetupTool,
} from '../api/client';
import { subscribeToEvents } from '../api/sse';
import { useLocale } from '../context/LocaleContext';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { StatTile } from '../components/ui/StatTile';
import { StatusBadge } from '../components/StatusBadge';
import { Profile } from '../types/api';
import { UsageModes } from '../components/UsageModes';
import { SetupChatButton } from '../components/SetupChatButton';

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export interface SetupCheckItem {
  key: string;
  label: string;
  ok: boolean;
  action?: React.ReactNode;
}

export interface SetupCheckRowProps {
  item: SetupCheckItem;
  result?: boolean;
  log?: string;
}

export const SetupCheckRow: React.FC<SetupCheckRowProps> = ({
  item,
  result,
  log,
}) => {
  const { t } = useLocale();
  const showLog = item.key !== 'node' && item.key !== 'git' && item.key !== 'firstProject' && log !== undefined;
  // Chỉ công cụ có file log trên server; MCP chỉ có lỗi trả về trực tiếp.
  const hasLogFile = item.key === 'claude' || item.key === 'codex' || item.key === 'agy';
  const [fullLog, setFullLog] = useState<string | null>(null);
  const [loadingLog, setLoadingLog] = useState(false);
  useEffect(() => setFullLog(null), [log]);

  // Endpoint log cần Bearer token nên không mở bằng <a href> được (sẽ 401).
  const loadFullLog = async () => {
    setLoadingLog(true);
    try {
      setFullLog(await getSetupLog(item.key));
    } catch (error) {
      setFullLog(errorMessage(error));
    } finally {
      setLoadingLog(false);
    }
  };

  return (
    <div className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
      <div className="flex items-start gap-3 min-w-0 flex-1">
        <div className="mt-0.5 shrink-0">
          {item.ok ? (
            <Check className="w-5 h-5 text-[var(--t-ok)]" />
          ) : (
            <AlertCircle className="w-5 h-5 text-[var(--t-warn)]" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-[var(--t-text)]">{item.label}</div>
          {result !== undefined && (
            <div
              data-testid={`install-result-${item.key}`}
              className={`text-xs font-medium flex items-center gap-1 mt-1 ${
                result ? 'text-[var(--t-ok)]' : 'text-[var(--t-crit)]'
              }`}
            >
              {result ? <Check size={13} /> : <AlertCircle size={13} />}
              <span>{result ? t('setup.done') : t('setup.installFailed')}</span>
            </div>
          )}
          {showLog && (
            <div className="mt-2 space-y-1">
              <pre className="max-h-36 overflow-auto rounded-lg bg-[var(--t-surface-2)] p-2.5 font-mono text-xs text-[var(--t-text)] border border-[var(--t-border)] whitespace-pre-wrap select-text leading-relaxed">
                {fullLog ?? log}
              </pre>
              {hasLogFile && (
                <button
                  type="button"
                  onClick={loadFullLog}
                  disabled={loadingLog}
                  className="inline-flex items-center gap-1 text-xs text-[var(--t-accent)] hover:underline disabled:opacity-60"
                >
                  {loadingLog ? <Loader2 className="animate-spin" size={12} /> : <FileText size={12} />}
                  <span>{t('setup.log')}</span>
                </button>
              )}
            </div>
          )}
          {item.key === 'agy' && !item.ok && (
            <div className="mt-2 rounded-lg border border-[var(--t-warn)]/30 bg-[var(--t-warn)]/10 p-2.5 text-xs text-[var(--t-text)]">
              <div>{t('setup.agyManualHint')}</div>
              <code className="mt-1 block select-text break-all font-mono">curl -fsSL https://antigravity.google/cli/install.sh | bash</code>
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center sm:shrink-0 self-start sm:self-center pl-8 sm:pl-0">
        {item.ok ? (
          <StatusBadge status="done" />
        ) : (
          item.action || (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--t-warn)]/30 bg-[var(--t-warn)]/10 text-[var(--t-warn)] font-semibold text-xs px-3 py-1">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--t-warn)]" />
              <span>{t('setup.needsCheck')}</span>
            </span>
          )
        )}
      </div>
    </div>
  );
};

export const SetupAccountsCard: React.FC<{ profiles: Profile[] }> = ({ profiles }) => {
  const { t } = useLocale();

  if (!profiles || profiles.length === 0) return null;

  return (
    <Card className="overflow-hidden">
      <div className="px-5 py-4 border-b border-[var(--t-border)]">
        <h3 className="font-semibold text-base text-[var(--t-text)]">{t('setup.accounts')}</h3>
      </div>
      <div className="divide-y divide-[var(--t-border)]">
        {profiles.map((profile) => (
          <div
            key={profile.name}
            className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
          >
            <div className="flex items-center gap-3">
              <div className="shrink-0">
                {profile.loggedIn ? (
                  <Check className="w-5 h-5 text-[var(--t-ok)]" />
                ) : (
                  <AlertCircle className="w-5 h-5 text-[var(--t-warn)]" />
                )}
              </div>
              <span className="text-sm font-medium text-[var(--t-text)]">
                {t('setup.account', { name: profile.name })}
              </span>
            </div>
            <div className="flex items-center sm:shrink-0 self-start sm:self-center pl-8 sm:pl-0">
              {profile.loggedIn ? (
                <StatusBadge status="done" />
              ) : (
                <Link
                  to={`/profiles#profile-${encodeURIComponent(profile.name)}`}
                  className="text-xs font-medium text-[var(--t-accent)] hover:underline inline-flex items-center gap-1"
                >
                  <span>{t('setup.login')}</span>
                  <ExternalLink size={12} />
                </Link>
              )}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
};

export interface SetupActionsProps {
  missingCount: number;
  installing: boolean;
  finishing: boolean;
  onInstallAll: () => void;
  onSkip: () => void;
  onComplete: () => void;
}

export const SetupActions: React.FC<SetupActionsProps> = ({
  missingCount,
  installing,
  finishing,
  onInstallAll,
  onSkip,
  onComplete,
}) => {
  const { t } = useLocale();

  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-2">
      <div>
        {missingCount > 0 && (
          <Button
            variant="primary"
            onClick={onInstallAll}
            disabled={installing}
            loading={installing}
            className="w-full sm:w-auto"
          >
            {installing ? (
              <>
                <Loader2 className="animate-spin" size={16} />
                <span>{t('setup.installing')}</span>
              </>
            ) : (
              <>
                <Download size={16} />
                <span>{t('setup.installAll')}</span>
              </>
            )}
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="secondary"
          onClick={onSkip}
          disabled={finishing}
          loading={finishing}
        >
          {t('setup.skip')}
        </Button>
        <Button
          variant="primary"
          onClick={onComplete}
          disabled={finishing}
          loading={finishing}
        >
          <Check size={16} />
          <span>{t('setup.complete')}</span>
        </Button>
      </div>
    </div>
  );
};

export const SetupPage: React.FC = () => {
  const { t } = useLocale();
  const queryClient = useQueryClient();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['setup-status'],
    queryFn: getSetupStatus,
    refetchInterval: 3000,
  });
  const { data: projects = [] } = useQuery({
    queryKey: ['projects'],
    queryFn: getProjects,
  });

  const [logs, setLogs] = useState<Record<string, string>>({});
  const [installErrors, setInstallErrors] = useState<Record<string, string>>({});
  const [installingTool, setInstallingTool] = useState<string | null>(null);
  const [installResult, setInstallResult] = useState<Record<string, boolean>>({});

  const install = useMutation({ mutationFn: (tool: string) => installSetupTool(tool) });
  const finish = useMutation({
    mutationFn: (skip: boolean) => completeSetup(skip),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['setup-status'] }),
  });
  const mcp = useMutation({
    mutationFn: () => installSetupMcp(),
    onMutate: () => {
      setInstallErrors((old) => ({ ...old, mcp: '' }));
      setInstallResult(({ mcp: _previous, ...rest }) => rest);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['setup-status'] }),
    onError: (error) => {
      setInstallResult((old) => ({ ...old, mcp: false }));
      setInstallErrors((old) => ({ ...old, mcp: errorMessage(error) }));
    },
  });

  useEffect(() => {
    return subscribeToEvents((event) => {
      if (!event.type.startsWith('setup.install_') || !event.payload?.tool) return;
      const tool = String(event.payload.tool);
      if (event.type === 'setup.install_progress') {
        setLogs((old) => ({
          ...old,
          [tool]: `${old[tool] || ''}${event.payload.line || ''}`,
        }));
      }
      if (event.type === 'setup.install_done') {
        setInstallResult((old) => ({ ...old, [tool]: Boolean(event.payload.ok) }));
        if (event.payload.error) setInstallErrors((old) => ({ ...old, [tool]: String(event.payload.error) }));
        queryClient.invalidateQueries({ queryKey: ['setup-status'] });
      }
    });
  }, [queryClient]);

  const missing = useMemo(() => {
    return data?.tools.filter((tool) => !tool.installed && !tool.manual) || [];
  }, [data]);

  const installOne = async (tool: string) => {
    if (tool === 'agy' && typeof window !== 'undefined' && !window.confirm(t('setup.agyInstallConfirm'))) return;
    setInstallingTool(tool);
    setLogs((old) => ({ ...old, [tool]: '' }));
    setInstallErrors((old) => ({ ...old, [tool]: '' }));
    setInstallResult(({ [tool]: _previous, ...rest }) => rest);
    let stop: (() => void) | undefined;
    const completed = new Promise<void>((resolve) => {
      const unsubscribe = subscribeToEvents((event) => {
        if (event.type === 'setup.install_done' && event.payload?.tool === tool) {
          unsubscribe();
          resolve();
        }
      });
      stop = unsubscribe;
    });

    try {
      await install.mutateAsync(tool);
      await completed;
    } catch (error) {
      // POST bị từ chối thì không có install_done: phải tự hiện lỗi, nếu không ô log trống và nút quay về im lặng.
      setInstallResult((old) => ({ ...old, [tool]: false }));
      setInstallErrors((old) => ({ ...old, [tool]: errorMessage(error) }));
    } finally {
      stop?.();
      setInstallingTool(null);
    }
  };

  const installAll = async () => {
    for (const tool of missing) {
      await installOne(tool.id);
    }
  };

  const checks: SetupCheckItem[] = useMemo(() => {
    if (!data) return [];
    const toolLabel = (id: string) => t(`setup.${id}`);

    return [
      {
        key: 'node',
        label: t('setup.node', { version: data.node.version }),
        ok: data.node.ok,
      },
      {
        key: 'git',
        label: t('setup.git', {
          version: data.git.version ? ` (${data.git.version})` : '',
        }),
        ok: data.git.installed,
      },
      ...data.tools.map((tool) => ({
        key: tool.id,
        label: toolLabel(tool.id),
        ok: tool.installed,
        action: tool.manual ? (
          <a
            href={tool.docsUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs font-medium text-[var(--t-accent)] hover:underline"
          >
            <span>{t('setup.manualGuide')}</span>
            <ExternalLink size={13} />
          </a>
        ) : (
          <Button
            size="sm"
            variant="primary"
            onClick={() => installOne(tool.id)}
            disabled={installingTool !== null}
            loading={installingTool === tool.id}
          >
            {installingTool === tool.id ? (
              <>
                <Loader2 className="animate-spin" size={14} />
                <span>{t('setup.running')}</span>
              </>
            ) : (
              <>
                <Download size={14} />
                <span>{t('setup.install')}</span>
              </>
            )}
          </Button>
        ),
      })),
      {
        key: 'service',
        label: t('setup.service'),
        ok: data.serviceRunning,
      },
      {
        key: 'mcp',
        label: t('setup.mcp'),
        ok: data.mcpRegistered,
        action: !data.mcpRegistered ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => mcp.mutate()}
            disabled={mcp.isPending}
            loading={mcp.isPending}
          >
            {mcp.isPending ? (
              <>
                <Loader2 className="animate-spin" size={14} />
                <span>{t('setup.running')}</span>
              </>
            ) : (
              <span>{t('setup.install')}</span>
            )}
          </Button>
        ) : undefined,
      },
      {
        key: 'firstProject',
        label: t('setup.firstProject'),
        ok: projects.length >= 1,
        action: projects.length < 1 ? (
          <Link
            to="/projects?new=1"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--t-accent)] hover:bg-[var(--t-accent-hover)] text-[var(--t-on-accent)] text-xs font-semibold cursor-pointer"
          >
            <span>{t('setup.addProject')}</span>
          </Link>
        ) : undefined,
      },
    ];
  }, [data, projects, installingTool, mcp, t]);

  const readyCount = useMemo(() => {
    return checks.filter((c) => c.ok).length;
  }, [checks]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-12 text-[var(--t-text-3)] text-sm">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        <span>{t('setup.loading')}</span>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="p-8 text-center space-y-4 max-w-md mx-auto">
        <AlertCircle className="w-8 h-8 text-[var(--t-crit)] mx-auto" />
        <p className="text-sm text-[var(--t-text)]">{t('setup.loadError')}</p>
        <Button variant="secondary" onClick={() => refetch()}>
          {t('common.retry')}
        </Button>
      </div>
    );
  }

  return (
    <div className="max-w-4xl space-y-6" data-tour="setup">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-[var(--t-text)]">
            {t('setup.title')}
          </h1>
          <p className="text-sm text-[var(--t-text-3)] mt-1">
            {t('setup.subtitle')}
          </p>
        </div>
        <SetupChatButton />
      </div>

      {/* Readiness Progress Summary */}
      <StatTile
        label={t('setup.progress')}
        value={`${readyCount}/${checks.length}`}
        subtext={
          <div className="space-y-1.5 mt-1">
            <div>
              {t('setup.progressSummary', {
                ready: readyCount,
                total: checks.length,
              })}
            </div>
            <div className="w-full bg-[var(--t-surface-2)] h-1.5 rounded-full overflow-hidden border border-[var(--t-border)]">
              <div
                className="bg-[var(--t-ok)] h-full transition-all duration-300 rounded-full"
                style={{
                  width: `${
                    checks.length > 0 ? (readyCount / checks.length) * 100 : 0
                  }%`,
                }}
              />
            </div>
          </div>
        }
        icon={<Wrench className="w-5 h-5" />}
        iconColor={readyCount === checks.length ? 'var(--t-ok)' : 'var(--t-accent)'}
      />

      <UsageModes />

      {/* Environment & Tools Checks */}
      <div data-tour="setup-tools"><Card className="overflow-hidden">
        <div className="divide-y divide-[var(--t-border)]">
          {checks.map((item) => (
            <SetupCheckRow
              key={item.key}
              item={item}
              result={installResult[item.key]}
              log={installErrors[item.key] ? `${installErrors[item.key]}\n\n${logs[item.key] || ''}` : logs[item.key]}
            />
          ))}
        </div>
      </Card></div>

      {/* Accounts */}
      <div data-tour="setup-profiles"><SetupAccountsCard profiles={data.profiles} /></div>

      {/* Bottom Actions */}
      <SetupActions
        missingCount={missing.length}
        installing={installingTool !== null || install.isPending}
        finishing={finish.isPending}
        onInstallAll={installAll}
        onSkip={() => finish.mutate(true)}
        onComplete={() => finish.mutate(false)}
      />
    </div>
  );
};
