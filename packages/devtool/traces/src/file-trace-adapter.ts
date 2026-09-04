import {
  ATTR_GEN_AI_AGENT_NAME,
  ATTR_GEN_AI_INPUT_MESSAGES,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_OUTPUT_MESSAGES,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_RESPONSE_FINISH_REASONS,
  ATTR_GEN_AI_TOOL_CALL_ARGUMENTS,
  ATTR_GEN_AI_TOOL_CALL_RESULT,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  ATTR_SESSION_ID,
  ATTR_USER_ID,
} from '@opentelemetry/semantic-conventions/incubating';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import type { ConversationId } from '@deepagents/experimental/zukhruf';

const AGENT_PATH = 'deepagents.agent.path';
const SPAN_TYPE = 'deepagents.span.type';
const STREAM_ID = 'deepagents.stream.id';
const ERROR = 'STATUS_CODE_ERROR';

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

interface FlatSpan {
  trace_id: string;
  span_id: string;
  parent_span_id: string;
  name: string;
  kind: string;
  start_time: string;
  end_time: string;
  status: { code: string; message: string };
  attributes: Record<string, unknown>;
  events: Array<{ name: string; attributes: Record<string, unknown> }>;
}

export class FileTraceAdapter implements AgentTraceReader {
  readonly #path: string;

  constructor(path: URL) {
    this.#path = fileURLToPath(path);
  }

