import type { OpenAISpan, OpenAITrace, TraceItem } from './types.ts';

export interface TracingExporter {
  export(items: TraceItem[], signal?: AbortSignal): Promise<void>;
}

export interface TracingProcessor {
  start?(): Promise<void> | void;
  onTraceStart?(trace: OpenAITrace): Promise<void> | void;
  onTraceEnd?(trace: OpenAITrace): Promise<void> | void;
  onSpanStart?(span: OpenAISpan): Promise<void> | void;
  onSpanEnd?(span: OpenAISpan): Promise<void> | void;
  forceFlush?(): Promise<void> | void;
  shutdown?(): Promise<void> | void;
}

export class CompositeTraceProcessor implements TracingProcessor {
  readonly #processors: TracingProcessor[];

  constructor(processors: TracingProcessor[]) {
    this.#processors = processors.filter(Boolean);
  }

  async start(): Promise<void> {
    for (const processor of this.#processors) {
      await processor.start?.();
    }
  }

  async onTraceStart(trace: OpenAITrace): Promise<void> {
    for (const processor of this.#processors) {
      await processor.onTraceStart?.(trace);
    }
  }

  async onTraceEnd(trace: OpenAITrace): Promise<void> {
    for (const processor of this.#processors) {
      await processor.onTraceEnd?.(trace);
    }
  }

  async onSpanStart(span: OpenAISpan): Promise<void> {
    for (const processor of this.#processors) {
      await processor.onSpanStart?.(span);
    }
  }

  async onSpanEnd(span: OpenAISpan): Promise<void> {
    for (const processor of this.#processors) {
      await processor.onSpanEnd?.(span);
    }
  }

  async forceFlush(): Promise<void> {
    for (const processor of this.#processors) {
      await processor.forceFlush?.();
    }
  }

  async shutdown(): Promise<void> {
    for (const processor of this.#processors) {
      await processor.shutdown?.();
    }
  }
}

export function createTracingProcessor(
  processors: TracingProcessor | TracingProcessor[] | undefined,
): TracingProcessor | undefined {
  if (processors == null) {
    return undefined;
  }

  const list = Array.isArray(processors) ? processors : [processors];
  if (list.length === 0) {
    return undefined;
  }

  return list.length === 1 ? list[0] : new CompositeTraceProcessor(list);
}
