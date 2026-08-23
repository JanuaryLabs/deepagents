import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import type { TelemetryLogRecord } from '@deepagents/context/telemetry';
import type { ConversationId } from '@deepagents/experimental/zukhruf';

export type RecordingState = 'recorded' | 'not-recorded';

export interface AgentTraceSummary {
  id: string;
  chatId: string;
  userId: string;
  streamId: string;
  agentName: string;
  agentPath: string;
  workflowName: string;
  startedAt: string | null;
  endedAt: string | null;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  stepCount: number;
  finishReason: string | null;
  usage: { inputTokens: number; outputTokens: number };
  recording: { inputs: RecordingState; outputs: RecordingState };
}

export interface AgentTraceSpan {
  id: string;
  traceId: string;
  parentId: string | null;
  startedAt: string;
  endedAt: string | null;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  type: string;
  name: string;
  input?: unknown;
  output?: unknown;
  usage?: unknown;
  error?: unknown;
  data: Record<string, unknown>;
}

export type AgentTrace = AgentTraceSummary & { spans: AgentTraceSpan[] };

export interface AgentTraceReader {
  list(conversation: ConversationId): Promise<AgentTraceSummary[]>;
  get(
    conversation: ConversationId,
    traceId: string,
  ): Promise<AgentTrace | undefined>;
}

type ProjectedTrace = AgentTraceSummary & {
  spans: AgentTraceSpan[];
  spansById: Map<string, AgentTraceSpan>;
  currentStep?: number;
};

export class FileTraceAdapter implements AgentTraceReader {
  readonly #path: string;

  constructor(path: URL) {
    this.#path = fileURLToPath(path);
  }

