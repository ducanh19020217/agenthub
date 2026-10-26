import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkWorktreeDependencies } from '../src/merge.js';

describe('checkWorktreeDependencies', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-merge-deps-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      scripts: { lint: 'agenthub-fake-linter .', typecheck: 'agenthub-fake-turbo typecheck', format: 'pnpm format:check && agenthub-fake-turbo lint' },
      devDependencies: { 'agenthub-fake-linter': '1.0.0' },
    }));
    fs.mkdirSync(path.join(dir, 'node_modules', '.bin'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const addBin = (name: string) => fs.writeFileSync(path.join(dir, 'node_modules', '.bin', name), '#!/bin/sh\n', { mode: 0o755 });

  it('treats `pnpm <script>` shorthand as running the package script', () => {
    addBin('agenthub-fake-linter');
    addBin('agenthub-fake-turbo');
    expect(checkWorktreeDependencies(dir, ['pnpm lint', 'pnpm typecheck'])).toEqual({ ok: true });
  });

  it('reports the script binary, not the script name, when it is missing', () => {
    const result = checkWorktreeDependencies(dir, ['pnpm lint']);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('"agenthub-fake-linter"');
    expect(result.reason).toContain('script "lint"');
  });

  it('accepts scripts that start with a package manager command', () => {
    addBin('agenthub-fake-turbo');
    expect(checkWorktreeDependencies(dir, ['pnpm format'])).toEqual({ ok: true });
  });

  it('still checks `pnpm <tool>` as a binary when no script has that name', () => {
    const result = checkWorktreeDependencies(dir, ['pnpm agenthub-fake-tool']);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('"agenthub-fake-tool"');
  });
});
