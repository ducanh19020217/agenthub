import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseResetTime,
  lastNLines,
  AgyEngine,
  CodexEngine,
  canRunBubblewrap,
  findBubblewrap,
  escapeTomlString,
  toTomlKey,
  toTomlValue,
  toTomlInlineTable,
  toTomlConfigArg,
} from '../src/engines/index.js';
import { getModelFamily, getModelEngine } from '../src/quota/index.js';
import { loadConfig } from '../src/config.js';

describe('parseResetTime', () => {
  it('parses "Resets in 4h54m26s" to seconds + 60s buffer', () => {
    const result = parseResetTime('Resets in 4h54m26s');
    // 4*3600 + 54*60 + 26 = 14400 + 3240 + 26 = 17666 + 60 = 17726
    expect(result).toBe(17726);
  });

  it('parses "try again in 2h 3m" to seconds + 60s buffer', () => {
    const result = parseResetTime('try again in 2h 3m');
    // 2*3600 + 3*60 = 7200 + 180 = 7380 + 60 = 7440
    expect(result).toBe(7440);
  });

  it('parses "Resets in 1h2m3s" to seconds + 60s buffer', () => {
    const result = parseResetTime('Resets in 1h2m3s');
    // 1*3600 + 2*60 + 3 = 3600 + 120 + 3 = 3723 + 60 = 3783
    expect(result).toBe(3783);
  });

  it('returns 18000 when no time info found', () => {
    const result = parseResetTime('some random text');
    expect(result).toBe(18000);
  });
});

describe('getModelFamily', () => {
  it('claude-opus-4-6-thinking → claude', () => {
    expect(getModelFamily('claude-opus-4-6-thinking')).toBe('claude');
  });

  it('gemini-3.8-flash-high → gemini', () => {
    expect(getModelFamily('gemini-3.8-flash-high')).toBe('gemini');
  });

  it('codex:gpt-5.6-luna → codex', () => {
    expect(getModelFamily('codex:gpt-5.6-luna')).toBe('codex');
  });

  it('gpt-oss-120b-medium → gpt', () => {
    expect(getModelFamily('gpt-oss-120b-medium')).toBe('gpt');
  });
});

describe('getModelEngine', () => {
  it('codex: models → codex engine', () => {
    expect(getModelEngine('codex:gpt-5.6-luna')).toBe('codex');
  });

  it('non-codex models → agy engine', () => {
    expect(getModelEngine('claude-opus-4-6-thinking')).toBe('agy');
    expect(getModelEngine('gemini-3.8-flash-high')).toBe('agy');
  });
});

describe('detectQuota', () => {
  const agy = new AgyEngine('/nonexistent');
  const codex = new CodexEngine('/nonexistent');

  it('detects RESOURCE_EXHAUSTED in last 8 lines', () => {
    const log = [
      'line 1',
      'line 2',
      'line 3',
      'line 4',
      'line 5',
      'line 6',
      'line 7',
      'AGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 4h54m26s."}',
    ].join('\n');

    const result = agy.detectQuota(log);
    expect(result.exhausted).toBe(true);
    expect(result.resetSeconds).toBe(17726);
  });

  it('ignores "429" that appears earlier in the log (not in last 8 lines)', () => {
    // Build a log where "429" appears at the start but not in the last 8 lines
    const lines = [
      '429 error in some test code at line 5',
      'line 2',
      'line 3',
      'line 4',
      'line 5',
      'line 6',
      'line 7',
      'line 8',
      'line 9',
      'line 10',
      'line 11',
      'completed successfully',
    ];
    const log = lines.join('\n');

    const result = agy.detectQuota(log);
    expect(result.exhausted).toBe(false);
  });

  it('detects codex quota pattern', () => {
    const log = 'some output\nusage limit exceeded, try again in 2h 3m\n';
    const result = codex.detectQuota(log);
    expect(result.exhausted).toBe(true);
    expect(result.resetSeconds).toBe(7440);
  });
});

