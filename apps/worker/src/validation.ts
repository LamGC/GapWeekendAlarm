import { z } from 'zod';

const hhmm = /^([01]\d|2[0-3]):([0-5]\d)$/;
const dateOnly = /^\d{4}-\d{2}-\d{2}$/;

export const scheduleRuleSchema = z.enum(['big_small', 'double_rest', 'single_rest']);

export const weekTypeSchema = z.enum(['big', 'small']);

export const createSubscriptionSchema = z.object({
  client_id: z.string().min(8).max(128),
  turnstile_token: z.string().min(1),
  subscription: z.object({
    endpoint: z.url(),
    keys: z.object({
      p256dh: z.string().min(16),
      auth: z.string().min(8),
    }),
  }),
  timezone: z.string().min(2).max(64),
  weekend_remind_time: z.string().regex(hhmm).default('17:00'),
  workday_remind_time: z.string().regex(hhmm).default('20:00'),
  schedule_rule: scheduleRuleSchema,
  week_pattern_anchor: z
    .object({
      anchor_date: z.string().regex(dateOnly),
      anchor_week_type: weekTypeSchema,
    })
    .optional(),
  enabled_holiday_sources: z.array(z.string()).max(8).optional().default([]),
});

export const updateSubscriptionSchema = z
  .object({
    timezone: z.string().min(2).max(64).optional(),
    weekend_remind_time: z.string().regex(hhmm).optional(),
    workday_remind_time: z.string().regex(hhmm).optional(),
    schedule_rule: scheduleRuleSchema.optional(),
    week_pattern_anchor: z
      .object({
        anchor_date: z.string().regex(dateOnly),
        anchor_week_type: weekTypeSchema,
      })
      .optional(),
    weekend_enabled: z.boolean().optional(),
    workday_enabled: z.boolean().optional(),
    enabled_holiday_sources: z.array(z.string()).max(8).optional(),
  })
  .refine(
    (value) => {
      if (value.schedule_rule === 'big_small' && !value.week_pattern_anchor) {
        return false;
      }
      return true;
    },
    { message: 'big_small rule requires week_pattern_anchor' }
  );

export const anchorCorrectionSchema = z.object({
  anchor_date: z.string().regex(dateOnly),
  anchor_week_type: weekTypeSchema,
});

export const extensionScopeSchema = z.enum(['holiday', 'adjustment', 'workday']);

export const extensionSchema = z.object({
  scope: extensionScopeSchema,
  start_date: z.string().regex(dateOnly),
  end_date: z.string().regex(dateOnly),
});
