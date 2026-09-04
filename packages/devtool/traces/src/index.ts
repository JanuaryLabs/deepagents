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
      const provider = new BasicTracerProvider({
        spanProcessors: [
          new SimpleSpanProcessor(fileExporter(path, options.onWriteError)),
        ],
      });
      return {
        traces: new FileTraceAdapter(pathToFileURL(path)),
        telemetry: (context: AgentPluginToolContext) =>
          new OpenTelemetry({
            tracer: provider.getTracer('@deepagents/devtool-traces'),
            usage: true,
            providerMetadata: true,
            enrichSpan: ({ spanType }) => ({
              [ATTR_SESSION_ID]: context.conversation.chatId,
              [ATTR_USER_ID]: context.conversation.userId,
              [ATTR_GEN_AI_AGENT_NAME]: context.agentName,
              'deepagents.stream.id': context.streamId,
              'deepagents.agent.path': context.agentPath,
              'deepagents.span.type': spanType,
            }),
          }),
        work: () =>
          Promise.resolve({
            [Symbol.asyncDispose]: () => provider.shutdown(),
          }),
      };
    },
  };
}

function fileExporter(
  path: string,
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
          `${spans.map((span) => JSON.stringify(flattenSpan(span))).join('\n')}\n`,
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

function flattenSpan(span: ReadableSpan) {
  const context = span.spanContext();
  return {
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
    attributes: haloAttributes(span),
    events: span.events.map((event) => ({
      name: event.name,
      timestamp: timestamp(event.time),
      attributes: event.attributes ?? {},
    })),
  };
}

function haloAttributes(span: ReadableSpan) {
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
  };
}

function timestamp([seconds, nanoseconds]: HrTime): string {
  return `${new Date(seconds * 1_000).toISOString().slice(0, -5)}.${String(nanoseconds).padStart(9, '0')}Z`;
}
