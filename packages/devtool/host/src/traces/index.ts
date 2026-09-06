import { OpenTelemetry } from '@ai-sdk/otel';
import { type HrTime, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { ExportResultCode } from '@opentelemetry/core';
import {
  BasicTracerProvider,
  type ReadableSpan,
  SimpleSpanProcessor,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base';
import {
  ATTR_GEN_AI_AGENT_NAME,
  ATTR_SESSION_ID,
  ATTR_USER_ID,
} from '@opentelemetry/semantic-conventions/incubating';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { FileTelemetryOptions } from '@deepagents/context/telemetry/file';
import type {
  AgentPluginDefinition,
  AgentPluginToolContext,
} from '@deepagents/experimental/zukhruf';

import { FileTraceAdapter } from './file-trace-adapter.ts';
import type { AgentTraceReader } from './file-trace-adapter.ts';

export * from './file-trace-adapter.ts';
export { tracesHttp } from './http.ts';

const CALL_ID = 'deepagents.call.id';
const RECORD_INPUTS = 'deepagents.record.inputs';
const RECORD_OUTPUTS = 'deepagents.record.outputs';
const SPAN_STATUS = 'deepagents.span.status';
const SPAN_TYPE = 'deepagents.span.type';

interface TraceCallState {
  recordInputs: boolean;
  recordOutputs: boolean;
  status?: 'cancelled';
}

export interface FileTelemetryInstance {
  readonly traces: AgentTraceReader;
}

/** AI SDK OpenTelemetry spans persisted in Halo's flat JSONL format. */
export function fileTelemetry(
  options: FileTelemetryOptions,
): AgentPluginDefinition<FileTelemetryInstance> {
  const path = resolve(options.path);
  return {
    name: `file-telemetry:${pathToFileURL(path).href}`,
    create: () => {
      const calls = new Map<string, TraceCallState>();
      const provider = new BasicTracerProvider({
        spanProcessors: [
          new SimpleSpanProcessor(
            fileExporter(path, calls, options.onWriteError),
          ),
        ],
      });
      return {
        traces: new FileTraceAdapter(pathToFileURL(path)),
        telemetry: (context: AgentPluginToolContext) =>
          openTelemetry(provider, context, calls),
        work: () =>
          Promise.resolve({
            [Symbol.asyncDispose]: async () => {
              await provider.shutdown();
              calls.clear();
            },
          }),
      };
    },
  };
}

function fileExporter(
  path: string,
  calls: Map<string, TraceCallState>,
  onWriteError?: FileTelemetryOptions['onWriteError'],
): SpanExporter {
  let initialized = false;
  return {
    export(spans, done) {
      try {
        if (!initialized) {
          mkdirSync(dirname(path), { recursive: true });
          initialized = true;
        }
        appendFileSync(
          path,
          `${spans
            .map((span) => JSON.stringify(flattenSpan(span, calls)))
            .join('\n')}\n`,
        );
        done({ code: ExportResultCode.SUCCESS });
      } catch (error) {
        try {
          Promise.resolve(onWriteError?.(error)).catch(() => {});
        } catch {
          // Telemetry must never affect the observed operation.
        }
        done({
          code: ExportResultCode.FAILED,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    },
    shutdown: () => Promise.resolve(),
  };
}

function openTelemetry(
  provider: BasicTracerProvider,
  context: AgentPluginToolContext,
  calls: Map<string, TraceCallState>,
) {
  const telemetry = new OpenTelemetry({
    tracer: provider.getTracer('@deepagents/devtool/traces'),
    usage: true,
    providerMetadata: true,
    enrichSpan: ({ spanType, callId }) => {
      const call = calls.get(callId);
      return {
        [ATTR_SESSION_ID]: context.conversation.chatId,
        [ATTR_USER_ID]: context.conversation.userId,
        [ATTR_GEN_AI_AGENT_NAME]: context.agentName,
        'deepagents.stream.id': context.streamId,
        'deepagents.agent.path': context.agentPath,
        [CALL_ID]: callId,
        [SPAN_TYPE]: spanType,
        ...(call
          ? {
              [RECORD_INPUTS]: call.recordInputs,
              [RECORD_OUTPUTS]: call.recordOutputs,
            }
          : {}),
      };
    },
  });
  const onStart = telemetry.onStart.bind(telemetry);
  telemetry.onStart = (event) => {
    calls.set(event.callId, {
      recordInputs: event.recordInputs !== false,
      recordOutputs: event.recordOutputs !== false,
    });
    onStart(event);
  };
  const onAbort = telemetry.onAbort.bind(telemetry);
  telemetry.onAbort = (event) => {
    const call = calls.get(event.callId);
    if (call) call.status = 'cancelled';
    onAbort(event);
  };
  return telemetry;
}

function flattenSpan(span: ReadableSpan, calls: Map<string, TraceCallState>) {
  const context = span.spanContext();
  const callId = span.attributes[CALL_ID];
  const call = typeof callId === 'string' ? calls.get(callId) : undefined;
  const flattened = {
    trace_id: context.traceId,
    span_id: context.spanId,
    parent_span_id: span.parentSpanContext?.spanId ?? '',
    trace_state: context.traceState?.serialize() ?? '',
    name: span.name,
    kind: `SPAN_KIND_${SpanKind[span.kind]}`,
    start_time: timestamp(span.startTime),
    end_time: timestamp(span.endTime),
    status: {
      code: `STATUS_CODE_${SpanStatusCode[span.status.code]}`,
      message: span.status.message ?? '',
    },
    resource: { attributes: span.resource.attributes },
    scope: span.instrumentationScope,
    attributes: haloAttributes(span, call),
    events: span.events.map((event) => ({
      name: event.name,
      timestamp: timestamp(event.time),
      attributes: event.attributes ?? {},
    })),
  };
  if (span.attributes[SPAN_TYPE] === 'operation' && typeof callId === 'string')
    calls.delete(callId);
  return flattened;
}

function haloAttributes(span: ReadableSpan, call?: TraceCallState) {
  const attributes = span.attributes;
  const kind = {
    operation: 'AGENT',
    step: 'CHAIN',
    languageModel: 'LLM',
    tool: 'TOOL',
  }[String(attributes['deepagents.span.type'])];
  return {
    ...attributes,
    'openinference.span.kind': kind,
    ...(call?.status ? { [SPAN_STATUS]: call.status } : {}),
  };
}

function timestamp([seconds, nanoseconds]: HrTime): string {
  return `${new Date(seconds * 1_000).toISOString().slice(0, -5)}.${String(nanoseconds).padStart(9, '0')}Z`;
}