  async list({ chatId, userId }: ConversationId): Promise<AgentTraceSummary[]> {
    return (await this.#project())
      .filter((trace) => trace.chatId === chatId && trace.userId === userId)
      .sort((left, right) =>
        (right.startedAt ?? '').localeCompare(left.startedAt ?? ''),
      )
      .map(({ spans: _spans, ...summary }) => summary);
  }

  async get(
    { chatId, userId }: ConversationId,
    traceId: string,
  ): Promise<AgentTrace | undefined> {
    return (await this.#project()).find(
      (trace) =>
        trace.id === traceId &&
        trace.chatId === chatId &&
        trace.userId === userId,
    );
  }

  async #project(): Promise<AgentTrace[]> {
    return [
      ...Map.groupBy(await readSpans(this.#path), (span) => span.trace_id),
    ]
      .map(([traceId, spans]) => projectTrace(traceId, spans))
      .filter((trace) => trace !== undefined);
  }
}

function projectTrace(
  traceId: string,
  spans: FlatSpan[],
): AgentTrace | undefined {
  const context = readContext(spans);
  if (!context) return undefined;
  const root = spans.find(
    (span) =>
      !span.parent_span_id &&
      span.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'invoke_agent',
  );
  const visible = spans
    .filter((span) => spanType(span))
    .sort((left, right) => left.start_time.localeCompare(right.start_time));
  const byId = new Map(spans.map((span) => [span.span_id, span]));
  const generationByStep = new Map(
    spans.flatMap((span) =>
      span.attributes[SPAN_TYPE] === 'languageModel' && span.parent_span_id
        ? [[span.parent_span_id, span.span_id]]
        : [],
    ),
  );
  const projected = visible.map((span) =>
    projectSpan(span, byId, generationByStep, context.agentName),
  );
  return {
    id: traceId,
    ...context,
    workflowName: context.agentName,
    startedAt: root?.start_time ?? spans[0]?.start_time ?? null,
    endedAt: root?.end_time ?? null,
    status: root
      ? root.status.code === ERROR
        ? 'failed'
        : 'completed'
      : 'running',
    stepCount: projected.filter(({ type }) => type === 'generation').length,
    finishReason:
      firstString(root?.attributes[ATTR_GEN_AI_RESPONSE_FINISH_REASONS]) ??
      null,
    usage: readUsage(root?.attributes) ?? sumUsage(visible),
    recording: {
      inputs: recorded(
        spans.some(({ attributes }) =>
          has(
            attributes,
            ATTR_GEN_AI_INPUT_MESSAGES,
            ATTR_GEN_AI_TOOL_CALL_ARGUMENTS,
          ),
        ),
      ),
      outputs: recorded(
        spans.some(({ attributes }) =>
          has(
            attributes,
            ATTR_GEN_AI_OUTPUT_MESSAGES,
            ATTR_GEN_AI_TOOL_CALL_RESULT,
          ),
        ),
      ),
    },
    spans: projected,
  };
}

function projectSpan(
  span: FlatSpan,
  byId: ReadonlyMap<string, FlatSpan>,
  generationByStep: ReadonlyMap<string, string>,
  agentName: string,
): AgentTraceSpan {
  const type = spanType(span) as 'agent' | 'generation' | 'function';
  const input = jsonAttribute(
    span.attributes,
    type === 'function'
      ? ATTR_GEN_AI_TOOL_CALL_ARGUMENTS
      : ATTR_GEN_AI_INPUT_MESSAGES,
  );
  const output = jsonAttribute(
    span.attributes,
    type === 'function'
      ? ATTR_GEN_AI_TOOL_CALL_RESULT
      : ATTR_GEN_AI_OUTPUT_MESSAGES,
  );
  const usage = readUsage(span.attributes);
  const exceptions = span.events
    .filter(({ name }) => name === 'exception')
    .map(({ attributes }) => attributes);
  const error =
    span.status.code === ERROR || exceptions.length
      ? { ...span.status, exceptions }
      : undefined;
  return {
    id: span.span_id,
    traceId: span.trace_id,
    parentId: visibleParent(span, byId, generationByStep),
    startedAt: span.start_time,
    endedAt: span.end_time,
    status: span.status.code === ERROR ? 'failed' : 'completed',
    type,
    name:
      type === 'agent'
        ? agentName
        : String(
            span.attributes[
              type === 'generation'
                ? ATTR_GEN_AI_REQUEST_MODEL
                : ATTR_GEN_AI_TOOL_NAME
            ] ?? span.name,
          ),
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(usage === undefined ? {} : { usage }),
    ...(error === undefined ? {} : { error }),
    data: {
      name: span.name,
      kind: span.kind,
      attributes: span.attributes,
      events: span.events,
      status: span.status,
    },
  };
}

function visibleParent(
  span: FlatSpan,
  byId: ReadonlyMap<string, FlatSpan>,
  generationByStep: ReadonlyMap<string, string>,
): string | null {
  if (!span.parent_span_id) return null;
  const parent = byId.get(span.parent_span_id);
  if (parent?.attributes[SPAN_TYPE] !== 'step') return span.parent_span_id;
  return span.attributes[SPAN_TYPE] === 'tool'
    ? (generationByStep.get(parent.span_id) ?? parent.parent_span_id ?? null)
    : parent.parent_span_id || null;
}

function readContext(spans: FlatSpan[]) {
  const attributes = spans.find(({ attributes }) =>
    [
      ATTR_SESSION_ID,
      ATTR_USER_ID,
      STREAM_ID,
      ATTR_GEN_AI_AGENT_NAME,
      AGENT_PATH,
    ].every((key) => typeof attributes[key] === 'string'),
  )?.attributes;
  if (!attributes) return undefined;
  return {
    chatId: attributes[ATTR_SESSION_ID] as string,
    userId: attributes[ATTR_USER_ID] as string,
    streamId: attributes[STREAM_ID] as string,
    agentName: attributes[ATTR_GEN_AI_AGENT_NAME] as string,
    agentPath: attributes[AGENT_PATH] as string,
  };
}

function spanType(
  span: FlatSpan,
): 'agent' | 'generation' | 'function' | undefined {
  return {
    operation: 'agent',
    languageModel: 'generation',
    tool: 'function',
  }[String(span.attributes[SPAN_TYPE])] as ReturnType<typeof spanType>;
}

function readUsage(attributes: Record<string, unknown> | undefined) {
  const inputTokens = attributes?.[ATTR_GEN_AI_USAGE_INPUT_TOKENS];
  const outputTokens = attributes?.[ATTR_GEN_AI_USAGE_OUTPUT_TOKENS];
  return typeof inputTokens === 'number' && typeof outputTokens === 'number'
    ? { inputTokens, outputTokens }
    : undefined;
}

function sumUsage(spans: FlatSpan[]) {
  return spans.reduce(
    (total, span) => {
      const usage = readUsage(span.attributes);
      return usage
        ? {
            inputTokens: total.inputTokens + usage.inputTokens,
            outputTokens: total.outputTokens + usage.outputTokens,
          }
        : total;
    },
    { inputTokens: 0, outputTokens: 0 },
  );
}

function jsonAttribute(attributes: Record<string, unknown>, key: string) {
  const value = attributes[key];
  if (typeof value !== 'string') return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function has(attributes: Record<string, unknown>, ...keys: string[]) {
  return keys.some((key) => Object.hasOwn(attributes, key));
}

function recorded(value: boolean): RecordingState {
  return value ? 'recorded' : 'not-recorded';
}

function firstString(value: unknown): string | undefined {
  return Array.isArray(value) && typeof value[0] === 'string'
    ? value[0]
    : undefined;
}

async function readSpans(path: string): Promise<FlatSpan[]> {
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return [];
    throw error;
  }
  const lines = contents.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.flatMap((line, index) => {
    if (!line.trim()) return [];
    let span: FlatSpan;
    try {
      span = JSON.parse(line);
    } catch (error) {
      if (index === lines.length - 1 && !contents.endsWith('\n')) return [];
      throw error;
    }
    if (
      !span ||
      typeof span.trace_id !== 'string' ||
      typeof span.span_id !== 'string' ||
      !Number.isFinite(Date.parse(span.start_time)) ||
      !isRecord(span.attributes)
    ) {
      throw new TypeError(`Invalid Halo trace record in "${path}"`);
    }
    return [span];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
