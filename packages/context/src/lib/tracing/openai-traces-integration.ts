import type {
  GenerateTextEndEvent,
  GenerateTextStartEvent,
  Telemetry,
} from 'ai';

import {
  type BatchTraceClock,
  BatchTraceProcessor,
  type BatchTraceProcessorOptions,
} from './batch-processor.ts';
import { OpenAITracesExporter } from './exporter.ts';
import { spanId, traceId } from './ids.ts';
import { type TracingProcessor, createTracingProcessor } from './processor.ts';
import {
  errorToSpanError,
  normalizeForJson,
  normalizeObjectForJson,
  normalizeRecordArray,
  normalizeUsage,
} from './serialization.ts';
import type {
  AgentSpanData,
  FunctionSpanData,
  GenerationSpanData,
  OpenAISpan,
  OpenAISpanError,
  OpenAITrace,
} from './types.ts';

interface TraceRunState {
  callId: string;
  trace: OpenAITrace;
  rootSpan: OpenAISpan;
  stepSpans: string[];
  spansById: Map<string, OpenAISpan>;
  toolCallSpans: Map<string, string>;
}

interface GenerationErrorEvent {
  callId: string;
  error: unknown;
}

export interface OpenAITracesIntegrationOptions {
  /** An entry gives `globalThis`; a test gives `createClock()`. */
  clock: BatchTraceClock & { Date: { now(): number } };
  apiKey?: string | (() => string | Promise<string>);
  baseURL?: string;
  endpoint?: string;
  organization?: string;
  project?: string;
  workflowName?: string;
  groupId?: string;
  metadata?: Record<string, unknown>;
  exporter?: OpenAITracesExporter;
  processor?: TracingProcessor | TracingProcessor[];
  batch?: Omit<BatchTraceProcessorOptions, 'clock'>;
  includeSensitiveData?: boolean;
}

