import { describe, it, expect } from 'vitest';
import { normalizePlan } from '../src/profiles/plan.js';

describe('normalizePlan', () => {
  it.each([
    ['plus', 'plus'],
    ['pro', 'pro'],
    ['free', 'free'],
    ['team', 'team'],
    ['default_claude_max_20x', 'max_20x'],
    ['default_claude_max_5x', 'max_5x'],
    ['claude_pro', 'pro'],
    ['enterprise', 'enterprise'],
    ['default_claude_ai', 'free'],
  ])('%s -> %s', (raw, expected) => {
    expect(normalizePlan(raw)).toBe(expected);
  });

  it('ignores technical values and falls back to the next source', () => {
    expect(normalizePlan('stripe_subscription')).toBeNull();
    expect(normalizePlan(null, 'stripe_subscription', 'plus')).toBe('plus');
    expect(normalizePlan('')).toBeNull();
  });
});

describe('Claude plan from .claude.json', () => {
  it('reads the rate limit tier, not the organisation name', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { loadConfig } = await import('../src/config.js');
    const { createContext } = await import('../src/daemon.js');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-claude-plan-'));
    const ctx = createContext(loadConfig(tmp));
    try {
      const home = path.join(tmp, 'claude-home');
      fs.mkdirSync(home);
      fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
        oauthAccount: { emailAddress: 'c@example.com', organizationName: 'Prosoft', billingType: 'stripe_subscription', userRateLimitTier: 'default_claude_max_20x' },
      }));
      expect(ctx.profileService.readClaudeAccount(home)?.planId).toBe('max_20x');
    } finally {
      ctx.db.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
