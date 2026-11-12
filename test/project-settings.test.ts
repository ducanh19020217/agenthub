import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/daemon.js';
import { FakeEngine, type Engine } from '../src/engines/index.js';
import {
  DEFAULT_PROJECT_SETTINGS,
  PublishSettingsSchema,
  PublishSettingsInputSchema,
  type ProjectSettings,
  mergeProjectSettings,
  parseProjectSettings,
  projectSettings,
} from '../src/projects/settings.js';
import { projectWorktreeRoot } from '../src/projects/paths.js';
import { effectiveBrainEngine } from '../src/brain/engine.js';

describe('project settings parsing', () => {
  it('resolves project engine before global engine and inherits by default', () => {
    expect(effectiveBrainEngine(null, { engine: 'codex' })).toBe('codex');
    expect(effectiveBrainEngine({ settings: JSON.stringify({ brain: { engine: 'claude' } }) }, { engine: 'codex' })).toBe('claude');
    expect(effectiveBrainEngine({ settings: JSON.stringify({}) }, { engine: 'codex' })).toBe('codex');
  });
  it('defaults reproduce the behaviour from before settings existed', () => {
    expect(DEFAULT_PROJECT_SETTINGS).toEqual({
      commitConvention: {
        branchTemplate: 'agenthub/{slug}',
        commitTemplate: '{type}: {summary}',
        defaultRef: '',
        mergeMessageTemplate: "Merge branch '{branch}' into {target}",
      },
      brain: { engine: 'inherit', mode: 'inherit', permissions: 'inherit' },
      worktree: { install: 'auto', gitHooks: 'run' },
      integration: { enabled: false, autoMerge: false },
      review: { autoMerge: false },
      ci: {},
      references: [],
      reviewChecklist: [],
      notifications: { telegramContent: 'full' },
      publish: {
        enabled: true,
        remote: 'origin',
        pushIntegrationBranch: true,
        audit: {
          enabled: true,
          maxFixRounds: 2,
          maxTasks: 10,
        },
      },
    });
    expect(projectSettings(undefined)).toEqual(DEFAULT_PROJECT_SETTINGS);
    expect(projectSettings({ settings: null })).toEqual(DEFAULT_PROJECT_SETTINGS);
  });

  it('never throws on broken or outdated stored JSON', () => {
    expect(parseProjectSettings('{not json')).toEqual(DEFAULT_PROJECT_SETTINGS);
    expect(parseProjectSettings(JSON.stringify({ brain: { mode: 'bogus' } }))).toEqual(DEFAULT_PROJECT_SETTINGS);
    // An older JSON with only some sections still gets defaults for the rest.
    expect(parseProjectSettings(JSON.stringify({ worktree: { install: 'skip' } }))).toEqual({
      ...DEFAULT_PROJECT_SETTINGS,
      worktree: { install: 'skip', gitHooks: 'run' },
    });
  });

  it('merges a partial update field by field and replaces reference lists', () => {
    const current = mergeProjectSettings(DEFAULT_PROJECT_SETTINGS, {
      brain: { mode: 'auto', dailyTokenBudget: 1000 },
      references: [{ name: 'old', path: '/data/old', inject: false }],
    });
    const next = mergeProjectSettings(current, {
      brain: { dailyTokenBudget: 5000 },
      references: [{ name: 'glossary', path: '/data/glossary.md', inject: true }],
    });
    expect(next.brain).toEqual({ engine: 'inherit', mode: 'auto', permissions: 'inherit', dailyTokenBudget: 5000 });
    expect(next.references).toEqual([{ name: 'glossary', path: '/data/glossary.md', inject: true }]);
    expect(next.worktree).toEqual(DEFAULT_PROJECT_SETTINGS.worktree);
  });

  it('merges ci settings and preserves unset fields', () => {
    const updated = mergeProjectSettings(DEFAULT_PROJECT_SETTINGS, {
      ci: { enabled: true, branch: 'develop' },
    });
    expect(updated.ci).toEqual({ enabled: true, branch: 'develop' });

    const partial = mergeProjectSettings(updated, {
      ci: { branch: 'staging' },
    });
    expect(partial.ci).toEqual({ enabled: true, branch: 'staging' });
  });

  it('merges publish audit settings and respects defaults', () => {
    const updated = mergeProjectSettings(DEFAULT_PROJECT_SETTINGS, {
      publish: {
        enabled: true,
        audit: { enabled: true, maxFixRounds: 3 },
      },
    });
    expect(updated.publish.enabled).toBe(true);
    expect(updated.publish.audit).toEqual({ enabled: true, maxFixRounds: 3, maxTasks: 10 });

    const disabledAudit = mergeProjectSettings(updated, {
      publish: {
        audit: { enabled: false },
      },
    });
    expect(disabledAudit.publish.audit).toEqual({ enabled: false, maxFixRounds: 3, maxTasks: 10 });
  });

  it('clears reviewer order and fallback overrides when set to null in mergeProjectSettings', () => {
    const withOverrides = mergeProjectSettings(DEFAULT_PROJECT_SETTINGS, {
      review: {
        order: [{ engine: 'codex', model: 'codex:gpt-5.6-luna', profiles: [] }],
        fallback: { onUnavailable: false, onError: false, onBusyAfterMin: 5 },
      },
    });
    expect(withOverrides.review.order).toEqual([{ engine: 'codex', model: 'codex:gpt-5.6-luna', profiles: [] }]);
    expect(withOverrides.review.fallback).toEqual({ onUnavailable: false, onError: false, onBusyAfterMin: 5 });

    // Clearing only order with null preserves fallback
    const clearedOrder = mergeProjectSettings(withOverrides, {
      review: { order: null },
    });
    expect(clearedOrder.review.order).toBeUndefined();
    expect(clearedOrder.review.fallback).toEqual({ onUnavailable: false, onError: false, onBusyAfterMin: 5 });

    // Clearing only fallback with null preserves order
    const clearedFallback = mergeProjectSettings(withOverrides, {
      review: { fallback: null },
    });
    expect(clearedFallback.review.order).toEqual([{ engine: 'codex', model: 'codex:gpt-5.6-luna', profiles: [] }]);
    expect(clearedFallback.review.fallback).toBeUndefined();

    // Clearing both with null
    const clearedBoth = mergeProjectSettings(withOverrides, {
      review: { order: null, fallback: null },
    });
    expect(clearedBoth.review).toEqual({ autoMerge: false });
  });

  it('supports an explicit worktree root and keeps the legacy default', () => {
    const root = path.join(os.tmpdir(), 'agenthub-worktree-root-test');
    const project = { id: 'demo', path: path.join(root, 'repo'), settings: JSON.stringify({ worktree: { root } }) };
    expect(projectWorktreeRoot(project, path.join(root, 'hub'))).toBe(root);
    expect(projectWorktreeRoot({ id: 'demo', path: project.path }, path.join(root, 'hub')))
      .toBe(path.join(root, 'hub', 'worktrees', 'demo'));
  });

  it('does not move an unconfigured project based on its mount path', () => {
    const hub = path.join(os.tmpdir(), 'agenthub-hub');
    const project = { id: 'mounted', path: '/media/veracrypt8/company/repo' };
    expect(projectWorktreeRoot(project, hub)).toBe(path.join(hub, 'worktrees', 'mounted'));
  });
});

