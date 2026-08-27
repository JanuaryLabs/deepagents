import type { UIMessage } from 'ai';
import { get } from 'lodash-es';
import { useMemo } from 'react';

import {
  formatCompactNumber,
  formatNullableNumber,
} from '@deepagents/react-formatters';

import { useAgentMessages } from './agent-context.tsx';

export type UsageDisplay = {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cachedInputTokens: number | null;
  totalTokens: number | null;
};

type UsageTracking = {
  assistantUsageByMessageId: Record<string, UsageDisplay>;
  chatUsageSummary: UsageDisplay | null;
};

const TOKEN_FIELDS: (keyof UsageDisplay)[] = [
  'inputTokens',
  'outputTokens',
  'reasoningTokens',
  'cachedInputTokens',
  'totalTokens',
];

const USAGE_FIELD_PATHS: Record<keyof UsageDisplay, string[][]> = {
  inputTokens: [['inputTokens'], ['raw', 'prompt_tokens']],
  outputTokens: [['outputTokens'], ['raw', 'completion_tokens']],
  reasoningTokens: [
    ['reasoningTokens'],
    ['outputTokenDetails', 'reasoningTokens'],
    ['raw', 'completion_tokens_details', 'reasoning_tokens'],
  ],
  cachedInputTokens: [
    // AI SDK v7 renamed this to `cacheReadTokens` and deleted the flat
    // `cachedInputTokens`. The older paths stay for chats persisted under v6.
    ['inputTokenDetails', 'cacheReadTokens'],
    ['cachedInputTokens'],
    ['inputTokenDetails', 'cachedTokens'],
    ['raw', 'prompt_tokens_details', 'cached_tokens'],
  ],
  totalTokens: [['totalTokens'], ['raw', 'total_tokens']],
};

function toFiniteToken(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }

  return null;
}

export function parseUsage(source: unknown): UsageDisplay | null {
  if (!source || typeof source !== 'object') return null;

  const parsed: UsageDisplay = {
    inputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    cachedInputTokens: null,
    totalTokens: null,
  };

  for (const field of TOKEN_FIELDS) {
    for (const path of USAGE_FIELD_PATHS[field]) {
      const token = toFiniteToken(get(source, path));
      if (token !== null) {
        parsed[field] = token;
        break;
      }
    }
  }

  return TOKEN_FIELDS.some((field) => parsed[field] !== null) ? parsed : null;
}

export function parseMetadataUsage(metadata: unknown): UsageDisplay | null {
  if (!metadata || typeof metadata !== 'object') return null;

  const record = metadata as Record<string, unknown>;

  return parseUsage(record.totalUsage ?? record.usage);
}

function diffUsage(
  current: UsageDisplay,
  previous: UsageDisplay | null,
): UsageDisplay | null {
  const diff: UsageDisplay = {
    inputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    cachedInputTokens: null,
    totalTokens: null,
  };

  for (const field of TOKEN_FIELDS) {
    const currentValue = current[field];
    if (currentValue === null) continue;

    if (!previous) {
      diff[field] = currentValue;
      continue;
    }

    const previousValue = previous[field];
    if (previousValue === null) continue;

    const delta = currentValue - previousValue;
    if (delta >= 0) {
      diff[field] = delta;
    }
  }

  return TOKEN_FIELDS.some((field) => diff[field] !== null) ? diff : null;
}

function sumUsage(usages: UsageDisplay[]): UsageDisplay | null {
  if (usages.length === 0) return null;

  const summed: UsageDisplay = {
    inputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    cachedInputTokens: null,
    totalTokens: null,
  };

  for (const field of TOKEN_FIELDS) {
    let fieldSum = 0;
    let hasValue = false;
    for (const usage of usages) {
      const value = usage[field];
      if (value === null) continue;
      fieldSum += value;
      hasValue = true;
    }

    if (hasValue) {
      summed[field] = fieldSum;
    }
  }

  return TOKEN_FIELDS.some((field) => summed[field] !== null) ? summed : null;
}

function computeUsageTracking(messages: UIMessage[]): UsageTracking {
  const assistantUsageByMessageId: Record<string, UsageDisplay> = {};
  const messageUsages: UsageDisplay[] = [];
  let previousCumulativeUsage: UsageDisplay | null = null;
  let latestCumulativeUsage: UsageDisplay | null = null;

  for (const message of messages) {
    if (message.role !== 'assistant') continue;

    const metadata = message.metadata as Record<string, unknown> | undefined;

    const usage = parseUsage(metadata?.usage);
    const totalUsage = parseUsage(metadata?.totalUsage);
    const perMessageUsage =
      usage ??
      (totalUsage ? diffUsage(totalUsage, previousCumulativeUsage) : null);

    if (perMessageUsage) {
      assistantUsageByMessageId[message.id] = perMessageUsage;
      messageUsages.push(perMessageUsage);
    }

    if (totalUsage) {
      latestCumulativeUsage = totalUsage;
      previousCumulativeUsage = totalUsage;
    }
  }

  return {
    assistantUsageByMessageId,
    chatUsageSummary: latestCumulativeUsage ?? sumUsage(messageUsages),
  };
}

export function useNormalizedUsageTracking(): UsageTracking {
  const agent = useAgentMessages();

  return useMemo(() => {
    return computeUsageTracking(agent.messages);
  }, [agent.messages]);
}

export function formatUsageValue(value: number | null): string {
  return formatNullableNumber(value);
}

export function formatUsageBreakdown(usage: UsageDisplay): string {
  const parts = [
    `↑ ${formatCompactNumber(usage.inputTokens)}`,
    `↓ ${formatCompactNumber(usage.outputTokens)}`,
  ];

  if (usage.totalTokens !== null) {
    parts.push(`· ${usage.totalTokens.toLocaleString()} tokens`);
  }

  if (usage.cachedInputTokens !== null && usage.cachedInputTokens > 0) {
    parts.push(`(${formatCompactNumber(usage.cachedInputTokens)} cached)`);
  }

  return parts.join(' ');
}
