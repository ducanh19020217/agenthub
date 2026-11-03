import type { PresetLevel, ProjectInspection, ProjectSettings } from '../../types/api';

export type WizardMode = 'existing' | 'new';
export type Check = { name: string; cmd: string[]; reason: string };
export type Reference = { name: string; path: string; inject: boolean };
export type ClaudeSession = { name: string; modifiedAt: string; sizeBytes: number };

export interface WizardDraft {
  mode: WizardMode;
  name: string;
  path: string;
  branch: string;
  preset?: PresetLevel;
  departmentId?: string;
  settings: ProjectSettings;
  skipInstall: boolean;
  skipHooks: boolean;
  integration: boolean;
  sensitive: boolean;
  checks: Check[];
  pinMemory: boolean;
  /** User confirmed they want to generate an AGENTS.md draft after creation */
  agentsDraft: boolean;
  /** Read-only references to attach */
  references: Reference[];
  /** Selected Claude sessions for context import */
  selectedSessions: string[];
  selectedContextItems: Array<{ session: string; text: string }>;
  /** User has approved pinning the selected memory/sessions */
  contextApproved: boolean;
  agentsContent: string;
  agentsApproved: boolean;
}

export type Translate = (key: string, vars?: Record<string, string | number>) => string;

export interface StepProps {
  draft: WizardDraft;
  update: (patch: Partial<WizardDraft>) => void;
  t: Translate;
}

export interface StepWithInspectionProps extends StepProps {
  inspection: ProjectInspection | null;
}

export function emptyDraft(): WizardDraft {
  return {
    mode: 'existing',
    name: '',
    path: '',
    branch: 'main',
    preset: 'balanced',
    departmentId: 'chung',
    settings: {
      brain: { mode: 'inherit', permissions: 'standard' },
      worktree: { install: 'auto', gitHooks: 'run' },
      integration: { enabled: false },
      ci: {},
      references: [],
      reviewChecklist: [],
      notifications: { telegramContent: 'full' },
    },
    skipInstall: false,
    skipHooks: false,
    integration: false,
    sensitive: false,
    checks: [],
    pinMemory: false,
    agentsDraft: false,
    references: [],
    selectedSessions: [],
    selectedContextItems: [],
    contextApproved: false,
    agentsContent:
      '# AgentHub project guidance\n\n## Conventions\n- Keep changes focused and use Conventional Commits.\n\n## Checks\n- Run the project checks before committing.\n',
    agentsApproved: false,
  };
}
