import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/daemon.js';
import { FakeEngine, type Engine } from '../src/engines/index.js';
import { createServer } from '../src/api/server.js';
import { getOrCreateToken } from '../src/auth.js';

describe('Git inspect API & service', () => {
  let tmpDir: string;
  let repoDir: string;
  let notGitDir: string;
  let ctx: Awaited<ReturnType<typeof createContext>>;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-git-inspect-'));
    repoDir = path.join(tmpDir, 'test-project');
    notGitDir = path.join(tmpDir, 'plain-folder');
    fs.mkdirSync(repoDir, { recursive: true });
    fs.mkdirSync(notGitDir, { recursive: true });

    // Initialize git repo with commits and branches
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir, stdio: 'ignore' });
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Test Project');
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['branch', 'develop'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['branch', 'feature/login'], { cwd: repoDir, stdio: 'ignore' });

    process.env.AGENTHUB_HOME = tmpDir;
    const config = loadConfig();
    const dataDir = path.join(tmpDir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const engines = new Map<string, Engine>([['fake', new FakeEngine()]]);
    ctx = await createContext(config, dataDir, engines);
  });

  afterEach(async () => {
    delete process.env.AGENTHUB_HOME;
    await ctx?.shutdown?.();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects empty or invalid paths', () => {
    const emptyResult = ctx.service.inspectGitRepo({ path: '' });
    expect(emptyResult.valid).toBe(false);
    expect(emptyResult.error).toBe('empty_path');

    const notFoundResult = ctx.service.inspectGitRepo({ path: path.join(tmpDir, 'non-existent-123') });
    expect(notFoundResult.valid).toBe(false);
    expect(notFoundResult.error).toBe('not_found');

    const fileDummy = path.join(tmpDir, 'dummy.txt');
    fs.writeFileSync(fileDummy, 'hello');
    const fileResult = ctx.service.inspectGitRepo({ path: fileDummy });
    expect(fileResult.valid).toBe(false);
    expect(fileResult.error).toBe('not_directory');

    const notGitResult = ctx.service.inspectGitRepo({ path: notGitDir });
    expect(notGitResult.valid).toBe(false);
    expect(notGitResult.error).toBe('not_git_repo');
  });

  it('extracts project name, default branch and branch list from valid git repo', () => {
    const result = ctx.service.inspectGitRepo({ path: repoDir });
    expect(result.valid).toBe(true);
    expect(result.suggestedName).toBe('test-project');
    expect(result.defaultBranch).toBe('main');
    expect(result.currentBranch).toBe('main');
    expect(result.branches).toEqual(expect.arrayContaining(['main', 'develop', 'feature/login']));
  });

  it('handles POST /api/git/inspect via HTTP', async () => {
    const config = loadConfig(tmpDir);
    config.port = 7789;
    const token = getOrCreateToken(config.tokenPath);
    const server = await createServer(ctx.service, config);
    await server.ready();

    const response = await server.inject({
      method: 'POST',
      url: '/api/git/inspect',
      headers: {
        host: '127.0.0.1:7789',
        authorization: `Bearer ${token}`,
      },
      payload: { path: repoDir },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.valid).toBe(true);
    expect(body.suggestedName).toBe('test-project');
    expect(body.branches).toContain('main');
    expect(body.branches).toContain('develop');

    await server.close();
  });
});
