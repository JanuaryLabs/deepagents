import type {
  GenerateTextEndEvent,
  GenerateTextStartEvent,
  Telemetry,
} from 'ai';

import {
  BatchTraceProcessor,
  type BatchTraceProcessorOptions,
} from './batch-processor.ts';
import { OpenAITracesExporter } from './exporter.ts';
import { spanId, traceId } from './ids.ts';
import { type TracingProcessor, createTracingProcessor } from './processor.ts';
import {
  errorToSpanError,
  normalizeForJson,
  normalizeRecordArray,
  normalizeUsage,
} from './serialization.ts';
import type {
  AgentSpanData,
  FunctionSpanData,
  GenerationSpanData,
  OpenAISpan,
  OpenAITrace,
} from './types.ts';

interface TraceRunState {
  callId: string;
  trace: OpenAITrace;
  rootSpan: OpenAISpan;
  responseIds: Set<string>;
  stepSpans: string[];
  spansById: Map<string, OpenAISpan>;
  toolCallSpans: Map<string, string>;
}

interface ResolvableEvent {
  callId?: string;
  response?: { id?: string };
  toolCall?: { toolCallId: string };
}

export interface OpenAITracesIntegrationOptions {
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
  batch?: BatchTraceProcessorOptions;
  includeSensitiveData?: boolean;
}

