import pMemoize from 'p-memoize';

import type { TracingExporter, TracingProcessor } from './processor.ts';
import type { OpenAISpan, OpenAITrace, TraceItem } from './types.ts';

/** An entry gives `globalThis`; a test gives `createClock()`. */
export interface BatchTraceClock {
  setInterval(callback: () => void, ms: number): number | object;
  clearInterval(timer: unknown): void;
}

export interface BatchTraceProcessorOptions {
  clock: BatchTraceClock;
  maxQueueSize?: number;
  maxBatchSize?: number;
  scheduleDelayMs?: number;
  exportTriggerRatio?: number;
  exportTimeoutMs?: number;
}

/** A phase of the processor: each phase decides what start, stop and an ended item do. */
interface BatchPhase {
  start(clock: BatchTraceClock, delayMs: number, tick: () => void): BatchPhase;
  stop(): BatchPhase;
  /** Adds an ended item to the queue, unless this phase takes no more items. */
  admit(queue: TraceItem[], item: TraceItem): void;
}

/** After shutdown(): items that end later are dropped, as OpenTelemetry's batch processor does. */
class ShutDown implements BatchPhase {
  start(): BatchPhase {
    return this;
  }

  stop(): BatchPhase {
    return this;
  }

  admit(): void {}
}

const SHUT_DOWN = new ShutDown();

/** After start(): a timer flushes the queue on the schedule. */
class Running implements BatchPhase {
  readonly #clock: BatchTraceClock;
  readonly #timer: unknown;

  constructor(clock: BatchTraceClock, delayMs: number, tick: () => void) {
    const timer = clock.setInterval(tick, delayMs);
    if (
      typeof timer === 'object' &&
      'unref' in timer &&
      typeof timer.unref === 'function'
    ) {
      timer.unref();
    }
    this.#clock = clock;
    this.#timer = timer;
  }

  start(): BatchPhase {
    return this;
  }

  stop(): BatchPhase {
    this.#clock.clearInterval(this.#timer);
    return SHUT_DOWN;
  }

  admit(queue: TraceItem[], item: TraceItem): void {
    queue.push(item);
  }
}

/** Before start(): items queue, and only a full queue or forceFlush() exports them. */
class Idle implements BatchPhase {
  start(clock: BatchTraceClock, delayMs: number, tick: () => void): BatchPhase {
    return new Running(clock, delayMs, tick);
  }

  stop(): BatchPhase {
    return SHUT_DOWN;
  }

  admit(queue: TraceItem[], item: TraceItem): void {
    queue.push(item);
  }
}

export class BatchTraceProcessor implements TracingProcessor {
  readonly #exporter: TracingExporter;
  readonly #clock: BatchTraceClock;
  readonly #maxQueueSize: number;
  readonly #maxBatchSize: number;
  readonly #scheduleDelayMs: number;
  readonly #exportTimeoutMs: number;
  readonly #flushThreshold: number;

  readonly #queue: TraceItem[] = [];
  #phase: BatchPhase = new Idle();
  /** Joins a flush in flight; a call after it settles starts the next one. */
  readonly #flushOnce = pMemoize(() => this.#flush(), { cache: false });

  constructor(exporter: TracingExporter, options: BatchTraceProcessorOptions) {
    this.#exporter = exporter;
    this.#clock = options.clock;
    this.#maxQueueSize = options.maxQueueSize ?? 8192;
    this.#maxBatchSize = options.maxBatchSize ?? 128;
    this.#scheduleDelayMs = options.scheduleDelayMs ?? 5000;
    this.#exportTimeoutMs = options.exportTimeoutMs ?? 30000;
    this.#flushThreshold = Math.max(
      1,
      Math.floor(this.#maxQueueSize * (options.exportTriggerRatio ?? 0.7)),
    );
  }

  start(): void {
    this.#phase = this.#phase.start(this.#clock, this.#scheduleDelayMs, () => {
      void this.forceFlush();
    });
  }

  onTraceEnd(trace: OpenAITrace): void {
    this.#enqueue(trace);
  }

  onSpanEnd(span: OpenAISpan): void {
    this.#enqueue(span);
  }

  forceFlush(): Promise<void> {
    return this.#flushOnce();
  }

  async shutdown(): Promise<void> {
    this.#phase = this.#phase.stop();
    await this.forceFlush();
  }

  #enqueue(item: TraceItem): void {
    if (this.#queue.length >= this.#maxQueueSize) {
      return;
    }

    this.#phase.admit(this.#queue, item);

    if (this.#queue.length >= this.#flushThreshold) {
      void this.forceFlush();
    }
  }

  async #flush(): Promise<void> {
    while (this.#queue.length > 0) {
      const batch = this.#queue.slice(0, this.#maxBatchSize);
      await this.#exporter.export(
        batch,
        AbortSignal.timeout(this.#exportTimeoutMs),
      );
      this.#queue.splice(0, batch.length);
    }
  }
}
