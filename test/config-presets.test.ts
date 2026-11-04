import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/daemon.js';
import { createServer } from '../src/api/server.js';
import { getOrCreateToken } from '../src/auth.js';
import { FakeEngine, type Engine } from '../src/engines/index.js';
import { parseProjectSettings, mergeProjectSettings } from '../src/projects/settings.js';
import { effectiveBrainMode, effectiveBrainPermission } from '../src/brain/mode.js';
import { effectiveBrainEngine } from '../src/brain/engine.js';
import { MIGRATIONS } from '../src/db/index.js';

let tmpDir: string;
let config: ReturnType<typeof loadConfig>;
let ctx: ReturnType<typeof createContext>;
let server: ReturnType<typeof createServer>;
let token: string;
let fakeEngine: FakeEngine;

function authHeaders() {
  return {
    host: '127.0.0.1',
    authorization: `Bearer ${token}`,
  };
}

function initGitRepo(repoPath: string) {
  fs.mkdirSync(repoPath, { recursive: true });
  execFileSync('git', ['init', '--template='], { cwd: repoPath });
  execFileSync('git', ['checkout', '-b', 'main'], { cwd: repoPath });
  fs.writeFileSync(path.join(repoPath, 'package.json'), JSON.stringify({
    name: 'test-project',
    scripts: {
      lint: 'eslint .',
      typecheck: 'tsc --noEmit',
      test: 'vitest run',
    },
  }, null, 2));
  execFileSync('git', ['add', '.'], { cwd: repoPath });
  execFileSync('git', ['commit', '-m', 'chore: initial commit', '--allow-empty'], {
    cwd: repoPath,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
}

describe('Config Presets, Priority, and Effective Config', () => {
  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-presets-test-'));
    const agyHomesDir = path.join(tmpDir, 'agy-homes');
    fs.mkdirSync(agyHomesDir, { recursive: true });

    config = loadConfig(tmpDir);
    token = getOrCreateToken(config.tokenPath);

    fakeEngine = new FakeEngine('codex');
    const engines = new Map<string, Engine>();
    engines.set('codex', fakeEngine);

    ctx = createContext(config, engines);
    ctx.scheduler.stop();

    server = await createServer(ctx.service, config);
    await server.ready();
  });

  afterEach(async () => {
    ctx?.scheduler?.stop();
    await server?.close();
    ctx?.db?.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  describe('1. Thứ tự ưu tiên (project > department > global)', () => {
    it('ưu tiên project khi project cấu hình khác inherit', () => {
      const project = { settings: JSON.stringify({ brain: { permissions: 'trusted', mode: 'auto', engine: 'codex' } }) };
      const department = { brainPermissions: 'standard', brainMode: 'suggest', brainEngine: 'claude' };
      const globalConfig = { permissions: 'full' as const, mode: 'off' as const, engine: 'claude' as const };

      expect(effectiveBrainPermission(project, globalConfig, department)).toBe('trusted');
      expect(effectiveBrainMode('p1', project, globalConfig, department)).toBe('auto');
      expect(effectiveBrainEngine(project, globalConfig, department)).toBe('codex');
    });

    it('ưu tiên department khi project là inherit và department khác inherit', () => {
      const project = { settings: JSON.stringify({ brain: { permissions: 'inherit', mode: 'inherit', engine: 'inherit' } }) };
      const department = { brainPermissions: 'standard', brainMode: 'suggest', brainEngine: 'codex' };
      const globalConfig = { permissions: 'full' as const, mode: 'off' as const, engine: 'claude' as const };

      expect(effectiveBrainPermission(project, globalConfig, department)).toBe('standard');
      expect(effectiveBrainMode('p1', project, globalConfig, department)).toBe('suggest');
      expect(effectiveBrainEngine(project, globalConfig, department)).toBe('codex');
    });

    it('rơi về global khi cả project và department đều là inherit', () => {
      const project = { settings: JSON.stringify({ brain: { permissions: 'inherit', mode: 'inherit', engine: 'inherit' } }) };
      const department = { brainPermissions: 'inherit', brainMode: 'inherit', brainEngine: 'inherit' };
      const globalConfig = { permissions: 'standard' as const, mode: 'suggest' as const, engine: 'claude' as const };

      expect(effectiveBrainPermission(project, globalConfig, department)).toBe('standard');
      expect(effectiveBrainMode('p1', project, globalConfig, department)).toBe('suggest');
      expect(effectiveBrainEngine(project, globalConfig, department)).toBe('claude');
    });
  });

  describe('2. Migration inherit (Migration 58)', () => {
    it('cập nhật các giá trị mặc định cũ của department thành inherit và 0', () => {
      const dbPath = path.join(tmpDir, 'migration-test.db');
      const db = new Database(dbPath);

      const inheritMigration = MIGRATIONS.find((sql) => sql.includes("UPDATE departments SET brainEngine = 'inherit'"));
      expect(inheritMigration).toBeDefined();
      const inheritIndex = MIGRATIONS.indexOf(inheritMigration!);

      // Run migrations up to the migration under test; later migrations belong to other features.
      for (let i = 0; i < inheritIndex; i++) {
        db.exec(MIGRATIONS[i]);
      }

      // Insert a department with old default values
      db.prepare(`
        INSERT INTO departments (
          id, name, brainEngine, brainModel, brainPermissions, brainMaxTurnsPerHour, brainDailyTokenBudget
        ) VALUES (
          'test-dept', 'Test Dept', 'claude', 'sonnet', 'full', 20, 0
        )
      `).run();

      db.exec(inheritMigration!);

      const row = db.prepare('SELECT * FROM departments WHERE id = ?').get('test-dept') as {
        brainEngine: string;
        brainModel: string;
        brainPermissions: string;
        brainMaxTurnsPerHour: number;
      };

      expect(row.brainEngine).toBe('inherit');
      expect(row.brainModel).toBe('inherit');
      expect(row.brainPermissions).toBe('inherit');
      expect(row.brainMaxTurnsPerHour).toBe(0);

      db.close();
    });
  });

  describe('3. GET /api/projects/:id/effective-config và nguồn source', () => {
    it('trả về cấu hình hiệu lực kèm nguồn attribution chính xác', async () => {
      const repoDir = path.join(tmpDir, 'test-repo-eff');
      initGitRepo(repoDir);

      // Tạo phòng ban custom
      await server.inject({
        method: 'POST',
        url: '/api/departments',
        headers: authHeaders(),
        payload: {
          id: 'dept-alpha',
          name: 'Phòng Alpha',
          brainMode: 'suggest',
          brainPermissions: 'trusted',
          brainMaxTurnsPerHour: 30,
        },
      });

      // Tạo project trong phòng ban dept-alpha với brain.engine = codex, nhưng permissions = inherit, mode = inherit
      const createRes = await server.inject({
        method: 'POST',
        url: '/api/projects',
        headers: authHeaders(),
        payload: {
          id: 'proj-alpha',
          name: 'Dự án Alpha',
          path: repoDir,
          departmentId: 'dept-alpha',
          checks: [{ name: 'lint', cmd: ['npm', 'run', 'lint'] }],
          settings: {
            brain: {
              engine: 'codex',
              dailyTokenBudget: 50000,
            },
            review: {
              autoMerge: true,
            },
          },
        },
      });
      expect(createRes.statusCode).toBe(201);

      // Gọi effective-config
      const effRes = await server.inject({
        method: 'GET',
        url: '/api/projects/proj-alpha/effective-config',
        headers: authHeaders(),
      });
      expect(effRes.statusCode).toBe(200);
      const eff = JSON.parse(effRes.body);

      // engine từ project
      expect(eff.brain.engine).toEqual({ value: 'codex', source: 'project' });
      // dailyTokenBudget từ project
      expect(eff.brain.budgets.dailyTokenBudget).toEqual({ value: 50000, source: 'project' });
      // permissions từ department
      expect(eff.brain.permissions).toEqual({ value: 'trusted', source: 'department' });
      // mode từ department
      expect(eff.brain.mode).toEqual({ value: 'suggest', source: 'department' });
      // maxTurnsPerHour từ department
      expect(eff.brain.budgets.maxTurnsPerHour).toEqual({ value: 30, source: 'department' });
      // autoMerge từ project
      expect(eff.review.autoMerge).toEqual({ value: true, source: 'project' });
      // checks từ project
      expect(eff.review.checks.value).toHaveLength(1);
      expect(eff.review.checks.source).toBe('project');
    });
  });

  describe('4. autoMergeReadiness', () => {
    it('kiểm tra chính xác 3 điều kiện: autoMerge, checks, và review chain kết thúc bằng Codex', async () => {
      const repoDir = path.join(tmpDir, 'test-repo-readiness');
      initGitRepo(repoDir);

      // Case 1: autoMerge=false, không có check, chain rỗng
      await server.inject({
        method: 'POST',
        url: '/api/projects',
        headers: authHeaders(),
        payload: {
          id: 'proj-r1',
          name: 'Proj R1',
          path: repoDir,
          checks: [],
          settings: { review: { autoMerge: false } },
          review: { chain: [] },
        },
      });

      const res1 = await server.inject({
        method: 'GET',
        url: '/api/projects/proj-r1/effective-config',
        headers: authHeaders(),
      });
      const data1 = JSON.parse(res1.body);
      expect(data1.autoMergeReadiness.ready).toBe(false);
      expect(data1.autoMergeReadiness.missing.length).toBeGreaterThanOrEqual(3);

      // Case 2: Bật autoMerge nhưng chưa có check và review chain kết thúc bằng claude
      await server.inject({
        method: 'PATCH',
        url: '/api/projects/proj-r1',
        headers: authHeaders(),
        payload: {
          settings: { review: { autoMerge: true } },
          review: {
            chain: [
              { reviewer: 'codex:gpt-5.6-luna', mode: 'gate' },
              { reviewer: 'claude', mode: 'final' },
            ],
          },
        },
      });

      const res2 = await server.inject({
        method: 'GET',
        url: '/api/projects/proj-r1/effective-config',
        headers: authHeaders(),
      });
      const data2 = JSON.parse(res2.body);
      expect(data2.autoMergeReadiness.ready).toBe(false);
      // Thiếu check và bước cuối là claude
      expect(data2.autoMergeReadiness.missing.some((m: string) => m.includes('check'))).toBe(true);
      expect(data2.autoMergeReadiness.missing.some((m: string) => m.includes('Codex') || m.includes('tự động'))).toBe(true);

      // Case 3: Thêm check và đổi bước cuối thành codex -> READY
      await server.inject({
        method: 'PATCH',
        url: '/api/projects/proj-r1',
        headers: authHeaders(),
        payload: {
          checks: [{ name: 'lint', cmd: ['npm', 'run', 'lint'] }],
          review: {
            chain: [
              { reviewer: 'codex:gpt-5.6-luna', mode: 'final' },
            ],
          },
        },
      });

      const res3 = await server.inject({
        method: 'GET',
        url: '/api/projects/proj-r1/effective-config',
        headers: authHeaders(),
      });
      const data3 = JSON.parse(res3.body);
      expect(data3.autoMergeReadiness.ready).toBe(true);
      expect(data3.autoMergeReadiness.missing).toEqual([]);
    });
  });

  describe('5. Preset API (GET /api/presets, POST /api/presets/apply)', () => {
    it('GET /api/presets trả về danh sách 3 preset kèm mô tả tiếng Việt và tiếng Anh', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/presets',
        headers: authHeaders(),
      });
      expect(res.statusCode).toBe(200);
      const presets = JSON.parse(res.body);
      expect(presets).toHaveLength(3);
      expect(presets.map((p: { id: string }) => p.id)).toEqual(['safe', 'balanced', 'auto']);

      const autoPreset = presets.find((p: { id: string }) => p.id === 'auto');
      expect(autoPreset.name.vi).toBe('Tự động hoá');
      expect(autoPreset.name.en).toBe('Automated');
      expect(autoPreset.config.brain.permissions).toBe('trusted'); // KHÔNG full
      expect(autoPreset.config.review.autoMerge).toBe(true);
      expect(autoPreset.config.review.maxRounds).toBe(3);
    });

    it('dryRun=true tính toán diff nhưng không ghi xuống dữ liệu', async () => {
      const repoDir = path.join(tmpDir, 'test-repo-preset-dry');
      initGitRepo(repoDir);

      await server.inject({
        method: 'POST',
        url: '/api/projects',
        headers: authHeaders(),
        payload: {
          id: 'proj-dry',
          name: 'Proj Dry',
          path: repoDir,
          checks: [{ name: 'lint', cmd: ['npm', 'run', 'lint'] }],
          settings: { brain: { mode: 'suggest' } },
        },
      });

      const res = await server.inject({
        method: 'POST',
        url: '/api/presets/apply',
        headers: authHeaders(),
        payload: {
          scope: 'project:proj-dry',
          preset: 'auto',
          dryRun: true,
        },
      });
      expect(res.statusCode).toBe(200);
      const result = JSON.parse(res.body);
      expect(result.applied).toBe(false);
      expect(result.diff.before['settings.brain.mode']).toBe('suggest');
      expect(result.diff.after['settings.brain.mode']).toBe('auto');

      // Kiểm tra thực tế project vẫn chưa bị đổi
      const checkRes = await server.inject({
        method: 'GET',
        url: '/api/projects/proj-dry',
        headers: authHeaders(),
      });
      expect(JSON.parse(checkRes.body).settings.brain.mode).toBe('suggest');
    });

    it('apply preset cho scope project, cảnh báo nếu preset auto mà chưa có check', async () => {
      const repoDir = path.join(tmpDir, 'test-repo-preset-apply');
      initGitRepo(repoDir);

      // Tạo project KHÔNG có check
      await server.inject({
        method: 'POST',
        url: '/api/projects',
        headers: authHeaders(),
        payload: {
          id: 'proj-nocheck',
          name: 'Proj No Check',
          path: repoDir,
          checks: [],
          settings: { brain: { mode: 'suggest' } },
        },
      });

      // Apply preset auto
      const res = await server.inject({
        method: 'POST',
        url: '/api/presets/apply',
        headers: authHeaders(),
        payload: {
          scope: 'project:proj-nocheck',
          preset: 'auto',
          dryRun: false,
        },
      });
      expect(res.statusCode).toBe(200);
      const result = JSON.parse(res.body);
      expect(result.applied).toBe(true);
      expect(result.warnings).toBeDefined();
      expect(result.warnings[0]).toContain('Project chưa có check nào');
      expect(result.suggestedChecks.length).toBeGreaterThan(0);

      // Xác nhận project đã lưu settings.preset = 'auto'
      const checkRes = await server.inject({
        method: 'GET',
        url: '/api/projects/proj-nocheck',
        headers: authHeaders(),
      });
      const proj = JSON.parse(checkRes.body);
      expect(proj.settings.preset).toBe('auto');
      expect(proj.settings.brain.mode).toBe('auto');
      expect(proj.settings.review.autoMerge).toBe(true);
      expect(proj.settings.integration.autoMerge).toBe(true);
      expect(proj.review.chain).toHaveLength(1);
      expect(proj.review.maxRounds).toBe(3);

      // Sửa tay một trường (ví dụ mode thành 'suggest') -> detectPreset trả về 'custom'
      await server.inject({
        method: 'PATCH',
        url: '/api/projects/proj-nocheck',
        headers: authHeaders(),
        payload: {
          settings: { brain: { mode: 'suggest' } },
        },
      });

      const effRes = await server.inject({
        method: 'GET',
        url: '/api/projects/proj-nocheck/effective-config',
        headers: authHeaders(),
      });
      expect(JSON.parse(effRes.body).preset).toBe('custom');
    });

    it('apply preset cho scope department và scope global', async () => {
      // 1. Department
      await server.inject({
        method: 'POST',
        url: '/api/departments',
        headers: authHeaders(),
        payload: { id: 'dept-presets', name: 'Dept Presets' },
      });

      const deptApplyRes = await server.inject({
        method: 'POST',
        url: '/api/presets/apply',
        headers: authHeaders(),
        payload: {
          scope: 'department:dept-presets',
          preset: 'balanced',
          dryRun: false,
        },
      });
      expect(deptApplyRes.statusCode).toBe(200);
      const deptCheck = await server.inject({
        method: 'GET',
        url: '/api/departments/dept-presets',
        headers: authHeaders(),
      });
      const deptBody = JSON.parse(deptCheck.body);
      expect(deptBody.brainMode).toBe('auto');
      expect(deptBody.brainPermissions).toBe('trusted');

      // 2. Global
      const globalApplyRes = await server.inject({
        method: 'POST',
        url: '/api/presets/apply',
        headers: authHeaders(),
        payload: {
          scope: 'global',
          preset: 'safe',
          dryRun: false,
        },
      });
      expect(globalApplyRes.statusCode).toBe(200);
      const globalCheck = await server.inject({
        method: 'GET',
        url: '/api/config',
        headers: authHeaders(),
      });
      const globalBody = JSON.parse(globalCheck.body);
      expect(globalBody.brain.mode).toBe('suggest');
      expect(globalBody.brain.permissions).toBe('standard');
      expect(globalBody.planning.requireApproval).toBe(true);
      expect(globalBody.autoFixOnFail).toBe(false);
    });
  });

  describe('6. Tương thích ngược integration.autoMerge', () => {
    it('đọc JSON cũ có integration.autoMerge=true thì review.autoMerge nhận true', () => {
      const parsed = parseProjectSettings(JSON.stringify({
        integration: { autoMerge: true },
        review: { autoMerge: false },
      }));
      expect(parsed.review.autoMerge).toBe(true);
      expect(parsed.integration.autoMerge).toBe(true);
    });

    it('khi ghi review.autoMerge hoặc integration.autoMerge thì đồng bộ cả hai', () => {
      const current = parseProjectSettings(null);
      const updated1 = mergeProjectSettings(current, {
        review: { autoMerge: true },
      });
      expect(updated1.review.autoMerge).toBe(true);
      expect(updated1.integration.autoMerge).toBe(true);

      const updated2 = mergeProjectSettings(updated1, {
        integration: { autoMerge: false },
      });
      expect(updated2.review.autoMerge).toBe(false);
      expect(updated2.integration.autoMerge).toBe(false);
    });
  });

  describe('7. UpdateConfigSchema giữ được digest, quietHours, turnTimeoutSec, director, desktopLevel', () => {
    it('PUT /api/config lưu và giữ nguyên các trường mới không bị Zod loại bỏ', async () => {
      const putRes = await server.inject({
        method: 'PUT',
        url: '/api/config',
        headers: authHeaders(),
        payload: {
          brain: {
            turnTimeoutSec: 1800,
            digest: {
              enabled: true,
              time: '08:30',
            },
            director: {
              enabled: true,
              engine: 'codex',
              model: 'gpt-5.6-luna',
              permissions: 'standard',
            },
          },
          notifications: {
            desktop: true,
            desktopLevel: 'important',
            quietHours: {
              enabled: true,
              start: '22:00',
              end: '07:00',
            },
          },
          telegram: {
            notify: {
              disk: false,
            },
          },
        },
      });
      expect(putRes.statusCode).toBe(200);

      // Đọc lại qua GET /api/config
      const getRes = await server.inject({
        method: 'GET',
        url: '/api/config',
        headers: authHeaders(),
      });
      expect(getRes.statusCode).toBe(200);
      const cfg = JSON.parse(getRes.body);

      expect(cfg.brain.turnTimeoutSec).toBe(1800);
      expect(cfg.brain.digest).toEqual({ enabled: true, time: '08:30' });
      expect(cfg.brain.director).toEqual({
        enabled: true,
        engine: 'codex',
        model: 'gpt-5.6-luna',
        permissions: 'standard',
      });
      expect(cfg.notifications.desktopLevel).toBe('important');
      expect(cfg.notifications.quietHours).toEqual({
        enabled: true,
        start: '22:00',
        end: '07:00',
      });
      expect(cfg.telegram?.notify?.disk).toBe(false);
    });
  });

  describe('8. API gán project vào phòng ban (PUT /api/departments/:id/projects)', () => {
    it('gán thành công danh sách project vào phòng ban', async () => {
      const repoDir = path.join(tmpDir, 'test-repo-assign');
      initGitRepo(repoDir);

      await server.inject({
        method: 'POST',
        url: '/api/departments',
        headers: authHeaders(),
        payload: { id: 'dept-target', name: 'Phòng ban Đích' },
      });

      await server.inject({
        method: 'POST',
        url: '/api/projects',
        headers: authHeaders(),
        payload: { id: 'proj-assign-1', name: 'P1', path: repoDir },
      });

      await server.inject({
        method: 'POST',
        url: '/api/projects',
        headers: authHeaders(),
        payload: { id: 'proj-assign-2', name: 'P2', path: repoDir },
      });

      const assignRes = await server.inject({
        method: 'PUT',
        url: '/api/departments/dept-target/projects',
        headers: authHeaders(),
        payload: {
          projectIds: ['proj-assign-1', 'proj-assign-2'],
        },
      });
      expect(assignRes.statusCode).toBe(200);
      const dept = JSON.parse(assignRes.body);
      expect(dept.projects.map((p: { id: string }) => p.id)).toContain('proj-assign-1');
      expect(dept.projects.map((p: { id: string }) => p.id)).toContain('proj-assign-2');

      // Kiểm tra project 1 có departmentId = 'dept-target'
      const p1Res = await server.inject({
        method: 'GET',
        url: '/api/projects/proj-assign-1',
        headers: authHeaders(),
      });
      expect(JSON.parse(p1Res.body).departmentId).toBe('dept-target');
    });
  });
});
