import path from 'node:path';
import { z } from 'zod';
import { isSafeProjectRelativePath } from './paths.js';
import { ReviewerFallbackSchema, ReviewerOrderSchema } from '../reviewer-config.js';

/**
 * Per-project behaviour switches, stored as JSON in `projects.settings`.
 *
 * Every section has defaults that reproduce the hub's behaviour before the setting existed, so a
 * project without settings (or with an older, partial JSON) behaves exactly as before. Features
 * read settings only through `projectSettings()`, never by parsing the column themselves.
 */

const ReferenceSchema = z.object({
  /** Short id used in prompts and env vars (AGENTHUB_REF_<NAME>). */
  name: z.string().min(1).max(40).regex(/^[a-zA-Z0-9_-]+$/),
  /** Absolute path to a directory or repo the worker may read but must not modify. */
  path: z.string().min(1),
  /** Inline a small text file (conventions, glossary) into the worker context instead of only listing it. */
  inject: z.boolean().default(false),
});

export function isValidBranchName(val: string): boolean {
  if (!val || val.length > 200) return false;
  if (val.startsWith('/') || val.endsWith('/') || val.includes('//')) return false;
  if (val.includes('..') || val.includes('@{')) return false;
  if (/[~^:?*[\\ ]/.test(val)) return false;
  if (val.endsWith('.lock')) return false;
  return true;
}

export const ProjectSettingsSchema = z.object({
  commitConvention: z.object({
    branchTemplate: z.string().min(1).max(200).default('agenthub/{slug}'),
    commitTemplate: z.string().min(1).max(200).default('{type}: {summary}'),
    commitRegex: z.string().min(1).max(1000).optional(),
    mergeMessageTemplate: z.string().min(1).max(200).default("Merge branch '{branch}' into {target}"),
  }).default({}),
  brain: z.object({
    engine: z.enum(['inherit', 'claude', 'codex']).default('inherit'),
    codexProfile: z.string().min(1).optional(),
    /**
     * Who coordinates this project:
     * - inherit: follow the global `brain.mode`
     * - off / suggest / auto: the hub's resident brain for this project, as for the global modes
     * - external: an outside Claude (e.g. VS Code via MCP) owns planning and review; the hub's brain
     *   ignores this project's events and only notifies.
     */
    mode: z.enum(['inherit', 'off', 'suggest', 'auto', 'external']).default('inherit'),
    permissions: z.enum(['inherit', 'standard', 'trusted', 'full']).default('inherit'),
    /** Overrides the global limits for this project's brain; unset = global value. */
    dailyTokenBudget: z.number().int().min(0).optional(),
    maxTurnsPerHour: z.number().int().positive().optional(),
  }).default({}),
  worktree: z.object({
    /** Absolute parent directory for task worktrees. Each task is created as <root>/<slug>. */
    root: z.string().min(1).refine((value) => path.isAbsolute(value), 'phải là đường dẫn tuyệt đối').optional(),
    /** Store task logs in <worktree root>/.logs instead of the hub home. */
    logsInRoot: z.boolean().optional(),
    /** auto: prepare node_modules when a lockfile exists; skip: never install; worker: worker installs dependencies. */
    install: z.enum(['auto', 'skip', 'worker']).default('auto'),
    /** run: git hooks (husky, commitlint…) run on worker commits; skip: workers commit with hooks disabled. */
    gitHooks: z.enum(['run', 'skip']).default('run'),
  }).default({}),
  integration: z.object({
    /** When enabled, approved tasks merge into a local integration branch the hub manages. */
    enabled: z.boolean().default(false),
    /** Local branch name, e.g. `agenthub/integration` or `anhdd/kb-portal-locale`. */
    branch: z.string().trim().min(1, 'Tên nhánh không được để trống').max(200).refine(isValidBranchName, 'Tên nhánh chứa ký tự không hợp lệ hoặc sai cú pháp').optional(),
    /** Branch/ref the integration branch starts from; defaults to the project's defaultBranch. */
    baseRef: z.string().trim().min(1, 'Tên nhánh gốc không được để trống').max(200).refine(isValidBranchName, 'Tên nhánh gốc chứa ký tự không hợp lệ hoặc sai cú pháp').optional(),
    /** Merge (and so self-deploy) on its own once a Codex reviewer approves the last review-chain step. */
    autoMerge: z.boolean().default(false),
  }).default({}),
  review: z.object({
    /** Merge automatically after the final reviewer approves and hub checks pass. */
    autoMerge: z.boolean().default(false),
    order: ReviewerOrderSchema.nullable().optional(),
    fallback: ReviewerFallbackSchema.partial().nullable().optional(),
  }).default({}),
  ci: z.object({
    /** When enabled, hub monitors GitHub Actions CI runs for this project. Defaults to true for GitHub repos. */
    enabled: z.boolean().optional(),
    /** Branch to monitor; defaults to the project's defaultBranch or pushed branch. */
    branch: z.string().trim().min(1, 'Tên nhánh CI không được để trống').max(200).refine(isValidBranchName, 'Tên nhánh CI chứa ký tự không hợp lệ hoặc sai cú pháp').optional(),
  }).default({}),
  /** Read-only material workers may consult (another repo, shared data, glossary). */
  references: z.array(ReferenceSchema).max(20).default([]),
  /** Files the brain must check against every review (at most five project-local paths). */
  reviewChecklist: z.array(z.string().min(1).max(500).refine(isSafeProjectRelativePath, 'phải là đường dẫn tương đối trong project, không được chứa ..')).max(5).default([]),
  notifications: z.object({
    /** full: task titles and summaries in Telegram; minimal: only counts and links, no content. */
    telegramContent: z.enum(['full', 'minimal']).default('full'),
  }).default({}),
});

export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;

/** Input accepted by the API: every section and field optional; merged over the stored settings. */
export const ProjectSettingsInputSchema = z.object({
  commitConvention: ProjectSettingsSchema.shape.commitConvention.removeDefault().partial().optional(),
  brain: ProjectSettingsSchema.shape.brain.removeDefault().partial().optional(),
  worktree: ProjectSettingsSchema.shape.worktree.removeDefault().partial().optional(),
  integration: ProjectSettingsSchema.shape.integration.removeDefault().partial().optional(),
  review: ProjectSettingsSchema.shape.review.removeDefault().partial().optional(),
  ci: ProjectSettingsSchema.shape.ci.removeDefault().partial().optional(),
  references: z.array(ReferenceSchema).max(20).optional(),
  reviewChecklist: z.array(z.string().min(1).max(500).refine(isSafeProjectRelativePath, 'phải là đường dẫn tương đối trong project, không được chứa ..')).max(5).optional(),
  notifications: ProjectSettingsSchema.shape.notifications.removeDefault().partial().optional(),
});

export type ProjectSettingsInput = z.infer<typeof ProjectSettingsInputSchema>;

export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = ProjectSettingsSchema.parse({});

/** Parse the stored column. Invalid or missing JSON yields defaults (never throws). */
export function parseProjectSettings(raw: string | null | undefined): ProjectSettings {
  if (!raw) return ProjectSettingsSchema.parse({});
  try {
    const result = ProjectSettingsSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : ProjectSettingsSchema.parse({});
  } catch {
    return ProjectSettingsSchema.parse({});
  }
}

/** Settings of a project row (or defaults when the row has none). */
export function projectSettings(project: { settings?: string | null } | null | undefined): ProjectSettings {
  return parseProjectSettings(project?.settings);
}

/** Merge a partial update over current settings, section by section; arrays are replaced. */
export function mergeProjectSettings(current: ProjectSettings, input: ProjectSettingsInput): ProjectSettings {
  let nextReviewOrder = current.review?.order;
  if (input.review && 'order' in input.review) {
    nextReviewOrder = input.review.order === null ? undefined : input.review.order;
  }

  let nextReviewFallback = current.review?.fallback;
  if (input.review && 'fallback' in input.review) {
    nextReviewFallback = input.review.fallback === null ? undefined : (
      input.review.fallback
        ? { ...current.review?.fallback, ...input.review.fallback }
        : undefined
    );
  }

  return ProjectSettingsSchema.parse({
    brain: { ...current.brain, ...input.brain },
    commitConvention: { ...current.commitConvention, ...input.commitConvention },
    worktree: { ...current.worktree, ...input.worktree },
    integration: { ...current.integration, ...input.integration },
    review: {
      autoMerge: input.review?.autoMerge ?? current.review?.autoMerge ?? false,
      ...(nextReviewOrder ? { order: nextReviewOrder } : {}),
      ...(nextReviewFallback ? { fallback: nextReviewFallback } : {}),
    },
    ci: { ...current.ci, ...input.ci },
    references: input.references ?? current.references,
    reviewChecklist: input.reviewChecklist ?? current.reviewChecklist,
    notifications: { ...current.notifications, ...input.notifications },
  });
}
