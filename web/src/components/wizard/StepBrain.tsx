import { useQuery } from '@tanstack/react-query';
import { Shield, Scale, Zap, Building2 } from 'lucide-react';
import { getDepartments } from '../../api/client';
import type { PresetLevel, ProjectSettings } from '../../types/api';
import type { StepProps } from './types';

const PRESETS: Array<{ level: PresetLevel; icon: typeof Shield }> = [
  { level: 'safe', icon: Shield },
  { level: 'balanced', icon: Scale },
  { level: 'auto', icon: Zap },
];

export function StepBrain({ draft, update, t }: StepProps) {
  const { data: departments = [] } = useQuery({
    queryKey: ['departments'],
    queryFn: getDepartments,
  });

  const currentPreset = draft.preset || (draft.sensitive ? 'safe' : 'balanced');

  return (
    <div className="space-y-4">
      {/* Preset selection */}
      <div className="space-y-2">
        <label className="text-xs font-semibold text-[var(--t-text)]">{t('projects.presetTitle')}</label>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {PRESETS.map(({ level, icon: Icon }) => {
            const isSelected = currentPreset === level;
            const title = t(`settings.preset${level.charAt(0).toUpperCase() + level.slice(1)}`);
            const desc = t(`settings.preset${level.charAt(0).toUpperCase() + level.slice(1)}Desc`);
            return (
              <button
                key={level}
                type="button"
                data-testid={`wizard-preset-${level}`}
                onClick={() => update({ preset: level, ...(level === 'safe' ? { sensitive: true } : {}) })}
                className={`flex flex-col items-start p-2.5 rounded-lg border text-left transition-all ${
                  isSelected
                    ? 'border-[var(--t-accent)] bg-[var(--t-accent)]/10 text-[var(--t-accent)] shadow-sm'
                    : 'border-[var(--t-border)] bg-[var(--t-surface-2)] text-[var(--t-text-2)] hover:border-[var(--t-border-strong)]'
                }`}
              >
                <div className="flex items-center gap-1.5 font-semibold text-xs text-[var(--t-text)]">
                  <Icon size={14} className={isSelected ? 'text-[var(--t-accent)]' : 'text-[var(--t-text-3)]'} />
                  {title}
                </div>
                <div className="text-[11px] text-[var(--t-text-3)] mt-1 line-clamp-2">
                  {desc}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Department selection */}
      <div className="space-y-1.5">
        <label className="text-xs font-semibold text-[var(--t-text)] flex items-center gap-1.5">
          <Building2 size={14} className="text-[var(--t-text-3)]" />
          {t('departments.title')}
        </label>
        <select
          aria-label={t('departments.title')}
          data-testid="wizard-department-select"
          value={draft.departmentId || 'chung'}
          onChange={(e) => update({ departmentId: e.target.value })}
          className="w-full rounded border border-[var(--t-border)] bg-[var(--t-surface-2)] p-2 text-xs text-[var(--t-text)]"
        >
          {departments.length > 0 ? (
            departments.map((dept) => (
              <option key={dept.id} value={dept.id}>
                {dept.name} ({dept.id})
              </option>
            ))
          ) : (
            <option value="chung">Chung</option>
          )}
        </select>
      </div>

      {/* Brain and Notification Settings */}
      <div className="grid gap-3 sm:grid-cols-2 pt-1 border-t border-[var(--t-border)]">
        <label className="text-xs font-semibold text-[var(--t-text)]">
          {t('projects.brainMode')}
          <select
            className="mt-1 w-full rounded border border-[var(--t-border)] bg-[var(--t-surface-2)] p-2 text-xs text-[var(--t-text)]"
            value={draft.settings.brain.mode}
            onChange={(event) =>
              update({
                settings: {
                  ...draft.settings,
                  brain: {
                    ...draft.settings.brain,
                    mode: event.target.value as ProjectSettings['brain']['mode'],
                  },
                },
              })
            }
          >
            <option value="inherit">{t('projects.brainInherit')}</option>
            <option value="suggest">{t('projects.brainSuggest')}</option>
            <option value="auto">{t('projects.brainAuto')}</option>
            <option value="external">{t('projects.brainExternal')}</option>
          </select>
        </label>
        <label className="text-xs font-semibold text-[var(--t-text)]">
          {t('projects.telegramContent')}
          <select
            className="mt-1 w-full rounded border border-[var(--t-border)] bg-[var(--t-surface-2)] p-2 text-xs text-[var(--t-text)]"
            value={draft.settings.notifications.telegramContent}
            onChange={(event) =>
              update({
                settings: {
                  ...draft.settings,
                  notifications: {
                    ...draft.settings.notifications,
                    telegramContent: event.target.value as ProjectSettings['notifications']['telegramContent'],
                  },
                },
              })
            }
          >
            <option value="full">{t('projects.telegramFull')}</option>
            <option value="minimal">{t('projects.telegramMinimal')}</option>
          </select>
        </label>
      </div>
    </div>
  );
}
