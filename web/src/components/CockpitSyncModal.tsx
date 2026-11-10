import React, { useEffect, useState, useMemo } from 'react';
import { RefreshCw, AlertTriangle, Check, Sliders } from 'lucide-react';
import { Modal } from './ui/Modal';
import { AgentIcon } from './AgentIcon';
import { useLocale } from '../context/LocaleContext';
import {
  scanCockpit,
  importCockpit,
  getConfig,
  updateConfig,
} from '../api/client';
import type {
  CockpitScanResult,
  CockpitScanItem,
  CockpitImportResult,
  CockpitSource,
} from '../types/api';

interface CockpitSyncModalProps {
  isOpen: boolean;
  onClose: () => void;
  onProfilesUpdated?: () => void;
  initialDataDir?: string;
}

export const CockpitSyncModal: React.FC<CockpitSyncModalProps> = ({
  isOpen,
  onClose,
  onProfilesUpdated,
  initialDataDir,
}) => {
  const { t } = useLocale();

  // Directory and scanning
  const [dataDir, setDataDir] = useState<string>(initialDataDir || '');
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanResult, setScanResult] = useState<CockpitScanResult | null>(null);

  // Selection
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [verifyTokens, setVerifyTokens] = useState<boolean>(true);

  // Import state
  const [isImporting, setIsImporting] = useState<boolean>(false);
  const [importResult, setImportResult] = useState<CockpitImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  // Auto-sync settings
  const [showAutoSync, setShowAutoSync] = useState<boolean>(false);
  const [autoSyncEnabled, setAutoSyncEnabled] = useState<boolean>(false);
  const [autoSyncInterval, setAutoSyncInterval] = useState<number>(30);
  const [autoSyncEngines, setAutoSyncEngines] = useState<CockpitSource[]>(['antigravity']);
  const [isSavingAutoSync, setIsSavingAutoSync] = useState<boolean>(false);
  const [autoSyncSaved, setAutoSyncSaved] = useState<boolean>(false);

  // Load config on mount
  useEffect(() => {
    if (!isOpen) return;
    let isMounted = true;
    getConfig()
      .then((cfg) => {
        if (!isMounted) return;
        const cockpitCfg = cfg.integrations?.cockpit;
        if (cockpitCfg?.dataDir && !initialDataDir) {
          setDataDir(cockpitCfg.dataDir);
        }
        if (cockpitCfg?.autoSync) {
          setAutoSyncEnabled(Boolean(cockpitCfg.autoSync.enabled));
          setAutoSyncInterval(cockpitCfg.autoSync.intervalMinutes || 30);
          setAutoSyncEngines(cockpitCfg.autoSync.engines || ['antigravity']);
        }
      })
      .catch(() => null);
    return () => {
      isMounted = false;
    };
  }, [isOpen, initialDataDir]);

  // Run scan
  const handleScan = async (overrideDir?: string, preserveImportResult?: boolean) => {
    setIsScanning(true);
    setScanError(null);
    if (!preserveImportResult) {
      setImportResult(null);
      setImportError(null);
    }

    const dirToScan = overrideDir !== undefined ? overrideDir : dataDir;

    try {
      const res = await scanCockpit(dirToScan.trim() || undefined);
      setScanResult(res);
      if (res.dataDir && !dataDir) {
        setDataDir(res.dataDir);
      }

      // Default selection: select all importable accounts with hubStatus === 'new'
      const newSelected: Record<string, boolean> = {};
      for (const item of res.items) {
        if (item.importable && item.hubStatus === 'new') {
          newSelected[`${item.source}:${item.cockpitId}`] = true;
        }
      }
      setSelected(newSelected);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setScanError(msg);
      setScanResult(null);
    } finally {
      setIsScanning(false);
    }
  };

  // Trigger scan when modal opens
  useEffect(() => {
    if (isOpen) {
      void handleScan(initialDataDir);
    }
  }, [isOpen]);

  // Group accounts by source
  const groupedItems = useMemo(() => {
    const items = scanResult?.items || [];
    return {
      antigravity: items.filter((i) => i.source === 'antigravity'),
      codex: items.filter((i) => i.source === 'codex'),
      claude: items.filter((i) => i.source === 'claude'),
    };
  }, [scanResult]);

  // Selection helpers
  const selectedCount = useMemo(() => {
    return Object.values(selected).filter(Boolean).length;
  }, [selected]);

  const toggleSelect = (key: string) => {
    setSelected((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const selectAllNew = () => {
    const next: Record<string, boolean> = {};
    for (const item of scanResult?.items || []) {
      if (item.importable && item.hubStatus === 'new') {
        next[`${item.source}:${item.cockpitId}`] = true;
      }
    }
    setSelected(next);
  };

  const deselectAll = () => {
    setSelected({});
  };

  // Perform import
  const handleImport = async () => {
    if (!scanResult || selectedCount === 0 || isImporting) return;

    setIsImporting(true);
    setImportError(null);

    const itemsToImport = scanResult.items
      .filter((item) => selected[`${item.source}:${item.cockpitId}`])
      .map((item) => ({ source: item.source, cockpitId: item.cockpitId }));

    try {
      const res = await importCockpit(itemsToImport, {
        verify: verifyTokens,
        dataDir: dataDir.trim() || undefined,
      });
      setImportResult(res);
      if (onProfilesUpdated) {
        onProfilesUpdated();
      }
      // Re-scan to update status while preserving import results
      await handleScan(undefined, true);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setImportError(msg);
    } finally {
      setIsImporting(false);
    }
  };

  // Save auto-sync settings
  const handleSaveAutoSync = async () => {
    setIsSavingAutoSync(true);
    setAutoSyncSaved(false);
    try {
      await updateConfig({
        integrations: {
          cockpit: {
            dataDir: dataDir.trim() || undefined,
            autoSync: {
              enabled: autoSyncEnabled,
              intervalMinutes: Math.max(1, Number(autoSyncInterval) || 30),
              engines: autoSyncEngines,
            },
          },
        },
      });
      setAutoSyncSaved(true);
      setTimeout(() => setAutoSyncSaved(false), 3000);
    } catch {
      // ignore
    } finally {
      setIsSavingAutoSync(false);
    }
  };

  const toggleAutoSyncEngine = (engine: CockpitSource) => {
    setAutoSyncEngines((prev) =>
      prev.includes(engine) ? prev.filter((e) => e !== engine) : [...prev, engine],
    );
  };

  const renderGroup = (
    source: CockpitSource,
    title: string,
    items: CockpitScanItem[],
    showRotationWarning?: boolean,
  ) => {
    return (
      <div className="space-y-3 rounded-lg border border-[var(--t-border)] p-4 bg-[var(--t-surface)]">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AgentIcon provider={source === 'antigravity' ? 'agy' : source} className="h-5 w-5 shrink-0" />
            <h3 className="font-semibold text-sm text-[var(--t-text)]">{title}</h3>
            <span className="rounded-full bg-[var(--t-surface-2)] px-2 py-0.5 text-xs text-[var(--t-text-3)]">
              {items.length}
            </span>
          </div>
        </div>

        {showRotationWarning && (
          <div className="flex items-start gap-2 rounded-md border border-[var(--t-warn)]/30 bg-[var(--t-warn)]/10 p-2.5 text-xs text-[var(--t-warn)]">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <p className="leading-relaxed">{t('profiles.cockpitTokenRotationWarning')}</p>
          </div>
        )}

        {items.length === 0 ? (
          <p className="text-xs text-[var(--t-text-3)] italic py-2">
            {t('profiles.cockpitEmptyGroup')}
          </p>
        ) : (
          <div className="divide-y divide-[var(--t-border)] border border-[var(--t-border)] rounded-md overflow-hidden bg-[var(--t-surface-2)]">
            {items.map((item) => {
              const key = `${item.source}:${item.cockpitId}`;
              const isChecked = Boolean(selected[key]);
              const itemResult = importResult?.items.find(
                (r) => r.source === item.source && r.cockpitId === item.cockpitId,
              );

              return (
                <div
                  key={key}
                  className={`flex flex-col sm:flex-row sm:items-center justify-between p-3 gap-2 transition-colors ${
                    !item.importable
                      ? 'opacity-60 bg-[var(--t-surface)]'
                      : isChecked
                        ? 'bg-[var(--t-accent)]/5'
                        : 'hover:bg-[var(--t-hover)]'
                  }`}
                >
                  <label className="flex items-center gap-2.5 min-w-0 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={isChecked}
                      disabled={!item.importable || isImporting}
                      onChange={() => toggleSelect(key)}
                      className="rounded border-[var(--t-border)] h-4 w-4 text-[var(--t-accent)]"
                    />
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-[var(--t-text)] truncate" data-testid="cockpit-item-email">
                        {item.email || t('profiles.cockpitNoEmail')}
                      </p>
                      <p className="text-[11px] text-[var(--t-text-3)] truncate" title={item.cockpitId}>
                        {[item.name, item.planType?.toUpperCase()].filter(Boolean).join(' · ')}
                        {(item.name || item.planType) ? ' · ' : ''}
                        <span className="font-mono">{item.cockpitId}</span>
                      </p>
                    </div>
                  </label>

                  <div className="flex items-center gap-2 shrink-0 pl-6 sm:pl-0 flex-wrap">
                    {/* Status badges */}
                    {item.disabled && (
                      <span className="rounded-full bg-[var(--t-surface-3)] px-2 py-0.5 text-[11px] text-[var(--t-text-3)] font-medium">
                        {t('profiles.cockpitStatusDisabled')}
                      </span>
                    )}

                    {!item.importable && item.skipReason && (
                      <span
                        className="rounded-full bg-[var(--t-warn)]/15 border border-[var(--t-warn)]/30 px-2 py-0.5 text-[11px] text-[var(--t-warn)] font-medium"
                        title={item.skipReason}
                      >
                        {t('profiles.cockpitStatusSkipped')}: {item.skipReason}
                      </span>
                    )}

                    {item.importable && item.hubStatus === 'new' && (
                      <span className="rounded-full bg-[var(--t-ok)]/15 border border-[var(--t-ok)]/30 px-2 py-0.5 text-[11px] text-[var(--t-ok)] font-medium">
                        {t('profiles.cockpitStatusNew')}
                      </span>
                    )}

                    {item.importable && item.hubStatus === 'exists' && (
                      <span className="rounded-full bg-[var(--t-surface-3)] border border-[var(--t-border)] px-2 py-0.5 text-[11px] text-[var(--t-text-2)] font-medium">
                        {t('profiles.cockpitStatusExists')}
                      </span>
                    )}

                    {item.importable && item.hubStatus === 'conflict' && (
                      <span className="rounded-full bg-[var(--t-crit)]/15 border border-[var(--t-crit)]/30 px-2 py-0.5 text-[11px] text-[var(--t-crit)] font-medium">
                        {t('profiles.cockpitStatusConflict')}
                      </span>
                    )}

                    {/* Import result if present */}
                    {itemResult && (
                      <span
                        className={`rounded-full px-2 py-0.5 text-[11px] font-semibold flex items-center gap-1 ${
                          itemResult.status === 'ok'
                            ? itemResult.action === 'imported'
                              ? 'bg-[var(--t-ok)]/20 text-[var(--t-ok)] border border-[var(--t-ok)]/40'
                              : 'bg-[var(--t-accent)]/20 text-[var(--t-accent)] border border-[var(--t-accent)]/40'
                            : 'bg-[var(--t-crit)]/20 text-[var(--t-crit)] border border-[var(--t-crit)]/40'
                        }`}
                      >
                        {itemResult.status === 'ok' ? (
                          <>
                            <Check className="h-3 w-3" />
                            {itemResult.action === 'imported'
                              ? t('profiles.cockpitImportedSuccess')
                              : t('profiles.cockpitUpdatedSuccess')}
                          </>
                        ) : (
                          <>
                            ✗ {itemResult.message || t('profiles.cockpitFailedResult', { reason: '' })}
                          </>
                        )}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('profiles.cockpitModalTitle')}
      maxWidth="max-w-3xl"
    >
      <div className="space-y-5 text-sm">
        {/* Cockpit directory path input */}
        <div className="space-y-1.5 rounded-lg border border-[var(--t-border)] p-3 bg-[var(--t-surface-2)]">
          <label className="block text-xs font-semibold text-[var(--t-text-2)]">
            {t('profiles.cockpitDataDirLabel')}
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              value={dataDir}
              onChange={(e) => setDataDir(e.target.value)}
              placeholder="~/.cockpit_tools"
              className="field flex-1 text-xs font-mono"
            />
            <button
              type="button"
              onClick={() => void handleScan()}
              disabled={isScanning}
              className="button-secondary shrink-0 text-xs flex items-center gap-1.5"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isScanning ? 'animate-spin' : ''}`} />
              {isScanning ? t('profiles.cockpitScanning') : t('profiles.cockpitRescan')}
            </button>
          </div>
        </div>

        {/* Missing Cockpit directory notice */}
        {scanResult && !scanResult.exists && (
          <div className="rounded-lg border border-[var(--t-warn)]/40 bg-[var(--t-warn)]/10 p-3 text-xs text-[var(--t-warn)] space-y-1">
            <div className="flex items-center gap-1.5 font-semibold">
              <AlertTriangle className="h-4 w-4" />
              <span>{t('profiles.cockpitDirNotFound')}</span>
            </div>
            <p className="leading-relaxed">{t('profiles.cockpitDirNotFoundHelp')}</p>
          </div>
        )}

        {/* Scan error notice */}
        {scanError && (
          <div className="rounded-lg border border-[var(--t-crit)]/40 bg-[var(--t-crit)]/10 p-3 text-xs text-[var(--t-crit)]">
            {scanError}
          </div>
        )}

        {/* Import summary / error notice */}
        {importError && (
          <div className="rounded-lg border border-[var(--t-crit)]/40 bg-[var(--t-crit)]/10 p-3 text-xs text-[var(--t-crit)]">
            {importError}
          </div>
        )}

        {importResult && (
          <div className="rounded-lg border border-[var(--t-ok)]/30 bg-[var(--t-ok)]/10 p-3 text-xs text-[var(--t-text)] space-y-1">
            <div className="font-semibold text-[var(--t-ok)] flex items-center gap-1">
              <Check className="h-4 w-4" />
              <span>
                {t('profiles.cockpitSummaryImported', { count: importResult.importedCount })}
                {importResult.updatedCount > 0 ? `, ${t('profiles.cockpitSummaryUpdated', { count: importResult.updatedCount })}` : ''}
                {importResult.skippedCount > 0 ? `, ${t('profiles.cockpitSummarySkipped', { count: importResult.skippedCount })}` : ''}
              </span>
            </div>
          </div>
        )}

        {/* Selection controls */}
        {scanResult && scanResult.items.length > 0 && (
          <div className="flex items-center justify-between text-xs pt-1">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={selectAllNew}
                className="text-[var(--t-accent)] hover:underline font-medium cursor-pointer"
              >
                {t('profiles.cockpitSelectAllNew')}
              </button>
              <span className="text-[var(--t-border)]">|</span>
              <button
                type="button"
                onClick={deselectAll}
                className="text-[var(--t-text-3)] hover:underline cursor-pointer"
              >
                {t('profiles.cockpitDeselectAll')}
              </button>
            </div>
            <label className="flex items-center gap-1.5 cursor-pointer text-[var(--t-text-2)]">
              <input
                type="checkbox"
                checked={verifyTokens}
                onChange={(e) => setVerifyTokens(e.target.checked)}
                className="rounded border-[var(--t-border)] h-3.5 w-3.5"
              />
              <span>{t('profiles.cockpitVerifyTokens')}</span>
            </label>
          </div>
        )}

        {/* 3 Groups */}
        <div className="space-y-4 max-h-[45vh] overflow-y-auto pr-1">
          {renderGroup(
            'antigravity',
            t('profiles.cockpitAntigravityGroup'),
            groupedItems.antigravity,
            false,
          )}

          {renderGroup(
            'codex',
            t('profiles.cockpitCodexGroup'),
            groupedItems.codex,
            true,
          )}

          {renderGroup(
            'claude',
            t('profiles.cockpitClaudeGroup'),
            groupedItems.claude,
            true,
          )}
        </div>

        {/* Auto-sync configuration section */}
        <div className="rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] p-3 space-y-3">
          <button
            type="button"
            onClick={() => setShowAutoSync(!showAutoSync)}
            className="flex items-center justify-between w-full text-xs font-semibold text-[var(--t-text)] hover:text-[var(--t-accent)] transition-colors cursor-pointer"
          >
            <div className="flex items-center gap-2">
              <Sliders className="h-4 w-4" />
              <span>{t('profiles.cockpitAutoSyncSection')}</span>
            </div>
            <span className="text-[11px] text-[var(--t-text-3)]">
              {showAutoSync ? '▲' : '▼'}
            </span>
          </button>

          {showAutoSync && (
            <div className="pt-2 space-y-3 border-t border-[var(--t-border)] text-xs">
              <label className="flex items-center gap-2 cursor-pointer font-medium text-[var(--t-text)]">
                <input
                  type="checkbox"
                  checked={autoSyncEnabled}
                  onChange={(e) => setAutoSyncEnabled(e.target.checked)}
                  className="rounded border-[var(--t-border)] h-4 w-4 text-[var(--t-accent)]"
                />
                <span>{t('profiles.cockpitAutoSyncEnable')}</span>
              </label>

              {autoSyncEnabled && (
                <div className="space-y-3 pl-6">
                  <div className="flex items-center gap-2">
                    <span className="text-[var(--t-text-2)]">{t('profiles.cockpitAutoSyncInterval')}:</span>
                    <input
                      type="number"
                      min={1}
                      max={1440}
                      value={autoSyncInterval}
                      onChange={(e) => setAutoSyncInterval(Math.max(1, parseInt(e.target.value) || 30))}
                      className="field w-20 text-xs py-1"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <span className="text-[var(--t-text-2)] block font-medium">
                      {t('profiles.cockpitAutoSyncEngines')}:
                    </span>
                    <div className="flex items-center gap-4">
                      {(['antigravity', 'codex', 'claude'] as const).map((eng) => (
                        <label key={eng} className="flex items-center gap-1.5 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={autoSyncEngines.includes(eng)}
                            onChange={() => toggleAutoSyncEngine(eng)}
                            className="rounded border-[var(--t-border)] h-3.5 w-3.5 text-[var(--t-accent)]"
                          />
                          <span className="capitalize">{eng}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between pt-1">
                <span className="text-[11px] text-[var(--t-ok)] font-medium">
                  {autoSyncSaved ? t('profiles.cockpitSavedAutoSync') : ''}
                </span>
                <button
                  type="button"
                  onClick={() => void handleSaveAutoSync()}
                  disabled={isSavingAutoSync}
                  className="button-secondary text-xs"
                >
                  {isSavingAutoSync
                    ? t('profiles.cockpitSavingAutoSync')
                    : t('profiles.cockpitSaveAutoSync')}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Modal actions */}
        <div className="flex items-center justify-between pt-2 border-t border-[var(--t-border)]">
          <button type="button" onClick={onClose} className="button-secondary">
            {t('common.close')}
          </button>
          <button
            type="button"
            onClick={() => void handleImport()}
            disabled={selectedCount === 0 || isImporting}
            className="button-primary flex items-center gap-2"
          >
            {isImporting ? (
              <>
                <RefreshCw className="h-4 w-4 animate-spin" />
                <span>{t('profiles.cockpitImporting')}</span>
              </>
            ) : (
              <span>{t('profiles.cockpitImportBtn', { count: selectedCount })}</span>
            )}
          </button>
        </div>
      </div>
    </Modal>
  );
};
