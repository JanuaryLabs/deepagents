import { Backoff } from '@zukhruf/async';
import { setTimeout as delay } from 'node:timers/promises';

import type { StreamChange, StreamChangeSource } from './change-source.ts';
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
  /** The wait before each poll. The default is 25 ms, doubled up to 500 ms, ±15 %. */
  backoff?: Backoff;
  /** Reads the stream status every this many polls. A positive integer; the default is 3. */
  statusCheckEvery?: number;
  onPoll?: (event: PollingTelemetryEvent) => void;
}

export class PollingChangeSource implements StreamChangeSource {
  #reads: PollingChangeSourceReads;
  #backoff: Backoff;
  #statusCheckEvery: number;
  #onPoll?: (event: PollingTelemetryEvent) => void;

  constructor(options: PollingChangeSourceOptions) {
    const statusCheckEvery = options.statusCheckEvery ?? 3;
    if (!(Number.isInteger(statusCheckEvery) && statusCheckEvery >= 1))
      throw new RangeError(
        `statusCheckEvery must be a positive integer, not ${statusCheckEvery}`,
      );
    this.#reads = options.reads;
    this.#backoff =
      options.backoff ??
      new Backoff({
        initial: 25,
        multiplier: 2,
        max: 500,
        jitter: { kind: 'ratio', ratio: 0.15 },
      });
    this.#statusCheckEvery = statusCheckEvery;
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

    let retries = 0;
    let pollsSinceStatus = 0;
    let lastStatus: StreamStatus = initialStatus;

    while (!signal.aborted) {
      const delayMs = this.#backoff.duration(retries++);
      this.#emit({ type: 'idle', streamId, delayMs });

      if (!(await waitForDelay(delayMs, signal))) return;

      pollsSinceStatus += 1;
      const shouldCheckStatus = pollsSinceStatus >= this.#statusCheckEvery;

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
        retries = 0;
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
