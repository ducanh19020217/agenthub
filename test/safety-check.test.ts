import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  assertTestIsolation,
  findHubEntryChanges,
  getAgyHomesSnapshot,
  getHubSnapshot,
  verifyAgyHomesSafety,
  verifyHubHomeSafety,
} from './safety-check';

describe('safety-check isolation and metadata warnings', () => {
  let tempDir: string;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-safety-test-'));
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('passes for the test HOME and fails when any configured path is the real HOME', () => {
    expect(() => assertTestIsolation()).not.toThrow();
    expect(() => assertTestIsolation({ home: tempDir, hubHome: path.join(tempDir, '.agenthub'), agyHomesDir: path.join(tempDir, '.agy-homes') })).not.toThrow();
    const realHome = os.userInfo().homedir;
    const saved = { HOME: process.env.HOME, AGENTHUB_HOME: process.env.AGENTHUB_HOME, AGENTHUB_AGY_HOMES: process.env.AGENTHUB_AGY_HOMES };
    try {
      process.env.HOME = realHome;
      process.env.AGENTHUB_HOME = path.join(realHome, '.agenthub');
      process.env.AGENTHUB_AGY_HOMES = path.join(realHome, '.agy-homes');
      expect(() => assertTestIsolation()).toThrow(/isolation is broken/);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });

  it('warns, without throwing, when a hub entry is added or removed', () => {
    const hub = path.join(tempDir, '.agenthub');
    fs.mkdirSync(hub);
    const snap = getHubSnapshot(hub);
    fs.mkdirSync(path.join(hub, 'runtime'));
    verifyHubHomeSafety(snap);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('runtime'));

    warn.mockClear();
    fs.rmSync(path.join(hub, 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(hub, 'removed'), 'x');
    const withFile = getHubSnapshot(hub);
    fs.rmSync(path.join(hub, 'removed'));
    verifyHubHomeSafety(withFile);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('removed'));
  });

  it('warns when config metadata changes, without reading its content', () => {
    const hub = path.join(tempDir, '.agenthub');
    fs.mkdirSync(hub);
    fs.writeFileSync(path.join(hub, 'config.json'), '{}');
    const snap = getHubSnapshot(hub);
    const later = new Date(Date.now() + 2000);
    fs.utimesSync(path.join(hub, 'config.json'), later, later);
    verifyHubHomeSafety(snap);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('config.json'));
  });

  it('warns when an agy profile is removed without inspecting profiles', () => {
    const agyHomes = path.join(tempDir, '.agy-homes');
    fs.mkdirSync(path.join(agyHomes, 'g1'), { recursive: true });
    fs.writeFileSync(path.join(agyHomes, 'g1', 'token'), 'secret');
    const snap = getAgyHomesSnapshot(agyHomes);
    fs.rmSync(path.join(agyHomes, 'g1'), { recursive: true });
    verifyAgyHomesSafety(snap);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('g1'));
  });

  it('does not read sensitive files while taking or comparing snapshots', () => {
    const hub = path.join(tempDir, '.agenthub');
    const agyHomes = path.join(tempDir, '.agy-homes');
    fs.mkdirSync(path.join(hub, 'secrets'), { recursive: true });
    fs.mkdirSync(path.join(hub, 'profiles'), { recursive: true });
    fs.mkdirSync(path.join(agyHomes, 'g1'), { recursive: true });
    fs.writeFileSync(path.join(hub, 'secrets', 'key'), 'secret');
    fs.writeFileSync(path.join(hub, 'profiles', 'p'), 'profile');
    fs.writeFileSync(path.join(agyHomes, 'g1', 'token'), 'secret');
    const readFile = vi.spyOn(fs, 'readFileSync');
    const open = vi.spyOn(fs, 'openSync');
    verifyHubHomeSafety(getHubSnapshot(hub));
    verifyAgyHomesSafety(getAgyHomesSnapshot(agyHomes));
    expect(readFile).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it('reports added and removed top-level names', () => {
    expect(findHubEntryChanges(['a', 'b'], ['b', 'c'])).toEqual({ added: ['c'], removed: ['a'] });
  });
});