describe('project settings through the service', () => {
  let tmpDir: string;
  let ctx: ReturnType<typeof createContext>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-project-settings-'));
    process.env.AGENTHUB_HOME = tmpDir;
    process.env.AGENTHUB_AGY_HOMES = path.join(tmpDir, 'agy-homes');
    fs.mkdirSync(process.env.AGENTHUB_AGY_HOMES, { recursive: true });
    const config = loadConfig(tmpDir);
    config.port = 0;
    const engines = new Map<string, Engine>([['agy', new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'))]]);
    ctx = createContext(config, engines);
    ctx.scheduler.stop();
    // createProject requires a real git repo whose default branch exists.
    const repo = path.join(tmpDir, 'repo');
    fs.mkdirSync(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo });
  });

  afterEach(() => {
    ctx.scheduler.stop();
    ctx.db.close();
    delete process.env.AGENTHUB_HOME;
    delete process.env.AGENTHUB_AGY_HOMES;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exposes defaults for a project created without settings', () => {
    const created = ctx.service.createProject({ name: 'plain', path: path.join(tmpDir, 'repo') }) as unknown as { settings: unknown };
    expect(created.settings).toEqual(DEFAULT_PROJECT_SETTINGS);
    expect((created as unknown as { merge: unknown }).merge).toEqual({
      enabled: true,
      worktrees: { main: path.join(tmpDir, 'repo') },
      checks: [],
      timeoutSec: 600,
    });
  });

  it('moves the automatic merge mapping when the default branch changes', () => {
    ctx.service.createProject({ name: 'branch-map', path: path.join(tmpDir, 'repo') });
    const updated = ctx.service.updateProject('branch-map', { defaultBranch: 'develop' }) as unknown as { merge: { worktrees: Record<string, string> } };
    expect(updated.merge.worktrees).toEqual({ develop: path.join(tmpDir, 'repo') });
  });

  it('does not move a merge mapping that points to a user-selected folder', () => {
    ctx.service.createProject({ name: 'custom-map', path: path.join(tmpDir, 'repo'), merge: { enabled: true, worktrees: { main: path.join(tmpDir, 'custom-integration') }, checks: [], timeoutSec: 600 } });
    const updated = ctx.service.updateProject('custom-map', { defaultBranch: 'develop' }) as unknown as { merge: { worktrees: Record<string, string> } };
    expect(updated.merge.worktrees).toEqual({ main: path.join(tmpDir, 'custom-integration') });
  });

  it('migrates a legacy git project with an empty merge configuration', () => {
    const legacyPath = path.join(tmpDir, 'repo');
    ctx.projectRepo.insert({ id: 'legacy-map', name: 'Legacy map', path: legacyPath, defaultBranch: 'main', envTemplate: null, maxParallel: 1, merge: null });
    (ctx.service as unknown as { migrateProjectMergeMappings: () => void }).migrateProjectMergeMappings();
    expect(JSON.parse(ctx.projectRepo.get('legacy-map')?.merge || '{}')).toEqual({
      enabled: true,
      worktrees: { main: legacyPath },
      checks: [],
      timeoutSec: 600,
    });
    expect(ctx.eventRepo.getByTask('legacy-map')).toHaveLength(0);
    expect(ctx.eventRepo.getRecent(20).some((event) => event.type === 'project.merge_migrated' && event.payload?.includes('legacy-map'))).toBe(true);
  });

  it('returns an early merge warning when a task targets an unmapped base branch', () => {
    ctx.service.createProject({ name: 'warning-map', path: path.join(tmpDir, 'repo'), merge: { enabled: true, worktrees: {}, checks: [], timeoutSec: 600 } });
    const task = ctx.service.createTask({ project: 'warning-map', slug: 'needs-merge', title: 'Needs merge', body: 'body' }) as unknown as { mergeWarning?: string };
    expect(task.mergeWarning).toContain('chưa có worktree tích hợp');
  });

  it('stores settings on create and merges partial updates', () => {
    ctx.service.createProject({
      name: 'fe',
      path: path.join(tmpDir, 'repo'),
      settings: { brain: { mode: 'external' }, worktree: { install: 'skip' } },
    });
    const updated = ctx.service.updateProject('fe', { settings: { worktree: { gitHooks: 'skip' } } }) as unknown as {
      settings: typeof DEFAULT_PROJECT_SETTINGS;
    };
    expect(updated.settings.brain.mode).toBe('external');
    expect(updated.settings.worktree).toEqual({ install: 'skip', gitHooks: 'skip' });

    // Updating other fields leaves settings untouched.
    const renamed = ctx.service.updateProject('fe', { name: 'Frontend' }) as unknown as { settings: typeof DEFAULT_PROJECT_SETTINGS };
    expect(renamed.settings.worktree).toEqual({ install: 'skip', gitHooks: 'skip' });
  });

  it('rejects invalid settings', () => {
    expect(() => ctx.service.createProject({
      name: 'bad',
      path: path.join(tmpDir, 'repo'),
      settings: { brain: { mode: 'sometimes' } },
    })).toThrow();
    expect(() => ctx.service.createProject({
      name: 'bad2',
      path: path.join(tmpDir, 'repo'),
      settings: { references: [{ name: 'has space', path: '/x' }] },
    })).toThrow();
    expect(() => ctx.service.createProject({
      name: 'bad3',
      path: path.join(tmpDir, 'repo'),
      settings: { reviewChecklist: ['/etc/passwd'] },
    })).toThrow();
    expect(() => ctx.service.createProject({
      name: 'bad4',
      path: path.join(tmpDir, 'repo'),
      settings: { reviewChecklist: ['docs/../secret.md'] },
    })).toThrow();
    expect(() => ctx.service.createProject({
      name: 'bad5',
      path: path.join(tmpDir, 'repo'),
      settings: { worktree: { root: path.join(tmpDir, 'missing-root') } },
    })).toThrow(/không tồn tại/);
    expect(() => ctx.service.createProject({
      name: 'bad6',
      path: path.join(tmpDir, 'repo'),
      settings: { integration: { branch: 'invalid branch with spaces' } },
    })).toThrow();
    expect(() => ctx.service.createProject({
      name: 'bad7',
      path: path.join(tmpDir, 'repo'),
      settings: { review: { order: [{ engine: 'claude', model: '   ' }] } },
    })).toThrow();
    expect(() => ctx.service.createProject({
      name: 'bad8',
      path: path.join(tmpDir, 'repo'),
      settings: { review: { order: [{ engine: 'claude', model: 'gpt-5.6-luna' }] } },
    })).toThrow();
    expect(() => ctx.service.createProject({
      name: 'bad9',
      path: path.join(tmpDir, 'repo'),
      reviewChain: [{ reviewer: 'codex:', mode: 'gate' }],
    })).toThrow();
  });

  it('accepts an existing external worktree root', () => {
    const root = path.join(tmpDir, 'custom-worktrees');
    fs.mkdirSync(root);
    const created = ctx.service.createProject({
      name: 'custom-root',
      path: path.join(tmpDir, 'repo'),
      settings: { worktree: { root } },
    }) as unknown as { settings: { worktree: { root?: string } } };
    expect(created.settings.worktree.root).toBe(root);
  });

  it('creates the project-local worktree root used by sensitive projects', () => {
    const root = path.join(tmpDir, '.agenthub-worktrees');
    const created = ctx.service.createProject({
      name: 'sensitive',
      path: path.join(tmpDir, 'repo'),
      settings: { worktree: { root, logsInRoot: true } },
    }) as unknown as { settings: { worktree: { root?: string; logsInRoot?: boolean } } };

    expect(fs.statSync(root).isDirectory()).toBe(true);
    expect(created.settings.worktree).toMatchObject({ root, logsInRoot: true });
  });

  it('supports round-trip removal of reviewer order and fallback overrides via null', () => {
    ctx.service.createProject({
      name: 'override-proj',
      path: path.join(tmpDir, 'repo'),
      settings: {
        review: {
          order: [{ engine: 'claude', model: 'sonnet', profiles: [] }],
          fallback: { onUnavailable: false, onError: true, onBusyAfterMin: 15 },
        },
      },
    });

    // Check project settings after creation
    const proj1 = ctx.service.getProject('override-proj') as unknown as { settings: typeof DEFAULT_PROJECT_SETTINGS };
    expect(proj1.settings.review.order).toEqual([{ engine: 'claude', model: 'sonnet', profiles: [] }]);
    expect(proj1.settings.review.fallback).toMatchObject({ onUnavailable: false, onBusyAfterMin: 15 });

    // Update with order: null to remove reviewer order override
    ctx.service.updateProject('override-proj', {
      settings: { review: { order: null } },
    });
    const proj2 = ctx.service.getProject('override-proj') as unknown as { settings: typeof DEFAULT_PROJECT_SETTINGS };
    expect(proj2.settings.review.order).toBeUndefined();
    expect(proj2.settings.review.fallback).toMatchObject({ onUnavailable: false, onBusyAfterMin: 15 });

    // Update with fallback: null to remove fallback override
    ctx.service.updateProject('override-proj', {
      settings: { review: { fallback: null } },
    });
    const proj3 = ctx.service.getProject('override-proj') as unknown as { settings: typeof DEFAULT_PROJECT_SETTINGS };
    expect(proj3.settings.review.order).toBeUndefined();
    expect(proj3.settings.review.fallback).toBeUndefined();
    expect(proj3.settings.review).toEqual({ autoMerge: false });
  });

  describe('publish.enabledAt protection and validation', () => {
    it('từ chối giá trị enabledAt ở tương lai qua PublishSettingsSchema và PublishSettingsInputSchema', () => {
      const futureDate = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
      const pastDate = new Date(Date.now() - 3600 * 1000).toISOString();

      // Valid past date
      expect(PublishSettingsSchema.safeParse({ enabledAt: pastDate }).success).toBe(true);
      expect(PublishSettingsInputSchema.safeParse({ enabledAt: pastDate }).success).toBe(true);

      // Invalid future date
      const r1 = PublishSettingsSchema.safeParse({ enabledAt: futureDate });
      expect(r1.success).toBe(false);
      expect(r1.error?.issues[0]?.message).toContain('enabledAt không được ở tương lai');

      const r2 = PublishSettingsInputSchema.safeParse({ enabledAt: futureDate });
      expect(r2.success).toBe(false);
      expect(r2.error?.issues[0]?.message).toContain('enabledAt không được ở tương lai');
    });

    it('mergeProjectSettings bỏ qua enabledAt do client gửi lên và chỉ cập nhật khi chuyển từ tắt sang bật', () => {
      const initial = parseProjectSettings(JSON.stringify({
        publish: { enabled: true, enabledAt: '2026-01-01T00:00:00.000Z' },
      }));

      // Client attempts to overwrite enabledAt with an arbitrary date
      const merged1 = mergeProjectSettings(initial, {
        publish: { enabledAt: '2026-02-01T00:00:00.000Z' } as unknown as ProjectSettings['publish'],
      });
      // Client value must be ignored, original enabledAt retained
      expect(merged1.publish.enabledAt).toBe('2026-01-01T00:00:00.000Z');

      // Disabling publish retains enabledAt
      const mergedDisabled = mergeProjectSettings(initial, {
        publish: { enabled: false },
      });
      expect(mergedDisabled.publish.enabled).toBe(false);
      expect(mergedDisabled.publish.enabledAt).toBe('2026-01-01T00:00:00.000Z');

      // Enabling publish from disabled state sets new current timestamp
      const beforeEnable = Date.now();
      const mergedReEnabled = mergeProjectSettings(mergedDisabled, {
        publish: { enabled: true },
      });
      expect(mergedReEnabled.publish.enabled).toBe(true);
      expect(mergedReEnabled.publish.enabledAt).toBeDefined();
      const newEnabledTime = Date.parse(mergedReEnabled.publish.enabledAt!);
      expect(newEnabledTime).toBeGreaterThanOrEqual(beforeEnable);
    });
  });
});
