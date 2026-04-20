import type { LanguageModelUsage } from 'ai';

import type { GenerationUsageData, OpenAISpanError } from './types.ts';

export function normalizeForJson(value: unknown): unknown {
  if (value == null) {
    return value;
  }

  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Error) {
    return errorToSpanError(value);
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeForJson(item))
      .filter((item) => item !== undefined);
  }

  if (typeof value === 'object') {
    const normalized: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>,
    )) {
      const result = normalizeForJson(entry);
      if (result !== undefined) {
        normalized[key] = result;
      }
    }
    return normalized;
  }

  return String(value);
}

export function normalizeRecordArray(
  value: unknown,
): Record<string, unknown>[] | undefined {
  const normalized = normalizeForJson(value);
  if (!Array.isArray(normalized)) {
    return undefined;
  }

  return normalized.map((item) =>
    typeof item === 'object' && item != null
      ? (item as Record<string, unknown>)
      : { value: item },
  );
}

export function normalizeUsage(
  usage: LanguageModelUsage | undefined,
): GenerationUsageData | undefined {
  if (usage == null) {
    return undefined;
  }

  const details: Record<string, unknown> = {};

  if (hasDefinedValue(usage.inputTokenDetails)) {
    details.input_token_details = normalizeForJson({
      no_cache_tokens: usage.inputTokenDetails.noCacheTokens,
      cache_read_tokens: usage.inputTokenDetails.cacheReadTokens,
      cache_write_tokens: usage.inputTokenDetails.cacheWriteTokens,
    });
  }

  if (hasDefinedValue(usage.outputTokenDetails)) {
    details.output_token_details = normalizeForJson({
      text_tokens: usage.outputTokenDetails.textTokens,
      reasoning_tokens: usage.outputTokenDetails.reasoningTokens,
    });
  }

  if (usage.raw != null) {
    details.raw = normalizeForJson(usage.raw);
  }

  if (usage.reasoningTokens !== undefined) {
    details.reasoning_tokens = usage.reasoningTokens;
  }

  if (usage.cachedInputTokens !== undefined) {
    details.cached_input_tokens = usage.cachedInputTokens;
  }

  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    ...(Object.keys(details).length > 0 ? { details } : {}),
  };
}

export function errorToSpanError(error: unknown): OpenAISpanError {
  if (error instanceof Error) {
    const data = normalizeForJson({
      name: error.name,
      stack: error.stack,
      cause: error.cause,
    }) as Record<string, unknown>;

    return {
      message: error.message,
      ...(Object.keys(data).length > 0 ? { data } : {}),
    };
  }

  return {
    message: String(error),
  };
}

function hasDefinedValue(value: Record<string, unknown> | undefined): boolean {
  if (value == null) {
    return false;
  }

  return Object.values(value).some((entry) => entry !== undefined);
}
