import { z } from 'zod';

export function isValidReviewerModel(engine: 'codex' | 'claude', model: string): boolean {
  const trimmed = model.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  if (engine === 'claude') {
    const raw = trimmed.startsWith('claude:') ? trimmed.slice('claude:'.length) : trimmed;
    return (
      ['sonnet', 'opus', 'haiku'].includes(raw) ||
      raw.startsWith('claude-')
    );
  }
  if (engine === 'codex') {
    const raw = trimmed.startsWith('codex:') ? trimmed.slice('codex:'.length) : trimmed;
    return (
      ['gpt-5.6-luna', 'gpt-5.6-turbo'].includes(raw) ||
      (raw.startsWith('gpt-') && raw.length > 4)
    );
  }
  return false;
}

export const ReviewerOrderItemSchema = z
  .object({
    engine: z.enum(['codex', 'claude']),
    model: z.string().trim().min(1, 'Model của reviewer không được để trống'),
    profiles: z.array(z.string().min(1)).max(50).default([]),
  })
  .superRefine((item, ctx) => {
    const trimmed = item.model.trim();
    if (/\s/.test(trimmed)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['model'],
        message: 'Model của reviewer không được chứa khoảng trắng',
      });
      return;
    }
    if (trimmed === 'codex:' || trimmed === 'claude:') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['model'],
        message: 'Model của reviewer không hợp lệ',
      });
    }
  });

export const ReviewerFallbackSchema = z.object({
  onUnavailable: z.boolean().default(true),
  onBusyAfterMin: z.number().int().min(0).max(1440).default(10),
  onError: z.boolean().default(true),
});

export const ReviewerOrderSchema = z.array(ReviewerOrderItemSchema).max(20);

export const ReviewerArbiterSchema = z
  .object({
    engine: z.enum(['codex', 'claude']).default('claude'),
    model: z.string().trim().min(1, 'Model của arbiter không được để trống').default('opus'),
  })
  .superRefine((item, ctx) => {
    const trimmed = item.model.trim();
    if (/\s/.test(trimmed)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['model'],
        message: 'Model của arbiter không được chứa khoảng trắng',
      });
      return;
    }
    if (trimmed === 'codex:' || trimmed === 'claude:') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['model'],
        message: 'Model của arbiter không hợp lệ',
      });
    }
  });

export const ReviewerSettingsSchema = z.object({
  order: ReviewerOrderSchema,
  fallback: ReviewerFallbackSchema,
});

export type ReviewerOrderItem = z.infer<typeof ReviewerOrderItemSchema>;
export type ReviewerFallback = z.infer<typeof ReviewerFallbackSchema>;
export type ReviewerArbiter = z.infer<typeof ReviewerArbiterSchema>;
export type ReviewerSettings = z.infer<typeof ReviewerSettingsSchema>;

export const DEFAULT_REVIEWER_ORDER: ReviewerOrderItem[] = [
  { engine: 'codex', model: 'gpt-5.6-luna', profiles: [] },
  { engine: 'claude', model: 'sonnet', profiles: [] },
];

export const DEFAULT_REVIEWER_FALLBACK: ReviewerFallback = {
  onUnavailable: true,
  onBusyAfterMin: 10,
  onError: true,
};

export const DEFAULT_REVIEWER_ARBITER: ReviewerArbiter = { engine: 'claude', model: 'opus' };

export function normalizeReviewerModel(engine: ReviewerOrderItem['engine'], model: string): string {
  if (engine === 'codex') return model.startsWith('codex:') ? model : `codex:${model}`;
  return model.startsWith('claude:') ? model : `claude:${model}`;
}

export function reviewerSettingsFromLegacy(raw: Record<string, unknown>): ReviewerSettings {
  const orderRaw = raw.order;
  const fallbackRaw = raw.fallback;
  if (Array.isArray(orderRaw)) {
    const order = ReviewerOrderSchema.safeParse(orderRaw);
    if (order.success) {
      return ReviewerSettingsSchema.parse({
        order: order.data,
        fallback: fallbackRaw && typeof fallbackRaw === 'object' ? fallbackRaw : {},
      });
    }
  }
  const codexModel = typeof raw.model === 'string' && raw.model.startsWith('codex:')
    ? raw.model.slice('codex:'.length) : 'gpt-5.6-luna';
  const claudeModel = typeof raw.claudeModel === 'string' && raw.claudeModel ? raw.claudeModel : 'sonnet';
  const claudeProfiles = Array.isArray(raw.claudeProfiles)
    ? raw.claudeProfiles.filter((value): value is string => typeof value === 'string' && value.length > 0)
    : [];
  const order: ReviewerOrderItem[] = [{ engine: 'codex', model: codexModel, profiles: [] }];
  if (raw.claudeFallback !== false) order.push({ engine: 'claude', model: claudeModel, profiles: claudeProfiles });
  return ReviewerSettingsSchema.parse({
    order,
    fallback: {
      onUnavailable: true,
      onBusyAfterMin: typeof raw.claudeFallbackAfterMin === 'number' ? raw.claudeFallbackAfterMin : 10,
      onError: true,
    },
  });
}