describe('detectAuthError', () => {
  it('detects agy authentication failures in the last 8 lines', () => {
    const agy = new AgyEngine('/nonexistent');
    expect(agy.detectAuthError('error: UNAUTHENTICATED (code 401)')).toEqual({ expired: true });
    expect(agy.detectAuthError('old error: code 401\n' + Array.from({ length: 8 }, (_, i) => `line ${i}`).join('\n'))).toEqual({ expired: false });
    expect(agy.detectAuthError('AGY_ERROR: {"error_code":401}')).toEqual({ expired: true });
  });
});

describe('lastNLines', () => {
  it('returns last N lines of a string', () => {
    const text = 'a\nb\nc\nd\ne';
    expect(lastNLines(text, 3)).toBe('c\nd\ne');
  });

  it('returns all lines if fewer than N', () => {
    expect(lastNLines('a\nb', 5)).toBe('a\nb');
  });
});

describe('CodexEngine sandbox configuration', () => {
  it('defaults codexSandbox to off in config and supports workspace-write', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-codex-config-'));
    try {
      // Default config
      const defaultCfg = loadConfig(tmp);
      expect(defaultCfg.workers.codexSandbox).toBe('off');

      // Config with workspace-write
      fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ workers: { codexSandbox: 'workspace-write' } }));
      const customCfg = loadConfig(tmp);
      expect(customCfg.workers.codexSandbox).toBe('workspace-write');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('passes --sandbox workspace-write when configured and --dangerously-bypass-approvals-and-sandbox when off', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-codex-sandbox-'));
    try {
      const dumpScript = path.join(tmp, 'dump-args.mjs');
      fs.writeFileSync(
        dumpScript,
        `#!/usr/bin/env node
import fs from 'node:fs';
fs.writeFileSync(process.argv[process.argv.length - 1], JSON.stringify(process.argv));
process.exit(0);
`,
        { mode: 0o755 },
      );

      const profile = {
        name: 'test-codex',
        engine: 'codex',
        kind: 'default',
        home: null,
        email: null,
        enabled: 1,
        autoCreated: 0,
        createdAt: '2026-01-01',
      };

      const outOff = path.join(tmp, 'args-off.json');
      const engineOff = new CodexEngine(dumpScript, 'off');
      const childOff = engineOff.spawn({
        profile,
        model: 'codex:gpt-5.6-luna',
        cwd: tmp,
        prompt: outOff,
        logPath: path.join(tmp, 'off.log'),
        codexSandbox: 'off',
      });
      await new Promise<void>((resolve) => childOff.on('exit', () => resolve()));
      const argsOff: string[] = JSON.parse(fs.readFileSync(outOff, 'utf8'));
      expect(argsOff).toContain('--dangerously-bypass-approvals-and-sandbox');
      expect(argsOff).not.toContain('--sandbox');

      const outWrite = path.join(tmp, 'args-write.json');
      const engineWrite = new CodexEngine(dumpScript, 'workspace-write');
      const childWrite = engineWrite.spawn({
        profile,
        model: 'codex:gpt-5.6-luna',
        cwd: tmp,
        prompt: outWrite,
        logPath: path.join(tmp, 'write.log'),
        codexSandbox: 'workspace-write',
      });
      await new Promise<void>((resolve) => childWrite.on('exit', () => resolve()));
      const argsWrite: string[] = JSON.parse(fs.readFileSync(outWrite, 'utf8'));
      expect(argsWrite).not.toContain('--dangerously-bypass-approvals-and-sandbox');
      expect(argsWrite).toContain('--sandbox');
      expect(argsWrite[argsWrite.indexOf('--sandbox') + 1]).toBe('workspace-write');

      // readOnly mode always uses --sandbox read-only
      const outReadOnly = path.join(tmp, 'args-readonly.json');
      const childReadOnly = engineWrite.spawn({
        profile,
        model: 'codex:gpt-5.6-luna',
        cwd: tmp,
        prompt: outReadOnly,
        logPath: path.join(tmp, 'readonly.log'),
        readOnly: true,
        codexSandbox: 'workspace-write',
      });
      await new Promise<void>((resolve) => childReadOnly.on('exit', () => resolve()));
      const argsReadOnly: string[] = JSON.parse(fs.readFileSync(outReadOnly, 'utf8'));
      expect(argsReadOnly).toContain('--sandbox');
      expect(argsReadOnly[argsReadOnly.indexOf('--sandbox') + 1]).toBe('read-only');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.skipIf(!canRunBubblewrap())('enforces brain policy for absolute commands and shell indirection', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-codex-brain-policy-'));
    try {
      const marker = path.join(tmp, 'must-survive');
      fs.writeFileSync(marker, 'keep');
      const work = path.join(tmp, 'work');
      fs.mkdirSync(work);
      const hubHome = path.join(tmp, 'hub');
      const hubToken = path.join(hubHome, 'token');
      fs.mkdirSync(hubHome, { recursive: true });
      fs.writeFileSync(hubToken, 'keep-secret');
      const fake = path.join(work, 'policy-check.mjs');
      fs.writeFileSync(fake, `import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
spawnSync('/bin/sh', ['-c', '/bin/rm -f ${marker}']);
if (fs.existsSync('${hubToken}')) process.exit(1);
`, { mode: 0o700 });

      const profile = { name: 'test-codex', engine: 'codex', kind: 'default', home: null, email: null, enabled: 1 };
      const child = new CodexEngine(fake).spawn({
        profile,
        model: 'gpt-5.6-luna',
        cwd: work,
        prompt: 'policy check',
        logPath: path.join(tmp, 'policy.log'),
        hubHome,
        brainPolicy: 'standard',
        codexSandbox: 'workspace-write',
      });
      const exitCode = await new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
      expect(exitCode).toBe(0);
      expect(fs.existsSync(marker)).toBe(true);
      expect(fs.readFileSync(hubToken, 'utf8')).toBe('keep-secret');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.skipIf(!canRunBubblewrap())('blocks mutation and interpreter bypasses in a brain sandbox', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-codex-brain-bypasses-'));
    try {
      const work = path.join(tmp, 'work');
      fs.mkdirSync(work);
      const marker = path.join(work, 'must-survive');
      const moved = path.join(work, 'moved');
      const touched = path.join(work, 'touched');
      const redirected = path.join(work, 'redirected');
      const readEscaped = path.join(work, 'read-escaped');
      const outsideSecret = '/etc/passwd';
      fs.writeFileSync(marker, 'keep');
      const hubHome = path.join(tmp, 'hub');
      fs.mkdirSync(hubHome, { recursive: true });
      const fake = path.join(work, 'policy-bypasses.mjs');
      fs.writeFileSync(fake, `import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
for (const args of [
  ['/usr/bin/node', ['-e', "require('node:fs').unlinkSync('${marker}')"]],
  ['/bin/mv', ['${marker}', '${moved}']],
  ['/usr/bin/cp', ['${marker}', '${moved}']],
  ['/usr/bin/find', ['${work}', '-name', 'must-survive', '-delete']],
  ['/usr/bin/touch', ['${touched}']],
  ['/bin/sh', ['-c', 'echo escaped > ${redirected}']],
  ['/bin/cat', ['${outsideSecret}']],
  ['/bin/grep', ['root:', '${outsideSecret}']],
]) {
  const result = spawnSync(args[0], args[1], { encoding: 'utf8' });
  if (result.status === 0) fs.writeFileSync('${readEscaped}', result.stdout || 'read escaped');
}
if (fs.existsSync('${readEscaped}')) process.exit(1);
if (!fs.existsSync('${marker}') || fs.existsSync('${moved}') || fs.existsSync('${touched}') || fs.existsSync('${redirected}')) process.exit(1);
`, { mode: 0o700 });

      const profile = { name: 'test-codex', engine: 'codex', kind: 'default', home: null, email: null, enabled: 1 };
      const child = new CodexEngine(fake).spawn({
        profile,
        model: 'gpt-5.6-luna',
        cwd: work,
        prompt: 'policy bypass check',
        logPath: path.join(tmp, 'policy-bypasses.log'),
        hubHome,
        brainPolicy: 'standard',
        codexSandbox: 'workspace-write',
      });
      const exitCode = await new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
      expect(exitCode).toBe(0);
      expect(fs.existsSync(marker)).toBe(true);
      expect(fs.existsSync(moved)).toBe(false);
      expect(fs.existsSync(touched)).toBe(false);
      expect(fs.existsSync(redirected)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.skipIf(!canRunBubblewrap())('does not let shell shims bypass the npm, npx, and curl allowlists', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-codex-brain-shell-policy-'));
    try {
      const work = path.join(tmp, 'work');
      fs.mkdirSync(work);
      const marker = path.join(work, 'bypass-ran');
      const hubHome = path.join(tmp, 'hub');
      fs.mkdirSync(hubHome, { recursive: true });
      const fake = path.join(work, 'shell-policy.mjs');
      fs.writeFileSync(fake, `import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const attempts = [
  ['npm', ['run', 'arbitrary-script']],
  ['npx', ['-p', 'evil-package', 'echo', 'owned']],
  ['curl', ['-X', 'POST', 'https://api.github.com/repos/openai/codex']],
  ['/bin/sh', ['-c', 'npm run arbitrary-script']],
  ['/bin/sh', ['-c', 'npx -p evil-package echo owned']],
  ['/bin/sh', ['-c', 'curl -X POST https://api.github.com/repos/openai/codex']],
  ['/bin/sh', ['-c', 'curl https://example.com']],
];
for (const [command, args] of attempts) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status === 0) fs.writeFileSync('${marker}', command + ' ' + args.join(' '));
}
if (fs.existsSync('${marker}')) process.exit(1);
`, { mode: 0o700 });

      const profile = { name: 'test-codex', engine: 'codex', kind: 'default', home: null, email: null, enabled: 1 };
      const child = new CodexEngine(fake).spawn({
        profile,
        model: 'gpt-5.6-luna',
        cwd: work,
        prompt: 'shell policy check',
        logPath: path.join(tmp, 'shell-policy.log'),
        hubHome,
        brainPolicy: 'standard',
        codexSandbox: 'workspace-write',
      });
      const exitCode = await new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
      expect(exitCode).toBe(0);
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('throws when brain policy is requested but bubblewrap is unavailable via AGENTHUB_BWRAP_BIN', () => {
    const prevBwrap = process.env.AGENTHUB_BWRAP_BIN;
    try {
      process.env.AGENTHUB_BWRAP_BIN = '';
      const profile = { name: 'test-codex', engine: 'codex', kind: 'default', home: null, email: null, enabled: 1 };
      expect(() => {
        new CodexEngine('dummy').spawn({
          profile,
          model: 'gpt-5.6-luna',
          cwd: '/tmp',
          prompt: 'test',
          logPath: '/tmp/test.log',
          brainPolicy: 'standard',
        });
      }).toThrow('Codex brain policy requires bubblewrap (bwrap)');
    } finally {
      if (prevBwrap === undefined) delete process.env.AGENTHUB_BWRAP_BIN;
      else process.env.AGENTHUB_BWRAP_BIN = prevBwrap;
    }
  });

  it('falls back to standard system paths when bwrap is missing from PATH', () => {
    const prevBwrap = process.env.AGENTHUB_BWRAP_BIN;
    const prevPath = process.env.PATH;
    try {
      delete process.env.AGENTHUB_BWRAP_BIN;
      process.env.PATH = '/nonexistent-bin-dir';
      const standardBwrap = ['/usr/bin/bwrap', '/bin/bwrap'].find((p) => {
        try {
          const stat = fs.statSync(p);
          return stat.isFile() && (process.platform === 'win32' || (stat.mode & 0o111) !== 0);
        } catch {
          return false;
        }
      });
      if (standardBwrap) {
        expect(findBubblewrap()).toBe(standardBwrap);
      } else {
        expect(findBubblewrap()).toBeNull();
      }
    } finally {
      if (prevBwrap === undefined) delete process.env.AGENTHUB_BWRAP_BIN;
      else process.env.AGENTHUB_BWRAP_BIN = prevBwrap;
      process.env.PATH = prevPath;
    }
  });

  it('discovers bwrap from PATH before standard fallback paths', () => {
    const prevBwrap = process.env.AGENTHUB_BWRAP_BIN;
    const prevPath = process.env.PATH;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-bwrap-test-'));
    try {
      delete process.env.AGENTHUB_BWRAP_BIN;
      const customBwrap = path.join(tmp, 'bwrap');
      fs.writeFileSync(customBwrap, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      process.env.PATH = `${tmp}${path.delimiter}${prevPath || ''}`;
      expect(findBubblewrap()).toBe(customBwrap);
    } finally {
      if (prevBwrap === undefined) delete process.env.AGENTHUB_BWRAP_BIN;
      else process.env.AGENTHUB_BWRAP_BIN = prevBwrap;
      process.env.PATH = prevPath;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('TOML serialization helpers', () => {
  it('escapes quotes, backslashes, newlines, control characters and preserves unicode', () => {
    expect(escapeTomlString('hello "world"')).toBe('hello \\"world\\"');
    expect(escapeTomlString('C:\\path\\to\\file')).toBe('C:\\\\path\\\\to\\\\file');
    expect(escapeTomlString('line1\nline2\r\nline3\t\b\f')).toBe('line1\\nline2\\r\\nline3\\t\\b\\f');
    expect(escapeTomlString('\0\x1f\x7f')).toBe('\\u0000\\u001f\\u007f');
    expect(escapeTomlString('Tiếng Việt và emoji 🚀')).toBe('Tiếng Việt và emoji 🚀');
  });

  it('escapes C1 control characters (U+0080-U+009F) while preserving non-control unicode above U+009F', () => {
    // C1 control characters boundary and representatives: U+0080, U+0085 (NEL), U+009F
    expect(escapeTomlString('\x80\x85\x9f')).toBe('\\u0080\\u0085\\u009f');
    expect(escapeTomlString('before\u0080after')).toBe('before\\u0080after');
    expect(escapeTomlString('before\u009fafter')).toBe('before\\u009fafter');
    // U+00A0 is non-breaking space (not a control character), should remain unescaped
    expect(escapeTomlString('\u00a0')).toBe('\u00a0');
  });

  it('formats bare keys and quoted keys properly', () => {
    expect(toTomlKey('AGENTHUB_PORT')).toBe('AGENTHUB_PORT');
    expect(toTomlKey('chat-session_123')).toBe('chat-session_123');
    expect(toTomlKey('key.with.dots')).toBe('"key.with.dots"');
    expect(toTomlKey('key with spaces')).toBe('"key with spaces"');
    expect(toTomlKey('key"with"quotes')).toBe('"key\\"with\\"quotes"');
    expect(toTomlKey('')).toBe('""');
  });

  it('formats values for strings, numbers, booleans, and arrays', () => {
    expect(toTomlValue('hello')).toBe('"hello"');
    expect(toTomlValue('hello "quoted" and \n newline')).toBe('"hello \\"quoted\\" and \\n newline"');
    expect(toTomlValue(7700)).toBe('7700');
    expect(toTomlValue(true)).toBe('true');
    expect(toTomlValue(false)).toBe('false');
    expect(toTomlValue(['a', 'b', 'c'])).toBe('["a", "b", "c"]');
    expect(toTomlValue(['path/with spaces/cli.js', 'mcp'])).toBe('["path/with spaces/cli.js", "mcp"]');
  });

  it('formats toTomlInlineTable with bare and quoted keys, escaping values properly', () => {
    const table = toTomlInlineTable({
      AGENTHUB_PORT: '7700',
      AGENTHUB_CHAT_KIND: 'brain',
    });
    expect(table).toBe('{AGENTHUB_PORT="7700", AGENTHUB_CHAT_KIND="brain"}');

    const empty = toTomlInlineTable({});
    expect(empty).toBe('{}');

    const complex = toTomlInlineTable({
      AGENTHUB_CHAT_SESSION_ID: 'brain:department:chung',
      'weird.key': 'val"quote\\backslash\nnewline\t',
      'unicode_key': 'Tiếng Việt 🚀',
    });
    expect(complex).toBe('{AGENTHUB_CHAT_SESSION_ID="brain:department:chung", "weird.key"="val\\"quote\\\\backslash\\nnewline\\t", unicode_key="Tiếng Việt 🚀"}');
  });

  it('formats toTomlConfigArg for command, args, and env', () => {
    expect(toTomlConfigArg('mcp_servers.agenthub.command', '/usr/bin/node')).toBe('mcp_servers.agenthub.command="/usr/bin/node"');
    expect(toTomlConfigArg('mcp_servers.agenthub.command', '/opt/My Path/node "v1"')).toBe('mcp_servers.agenthub.command="/opt/My Path/node \\"v1\\""');
    expect(toTomlConfigArg('mcp_servers.agenthub.args', ['dist/cli.js', 'mcp'])).toBe('mcp_servers.agenthub.args=["dist/cli.js", "mcp"]');
    expect(toTomlConfigArg('mcp_servers.agenthub.env', { AGENTHUB_PORT: '7700', AGENTHUB_CHAT_KIND: 'brain' })).toBe('mcp_servers.agenthub.env={AGENTHUB_PORT="7700", AGENTHUB_CHAT_KIND="brain"}');
  });
});

describe('CodexEngine MCP argv construction', () => {
  it('constructs valid -c arguments for command, args, and env inline table', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-codex-mcp-test-'));
    try {
      const dumpScript = path.join(tmp, 'dump-args.mjs');
      fs.writeFileSync(
        dumpScript,
        `#!/usr/bin/env node
import fs from 'node:fs';
fs.writeFileSync(process.argv[process.argv.length - 1], JSON.stringify(process.argv));
process.exit(0);
`,
        { mode: 0o755 },
      );

      const mcpConfigFile = path.join(tmp, 'mcp_config.json');
      fs.writeFileSync(
        mcpConfigFile,
        JSON.stringify({
          mcpServers: {
            agenthub: {
              command: '/opt/special path/node "v22"',
              args: ['/path/to/dist/cli.js', 'mcp'],
              env: {
                AGENTHUB_PORT: '7700',
                AGENTHUB_CHAT_KIND: 'brain',
                AGENTHUB_CHAT_SESSION_ID: 'brain:department:chung',
              },
            },
          },
        }),
      );

      const outFile = path.join(tmp, 'out.json');
      const profile = {
        name: 'test-codex',
        engine: 'codex',
        kind: 'default',
        home: null,
        email: null,
        enabled: 1,
        autoCreated: 0,
        createdAt: '2026-01-01',
      };

      const engine = new CodexEngine(dumpScript, 'off');
      const child = engine.spawn({
        profile,
        model: 'codex:gpt-5.6-luna',
        cwd: tmp,
        prompt: outFile,
        logPath: path.join(tmp, 'run.log'),
        mcpConfigPath: mcpConfigFile,
      });

      await new Promise<void>((resolve, reject) => {
        child.on('error', reject);
        child.on('exit', () => {
          try {
            const spawnedArgs: string[] = JSON.parse(fs.readFileSync(outFile, 'utf8'));

            // Check command quoting
            const cmdIdx = spawnedArgs.indexOf('mcp_servers.agenthub.command="/opt/special path/node \\"v22\\""');
            expect(cmdIdx).toBeGreaterThan(-1);
            expect(spawnedArgs[cmdIdx - 1]).toBe('-c');

            // Check args array
            const argsIdx = spawnedArgs.indexOf('mcp_servers.agenthub.args=["/path/to/dist/cli.js", "mcp"]');
            expect(argsIdx).toBeGreaterThan(-1);
            expect(spawnedArgs[argsIdx - 1]).toBe('-c');

            // Check env inline table TOML
            const envIdx = spawnedArgs.indexOf('mcp_servers.agenthub.env={AGENTHUB_PORT="7700", AGENTHUB_CHAT_KIND="brain", AGENTHUB_CHAT_SESSION_ID="brain:department:chung"}');
            expect(envIdx).toBeGreaterThan(-1);
            expect(spawnedArgs[envIdx - 1]).toBe('-c');

            resolve();
          } catch (err) {
            reject(err);
          }
        });
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
