import type { UIMessage } from 'ai';

import type { ContextFragment } from '../../fragments.ts';
import { everyNTurns, reminder } from './user.ts';

export interface EnvironmentReminderOptions {
  language?: string;
  timeZone?: string;
  getNow?: () => Date;
}

export interface EnvironmentSnapshot {
  timeZone: string;
  language: string;
  currentDateTime: string;
  dateKey: string;
  dayOfWeek: string;
  month: string;
  year: number;
  season: string;
  timestamp: number;
}

export interface EnvironmentReminderMetadata {
  version: 1;
  snapshot: EnvironmentSnapshot;
}

export const ENVIRONMENT_REMINDER_METADATA_KEY = 'environment';

function getSeason(month: number): string {
  if (month >= 2 && month <= 4) return 'Spring';
  if (month >= 5 && month <= 7) return 'Summer';
  if (month >= 8 && month <= 10) return 'Fall';
  return 'Winter';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function buildEnvironmentSnapshot(
  now: Date,
  options: {
    language: string;
    timeZone: string;
  },
): EnvironmentSnapshot {
  const { language, timeZone } = options;
  const currentDateTime = now.toLocaleString('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const dayOfWeek = now.toLocaleString('default', {
    weekday: 'long',
    timeZone,
  });
  const month = now.toLocaleString('default', {
    month: 'long',
    timeZone,
  });
  const year = parseInt(
    now.toLocaleString('en-CA', { year: 'numeric', timeZone }),
    10,
  );
  const monthIndex =
    parseInt(now.toLocaleString('en-CA', { month: 'numeric', timeZone }), 10) -
    1;

  return {
    timeZone,
    language,
    currentDateTime,
    dateKey: now.toLocaleDateString('en-CA', { timeZone }),
    dayOfWeek,
    month,
    year,
    season: getSeason(monthIndex),
    timestamp: now.getTime(),
  };
}

function buildEnvironmentBlock(snapshot: EnvironmentSnapshot): string {
  return `TimeZone is always in ${snapshot.timeZone}.

Current Date & Time: "${snapshot.currentDateTime}"
Day of Week: ${snapshot.dayOfWeek}
Month: ${snapshot.month}
Year: ${snapshot.year}
Timestamp: ${snapshot.timestamp}
Language: ${snapshot.language}
Season: ${snapshot.season}`;
}

function formatChange(
  previous: EnvironmentSnapshot,
  current: EnvironmentSnapshot,
): string[] {
  const changes: string[] = [];

  if (previous.timeZone !== current.timeZone) {
    changes.push(`time zone: ${previous.timeZone} -> ${current.timeZone}`);
  }
  if (previous.language !== current.language) {
    changes.push(`language: ${previous.language} -> ${current.language}`);
  }
  if (previous.dateKey !== current.dateKey) {
    changes.push(`date: ${previous.dateKey} -> ${current.dateKey}`);
  }
  if (previous.dayOfWeek !== current.dayOfWeek) {
    changes.push(`day of week: ${previous.dayOfWeek} -> ${current.dayOfWeek}`);
  }
  if (previous.month !== current.month) {
    changes.push(`month: ${previous.month} -> ${current.month}`);
  }
  if (previous.year !== current.year) {
    changes.push(`year: ${previous.year} -> ${current.year}`);
  }
  if (previous.season !== current.season) {
    changes.push(`season: ${previous.season} -> ${current.season}`);
  }

  return changes;
}

function buildChangeSummary(
  previous: EnvironmentSnapshot | null,
  current: EnvironmentSnapshot,
): string {
  if (!previous) {
    return '';
  }

  const changes = formatChange(previous, current);
  if (changes.length === 0) {
    return '';
  }

  return `Changes since last environment snapshot:
- ${changes.join('\n- ')}

`;
}

function parseEnvironmentSnapshot(value: unknown): EnvironmentSnapshot | null {
  if (!isRecord(value)) {
    return null;
  }

  if (
    typeof value.timeZone !== 'string' ||
    typeof value.language !== 'string' ||
    typeof value.currentDateTime !== 'string' ||
    typeof value.dateKey !== 'string' ||
    typeof value.dayOfWeek !== 'string' ||
    typeof value.month !== 'string' ||
    typeof value.year !== 'number' ||
    typeof value.season !== 'string' ||
    typeof value.timestamp !== 'number'
  ) {
    return null;
  }

  return {
    timeZone: value.timeZone,
    language: value.language,
    currentDateTime: value.currentDateTime,
    dateKey: value.dateKey,
    dayOfWeek: value.dayOfWeek,
    month: value.month,
    year: value.year,
    season: value.season,
    timestamp: value.timestamp,
  };
}

export function getEnvironmentSnapshot(
  message: UIMessage | undefined,
): EnvironmentSnapshot | null {
  const metadata = isRecord(message?.metadata) ? message.metadata : null;
  if (!metadata) {
    return null;
  }

  const stored = metadata[ENVIRONMENT_REMINDER_METADATA_KEY];
  if (!isRecord(stored) || stored.version !== 1) {
    return null;
  }

  return parseEnvironmentSnapshot(stored.snapshot);
}

export function environmentReminder(
  options?: EnvironmentReminderOptions,
): ContextFragment {
  const getNow = options?.getNow ?? (() => new Date());
  const language = options?.language ?? 'English (US)';
  const timeZone = options?.timeZone ?? 'UTC';

  return reminder(
    (ctx) => {
      const snapshot = buildEnvironmentSnapshot(getNow(), {
        language,
        timeZone,
      });
      const previousSnapshot = getEnvironmentSnapshot(ctx.lastMessage);
      const summary = buildChangeSummary(previousSnapshot, snapshot);

      return {
        text: `${summary}${buildEnvironmentBlock(snapshot)}`,
        metadata: {
          [ENVIRONMENT_REMINDER_METADATA_KEY]: {
            version: 1,
            snapshot,
          } satisfies EnvironmentReminderMetadata,
        },
      };
    },
    { when: everyNTurns(1) },
  );
}