export function createOpenAITracesIntegration(
  options: OpenAITracesIntegrationOptions,
): Telemetry {
  if (process.env.OPENAI_AGENTS_DISABLE_TRACING === '1') {
    return {};
  }

  const exporter =
    options.exporter ??
    new OpenAITracesExporter({
      clock: options.clock,
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      endpoint: options.endpoint,
      organization: options.organization,
      project: options.project,
    });

  const processor: TracingProcessor =
    createTracingProcessor(options.processor) ??
    new BatchTraceProcessor(exporter, {
      ...options.batch,
      clock: options.clock,
    });

  const now = () => new Date(options.clock.Date.now()).toISOString();
  const includeSensitive =
    options.includeSensitiveData ??
    process.env.OPENAI_AGENTS_TRACE_INCLUDE_SENSITIVE_DATA !== '0';
  const runs = new Map<string, TraceRunState>();

  void processor.start?.();

  const integration: Telemetry = {
    onStart: async (event) => {
      if (!isGenerateTextStartEvent(event)) {
        return;
      }

      const trace: OpenAITrace = {
        object: 'trace',
        id: traceId(),
        workflow_name:
          options.workflowName ?? event.functionId ?? 'ai-sdk-workflow',
        group_id: options.groupId ?? null,
        metadata: normalizeMetadata({
          ...options.metadata,
        }),
      };

      const rootSpan: OpenAISpan = {
        object: 'trace.span',
        id: spanId(),
        trace_id: trace.id,
        parent_id: null,
        started_at: now(),
        span_data: {
          type: 'agent',
          name: trace.workflow_name,
          tools: event.tools ? Object.keys(event.tools) : undefined,
          output_type: getOutputType(event.output),
        } satisfies AgentSpanData,
      };

      const state: TraceRunState = {
        callId: event.callId,
        trace,
        rootSpan,
        stepSpans: [],
        spansById: new Map([[rootSpan.id, rootSpan]]),
        toolCallSpans: new Map(),
      };

      runs.set(event.callId, state);

      await processor.onTraceStart?.(trace);
      await processor.onSpanStart?.(rootSpan);
    },

    onStepStart: async (event) => {
      const state = runs.get(event.callId);
      if (state == null) {
        return;
      }

      const span: OpenAISpan = {
        object: 'trace.span',
        id: spanId(),
        trace_id: state.trace.id,
        parent_id: currentParentId(state),
        started_at: now(),
        span_data: {
          type: 'generation',
          model: event.modelId,
          model_config: normalizeMetadata({
            provider: event.provider,
            tool_choice: event.toolChoice,
            active_tools: event.activeTools,
            provider_options: event.providerOptions,
          }),
          ...(includeSensitive && event.recordInputs !== false
            ? { input: normalizeRecordArray(event.messages) }
            : {}),
        } satisfies GenerationSpanData,
      };

      state.stepSpans.push(span.id);
      state.spansById.set(span.id, span);

      await processor.onSpanStart?.(span);
    },

    onToolExecutionStart: async (event) => {
      const state = runs.get(event.callId);
      if (state == null) {
        return;
      }

      const span: OpenAISpan = {
        object: 'trace.span',
        id: spanId(),
        trace_id: state.trace.id,
        parent_id: currentParentId(state),
        started_at: now(),
        span_data: {
          type: 'function',
          name: event.toolCall.toolName,
          ...(includeSensitive && event.recordInputs !== false
            ? {
                input: normalizeForJson(event.toolCall.input),
              }
            : {}),
        } satisfies FunctionSpanData,
      };

      state.toolCallSpans.set(event.toolCall.toolCallId, span.id);
      state.spansById.set(span.id, span);

      await processor.onSpanStart?.(span);
    },

    onToolExecutionEnd: async (event) => {
      const state = runs.get(event.callId);
      if (state == null) {
        return;
      }

      const id = state.toolCallSpans.get(event.toolCall.toolCallId);
      if (id == null) {
        return;
      }

      state.toolCallSpans.delete(event.toolCall.toolCallId);

      const span = state.spansById.get(id);
      if (span == null) {
        return;
      }

      span.ended_at = now();

      const data = span.span_data;
      if (event.toolOutput.type === 'tool-result') {
        if (
          data.type === 'function' &&
          includeSensitive &&
          event.recordOutputs !== false
        ) {
          data.output = normalizeForJson(event.toolOutput.output);
        }
      } else {
        span.error = errorToSpanError(event.toolOutput.error);
      }

      await processor.onSpanEnd?.(span);
    },

    onStepEnd: async (event) => {
      const state = runs.get(event.callId);
      if (state == null) {
        return;
      }

      const id = state.stepSpans.pop();
      if (id == null) {
        return;
      }

      const span = state.spansById.get(id);
      if (span == null) {
        return;
      }

      span.ended_at = now();

      const data = span.span_data;
      if (data.type === 'generation') {
        if (includeSensitive && event.recordOutputs !== false) {
          data.output = normalizeRecordArray(event.response.messages);
        }
        data.usage = normalizeUsage(event.usage);
      }
      await processor.onSpanEnd?.(span);
    },

    onEnd: async (event) => {
      if (!isGenerateTextEndEvent(event)) {
        return;
      }

      const state = runs.get(event.callId);
      if (state == null) {
        return;
      }

      state.trace.metadata = normalizeMetadata({
        ...state.trace.metadata,
        total_usage: normalizeUsage(event.usage),
        steps: event.steps.length,
        finish_reason: event.finishReason,
      });
      await endRun(state);
    },

    onStepError: async (event) => {
      const state = runs.get(event.callId);
      const id = state?.stepSpans.pop();
      const span = id == null ? undefined : state?.spansById.get(id);
      if (span == null) {
        return;
      }

      span.ended_at = now();
      span.error = errorToSpanError(event.error);
      await processor.onSpanEnd?.(span);
    },

    onAbort: async (event) => {
      const state = runs.get(event.callId);
      if (state == null) {
        return;
      }

      await endRun(
        state,
        event.reason === undefined
          ? { message: 'Aborted' }
          : errorToSpanError(event.reason),
      );
    },

    onError: async (event) => {
      if (!isGenerationErrorEvent(event)) {
        return;
      }

      const state = runs.get(event.callId);
      if (state == null) {
        return;
      }

      await endRun(state, errorToSpanError(event.error));
    },
  };

  return integration;

  async function endRun(
    state: TraceRunState,
    error?: OpenAISpanError,
  ): Promise<void> {
    try {
      const openSpanIds = [
        ...state.toolCallSpans.values(),
        ...state.stepSpans.toReversed(),
      ];
      for (const id of openSpanIds) {
        const span = state.spansById.get(id);
        if (span == null || span.ended_at != null) {
          continue;
        }

        span.ended_at = now();
        if (error != null) {
          span.error = error;
        }
        await processor.onSpanEnd?.(span);
      }

      state.rootSpan.ended_at = now();
      if (error != null) {
        state.rootSpan.error = error;
      }
      await processor.onSpanEnd?.(state.rootSpan);
      await processor.onTraceEnd?.(state.trace);
      await processor.forceFlush?.();
    } finally {
      runs.delete(state.callId);
    }
  }
}

function isGenerationErrorEvent(event: unknown): event is GenerationErrorEvent {
  return (
    event != null &&
    typeof event === 'object' &&
    'callId' in event &&
    typeof event.callId === 'string' &&
    'error' in event
  );
}

function isGenerateTextStartEvent(
  event: unknown,
): event is GenerateTextStartEvent {
  if (event == null || typeof event !== 'object' || !('operationId' in event)) {
    return false;
  }
  const { operationId } = event;
  return operationId === 'ai.generateText' || operationId === 'ai.streamText';
}

function isGenerateTextEndEvent(event: unknown): event is GenerateTextEndEvent {
  return (
    event != null &&
    typeof event === 'object' &&
    'finalStep' in event &&
    'steps' in event &&
    'usage' in event
  );
}

function currentParentId(state: TraceRunState): string {
  return state.stepSpans.at(-1) ?? state.rootSpan.id;
}

function normalizeMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (metadata == null) {
    return undefined;
  }

  const normalized = normalizeObjectForJson(metadata);
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function getOutputType(output: unknown): string | undefined {
  if (output == null) {
    return undefined;
  }

  if (
    typeof output === 'object' &&
    'type' in output &&
    typeof output.type === 'string'
  ) {
    return output.type;
  }

  if (typeof output === 'object' && output.constructor?.name != null) {
    return output.constructor.name;
  }

  return typeof output;
}
