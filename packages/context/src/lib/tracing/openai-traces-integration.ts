import type {
  OnFinishEvent,
  OnStartEvent,
  OnStepFinishEvent,
  OnStepStartEvent,
  OnToolCallFinishEvent,
  OnToolCallStartEvent,
  TelemetryIntegration,
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
  trace: OpenAITrace;
  rootSpan: OpenAISpan;
  functionId?: string;
  modelKey?: string;
  inputFingerprint?: string;
  metadataRef?: object;
  contextRef?: object;
  abortSignal?: AbortSignal;
  responseIds: Set<string>;
  stepSpans: string[];
  spansById: Map<string, OpenAISpan>;
  toolCallSpans: Map<string, string>;
}

interface ResolvableEvent {
  functionId?: string;
  metadata?: unknown;
  experimental_context?: unknown;
  abortSignal?: AbortSignal;
  model?: { provider: string; modelId: string };
  system?: unknown;
  prompt?: unknown;
  messages?: unknown;
  response?: { id: string };
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
): TelemetryIntegration {
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
  const responseIdToRun = new Map<string, TraceRunState>();
  const toolCallIdToRun = new Map<string, TraceRunState>();

  void processor.start?.();

  return {
    onStart: async (event: OnStartEvent) => {
      const trace: OpenAITrace = {
        object: 'trace',
        id: traceId(),
        workflow_name:
          options.workflowName ?? event.functionId ?? 'ai-sdk-workflow',
        group_id: options.groupId ?? null,
        metadata: normalizeMetadata({
          ...options.metadata,
          ...(event.metadata as Record<string, unknown> | undefined),
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
        trace,
        rootSpan,
        functionId: event.functionId,
        modelKey: toModelKey(event.model),
        inputFingerprint: fingerprintInput({
          system: event.system,
          prompt: event.prompt,
          messages: event.messages,
        }),
        metadataRef: asObjectRef(event.metadata),
        contextRef: asObjectRef(event.experimental_context),
        abortSignal: event.abortSignal,
        responseIds: new Set(),
        stepSpans: [],
        spansById: new Map([[rootSpan.id, rootSpan]]),
        toolCallSpans: new Map(),
      };

      openRuns.push(state);

      await processor.onTraceStart?.(trace);
      await processor.onSpanStart?.(rootSpan);
    },

    onStepStart: async (event: OnStepStartEvent) => {
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
          model: event.model.modelId,
          model_config: normalizeMetadata({
            provider: event.model.provider,
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

    onToolCallStart: async (event: OnToolCallStartEvent) => {
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

    onToolCallFinish: async (event: OnToolCallFinishEvent) => {
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
      if (includeSensitive && event.success) {
        data.output = normalizeForJson(event.output);
      }

      if (!event.success) {
        span.error = errorToSpanError(event.error);
      }

      await processor.onSpanEnd?.(span);
    },

    onStepFinish: async (event: OnStepFinishEvent) => {
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
      state.responseIds.add(event.response.id);
      responseIdToRun.set(event.response.id, state);

      await processor.onSpanEnd?.(span);
    },

    onFinish: async (event: OnFinishEvent) => {
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
          total_usage: normalizeUsage(event.totalUsage),
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

  function resolveRunState(event: ResolvableEvent): TraceRunState | undefined {
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

    let bestScore = 0;
    let bestStates: TraceRunState[] = [];
    const eventMetadataRef = asObjectRef(event.metadata);
    const eventContextRef = asObjectRef(event.experimental_context);
    const eventModelKey =
      event.model != null ? toModelKey(event.model) : undefined;
    const eventFingerprint = fingerprintInput({
      system: event.system,
      prompt: event.prompt,
      messages: event.messages,
    });

    for (const state of openRuns) {
      let score = 0;

      if (eventContextRef != null && state.contextRef === eventContextRef) {
        score += 1000;
      }

      if (eventMetadataRef != null && state.metadataRef === eventMetadataRef) {
        score += 800;
      }

      if (
        event.abortSignal != null &&
        state.abortSignal != null &&
        state.abortSignal === event.abortSignal
      ) {
        score += 600;
      }

      if (event.functionId != null && state.functionId === event.functionId) {
        score += 300;
      }

      if (eventModelKey != null && state.modelKey === eventModelKey) {
        score += 100;
      }

      if (
        eventFingerprint != null &&
        state.inputFingerprint != null &&
        state.inputFingerprint === eventFingerprint
      ) {
        score += 200;
      }

      if (score > bestScore) {
        bestScore = score;
        bestStates = [state];
      } else if (score === bestScore && bestScore > 0) {
        bestStates.push(state);
      }
    }

    if (bestStates.length === 0) return undefined;
    if (bestStates.length === 1) return bestStates[0];

    if (event.response?.id != null) {
      const withOpenStep = bestStates.filter((s) => s.stepSpans.length > 0);
      if (withOpenStep.length >= 1) return withOpenStep[0];
    }

    if (event.toolCall?.toolCallId != null) {
      const withOpenTool = bestStates.filter((s) => s.toolCallSpans.size > 0);
      if (withOpenTool.length >= 1) return withOpenTool[0];
    }

    return bestStates[0];
  }

  function closeRunState(state: TraceRunState): void {
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

function toModelKey(model: { provider: string; modelId: string }): string {
  return `${model.provider}:${model.modelId}`;
}

function canonicalizeMessageContent(content: unknown): unknown {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  return content;
}

function canonicalizeMessages(messages: unknown): unknown {
  if (!Array.isArray(messages)) return messages;
  return messages.map((message) => {
    if (message == null || typeof message !== 'object') return message;
    const record = message as Record<string, unknown>;
    if (!('content' in record)) return record;
    return { ...record, content: canonicalizeMessageContent(record.content) };
  });
}

function fingerprintInput(input: {
  system?: unknown;
  prompt?: unknown;
  messages?: unknown;
}): string | undefined {
  const source =
    input.messages ??
    (typeof input.prompt === 'string'
      ? [{ role: 'user', content: input.prompt }]
      : input.prompt);
  const normalized = normalizeForJson({
    system: input.system,
    messages: canonicalizeMessages(source),
  });

  if (normalized == null) {
    return undefined;
  }

  return JSON.stringify(normalized);
}

function asObjectRef(value: unknown): object | undefined {
  return value != null && typeof value === 'object'
    ? (value as object)
    : undefined;
}
