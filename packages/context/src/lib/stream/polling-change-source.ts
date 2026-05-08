import { setTimeout as delay } from 'node:timers/promises';

import type { StreamChange, StreamChangeSource } from './change-source.ts';
import {
  DEFAULT_WATCH_POLLING,
  type WatchPollingConfig,
  createAdaptivePollingState,
  nextAdaptivePollingDelay,
  normalizeWatchPolling,
  resetAdaptivePolling,
} from './polling-policy.ts';
import type { StreamStatus } from './stream-store.ts';

export type PollingTelemetryEvent =
  | {
      type: 'poll';
      streamId: string;
      delayMs: number;
      status: StreamStatus | 'missing';
    }
  | {
      type: 'idle';
      streamId: string;
      delayMs: number;
    };

export interface PollingChangeSourceReads {
  getStreamStatus(streamId: string): Promise<StreamStatus | undefined>;
}

export interface PollingChangeSourceOptions {
  reads: PollingChangeSourceReads;
  config?: Partial<WatchPollingConfig>;
  onPoll?: (event: PollingTelemetryEvent) => void;
}

export class PollingChangeSource implements StreamChangeSource {
  #reads: PollingChangeSourceReads;
  #config: WatchPollingConfig;
  #onPoll?: (event: PollingTelemetryEvent) => void;

  constructor(options: PollingChangeSourceOptions) {
    this.#reads = options.reads;
    this.#config = normalizeWatchPolling(options.config, DEFAULT_WATCH_POLLING);
    this.#onPoll = options.onPoll;
  }

  async *subscribe(
    streamId: string,
    signal: AbortSignal,
  ): AsyncIterable<StreamChange> {
    const initialStatus = await this.#reads.getStreamStatus(streamId);
    if (initialStatus === undefined) {
      throw new Error(`Stream "${streamId}" not found`);
    }

    yield { kind: 'tick' };

    if (isTerminal(initialStatus)) return;

    const delayState = createAdaptivePollingState(this.#config);
    let pollsSinceStatus = 0;
    let lastStatus: StreamStatus = initialStatus;

    while (!signal.aborted) {
      const delayMs = nextAdaptivePollingDelay(delayState);
      this.#emit({ type: 'idle', streamId, delayMs });

      if (!(await waitForDelay(delayMs, signal))) return;

      pollsSinceStatus += 1;
      const shouldCheckStatus =
        pollsSinceStatus >= this.#config.statusCheckEvery;

      if (!shouldCheckStatus) {
        yield { kind: 'chunks' };
        continue;
      }

      pollsSinceStatus = 0;
      const status = await this.#reads.getStreamStatus(streamId);
      this.#emit({
        type: 'poll',
        streamId,
        delayMs,
        status: status ?? 'missing',
      });

      if (status === undefined) {
        yield { kind: 'status' };
        return;
      }

      if (status === 'running' && lastStatus !== 'running') {
        resetAdaptivePolling(delayState);
      }
      lastStatus = status;

      if (isTerminal(status)) {
        yield { kind: 'status' };
        return;
      }

      yield { kind: 'tick' };
    }
  }

  #emit(event: PollingTelemetryEvent): void {
    if (!this.#onPoll) return;
    try {
      this.#onPoll(event);
    } catch {
      // swallow telemetry errors — polling must not be coupled to observer faults
    }
  }
}

function isTerminal(status: StreamStatus): boolean {
  return status !== 'queued' && status !== 'running';
}

function waitForDelay(ms: number, signal: AbortSignal): Promise<boolean> {
  return delay(ms, true, { signal }).catch((err: unknown) => {
    if (signal.aborted) return false;
    throw err;
  });
}
