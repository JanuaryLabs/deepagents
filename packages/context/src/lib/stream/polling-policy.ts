export interface AdaptivePollingConfig {
  minMs: number;
  maxMs: number;
  multiplier: number;
  jitterRatio: number;
}

export interface WatchPollingConfig extends AdaptivePollingConfig {
  statusCheckEvery: number;
  chunkPageSize: number;
}

export type CancelPollingConfig = AdaptivePollingConfig;

export interface AdaptivePollingState {
  config: AdaptivePollingConfig;
  currentMs: number;
}

export const DEFAULT_WATCH_POLLING: WatchPollingConfig = {
  minMs: 25,
  maxMs: 500,
  multiplier: 2,
  jitterRatio: 0.15,
  statusCheckEvery: 3,
  chunkPageSize: 128,
};

export const DEFAULT_CANCEL_POLLING: CancelPollingConfig = {
  minMs: 50,
  maxMs: 500,
  multiplier: 2,
  jitterRatio: 0.15,
};

export function normalizeWatchPolling(
  polling: Partial<WatchPollingConfig> | undefined,
  fallback: WatchPollingConfig = DEFAULT_WATCH_POLLING,
): WatchPollingConfig {
  const merged: WatchPollingConfig = {
    ...fallback,
    ...polling,
  };
  const normalizedBase = normalizeAdaptivePolling(merged, fallback);
  return {
    ...normalizedBase,
    statusCheckEvery: clampInt(merged.statusCheckEvery, 1, 10_000),
    chunkPageSize: clampInt(merged.chunkPageSize, 1, 10_000),
  };
}

export function normalizeCancelPolling(
  polling: Partial<CancelPollingConfig> | undefined,
  fallback: CancelPollingConfig = DEFAULT_CANCEL_POLLING,
): CancelPollingConfig {
  return normalizeAdaptivePolling(polling, fallback);
}

export function createAdaptivePollingState(
  config: AdaptivePollingConfig,
): AdaptivePollingState {
  return {
    config,
    currentMs: config.minMs,
  };
}

export function resetAdaptivePolling(state: AdaptivePollingState): void {
  state.currentMs = state.config.minMs;
}

export function nextAdaptivePollingDelay(state: AdaptivePollingState): number {
  const current = clampInt(
    state.currentMs,
    state.config.minMs,
    state.config.maxMs,
  );
  const delay = applyJitter(
    current,
    state.config.jitterRatio,
    state.config.minMs,
    state.config.maxMs,
  );
  state.currentMs = clampInt(
    Math.ceil(current * state.config.multiplier),
    state.config.minMs,
    state.config.maxMs,
  );
  return delay;
}

function normalizeAdaptivePolling(
  polling: Partial<AdaptivePollingConfig> | AdaptivePollingConfig | undefined,
  fallback: AdaptivePollingConfig,
): AdaptivePollingConfig {
  const merged: AdaptivePollingConfig = {
    ...fallback,
    ...polling,
  };
  const minMs = clampInt(merged.minMs, 1, 60_000);
  const maxMs = clampInt(merged.maxMs, minMs, 60_000);
  return {
    minMs,
    maxMs,
    multiplier: clampFloat(merged.multiplier, 1, 10),
    jitterRatio: clampFloat(merged.jitterRatio, 0, 1),
  };
}

function applyJitter(
  value: number,
  jitterRatio: number,
  min: number,
  max: number,
): number {
  if (jitterRatio <= 0) return value;
  const radius = value * jitterRatio;
  const lowerBound = Math.max(0, value - radius);
  const upperBound = value + radius;
  const jittered = Math.round(
    lowerBound + Math.random() * (upperBound - lowerBound),
  );
  return clampInt(jittered, min, max);
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function clampFloat(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
