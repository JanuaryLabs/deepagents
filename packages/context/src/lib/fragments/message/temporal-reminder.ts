import type { UIMessage } from 'ai';

import type { ContextFragment } from '../../fragments.ts';
import {
  type WhenPredicate,
  dayChanged,
  getSeason,
  hourChanged,
  monthChanged,
  reminder,
  seasonChanged,
  yearChanged,
} from './user.ts';

export interface TemporalReminderOptions {
  tz?: string;
}

export interface LocaleReminderOptions {
  language?: string;
  timeZone?: string;
}

function formatDateKey(date: Date, tz: string): string {
  return date.toLocaleDateString('en-CA', { timeZone: tz });
}

function formatDayOfWeek(date: Date, tz: string): string {
  return date.toLocaleString('default', { weekday: 'long', timeZone: tz });
}

function formatTime(date: Date, tz: string): string {
  return date.toLocaleString('en-CA', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function formatMonthName(date: Date, tz: string): string {
  return date.toLocaleString('default', { month: 'long', timeZone: tz });
}

function formatYear(date: Date, tz: string): number {
  return parseInt(
    date.toLocaleString('en-CA', { year: 'numeric', timeZone: tz }),
    10,
  );
}

function getMonthIndex(date: Date, tz: string): number {
  return (
    parseInt(
      date.toLocaleString('en-CA', { month: 'numeric', timeZone: tz }),
      10,
    ) - 1
  );
}

function formatHour(date: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  return parts.find((p) => p.type === 'hour')?.value ?? '00';
}

function diffLine(
  label: string,
  prev: string | number,
  curr: string | number,
): string | null {
  return prev !== curr ? `${label}: ${prev} -> ${curr}` : null;
}

function formatDiff(changes: (string | null)[]): string {
  const filtered = changes.filter((c): c is string => c !== null);
  if (filtered.length === 0) return '';
  return `${filtered.join('\n')}\n\n`;
}

export function dateReminder(
  options?: TemporalReminderOptions,
): ContextFragment {
  const tz = options?.tz ?? 'UTC';
  return reminder(
    (ctx) => {
      const now = new Date();
      const currentDate = formatDateKey(now, tz);
      const currentDay = formatDayOfWeek(now, tz);

      let diff = '';
      if (ctx.lastMessageAt !== undefined) {
        const prev = new Date(ctx.lastMessageAt);
        diff = formatDiff([
          diffLine('date', formatDateKey(prev, tz), currentDate),
          diffLine('day of week', formatDayOfWeek(prev, tz), currentDay),
        ]);
      }

      return `${diff}Date: ${currentDate}\nDay of Week: ${currentDay}`;
    },
    { when: dayChanged(tz), asPart: true },
  );
}

export function timeReminder(
  options?: TemporalReminderOptions,
): ContextFragment {
  const tz = options?.tz ?? 'UTC';
  return reminder(
    (ctx) => {
      const now = new Date();
      const currentTime = formatTime(now, tz);

      let diff = '';
      if (ctx.lastMessageAt !== undefined) {
        const prev = new Date(ctx.lastMessageAt);
        diff = formatDiff([
          diffLine('hour', formatHour(prev, tz), formatHour(now, tz)),
        ]);
      }

      return `${diff}Time: ${currentTime}`;
    },
    { when: hourChanged(tz), asPart: true },
  );
}

export function monthReminder(
  options?: TemporalReminderOptions,
): ContextFragment {
  const tz = options?.tz ?? 'UTC';
  return reminder(
    (ctx) => {
      const now = new Date();
      const currentMonth = formatMonthName(now, tz);

      let diff = '';
      if (ctx.lastMessageAt !== undefined) {
        const prev = new Date(ctx.lastMessageAt);
        diff = formatDiff([
          diffLine('month', formatMonthName(prev, tz), currentMonth),
        ]);
      }

      return `${diff}Month: ${currentMonth}`;
    },
    { when: monthChanged(tz), asPart: true },
  );
}

export function yearReminder(
  options?: TemporalReminderOptions,
): ContextFragment {
  const tz = options?.tz ?? 'UTC';
  return reminder(
    (ctx) => {
      const now = new Date();
      const currentYear = formatYear(now, tz);

      let diff = '';
      if (ctx.lastMessageAt !== undefined) {
        const prev = new Date(ctx.lastMessageAt);
        diff = formatDiff([
          diffLine('year', formatYear(prev, tz), currentYear),
        ]);
      }

      return `${diff}Year: ${currentYear}`;
    },
    { when: yearChanged(tz), asPart: true },
  );
}

export function seasonReminder(
  options?: TemporalReminderOptions,
): ContextFragment {
  const tz = options?.tz ?? 'UTC';
  return reminder(
    (ctx) => {
      const now = new Date();
      const currentSeason = getSeason(getMonthIndex(now, tz));

      let diff = '';
      if (ctx.lastMessageAt !== undefined) {
        const prev = new Date(ctx.lastMessageAt);
        diff = formatDiff([
          diffLine('season', getSeason(getMonthIndex(prev, tz)), currentSeason),
        ]);
      }

      return `${diff}Season: ${currentSeason}`;
    },
    { when: seasonChanged(tz), asPart: true },
  );
}

const LOCALE_METADATA_KEY = 'locale';

interface LocaleData {
  language: string;
  timeZone: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getLocaleFromMessage(
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

export function localeReminder(
  options?: LocaleReminderOptions,
): ContextFragment {
  const language = options?.language ?? 'English (US)';
  const timeZone = options?.timeZone ?? 'UTC';

  const whenFn: WhenPredicate = (ctx) => {
    const prev = getLocaleFromMessage(ctx.lastMessage);
    if (!prev) return true;
    return prev.language !== language || prev.timeZone !== timeZone;
  };

  return reminder(
    (ctx) => {
      const prev = getLocaleFromMessage(ctx.lastMessage);
      let diff = '';
      if (prev) {
        diff = formatDiff([
          diffLine('language', prev.language, language),
          diffLine('timezone', prev.timeZone, timeZone),
        ]);
      }

      return {
        text: `${diff}Language: ${language}\nTimezone: ${timeZone}`,
        metadata: {
          [LOCALE_METADATA_KEY]: { language, timeZone } satisfies LocaleData,
        },
      };
    },
    { when: whenFn, asPart: true },
  );
}

export function temporalReminder(
  options?: TemporalReminderOptions,
): ContextFragment[] {
  const tz = options?.tz ?? 'UTC';

  return [
    dateReminder({ tz }),
    timeReminder({ tz }),
    monthReminder({ tz }),
    yearReminder({ tz }),
    seasonReminder({ tz }),
  ];
}
