import type { UIMessage } from 'ai';

import {
  type WhenContext,
  type WhenPredicate,
  isRecord,
} from '../../message/user.ts';

export interface TemporalReminderOptions {
  tz?: string;
}

export interface LocaleData {
  language: string;
  timeZone: string;
}

export const LOCALE_METADATA_KEY = 'locale';

export function getLocaleFromMessage(
  message: UIMessage | undefined,
): LocaleData | null {
  if (!message) return null;
  const metadata = isRecord(message.metadata) ? message.metadata : null;
  if (!metadata) return null;
  const locale = metadata[LOCALE_METADATA_KEY];
  if (!isRecord(locale)) return null;
  if (
    typeof locale.language !== 'string' ||
    typeof locale.timeZone !== 'string'
  ) {
    return null;
  }
  return { language: locale.language, timeZone: locale.timeZone };
}

export function resolveTz(
  options: TemporalReminderOptions | undefined,
  ctx: { currentMessage?: UIMessage; lastMessage?: UIMessage },
): string {
  if (options?.tz) return options.tz;
  return (
    getLocaleFromMessage(ctx.currentMessage)?.timeZone ??
    getLocaleFromMessage(ctx.lastMessage)?.timeZone ??
    'UTC'
  );
}

function toDateParts(
  date: Date,
  tz: string,
): { year: string; month: string; day: string; hour: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '';

  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
  };
}

function temporalChanged(
  ctx: WhenContext,
  tz: string,
  getKey: (parts: ReturnType<typeof toDateParts>) => string,
): boolean {
  if (ctx.lastMessageAt === undefined) return true;
  const nowParts = toDateParts(new Date(), tz);
  const prevParts = toDateParts(new Date(ctx.lastMessageAt), tz);
  return getKey(nowParts) !== getKey(prevParts);
}

export function getSeason(month: number): string {
  if (month >= 2 && month <= 4) return 'Spring';
  if (month >= 5 && month <= 7) return 'Summer';
  if (month >= 8 && month <= 10) return 'Fall';
  return 'Winter';
}

function isoWeekKey(parts: ReturnType<typeof toDateParts>): string {
  const d = new Date(
    Date.UTC(
      parseInt(parts.year),
      parseInt(parts.month) - 1,
      parseInt(parts.day),
    ),
  );
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(
    ((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
  );
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

export function dayChanged(options?: TemporalReminderOptions): WhenPredicate {
  return (ctx) =>
    temporalChanged(
      ctx,
      resolveTz(options, ctx),
      (p) => `${p.year}-${p.month}-${p.day}`,
    );
}

export function hourChanged(options?: TemporalReminderOptions): WhenPredicate {
  return (ctx) =>
    temporalChanged(
      ctx,
      resolveTz(options, ctx),
      (p) => `${p.year}-${p.month}-${p.day}-${p.hour}`,
    );
}

export function monthChanged(options?: TemporalReminderOptions): WhenPredicate {
  return (ctx) =>
    temporalChanged(
      ctx,
      resolveTz(options, ctx),
      (p) => `${p.year}-${p.month}`,
    );
}

export function yearChanged(options?: TemporalReminderOptions): WhenPredicate {
  return (ctx) => temporalChanged(ctx, resolveTz(options, ctx), (p) => p.year);
}

export function seasonChanged(
  options?: TemporalReminderOptions,
): WhenPredicate {
  return (ctx) =>
    temporalChanged(ctx, resolveTz(options, ctx), (p) =>
      getSeason(parseInt(p.month) - 1),
    );
}

export function weekChanged(options?: TemporalReminderOptions): WhenPredicate {
  return (ctx) => temporalChanged(ctx, resolveTz(options, ctx), isoWeekKey);
}
