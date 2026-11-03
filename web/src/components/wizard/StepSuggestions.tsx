import { Suggestion } from './Suggestion';
import type { Check, StepWithInspectionProps } from './types';

export function StepSuggestions({
  inspection,
  draft,
  update,
  t,
}: StepWithInspectionProps) {
  const checks = inspection?.suggestedSettings.checks || [];

  const toggleCheck = (check: Check) =>
    update({
      checks: draft.checks.some((item) => item.name === check.name)
        ? draft.checks.filter((item) => item.name !== check.name)
        : [...draft.checks, check],
    });

  const installReason = inspection?.lockfiles.length
    ? `${t('projects.wizardReasonLockfile')}: ${inspection.lockfiles.join(', ')}`
    : inspection?.monorepo.detected
      ? `${t('projects.wizardReasonMonorepo')}: ${inspection.monorepo.type}`
      : '';

  const hooksReason =
    inspection?.gitHooks.husky || inspection?.gitHooks.commitlint
      ? t('projects.wizardReasonHooks')
      : '';

  const sensitiveReason =
    inspection?.path?.startsWith('/media/')
      ? t('projects.wizardReasonMedia')
      : inspection?.mount.encrypted ||
          inspection?.mount.temporary ||
          inspection?.suggestedSettings.sensitiveProject
        ? t('projects.wizardReasonMount')
        : '';

  return (
    <div className="space-y-3">
      <p className="text-sm">{t('projects.wizardSuggestionsDesc')}</p>
      <Suggestion
        checked={draft.skipInstall}
        onChange={(value) => update({ skipInstall: value })}
        label={t('projects.wizardSkipInstall')}
        reason={installReason}
      />
      <Suggestion
        checked={draft.skipHooks}
        onChange={(value) => update({ skipHooks: value })}
        label={t('projects.wizardSkipHooks')}
        reason={hooksReason}
      />
      <Suggestion
        checked={draft.integration}
        onChange={(value) => update({ integration: value })}
        label={t('projects.wizardIntegration')}
        reason={t('projects.wizardIntegrationReason')}
      />
      {sensitiveReason && (
        <Suggestion
          checked={draft.sensitive}
          onChange={(value) => update({
            sensitive: value,
            ...(value ? { preset: 'safe' } : draft.preset === 'safe' ? { preset: 'balanced' } : {}),
          })}
          label={t('projects.wizardSensitive')}
          reason={sensitiveReason}
        />
      )}
      {checks.length > 0 && (
        <div className="space-y-2">
          <b className="text-sm">{t('projects.wizardChecks')}</b>
          {checks.map((check) => (
            <Suggestion
              key={check.name}
              checked={draft.checks.some((item) => item.name === check.name)}
              onChange={() => toggleCheck(check)}
              label={check.name}
              reason={check.reason}
            />
          ))}
        </div>
      )}
    </div>
  );
}