export function createOpenAITracesIntegration(
  options: OpenAITracesIntegrationOptions = {},
): Telemetry {
  if (process.env.OPENAI_AGENTS_DISABLE_TRACING === '1') {
    return {};
  }

  const exporter =
    options.exporter ??
    new OpenAITracesExporter({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      endpoint: options.endpoint,
      organization: options.organization,
      project: options.project,
    });

  const processor: TracingProcessor =
    createTracingProcessor(options.processor) ??
    new BatchTraceProcessor(exporter, options.batch);

  const includeSensitive =
    options.includeSensitiveData ??
    process.env.OPENAI_AGENTS_TRACE_INCLUDE_SENSITIVE_DATA !== '0';
  const openRuns: TraceRunState[] = [];
  const callIdToRun = new Map<string, TraceRunState>();
  const responseIdToRun = new Map<string, TraceRunState>();
  const toolCallIdToRun = new Map<string, TraceRunState>();

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
        responseIds: new Set(),
        stepSpans: [],
        spansById: new Map([[rootSpan.id, rootSpan]]),
        toolCallSpans: new Map(),
      };

      openRuns.push(state);
      callIdToRun.set(event.callId, state);

      await processor.onTraceStart?.(trace);
      await processor.onSpanStart?.(rootSpan);
    },

    onStepStart: async (event) => {
      const state = resolveRunState(event);
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
          ...(includeSensitive
            ? { input: normalizeRecordArray(event.messages) }
            : {}),
        } satisfies GenerationSpanData,
      };

      state.stepSpans.push(span.id);
      state.spansById.set(span.id, span);

      await processor.onSpanStart?.(span);
    },

    onToolExecutionStart: async (event) => {
      const state = resolveRunState(event);
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
          ...(includeSensitive
            ? {
                input: normalizeForJson(event.toolCall.input),
              }
            : {}),
        } satisfies FunctionSpanData,
      };

      state.toolCallSpans.set(event.toolCall.toolCallId, span.id);
      toolCallIdToRun.set(event.toolCall.toolCallId, state);
      state.spansById.set(span.id, span);

      await processor.onSpanStart?.(span);
    },

    onToolExecutionEnd: async (event) => {
      const state =
        toolCallIdToRun.get(event.toolCall.toolCallId) ??
        resolveRunState(event);
      if (state == null) {
        return;
      }

      const id = state.toolCallSpans.get(event.toolCall.toolCallId);
      if (id == null) {
        return;
      }

      state.toolCallSpans.delete(event.toolCall.toolCallId);
      toolCallIdToRun.delete(event.toolCall.toolCallId);

      const span = state.spansById.get(id);
      if (span == null) {
        return;
      }

      span.ended_at = now();

      const data = span.span_data as FunctionSpanData;
      if (event.toolOutput.type === 'tool-result') {
        if (includeSensitive) {
          data.output = normalizeForJson(event.toolOutput.output);
        }
      } else {
        span.error = errorToSpanError(event.toolOutput.error);
      }

      await processor.onSpanEnd?.(span);
    },

    onStepEnd: async (event) => {
      const state = resolveRunState(event);
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

      const data = span.span_data as GenerationSpanData;
      if (includeSensitive) {
        data.output = normalizeRecordArray(event.response.messages);
      }
      data.usage = normalizeUsage(event.usage);
      if (event.response.id != null) {
        state.responseIds.add(event.response.id);
        responseIdToRun.set(event.response.id, state);
      }

      await processor.onSpanEnd?.(span);
    },

    onEnd: async (event) => {
      if (!isGenerateTextEndEvent(event)) {
        return;
      }

      const state = resolveRunState(event);
      if (state == null) {
        return;
      }

      try {
        while (state.stepSpans.length > 0) {
          const openStepId = state.stepSpans.pop();
          if (openStepId == null) {
            continue;
          }

          const openStep = state.spansById.get(openStepId);
          if (openStep == null || openStep.ended_at != null) {
            continue;
          }

          openStep.ended_at = now();
          await processor.onSpanEnd?.(openStep);
        }

        state.rootSpan.ended_at = now();
        state.trace.metadata = normalizeMetadata({
          ...state.trace.metadata,
          total_usage: normalizeUsage(event.usage),
          steps: event.steps.length,
          finish_reason: event.finishReason,
        });

        await processor.onSpanEnd?.(state.rootSpan);
        await processor.onTraceEnd?.(state.trace);
        await processor.forceFlush?.();
      } finally {
        closeRunState(state);
      }
    },
  };

  return integration;

  function resolveRunState(event: ResolvableEvent): TraceRunState | undefined {
    if (event.callId != null) {
      const state = callIdToRun.get(event.callId);
      if (state != null) {
        return state;
      }
    }

    if (event.response?.id != null) {
      const state = responseIdToRun.get(event.response.id);
      if (state != null) {
        return state;
      }
    }

    if (event.toolCall?.toolCallId != null) {
      const state = toolCallIdToRun.get(event.toolCall.toolCallId);
      if (state != null) {
        return state;
      }
    }

    if (openRuns.length === 0) {
      return undefined;
    }
    if (openRuns.length === 1) {
      return openRuns[0];
    }

    return undefined;
  }

  function closeRunState(state: TraceRunState): void {
    callIdToRun.delete(state.callId);
    const index = openRuns.indexOf(state);
    if (index >= 0) {
      openRuns.splice(index, 1);
    }

    for (const responseId of state.responseIds) {
      responseIdToRun.delete(responseId);
    }

    for (const toolCallId of state.toolCallSpans.keys()) {
      toolCallIdToRun.delete(toolCallId);
    }
  }
}

function isGenerateTextStartEvent(
  event: unknown,
): event is GenerateTextStartEvent {
  if (event == null || typeof event !== 'object') {
    return false;
  }
  const operationId = (event as { operationId?: unknown }).operationId;
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
  return state.stepSpans[state.stepSpans.length - 1] ?? state.rootSpan.id;
}

function normalizeMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (metadata == null) {
    return undefined;
  }

  const normalized = normalizeForJson(metadata);
  if (
    normalized == null ||
    typeof normalized !== 'object' ||
    Array.isArray(normalized)
  ) {
    return undefined;
  }

  return Object.keys(normalized).length > 0
    ? (normalized as Record<string, unknown>)
    : undefined;
}

function getOutputType(output: unknown): string | undefined {
  if (output == null) {
    return undefined;
  }

  if (
    typeof output === 'object' &&
    'type' in (output as Record<string, unknown>) &&
    typeof (output as Record<string, unknown>).type === 'string'
  ) {
    return (output as Record<string, unknown>).type as string;
  }

  if (typeof output === 'object' && output.constructor?.name != null) {
    return output.constructor.name;
  }

  return typeof output;
}

function now(): string {
  return new Date().toISOString();
}
