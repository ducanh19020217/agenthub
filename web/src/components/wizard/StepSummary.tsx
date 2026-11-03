import type { ProjectInspection } from '../../types/api';
import type { Translate, WizardDraft } from './types';

export function StepSummary({
  draft,
  inspection,
  t,
}: {
  draft: WizardDraft;
  inspection: ProjectInspection | null;
  t: Translate;
}) {
  return (
    <div className="space-y-2 rounded-lg border p-4 text-sm">
      <b>{t('projects.wizardSummary')}</b>
      <div>
        {t('projects.nameLabel')}: {draft.name}
      </div>
      <div>
        {t('projects.pathLabel')}: {draft.path}
      </div>
      <div>
        {t('projects.branchLabel')}: {draft.branch}
      </div>
      <div>
        {t('projects.wizardIntegration')}:{' '}
        {draft.integration ? t('common.yes') : t('common.no')}
      </div>
      <div>
        {t('projects.wizardSkipInstall')}:{' '}
        {draft.skipInstall ? t('common.yes') : t('common.no')}
      </div>
      <div>
        {t('projects.wizardSkipHooks')}:{' '}
        {draft.skipHooks ? t('common.yes') : t('common.no')}
      </div>
      {draft.sensitive && (
        <div>
          {t('projects.wizardSensitive')}: {t('common.yes')}
        </div>
      )}
      {draft.checks.length > 0 && (
        <div>
          {t('projects.wizardChecks')}:{' '}
          {draft.checks.map((c) => c.name).join(', ')}
        </div>
      )}
      {draft.references.length > 0 && (
        <div>
          {t('projects.sectionReferencesTitle')}:{' '}
          {draft.references.map((r) => r.name || r.path).join(', ')}
        </div>
      )}
      {draft.agentsDraft && (
        <div>
          {t('projects.wizardAgentsDraft')}: {t('common.yes')}
        </div>
      )}
      {draft.pinMemory && draft.contextApproved && (
        <div>
          {t('projects.wizardPinMemory')}: {t('common.yes')}
        </div>
      )}
      {draft.selectedSessions.length > 0 && draft.contextApproved && (
        <div>
          {t('projects.wizardSessions')}:{' '}
          {draft.selectedSessions.length}{' '}
          {t('projects.wizardSessionsSelected')}
        </div>
      )}
      <div>
        {t('settings.presetTitle')}: {draft.preset ? t(`settings.preset${draft.preset.charAt(0).toUpperCase() + draft.preset.slice(1)}`) : t('settings.presetBalanced')}
      </div>
      <div>
        {t('departments.title')}: {draft.departmentId || 'chung'}
      </div>
      <div>
        {t('projects.brainMode')}: {draft.settings.brain.mode}
      </div>
      <div>
        {t('projects.telegramContent')}:{' '}
        {draft.settings.notifications.telegramContent}
      </div>
      {inspection && (
        <div className="text-xs text-[var(--t-text-3)]">
          {t('projects.wizardLanguage')}: {inspection.language}
        </div>
      )}
    </div>
  );
}