  async list({ chatId, userId }: ConversationId): Promise<AgentTraceSummary[]> {
    return (await this.#project())
      .filter((trace) => trace.chatId === chatId && trace.userId === userId)
      .sort(newestFirst)
      .map(traceSummary);
  }

  async get(
    { chatId, userId }: ConversationId,
    traceId: string,
  ): Promise<AgentTrace | undefined> {
    const trace = (await this.#project()).find(
      (candidate) =>
        candidate.id === traceId &&
        candidate.chatId === chatId &&
        candidate.userId === userId,
    );
    if (!trace) return undefined;
    return { ...traceSummary(trace), spans: trace.spans };
  }

  async #project(): Promise<ProjectedTrace[]> {
    const records = (await readRecords(this.#path)).sort(byTimestamp);
    const traces = new Map<string, ProjectedTrace>();

    for (const record of records) {
      if (!isRecord(record.data)) continue;
      const callId = string(record.data.callId);
      if (callId === undefined) continue;

      if (record.event === 'onStart') {
        const context = captureContext(record.data.zukhruf);
        if (!context) continue;
        const trace: ProjectedTrace = {
          id: callId,
          ...context,
          workflowName: context.agentName,
          startedAt: record.timestamp ?? null,
          endedAt: null,
          status: 'running',
          stepCount: 0,
          finishReason: null,
          usage: { inputTokens: 0, outputTokens: 0 },
          recording: {
            inputs: recordingState(record.data.recordInputs),
            outputs: recordingState(record.data.recordOutputs),
          },
          spans: [],
          spansById: new Map(),
        };
        if (record.timestamp !== undefined) {
          addSpan(trace, {
            id: agentSpanId(callId),
            traceId: callId,
            parentId: null,
            startedAt: record.timestamp,
            endedAt: null,
            status: 'running',
            type: 'agent',
            name: context.agentName,
            ...(trace.recording.inputs === 'recorded'
              ? { input: record.data.messages }
              : {}),
            data: {
              type: 'agent',
              name: context.agentName,
              start: record.data,
            },
          });
        }
        traces.set(callId, trace);
        continue;
      }

      const trace = traces.get(callId);
      if (!trace) continue;

      switch (record.event) {
        case 'onStepStart': {
          const stepNumber = integer(record.data.stepNumber);
          const provider = string(record.data.provider);
          const modelId = string(record.data.modelId);
          if (
            stepNumber === undefined ||
            provider === undefined ||
            modelId === undefined ||
            record.timestamp === undefined
          ) {
            break;
          }
          trace.currentStep = stepNumber;
          addSpan(trace, {
            id: generationSpanId(callId, stepNumber),
            traceId: callId,
            parentId: agentSpanId(callId),
            startedAt: record.timestamp,
            endedAt: null,
            status: 'running',
            type: 'generation',
            name: modelId,
            ...(trace.recording.inputs === 'recorded'
              ? {
                  input: Object.hasOwn(record.data, 'promptMessages')
                    ? record.data.promptMessages
                    : record.data.messages,
                }
              : {}),
            data: {
              type: 'generation',
              provider,
              model: modelId,
              start: record.data,
            },
          });
          break;
        }
        case 'onToolExecutionStart': {
          const toolCall = record.data.toolCall;
          if (
            trace.currentStep === undefined ||
            !isRecord(toolCall) ||
            record.timestamp === undefined
          ) {
            break;
          }
          const toolCallId = string(toolCall.toolCallId);
          const toolName = string(toolCall.toolName);
          if (toolCallId === undefined || toolName === undefined) break;
          addSpan(trace, {
            id: functionSpanId(callId, toolCallId),
            traceId: callId,
            parentId: generationSpanId(callId, trace.currentStep),
            startedAt: record.timestamp,
            endedAt: null,
            status: 'running',
            type: 'function',
            name: toolName,
            ...(trace.recording.inputs === 'recorded' &&
            Object.hasOwn(toolCall, 'input')
              ? { input: toolCall.input }
              : {}),
            data: { type: 'function', name: toolName, start: record.data },
          });
          break;
        }
        case 'onToolExecutionEnd': {
          const toolCall = record.data.toolCall;
          if (!isRecord(toolCall)) break;
          const toolCallId = string(toolCall.toolCallId);
          if (toolCallId === undefined) break;
          const span = trace.spansById.get(functionSpanId(callId, toolCallId));
          if (!span) break;
          const toolOutput = record.data.toolOutput;
          span.endedAt = record.timestamp ?? null;
          span.data = { ...span.data, end: record.data };
          if (trace.recording.outputs === 'recorded' && isRecord(toolOutput)) {
            if (Object.hasOwn(toolOutput, 'output')) {
              span.output = toolOutput.output;
            }
            if (Object.hasOwn(toolOutput, 'error')) {
              span.error = toolOutput.error;
            }
          }
          span.status = span.error === undefined ? 'completed' : 'failed';
          break;
        }
        case 'onStepEnd': {
          const stepNumber = integer(record.data.stepNumber);
          if (stepNumber === undefined) break;
          const span = trace.spansById.get(
            generationSpanId(callId, stepNumber),
          );
          if (!span) break;
          span.endedAt = record.timestamp ?? null;
          span.status = 'completed';
          span.data = { ...span.data, end: record.data };
          if (trace.recording.outputs === 'recorded') {
            span.output = record.data.content;
          }
          const usage = readUsage(record.data.usage);
          if (usage) span.usage = usage;
          break;
        }
        case 'onEnd': {
          trace.endedAt = record.timestamp ?? null;
          trace.status = 'completed';
          trace.stepCount = trace.spans.filter(
            ({ type }) => type === 'generation',
          ).length;
          trace.finishReason = string(record.data.finishReason) ?? null;
          const usage = readUsage(record.data.totalUsage);
          if (usage) trace.usage = usage;
          const root = trace.spansById.get(agentSpanId(callId));
          if (root) {
            root.endedAt = record.timestamp ?? null;
            root.status = 'completed';
            root.data = { ...root.data, end: record.data };
            root.usage = trace.usage;
            if (trace.recording.outputs === 'recorded') {
              root.output = record.data.content;
            }
          }
          break;
        }
        case 'onAbort': {
          trace.endedAt = record.timestamp ?? null;
          trace.status = 'cancelled';
          finishOpenSpans(trace, record.timestamp, record.data, 'cancelled');
          break;
        }
        case 'onError': {
          trace.endedAt = record.timestamp ?? null;
          trace.status = 'failed';
          finishOpenSpans(trace, record.timestamp, record.data, 'failed');
          break;
        }
      }
    }

    return [...traces.values()];
  }
}

function finishOpenSpans(
  trace: ProjectedTrace,
  timestamp: string | undefined,
  data: Record<string, unknown>,
  status: 'failed' | 'cancelled',
): void {
  for (const span of trace.spans) {
    if (span.endedAt !== null) continue;
    span.endedAt = timestamp ?? null;
    span.status = status;
    span.data = { ...span.data, end: data };
    if (
      status === 'failed' &&
      trace.recording.outputs === 'recorded' &&
      Object.hasOwn(data, 'error')
    ) {
      span.error = data.error;
    }
  }
}

async function readRecords(path: string): Promise<TelemetryLogRecord[]> {
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return [];
    throw error;
  }
  const lines = contents.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const records: TelemetryLogRecord[] = [];
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      if (index === lines.length - 1 && !contents.endsWith('\n')) break;
      throw error;
    }
    if (
      !isRecord(parsed) ||
      typeof parsed.event !== 'string' ||
      (parsed.timestamp !== undefined && typeof parsed.timestamp !== 'string')
    ) {
      throw new TypeError(`Invalid telemetry record in "${path}"`);
    }
    records.push(parsed as unknown as TelemetryLogRecord);
  }
  return records;
}

