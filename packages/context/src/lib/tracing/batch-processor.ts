import type { TracingExporter, TracingProcessor } from './processor.ts';
import type { OpenAISpan, OpenAITrace, TraceItem } from './types.ts';

export interface BatchTraceProcessorOptions {
  maxQueueSize?: number;
  maxBatchSize?: number;
  scheduleDelayMs?: number;
  exportTriggerRatio?: number;
  exportTimeoutMs?: number;
}

export class BatchTraceProcessor implements TracingProcessor {
  readonly #exporter: TracingExporter;
  readonly #maxQueueSize: number;
  readonly #maxBatchSize: number;
  readonly #scheduleDelayMs: number;
  readonly #exportTimeoutMs: number;
  readonly #flushThreshold: number;

  #queue: TraceItem[] = [];
  #flushTimer?: NodeJS.Timeout;
  #flushPromise?: Promise<void>;
  #shutdown = false;

  constructor(
    exporter: TracingExporter,
    options: BatchTraceProcessorOptions = {},
  ) {
    this.#exporter = exporter;
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
    if (this.#shutdown || this.#flushTimer != null) {
      return;
    }

    this.#flushTimer = setInterval(() => {
      void this.forceFlush();
    }, this.#scheduleDelayMs);
    this.#flushTimer.unref?.();
  }

  onTraceEnd(trace: OpenAITrace): void {
    this.#enqueue(trace);
  }

  onSpanEnd(span: OpenAISpan): void {
    this.#enqueue(span);
  }

  async forceFlush(): Promise<void> {
    if (this.#flushPromise != null) {
      await this.#flushPromise;
      return;
    }

    if (this.#queue.length === 0) {
      return;
    }

    this.#flushPromise = this.#flush();

    try {
      await this.#flushPromise;
    } finally {
      this.#flushPromise = undefined;
    }
  }

  async shutdown(): Promise<void> {
    this.#shutdown = true;

    if (this.#flushTimer != null) {
      clearInterval(this.#flushTimer);
      this.#flushTimer = undefined;
    }

    await this.forceFlush();
  }

  #enqueue(item: TraceItem): void {
    if (this.#queue.length >= this.#maxQueueSize) {
      return;
    }

    this.#queue.push(item);

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
