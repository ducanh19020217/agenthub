import { describe, it, expect } from 'vitest';
import { applyIsolatedAgyEnv } from '../src/agy.js';

describe('applyIsolatedAgyEnv', () => {
  it('isolates HOME and the DBus keyring on Linux without faking SSH', () => {
    const env: Record<string, string> = { HOME: '/home/real' };
    applyIsolatedAgyEnv(env, '/tmp/agy-homes/g1', 'linux');
    expect(env.HOME).toBe('/tmp/agy-homes/g1');
    expect(env.DBUS_SESSION_BUS_ADDRESS).toBe('unix:path=/nonexistent/agy-no-keyring');
    expect(env.SSH_CONNECTION).toBeUndefined();
  });

  it('sets SSH_CONNECTION on macOS so agy uses file token storage instead of the keychain', () => {
    const env: Record<string, string> = {};
    applyIsolatedAgyEnv(env, '/tmp/agy-homes/g1', 'darwin');
    expect(env.HOME).toBe('/tmp/agy-homes/g1');
    expect(env.SSH_CONNECTION).toBe('127.0.0.1 0 127.0.0.1 0');
  });

  it('keeps a real SSH_CONNECTION on macOS', () => {
    const env: Record<string, string> = { SSH_CONNECTION: '10.0.0.2 50000 10.0.0.1 22' };
    applyIsolatedAgyEnv(env, '/tmp/agy-homes/g1', 'darwin');
    expect(env.SSH_CONNECTION).toBe('10.0.0.2 50000 10.0.0.1 22');
  });
});
