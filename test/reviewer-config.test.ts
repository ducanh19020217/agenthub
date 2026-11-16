import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import {
  ReviewerArbiterSchema,
  ReviewerOrderItemSchema,
  reviewerSettingsFromLegacy,
} from '../src/reviewer-config.js';
import { modelValidator, reviewerModelValidator } from '../src/services/index.js';

describe('reviewer order configuration', () => {
  it('migrates legacy Codex/Claude settings to the ordered form', () => {
    expect(reviewerSettingsFromLegacy({
      model: 'codex:gpt-5.6-luna',
      claudeFallback: false,
      claudeFallbackAfterMin: 0,
    })).toEqual({
      order: [{ engine: 'codex', model: 'gpt-5.6-luna', profiles: [] }],
      fallback: { onUnavailable: true, onBusyAfterMin: 0, onError: true },
    });
  });

  it('preserves explicit order, fallback and arbiter values when loading config', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-review-config-'));
    try {
      fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ reviewer: {
        order: [{ engine: 'claude', model: 'sonnet', profiles: ['claude-may'] }, { engine: 'codex', model: 'gpt-5.6-luna', profiles: [] }],
        fallback: { onUnavailable: false, onBusyAfterMin: 0, onError: false },
        arbiter: { engine: 'codex', model: 'gpt-5.6-luna' },
      }}));
      const config = loadConfig(home);
      expect(config.reviewer.order).toEqual([
        { engine: 'claude', model: 'sonnet', profiles: ['claude-may'] },
        { engine: 'codex', model: 'gpt-5.6-luna', profiles: [] },
      ]);
      expect(config.reviewer.fallback).toEqual({ onUnavailable: false, onBusyAfterMin: 0, onError: false });
      expect(config.reviewer.arbiter).toEqual({ engine: 'codex', model: 'gpt-5.6-luna' });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('validates reviewer order items according to engine syntax', () => {
    // Valid Claude models
    expect(ReviewerOrderItemSchema.safeParse({ engine: 'claude', model: 'sonnet', profiles: [] }).success).toBe(true);
    expect(ReviewerOrderItemSchema.safeParse({ engine: 'claude', model: 'opus', profiles: [] }).success).toBe(true);
    expect(ReviewerOrderItemSchema.safeParse({ engine: 'claude', model: 'haiku', profiles: [] }).success).toBe(true);
    expect(ReviewerOrderItemSchema.safeParse({ engine: 'claude', model: 'claude-sonnet-4-6', profiles: [] }).success).toBe(true);
    expect(ReviewerOrderItemSchema.safeParse({ engine: 'claude', model: 'claude:sonnet', profiles: [] }).success).toBe(true);
    expect(ReviewerOrderItemSchema.safeParse({ engine: 'claude', model: 'my-model', profiles: [] }).success).toBe(true);

    // Valid Codex models
    expect(ReviewerOrderItemSchema.safeParse({ engine: 'codex', model: 'gpt-5.6-luna', profiles: [] }).success).toBe(true);
    expect(ReviewerOrderItemSchema.safeParse({ engine: 'codex', model: 'gpt-5.6-turbo', profiles: [] }).success).toBe(true);
    expect(ReviewerOrderItemSchema.safeParse({ engine: 'codex', model: 'codex:gpt-5.6-luna', profiles: [] }).success).toBe(true);
    expect(ReviewerOrderItemSchema.safeParse({ engine: 'codex', model: 'gpt-4o', profiles: [] }).success).toBe(true);
    expect(ReviewerOrderItemSchema.safeParse({ engine: 'codex', model: 'my-model', profiles: [] }).success).toBe(true);

    // Invalid: empty or whitespace or invalid prefix-only
    expect(ReviewerOrderItemSchema.safeParse({ engine: 'codex', model: '', profiles: [] }).success).toBe(false);
    expect(ReviewerOrderItemSchema.safeParse({ engine: 'codex', model: '   ', profiles: [] }).success).toBe(false);
    expect(ReviewerOrderItemSchema.safeParse({ engine: 'codex', model: 'gpt 5.6', profiles: [] }).success).toBe(false);
    expect(ReviewerOrderItemSchema.safeParse({ engine: 'codex', model: 'codex: a', profiles: [] }).success).toBe(false);
    expect(ReviewerOrderItemSchema.safeParse({ engine: 'codex', model: 'codex:', profiles: [] }).success).toBe(false);
    expect(ReviewerOrderItemSchema.safeParse({ engine: 'claude', model: 'claude:', profiles: [] }).success).toBe(false);
    expect(ReviewerOrderItemSchema.safeParse({ engine: 'claude', model: 'my model', profiles: [] }).success).toBe(false);
  });

  it('validates reviewer arbiter according to engine syntax', () => {
    expect(ReviewerArbiterSchema.safeParse({ engine: 'claude', model: 'opus' }).success).toBe(true);
    expect(ReviewerArbiterSchema.safeParse({ engine: 'codex', model: 'gpt-5.6-luna' }).success).toBe(true);
    expect(ReviewerArbiterSchema.safeParse({ engine: 'claude', model: 'my-model' }).success).toBe(true);
    expect(ReviewerArbiterSchema.safeParse({ engine: 'codex', model: 'my-model' }).success).toBe(true);

    // Invalid: empty or whitespace or invalid prefix-only
    expect(ReviewerArbiterSchema.safeParse({ engine: 'claude', model: '' }).success).toBe(false);
    expect(ReviewerArbiterSchema.safeParse({ engine: 'claude', model: 'opus thinking' }).success).toBe(false);
    expect(ReviewerArbiterSchema.safeParse({ engine: 'codex', model: 'gpt 5.6' }).success).toBe(false);
    expect(ReviewerArbiterSchema.safeParse({ engine: 'codex', model: 'codex:' }).success).toBe(false);
    expect(ReviewerArbiterSchema.safeParse({ engine: 'claude', model: 'claude:' }).success).toBe(false);
  });

  it('validates modelValidator and reviewerModelValidator with engine rules', () => {
    // modelValidator
    expect(modelValidator.safeParse('gemini-3.8-flash-high').success).toBe(true);
    expect(modelValidator.safeParse('claude-sonnet-4-6').success).toBe(true);
    expect(modelValidator.safeParse('codex:gpt-5.6-luna').success).toBe(true);
    expect(modelValidator.safeParse('codex:gpt-4o').success).toBe(true);
    expect(modelValidator.safeParse('codex:x').success).toBe(true);
    expect(modelValidator.safeParse('codex:custom-model-id').success).toBe(true);
    expect(modelValidator.safeParse('codex:').success).toBe(true);
    expect(modelValidator.safeParse('').success).toBe(false);
    expect(modelValidator.safeParse('gemini-custom').success).toBe(true);

    // reviewerModelValidator
    expect(reviewerModelValidator.safeParse('codex:gpt-5.6-luna').success).toBe(true);
    expect(reviewerModelValidator.safeParse('gpt-5.6-luna').success).toBe(true);
    expect(reviewerModelValidator.safeParse('codex:gpt-4o').success).toBe(true);
    expect(reviewerModelValidator.safeParse('sonnet').success).toBe(true);
    expect(reviewerModelValidator.safeParse('claude:sonnet').success).toBe(true);
    expect(reviewerModelValidator.safeParse('claude-sonnet-4-6').success).toBe(true);
    expect(reviewerModelValidator.safeParse('codex:x').success).toBe(false);
    expect(reviewerModelValidator.safeParse('claude:x').success).toBe(false);
    expect(reviewerModelValidator.safeParse('gemini-3.8-flash-high').success).toBe(false);
    expect(reviewerModelValidator.safeParse('').success).toBe(false);
  });
});
