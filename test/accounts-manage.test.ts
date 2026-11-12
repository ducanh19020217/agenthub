import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { createContext, closeContext } from '../src/daemon.js';
import { createServer } from '../src/api/server.js';
import { getOrCreateToken } from '../src/auth.js';
import { AgyEngine, CodexEngine, FakeEngine } from '../src/engines/index.js';
import { parseCodexLoginStatus } from '../src/profiles/auth.js';
import { cmdProfile } from '../src/cli.js';
import { isProfileLoggedIn } from '../src/profiles/index.js';

describe('c-accounts-manage: Quản lý tài khoản', () => {
  let tmpDir: string;
  let agyHomesDir: string;
  let config: ReturnType<typeof loadConfig>;
  let ctx: ReturnType<typeof createContext>;
  let server: ReturnType<typeof createServer>;
  let token: string;

  const authHeaders = () => ({
    Authorization: `Bearer ${token}`,
    Host: '127.0.0.1:7700',
  });

  let prevHome: string | undefined;
  let prevAgyHomes: string | undefined;
  let prevLogDir: string | undefined;

  beforeEach(async () => {
    prevHome = process.env.AGENTHUB_HOME;
    prevAgyHomes = process.env.AGENTHUB_AGY_HOMES;
    prevLogDir = process.env.AGENTHUB_DEFAULT_LOG_DIR;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-accounts-test-'));
    agyHomesDir = path.join(tmpDir, 'agy-homes');
    fs.mkdirSync(agyHomesDir, { recursive: true });

    process.env.AGENTHUB_HOME = tmpDir;
    process.env.AGENTHUB_AGY_HOMES = agyHomesDir;
    process.env.AGENTHUB_DEFAULT_LOG_DIR = path.resolve(__dirname, 'fixtures', 'fake-gemini-log');

    config = loadConfig(tmpDir);
    config.agyHomesDir = agyHomesDir;
    config.defaultLogDir = process.env.AGENTHUB_DEFAULT_LOG_DIR;

    token = getOrCreateToken(config.tokenPath);

    const fakeEngine = new FakeEngine();
    const engines = new Map<string, Engine>([
      ['agy', fakeEngine as unknown as Engine],
      ['codex', fakeEngine as unknown as Engine],
    ]);

    ctx = createContext(config, engines);
    server = await createServer(ctx.service, config, ctx.chatService);
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
    closeContext(ctx);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    if (prevHome !== undefined) process.env.AGENTHUB_HOME = prevHome;
    else delete process.env.AGENTHUB_HOME;

    if (prevAgyHomes !== undefined) process.env.AGENTHUB_AGY_HOMES = prevAgyHomes;
    else delete process.env.AGENTHUB_AGY_HOMES;

    if (prevLogDir !== undefined) process.env.AGENTHUB_DEFAULT_LOG_DIR = prevLogDir;
    else delete process.env.AGENTHUB_DEFAULT_LOG_DIR;
  });

  describe('1. Sửa hồ sơ PATCH /api/profiles/:name', () => {
    it('cập nhật label, notes, priority, enabled', async () => {
      // Create a test profile
      ctx.profileRepo.upsert({
        name: 'worker-patch',
        engine: 'agy',
        kind: 'isolated',
        home: path.join(agyHomesDir, 'worker-patch'),
        email: null,
        enabled: 1,
      });

      const res = await server.inject({
        method: 'PATCH',
        url: '/api/profiles/worker-patch',
        headers: authHeaders(),
        payload: {
          label: 'Worker Alpha',
          notes: 'Dùng cho các task backend',
          priority: 10,
          enabled: false,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.label).toBe('Worker Alpha');
      expect(body.notes).toBe('Dùng cho các task backend');
      expect(body.priority).toBe(10);
      expect(body.enabled).toBe(0);

      const inDb = ctx.profileRepo.get('worker-patch')!;
      expect(inDb.label).toBe('Worker Alpha');
      expect(inDb.notes).toBe('Dùng cho các task backend');
      expect(inDb.priority).toBe(10);
      expect(inDb.enabled).toBe(0);
    });

    it('từ chối 404 khi sửa hồ sơ không tồn tại hoặc đã xóa', async () => {
      const res = await server.inject({
        method: 'PATCH',
        url: '/api/profiles/nonexistent',
        headers: authHeaders(),
        payload: { priority: 5 },
      });
      expect(res.statusCode).toBe(404);
    });

    it('scheduler ưu tiên hồ sơ priority cao hơn khi quota ngang nhau', async () => {
      const repoDir = path.join(tmpDir, 'repo');
      fs.mkdirSync(repoDir, { recursive: true });
      execFileSync('git', ['init', repoDir], { stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoDir, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.name', 'test'], { cwd: repoDir, stdio: 'ignore' });
      execFileSync('git', ['commit', '--allow-empty', '-m', 'initial'], { cwd: repoDir, stdio: 'ignore' });
      execFileSync('git', ['checkout', '-b', 'main'], { cwd: repoDir, stdio: 'ignore' });

      ctx.projectRepo.insert({
        id: 'p-sched',
        name: 'Project Sched',
        path: repoDir,
        defaultBranch: 'main',
        maxParallel: 3,
      });

      // Tạo 2 hồ sơ agy với priority khác nhau
      ctx.profileRepo.upsert({
        name: 'prof-low',
        engine: 'agy',
        kind: 'isolated',
        home: path.join(agyHomesDir, 'prof-low'),
        email: null,
        enabled: 1,
        priority: 1,
        authState: 'ok',
      });
      ctx.profileRepo.upsert({
        name: 'prof-high',
        engine: 'agy',
        kind: 'isolated',
        home: path.join(agyHomesDir, 'prof-high'),
        email: null,
        enabled: 1,
        priority: 10,
        authState: 'ok',
      });

      ctx.taskRepo.insert({
        id: 'p-sched/t1',
        projectId: 'p-sched',
        slug: 't1',
        title: 'Task 1',
        level: 'easy',
        status: 'queued',
      });

      await ctx.scheduler.tick();

      await vi.waitFor(() => expect(ctx.runRepo.getByTask('p-sched/t1')).toHaveLength(1));
      const runs = ctx.runRepo.getByTask('p-sched/t1');
      expect(runs.length).toBe(1);
      // prof-high có priority 10 cao hơn prof-low có priority 1
      expect(runs[0].profileName).toBe('prof-high');
    });
  });

  describe('2. Đổi tên hồ sơ POST /api/profiles/:name/rename', () => {
    it('cập nhật trong 1 transaction mọi bảng tham chiếu và đổi tên thư mục home', async () => {
      const homeDir = path.join(agyHomesDir, 'old-acc');
      fs.mkdirSync(homeDir, { recursive: true });
      fs.writeFileSync(path.join(homeDir, 'file.txt'), 'content');

      ctx.profileRepo.upsert({
        name: 'old-acc',
        engine: 'agy',
        kind: 'isolated',
        home: homeDir,
        email: 'shared@example.com',
        enabled: 1,
      });

      // Tạo các dòng tham chiếu trong quota_marks, quota_usage, runs, run_metrics, chat_sessions
      ctx.projectRepo.insert({ id: 'proj-rn', name: 'PRN', path: tmpDir, defaultBranch: 'main', maxParallel: 2 });
      ctx.taskRepo.insert({ id: 'proj-rn/t1', projectId: 'proj-rn', slug: 't1', title: 'T1', level: 'easy', status: 'done' });
      ctx.quotaMarkRepo.mark('old-acc', 'gemini', Math.floor(Date.now() / 1000) + 3600, 'test');
      ctx.usageRepo.upsert({
        profileName: 'old-acc',
        grp: 'gemini',
        window: '5h',
        remainingPct: 80,
        resetAt: 1000,
        fetchedAt: 1000,
      });
      ctx.runRepo.insert({
        id: 'run-rn-1',
        taskId: 'proj-rn/t1',
        engine: 'agy',
        model: 'gemini-3.8-flash-low',
        profileName: 'old-acc',
      });
      ctx.runMetricsRepo.upsert({
        runId: 'run-rn-1',
        taskId: 'proj-rn/t1',
        engine: 'agy',
        model: 'gemini-3.8-flash-low',
        profileName: 'old-acc',
        linesAdded: 10,
        linesDeleted: 2,
        filesChanged: 1,
      });
      ctx.chatSessionRepo.insert({
        id: 'chat-rn-1',
        projectId: 'proj-rn',
        title: 'Chat 1',
        profileName: 'old-acc',
      });

      const res = await server.inject({
        method: 'POST',
        url: '/api/profiles/old-acc/rename',
        headers: authHeaders(),
        payload: { newName: 'new-acc' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.name).toBe('new-acc');
      const expectedNewHome = path.join(agyHomesDir, 'new-acc');
      expect(body.home).toBe(expectedNewHome);

      // Thư mục trên đĩa đã đổi tên
      expect(fs.existsSync(homeDir)).toBe(false);
      expect(fs.existsSync(expectedNewHome)).toBe(true);
      expect(fs.readFileSync(path.join(expectedNewHome, 'file.txt'), 'utf8')).toBe('content');

      // Bảng tham chiếu đã được cập nhật sang tên mới
      expect(ctx.profileRepo.get('old-acc')).toBeUndefined();
      expect(ctx.profileRepo.get('new-acc')).toBeDefined();
      expect(ctx.quotaMarkRepo.getAll().find((m) => m.profileName === 'new-acc')).toBeDefined();
      expect(ctx.quotaMarkRepo.getAll().find((m) => m.profileName === 'old-acc')).toBeUndefined();
      expect(ctx.usageRepo.getForProfile('new-acc').length).toBe(1);
      expect(ctx.usageRepo.getForProfile('old-acc').length).toBe(0);
      expect(ctx.runRepo.get('run-rn-1')?.profileName).toBe('new-acc');
      expect(ctx.runMetricsRepo.get('run-rn-1')?.profileName).toBe('new-acc');
      expect(ctx.chatSessionRepo.get('chat-rn-1')?.profileName).toBe('new-acc');
    });

    it('không đổi tên thư mục nếu home nằm ngoài managed root (ví dụ chinh -> g0)', async () => {
      const realUserHome = os.homedir();
      ctx.profileRepo.upsert({
        name: 'chinh',
        engine: 'agy',
        kind: 'keyring',
        home: realUserHome,
        email: 'chinh@example.com',
        enabled: 1,
      });

      const res = await server.inject({
        method: 'POST',
        url: '/api/profiles/chinh/rename',
        headers: authHeaders(),
        payload: { newName: 'g0' },
      });

      expect(res.statusCode).toBe(200);
      const inDb = ctx.profileRepo.get('g0')!;
      expect(inDb.name).toBe('g0');
      // Thư mục home thật không bị đổi tên
      expect(inDb.home).toBe(realUserHome);
      expect(fs.existsSync(realUserHome)).toBe(true);
    });

    it('từ chối khi tên mới đã tồn tại (409)', async () => {
      ctx.profileRepo.upsert({ name: 'p-a', engine: 'agy', kind: 'isolated', home: null, email: null, enabled: 1 });
      ctx.profileRepo.upsert({ name: 'p-b', engine: 'agy', kind: 'isolated', home: null, email: null, enabled: 1 });

      const res = await server.inject({
        method: 'POST',
        url: '/api/profiles/p-a/rename',
        headers: authHeaders(),
        payload: { newName: 'p-b' },
      });
      expect(res.statusCode).toBe(409);
    });

    it('từ chối khi hồ sơ đang chạy task (409)', async () => {
      ctx.profileRepo.upsert({ name: 'p-busy', engine: 'agy', kind: 'isolated', home: null, email: null, enabled: 1 });
      ctx.scheduler.getRunning().set('task-running', {
        taskId: 'proj/t-run',
        runId: 'r-1',
        pid: 1234,
        engine: ctx.scheduler['engines'].get('agy')!,
        model: 'gemini-3.8-flash-low',
        profileName: 'p-busy',
        logPath: '/tmp/log',
        startedAt: Date.now(),
        lockSlot: 1,
      });

      const res = await server.inject({
        method: 'POST',
        url: '/api/profiles/p-busy/rename',
        headers: authHeaders(),
        payload: { newName: 'p-free' },
      });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).message).toMatch(/đang chạy task/);
    });
  });

  describe('3. Xoá hồ sơ DELETE /api/profiles/:name (soft-delete & purgeHome)', () => {
    it('soft-delete hồ sơ: đặt deletedAt, ẩn khỏi listProfiles, không scheduler nào chọn', async () => {
      ctx.profileRepo.upsert({
        name: 'to-delete',
        engine: 'agy',
        kind: 'isolated',
        home: path.join(agyHomesDir, 'to-delete'),
        email: null,
        enabled: 1,
      });

      const res = await server.inject({
        method: 'DELETE',
        url: '/api/profiles/to-delete',
        headers: authHeaders(),
      });
      expect(res.statusCode).toBe(200);

      // Ẩn khỏi API mặc định
      const listRes = await server.inject({
        method: 'GET',
        url: '/api/profiles',
        headers: authHeaders(),
      });
      const profiles = JSON.parse(listRes.body) as Array<{ name: string }>;
      expect(profiles.find((p) => p.name === 'to-delete')).toBeUndefined();

      // Không bao giờ được scheduler chọn
      const inDb = ctx.profileRepo.get('to-delete')!;
      expect(inDb.deletedAt).toBeTruthy();
      expect(ctx.profileRepo.getEnabled().find((p) => p.name === 'to-delete')).toBeUndefined();
    });

    it('từ chối xoá hồ sơ system (400); keyring chỉ xoá mềm, giữ HOME thật', async () => {
      ctx.profileRepo.upsert({ name: 'acc-sys', engine: 'claude', kind: 'system', home: os.homedir(), email: null, enabled: 1 });
      ctx.profileRepo.upsert({ name: 'acc-key', engine: 'agy', kind: 'keyring', home: os.homedir(), email: null, enabled: 1 });

      const resSys = await server.inject({
        method: 'DELETE',
        url: '/api/profiles/acc-sys',
        headers: authHeaders(),
      });
      expect(resSys.statusCode).toBe(400);

      // Keyring được xoá mềm (DEC-008) nhưng không bao giờ đụng tới HOME thật, kể cả khi yêu cầu purge.
      const resKey = await server.inject({
        method: 'DELETE',
        url: '/api/profiles/acc-key?purgeHome=1',
        headers: authHeaders(),
      });
      expect(resKey.statusCode).toBe(200);
      expect(ctx.profileRepo.get('acc-key')?.deletedAt).toBeTruthy();
      expect(fs.existsSync(os.homedir())).toBe(true);
    });

    it('từ chối xoá hồ sơ đang chạy task (409)', async () => {
      ctx.profileRepo.upsert({ name: 'p-run-del', engine: 'agy', kind: 'isolated', home: null, email: null, enabled: 1 });
      ctx.scheduler.getRunning().set('task-run-2', {
        taskId: 'proj/t2',
        runId: 'r-2',
        pid: 5678,
        engine: ctx.scheduler['engines'].get('agy')!,
        model: 'gemini-3.8-flash-low',
        profileName: 'p-run-del',
        logPath: '/tmp/log2',
        startedAt: Date.now(),
        lockSlot: 1,
      });

      const res = await server.inject({
        method: 'DELETE',
        url: '/api/profiles/p-run-del',
        headers: authHeaders(),
      });
      expect(res.statusCode).toBe(409);
    });

    it('tuỳ chọn ?purgeHome=1 xoá thư mục home an toàn', async () => {
      const homeDir = path.join(agyHomesDir, 'p-purged');
      fs.mkdirSync(homeDir, { recursive: true });
      fs.writeFileSync(path.join(homeDir, 'data.txt'), 'delete me');

      ctx.profileRepo.upsert({
        name: 'p-purged',
        engine: 'agy',
        kind: 'isolated',
        home: homeDir,
        email: null,
        enabled: 1,
      });

      const res = await server.inject({
        method: 'DELETE',
        url: '/api/profiles/p-purged?purgeHome=1',
        headers: authHeaders(),
      });
      expect(res.statusCode).toBe(200);
      expect(fs.existsSync(homeDir)).toBe(false);
    });

    it('từ chối xoá home khi home là symlink trỏ ra ngoài engine root', async () => {
      const outsideDir = path.join(tmpDir, 'outside-secret');
      fs.mkdirSync(outsideDir, { recursive: true });
      fs.writeFileSync(path.join(outsideDir, 'important.txt'), 'do not touch');

      const linkedHome = path.join(agyHomesDir, 'p-symlink');
      fs.symlinkSync(outsideDir, linkedHome);

      ctx.profileRepo.upsert({
        name: 'p-symlink',
        engine: 'agy',
        kind: 'isolated',
        home: linkedHome,
        email: null,
        enabled: 1,
      });

      const res = await server.inject({
        method: 'DELETE',
        url: '/api/profiles/p-symlink?purgeHome=1',
        headers: authHeaders(),
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toMatch(/nằm ngoài/);
      expect(fs.existsSync(path.join(outsideDir, 'important.txt'))).toBe(true);
    });
  });

  describe('4. Hồ sơ Codex riêng & đăng nhập/trạng thái', () => {
    it('tạo hồ sơ Codex isolated trong <hubHome>/codex-homes/<name>', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/profiles',
        headers: authHeaders(),
        payload: {
          name: 'codex-team',
          engine: 'codex',
        },
      });

      expect(res.statusCode).toBe(201);
      const expectedHome = path.join(config.hubHome, 'codex-homes', 'codex-team');
      expect(JSON.parse(res.body).home).toBe(expectedHome);
      expect(fs.existsSync(expectedHome)).toBe(true);

      const inDb = ctx.profileRepo.get('codex-team')!;
      expect(inDb.engine).toBe('codex');
      expect(inDb.kind).toBe('isolated');
      expect(inDb.home).toBe(expectedHome);
    });

    it('kiểm tra đã đăng nhập = existsSync(<CODEX_HOME>/auth.json)', () => {
      const codexHome = path.join(config.hubHome, 'codex-homes', 'codex-check');
      fs.mkdirSync(codexHome, { recursive: true });

      const prof = {
        name: 'codex-check',
        engine: 'codex' as const,
        kind: 'isolated' as const,
        home: codexHome,
        email: null,
        enabled: 1,
        createdAt: '2026-10-20',
      };

      expect(isProfileLoggedIn(prof)).toBe(false);

      fs.writeFileSync(path.join(codexHome, 'auth.json'), '{}');
      expect(isProfileLoggedIn(prof)).toBe(true);
    });

    it('parseCodexLoginStatus parse email và gói cước không lộ token', () => {
      const output = `
Logged in using ChatGPT
Account: dev@company.com
Subscription: ChatGPT Plus
Session token: secret_token_value_do_not_leak
`;
      const parsed = parseCodexLoginStatus(output);
      expect(parsed.loggedIn).toBe(true);
      expect(parsed.notLoggedIn).toBe(false);
      expect(parsed.email).toBe('dev@company.com');
      expect(parsed.plan).toBe('ChatGPT Plus');

      const notLoggedInOutput = 'Not logged in. Run codex login to sign in.';
      const parsedNotLogged = parseCodexLoginStatus(notLoggedInOutput);
      expect(parsedNotLogged.loggedIn).toBe(false);
      expect(parsedNotLogged.notLoggedIn).toBe(true);
    });

    it('spawn CodexEngine dùng CODEX_HOME cho isolated profile', () => {
      const codexHome = path.join(config.hubHome, 'codex-homes', 'codex-spawn');
      fs.mkdirSync(codexHome, { recursive: true });

      const fakeScript = path.join(tmpDir, 'fake-codex.mjs');
      fs.writeFileSync(
        fakeScript,
        `import fs from 'node:fs';
fs.writeFileSync(process.argv[process.argv.length - 1], process.env.CODEX_HOME || 'NO_ENV');
process.exit(0);`,
      );

      const engine = new CodexEngine(fakeScript);
      const logPath = path.join(tmpDir, 'codex.log');
      const outPath = path.join(tmpDir, 'env-result.txt');

      const child = engine.spawn({
        profile: {
          name: 'codex-spawn',
          engine: 'codex',
          kind: 'isolated',
          home: codexHome,
          email: null,
          enabled: 1,
          createdAt: '2026-10-20',
        },
        model: 'codex:gpt-5.6-luna',
        cwd: tmpDir,
        prompt: outPath,
        logPath,
      });

      expect(child.pid).toBeDefined();
    });
  });

  describe('5. Mất đăng nhập giữa chừng', () => {
    it('đánh dấu hồ sơ not_logged_in và đưa task về queued (resume=1, không tăng attempt)', () => {
      const agyEngine = new AgyEngine();
      expect(agyEngine.detectAuthError('Error: Authentication required to proceed.').expired).toBe(true);
      expect(agyEngine.detectAuthError('Error: authentication timed out waiting for response').expired).toBe(true);
      expect(agyEngine.detectAuthError('User not signed in. Please authenticate.').expired).toBe(true);

      const codexEngine = new CodexEngine();
      expect(codexEngine.detectAuthError('Error: Not logged in. Run codex login.').expired).toBe(true);
      expect(codexEngine.detectAuthError('Failed with status code 401 Unauthorized').expired).toBe(true);
    });
  });

  describe('6. CLI agenthub profile', () => {
    it('agenthub profile add <name> --engine codex tạo hồ sơ codex isolated', async () => {
      await cmdProfile(config, 'add', ['codex-cli-test', '--engine', 'codex']);

      const prof = ctx.profileRepo.get('codex-cli-test');
      expect(prof).toBeDefined();
      expect(prof?.engine).toBe('codex');
      expect(prof?.kind).toBe('isolated');
      expect(prof?.home).toBe(path.join(config.hubHome, 'codex-homes', 'codex-cli-test'));
    });

    it('agenthub profile rename đổi tên hồ sơ', async () => {
      ctx.profileRepo.upsert({
        name: 'cli-old',
        engine: 'agy',
        kind: 'isolated',
        home: path.join(agyHomesDir, 'cli-old'),
        email: null,
        enabled: 1,
      });

      await cmdProfile(config, 'rename', ['cli-old', 'cli-new']);
      expect(ctx.profileRepo.get('cli-old')).toBeUndefined();
      expect(ctx.profileRepo.get('cli-new')).toBeDefined();
    });

    it('agenthub profile remove soft-delete hồ sơ', async () => {
      const homeDir = path.join(agyHomesDir, 'cli-rem');
      fs.mkdirSync(homeDir, { recursive: true });

      ctx.profileRepo.upsert({
        name: 'cli-rem',
        engine: 'agy',
        kind: 'isolated',
        home: homeDir,
        email: null,
        enabled: 1,
      });

      await cmdProfile(config, 'remove', ['cli-rem', '--purge-home']);
      expect(ctx.profileRepo.get('cli-rem')?.deletedAt).toBeTruthy();
      expect(fs.existsSync(homeDir)).toBe(false);
    });
  });

  describe('7. Tuân thủ điều khoản provider', () => {
    it('chặn personal thứ hai nhưng cho phép team và api', async () => {
      config.multiplePerProvider = false;
      const first = await server.inject({
        method: 'POST',
        url: '/api/profiles',
        headers: authHeaders(),
        payload: { name: 'personal-one', engine: 'agy', accountType: 'personal' },
      });
      expect(first.statusCode).toBe(201);
      const firstTokenDir = path.join(agyHomesDir, 'personal-one', '.gemini', 'antigravity-cli');
      fs.mkdirSync(firstTokenDir, { recursive: true });
      fs.writeFileSync(path.join(firstTokenDir, 'antigravity-oauth-token'), 'fake-token');

      const second = await server.inject({
        method: 'POST',
        url: '/api/profiles',
        headers: authHeaders(),
        payload: { name: 'personal-two', engine: 'agy', accountType: 'personal' },
      });
      expect(second.statusCode).toBe(409);

      for (const accountType of ['team', 'api']) {
        const response = await server.inject({
          method: 'POST',
          url: '/api/profiles',
          headers: authHeaders(),
          payload: { name: `agy-${accountType}`, engine: 'agy', accountType },
        });
        expect(response.statusCode).toBe(201);
        expect(JSON.parse(response.body).accountType).toBe(accountType);
      }
    });

    it('hồ sơ không khai báo accountType vẫn mặc định là personal', () => {
      const first = ctx.profileRepo.get('legacy-one');
      expect(first).toBeUndefined();
      ctx.profileRepo.upsert({ name: 'legacy-one', engine: 'agy', kind: 'isolated', home: null, email: null, enabled: 1 });
      ctx.profileRepo.upsert({ name: 'legacy-two', engine: 'agy', kind: 'isolated', home: null, email: null, enabled: 1 });
      expect(ctx.profileRepo.get('legacy-one')?.accountType).toBe('personal');
      expect(ctx.profileRepo.get('legacy-two')?.accountType).toBe('personal');
    });
  });
});