function addSpan(trace: ProjectedTrace, span: AgentTraceSpan): void {
  trace.spans.push(span);
  trace.spansById.set(span.id, span);
}

function traceSummary(trace: ProjectedTrace): AgentTraceSummary {
  return {
    id: trace.id,
    chatId: trace.chatId,
    userId: trace.userId,
    streamId: trace.streamId,
    agentName: trace.agentName,
    agentPath: trace.agentPath,
    workflowName: trace.workflowName,
    startedAt: trace.startedAt,
    endedAt: trace.endedAt,
    status: trace.status,
    stepCount: trace.stepCount,
    finishReason: trace.finishReason,
    usage: trace.usage,
    recording: trace.recording,
  };
}

function captureContext(
  value: unknown,
):
  | Pick<
      AgentTraceSummary,
      'chatId' | 'userId' | 'streamId' | 'agentName' | 'agentPath'
    >
  | undefined {
  if (!isRecord(value) || !isRecord(value.conversation)) return undefined;
  const { chatId, userId } = value.conversation;
  const { streamId, agentName, agentPath } = value;
  if (
    typeof chatId !== 'string' ||
    typeof userId !== 'string' ||
    typeof streamId !== 'string' ||
    typeof agentName !== 'string' ||
    typeof agentPath !== 'string'
  ) {
    return undefined;
  }
  return { chatId, userId, streamId, agentName, agentPath };
}

function readUsage(
  value: unknown,
): { inputTokens: number; outputTokens: number } | undefined {
  if (!isRecord(value)) return undefined;
  const { inputTokens, outputTokens } = value;
  return typeof inputTokens === 'number' && typeof outputTokens === 'number'
    ? { inputTokens, outputTokens }
    : undefined;
}

function recordingState(value: unknown): RecordingState {
  return value === false ? 'not-recorded' : 'recorded';
}

function newestFirst(
  left: AgentTraceSummary,
  right: AgentTraceSummary,
): number {
  if (left.startedAt === right.startedAt) return 0;
  if (left.startedAt === null) return 1;
  if (right.startedAt === null) return -1;
  return right.startedAt.localeCompare(left.startedAt);
}

function byTimestamp(
  left: TelemetryLogRecord,
  right: TelemetryLogRecord,
): number {
  if (left.timestamp === right.timestamp) return 0;
  if (left.timestamp === undefined) return 1;
  if (right.timestamp === undefined) return -1;
  return left.timestamp.localeCompare(right.timestamp);
}

function agentSpanId(callId: string): string {
  return `${callId}:agent`;
}

function generationSpanId(callId: string, stepNumber: number): string {
  return `${callId}:step:${stepNumber}`;
}

function functionSpanId(callId: string, toolCallId: string): string {
  return `${callId}:tool:${toolCallId}`;
}

function integer(value: unknown): number | undefined {
  return Number.isInteger(value) ? (value as number) : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '[Undefined]'
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
