import { describe, expect, it } from 'vitest';
import { parseReviewChain, ReviewChainSchema, reviewerModel } from '../src/review-chain.js';

describe('project review chain', () => {
  it('parses gate and final steps and extracts Codex models', () => {
    const chain = parseReviewChain(JSON.stringify([
      { reviewer: 'codex:gpt-5.6-luna', mode: 'gate' },
      { reviewer: 'claude', mode: 'final' },
    ]));

    expect(chain).toHaveLength(2);
    expect(reviewerModel(chain[0])).toBe('codex:gpt-5.6-luna');
    expect(reviewerModel(chain[1])).toBeNull();
  });

  it('fails closed for malformed or unsupported reviewers', () => {
    expect(parseReviewChain('{"chain":[]}')).toEqual([]);
    expect(ReviewChainSchema.safeParse([{ reviewer: 'gemini', mode: 'gate' }]).success).toBe(false);
    expect(ReviewChainSchema.safeParse([{ reviewer: 'codex:', mode: 'gate' }]).success).toBe(false);
    expect(ReviewChainSchema.safeParse([{ reviewer: 'codex: ', mode: 'gate' }]).success).toBe(false);
    expect(ReviewChainSchema.safeParse([{ reviewer: 'codex:x', mode: 'gate' }]).success).toBe(false);
    expect(ReviewChainSchema.safeParse([{ reviewer: 'codex:gpt-5.6-luna', mode: 'gate' }]).success).toBe(true);
    expect(ReviewChainSchema.safeParse([{ reviewer: 'codex:gpt-4o', mode: 'gate' }]).success).toBe(true);
  });
});

describe('isAutomatedStep', () => {
  it('runs gates and any Codex step automatically, leaves a Claude final step to the brain', async () => {
    const { isAutomatedStep } = await import('../src/review-chain.js');
    expect(isAutomatedStep({ reviewer: 'codex:gpt-5.6-luna', mode: 'gate' })).toBe(true);
    expect(isAutomatedStep({ reviewer: 'codex:gpt-5.6-luna', mode: 'final' })).toBe(true);
    expect(isAutomatedStep({ reviewer: 'claude', mode: 'gate' })).toBe(true);
    expect(isAutomatedStep({ reviewer: 'claude', mode: 'final' })).toBe(false);
    expect(isAutomatedStep(undefined)).toBe(false);
  });
});
