import { Button, Input } from '../ui';
import { Suggestion } from './Suggestion';
import type { ClaudeSession, Reference, StepWithInspectionProps } from './types';
import { useLocale } from '../../context/LocaleContext';
import { formatDateTime, formatIsoTitle } from '../../lib/time';

export function StepContext({
  inspection,
  draft,
  update,
  t,
}: StepWithInspectionProps) {
  const { locale } = useLocale();
  const sessions: ClaudeSession[] = inspection?.claudeSessions || [];

  const toggleSession = (name: string) =>
    update({
      selectedSessions: draft.selectedSessions.includes(name)
        ? draft.selectedSessions.filter((s) => s !== name)
        : [...draft.selectedSessions, name],
    });

  const toggleItem = (session: string, text: string) => {
    const exists = draft.selectedContextItems.some((item) => item.session === session && item.text === text);
    update({
      selectedContextItems: exists
        ? draft.selectedContextItems.filter((item) => !(item.session === session && item.text === text))
        : [...draft.selectedContextItems, { session, text }],
    });
  };

  const addReference = () =>
    update({
      references: [...draft.references, { name: '', path: '', inject: false }],
    });

  const updateReference = (index: number, patch: Partial<Reference>) =>
    update({
      references: draft.references.map((ref, i) =>
        i === index ? { ...ref, ...patch } : ref,
      ),
    });

  const removeReference = (index: number) =>
    update({
      references: draft.references.filter((_, i) => i !== index),
    });

  const hasGuidance = inspection?.guidanceFiles.includes('AGENTS.md') ?? false;
  const hasAnythingToPin =
    draft.pinMemory || draft.selectedSessions.length > 0;

  return (
    <div className="space-y-4">
      <p className="text-sm">{t('projects.wizardContextDesc')}</p>

      {/* AGENTS.md section */}
      <div className="space-y-1">
        <p className="text-sm font-medium">{t('projects.wizardGuidance')}</p>
        {hasGuidance ? (
          <p className="text-sm text-[var(--t-text-3)]">
            {t('projects.wizardGuidanceFound')}:{' '}
            {inspection!.guidanceFiles.join(', ')}
          </p>
        ) : (
          <>
            <Suggestion
              checked={draft.agentsDraft}
              onChange={(value) => update({ agentsDraft: value })}
              label={t('projects.wizardAgentsDraft')}
              reason={t('projects.wizardAgentsDraftReason')}
            />
            {draft.agentsDraft && (
              <div className="space-y-2">
                <textarea
                  aria-label={t('projects.wizardAgentsContent')}
                  className="min-h-32 w-full rounded border bg-[var(--t-surface-2)] p-2 text-sm"
                  value={draft.agentsContent}
                  onChange={(event) =>
                    update({ agentsContent: event.target.value })
                  }
                />
                <Suggestion
                  checked={draft.agentsApproved}
                  onChange={(value) => update({ agentsApproved: value })}
                  label={t('projects.wizardAgentsApprove')}
                  reason={t('projects.wizardAgentsApproveReason')}
                />
              </div>
            )}
          </>
        )}
      </div>

      {/* Read-only references */}
      <div className="space-y-2">
        <p className="text-sm font-medium">
          {t('projects.sectionReferencesTitle')}
        </p>
        {draft.references.map((ref, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input
              className="flex-1"
              value={ref.name}
              onChange={(event) =>
                updateReference(i, { name: event.target.value })
              }
              placeholder={t('projects.refNamePlaceholder')}
            />
            <Input
              className="flex-1"
              value={ref.path}
              onChange={(event) =>
                updateReference(i, { path: event.target.value })
              }
              placeholder={t('projects.refPathPlaceholder')}
            />
            <label className="flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                checked={ref.inject}
                onChange={(event) =>
                  updateReference(i, { inject: event.target.checked })
                }
              />
              {t('projects.inject')}
            </label>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => removeReference(i)}
            >
              ×
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={addReference}
        >
          {t('projects.addReference')}
        </Button>
      </div>

      {/* MEMORY.md preview and pin */}
      {inspection?.memoryPreview && (
        <div className="space-y-1">
          <p className="text-sm font-medium">
            {t('projects.wizardPinMemory')}
          </p>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.pinMemory}
              onChange={(event) =>
                update({ pinMemory: event.target.checked })
              }
            />
            <span>
              {t('projects.wizardPinMemoryLabel')}
              <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-[var(--t-surface-2)] p-2 text-xs">
                {inspection.memoryPreview}
              </pre>
            </span>
          </label>
        </div>
      )}

      {/* Claude sessions listing and selection */}
      {sessions.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">
              {t('projects.wizardSessionsFound', { count: sessions.length })}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                className="text-xs text-[var(--t-accent)] hover:underline"
                onClick={() => update({ selectedSessions: sessions.map((s) => s.name) })}
              >
                {t('projects.wizardSessionSelectAll')}
              </button>
              <button
                type="button"
                className="text-xs text-[var(--t-text-3)] hover:underline"
                onClick={() => update({ selectedSessions: [] })}
              >
                {t('projects.wizardSessionDeselectAll')}
              </button>
            </div>
          </div>
          <ul className="space-y-1 text-sm">
            {sessions.map((session) => (
              <li key={session.name} className="flex flex-col gap-1 rounded border border-[var(--t-border)] p-2">
                <div className="flex items-center justify-between gap-2">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      aria-label={session.name}
                      checked={draft.selectedSessions.includes(session.name)}
                      onChange={() => toggleSession(session.name)}
                    />
                    <span className="text-xs font-mono font-medium">{session.name}</span>
                  </label>
                  <span className="text-xs text-[var(--t-text-3)]" title={formatIsoTitle(session.modifiedAt)}>
                    {formatDateTime(session.modifiedAt, locale)} · {Math.round(session.sizeBytes / 1024)} KB
                  </span>
                </div>
                <details className="text-xs">
                  <summary className="cursor-pointer text-[var(--t-accent)]">{t('projects.wizardViewSession')}</summary>
                  {(() => {
                    const preview = inspection?.claudeSessionPreviews.find((item) => item.name === session.name)?.content;
                    const items = (preview || '').split(/\n+/).map((item) => item.trim()).filter((item) => item.length > 15).slice(0, 20);
                    return items.length ? (
                      <div className="mt-1 max-h-32 space-y-1 overflow-auto rounded bg-[var(--t-surface-2)] p-2">
                        {items.map((item) => (
                          <label key={item} className="flex gap-2 whitespace-pre-wrap">
                            <input type="checkbox" aria-label={t('projects.wizardSelectContextItem', { item: item.slice(0, 40) })} checked={draft.selectedContextItems.some((selected) => selected.session === session.name && selected.text === item)} onChange={() => toggleItem(session.name, item)} />
                            <span>{item}</span>
                          </label>
                        ))}
                      </div>
                    ) : <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-[var(--t-surface-2)] p-2">{preview || t('projects.wizardNoSessionPreview')}</pre>;
                  })()}
                </details>
              </li>
            ))}
          </ul>
        </div>
      )}

      {sessions.length === 0 && !inspection?.memoryPreview && (
        <p className="text-sm text-[var(--t-text-3)]">
          {t('projects.wizardNoSessions')}
        </p>
      )}

      {/* Approval gate: context is only pinned after user approves */}
      {hasAnythingToPin && (
        <Suggestion
          checked={draft.contextApproved}
          onChange={(value) => update({ contextApproved: value })}
          label={t('projects.wizardContextApprove')}
          reason={t('projects.wizardContextReadonly')}
        />
      )}
    </div>
  );
}
