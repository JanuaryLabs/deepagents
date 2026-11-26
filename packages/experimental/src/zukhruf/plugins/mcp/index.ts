import type { CallToolResult, MCPClient } from '@ai-sdk/mcp';
import type { Tool, ToolResultOutput } from '@ai-sdk/provider-utils';
import { untilAborted } from '@zukhruf/async';

import type { AgentPluginDefinition } from '../../runtime/agent-runtime.ts';
import { modelToolNames } from './model-tool-names.ts';

type McpTool = Awaited<ReturnType<MCPClient['tools']>>[string];
type ContentItem =
  | { type: 'text'; text: string }
  | {
      type: 'file';
      mediaType: string;
      data: { type: 'data'; data: string };
    };

/**
 * A call's result with the wall time of its execute, stored so a later turn
 * renders the model output the first one read.
 */
type McpToolOutput = CallToolResult & { wallTimeMs: number };

// Codex codex-rs/codex-mcp/src/rmcp_client.rs (DEFAULT_STARTUP_TIMEOUT,
// DEFAULT_TOOL_TIMEOUT).
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_TOOL_TIMEOUT_MS = 300_000;

// Codex codex-rs/models-manager/models.json gives every bundled model a
// truncation_policy of 10,000 tokens; with_serialization_allowance adds 20%
// (codex-rs/utils/output-truncation/src/lib.rs).
const MODEL_OUTPUT_TOKENS = 12_000;
// Codex codex-rs/utils/string/src/truncate.rs APPROX_BYTES_PER_TOKEN.
const BYTES_PER_TOKEN = 4;

/**
 * Connect once per runtime and contribute all of the server's AI SDK tools,
 * each named `mcp__<server>__<tool>` for the model. Connecting and listing
 * tools each have `connectTimeoutMs`; a server that misses it fails runtime
 * start. A tool call that outlasts `toolTimeoutMs` or that the server fails
 * returns Codex's error result to the model instead of failing the turn. The
 * model reads each result as Codex renders it: a wall-time header, the
 * serialized structuredContent ahead of the content, isError as an error
 * result, and both ends of an output over 12,000 tokens.
 */
export function mcp(options: {
  name: string;
  /** `signal` aborts at `connectTimeoutMs`; pass it to `createMCPClient`. */
  connect: (options: { signal: AbortSignal }) => Promise<MCPClient>;
  connectTimeoutMs?: number;
  toolTimeoutMs?: number;
}): AgentPluginDefinition {
  const {
    name,
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    toolTimeoutMs = DEFAULT_TOOL_TIMEOUT_MS,
  } = options;
  // Codex connection_manager/required.rs wraps each startup error.
  const startupFailed = (error: string) =>
    new Error(`required MCP servers failed to initialize: ${name}: ${error}`);
  return {
    name,
    create: () => ({
      async initialize() {
        await using resources = new AsyncDisposableStack();
        const connectDeadline = AbortSignal.timeout(connectTimeoutMs);
        const connecting = options.connect({ signal: connectDeadline });
        const client = resources.adopt(
          await untilAborted(connecting, connectDeadline).catch(
            (error: unknown) => {
              if (!connectDeadline.aborted) throw error;
              void connecting.then(
                (late) => late.close(),
                () => undefined,
              );
              throw startupFailed(
                `MCP client startup timed out after ${durationDebug(connectTimeoutMs)}`,
              );
            },
          ),
          (client) => client.close(),
        );
        const listDeadline = AbortSignal.timeout(connectTimeoutMs);
        const tools = await untilAborted(client.tools(), listDeadline).catch(
          (error: unknown) => {
            if (!listDeadline.aborted) throw error;
            throw startupFailed(
              `timed out awaiting tools/list after ${roundedDurationDebug(connectTimeoutMs)}`,
            );
          },
        );
        const lifetime = resources.move();
        return {
          tools: modelToolNames(
            name,
            Object.fromEntries(
              Object.entries(tools).map(([toolName, tool]) => [
                toolName,
                codexTool(name, toolName, tool, toolTimeoutMs),
              ]),
            ),
          ),
          [Symbol.asyncDispose]: () => lifetime.disposeAsync(),
        };
      },
    }),
  };
}

/**
 * Bounds each call by `timeoutMs` as well as the turn's own signal, times it,
 * and renders its result for the model the way Codex does
 * (codex-rs/core/src/tools/context.rs, McpToolOutput::response_payload). A
 * call that times out or fails returns the result Codex gives the model
 * (codex-rs/core/src/mcp_tool_call.rs, CallToolResult::from_error_text).
 */
function codexTool(
  server: string,
  toolName: string,
  tool: McpTool,
  timeoutMs: number,
): Tool<unknown, McpToolOutput> {
  return {
    ...tool,
    // client.tools() never sets an outputSchema, even when tools/list
    // advertises one, but its Tool type allows a CallToolResult schema, which
    // an output that carries wallTimeMs cannot satisfy.
    outputSchema: undefined,
    async execute(input, callOptions) {
      const turn = callOptions.abortSignal;
      const deadline = AbortSignal.timeout(timeoutMs);
      const started = performance.now();
      const result = await call().catch((error: unknown) => {
        if (turn?.aborted) throw error;
        return callFailed(
          server,
          toolName,
          deadline.aborted
            ? [
                `timed out awaiting tools/call after ${roundedDurationDebug(timeoutMs)}`,
              ]
            : errorChain(error),
        );
      });
      return { ...result, wallTimeMs: performance.now() - started };

      async function call(): Promise<CallToolResult> {
        const result = await tool.execute(input, {
          ...callOptions,
          abortSignal: turn ? AbortSignal.any([turn, deadline]) : deadline,
        });
        // MCPClient.toolsFromDefinitions builds every execute as an async
        // callTool; only the shared Tool type allows a streamed result.
        if (Symbol.asyncIterator in result) {
          throw new TypeError(`MCP tool ${toolName} streamed its result`);
        }
        return result;
      }
    },
    toModelOutput: ({ output }) => modelOutput(output),
  };
}

/** Codex's `tool call error: {error:?}` of an anyhow error with context. */
function callFailed(
  server: string,
  toolName: string,
  causes: string[],
): CallToolResult {
  const causedBy =
    causes.length === 1
      ? `    ${causes[0]}`
      : causes.map((cause, index) => `    ${index}: ${cause}`).join('\n');
  return {
    content: [
      {
        type: 'text',
        text: `tool call error: tool call failed for \`${server}/${toolName}\`\n\nCaused by:\n${causedBy}`,
      },
    ],
    isError: true,
  };
}

function errorChain(error: unknown): string[] {
  const chain: string[] = [];
  let current = error;
  while (Error.isError(current)) {
    chain.push(current.message);
    current = current.cause;
  }
  return chain.length > 0 ? chain : [String(error)];
}

/**
 * Codex CallToolResult::as_function_call_output_payload
 * (codex-rs/protocol/src/models.rs) under McpToolOutput's header and budget.
 * The AI SDK marks only a text or JSON output as an error, so an isError
 * result with media stays content.
 */
function modelOutput(output: McpToolOutput): ToolResultOutput {
  const header = `Wall time: ${(output.wallTimeMs / 1_000).toFixed(4)} seconds\nOutput:`;
  const failed = output.isError === true;
  const structured = output.structuredContent;
  if (structured != null) {
    const value = truncateMiddle(
      `${header}\n${JSON.stringify(structured)}`,
      MODEL_OUTPUT_TOKENS,
    );
    return { type: failed ? 'error-text' : 'text', value };
  }
  const items = truncateItems([
    { type: 'text', text: header },
    ...(Array.isArray(output.content) ? output.content : []).map(contentItem),
  ]);
  if (failed && items.every((item) => item.type === 'text')) {
    return {
      type: 'error-text',
      value: items.map((item) => item.text).join('\n'),
    };
  }
  return { type: 'content', value: items };
}

/** @ai-sdk/mcp's mcpToModelOutput mapping of one MCP content block. */
function contentItem(part: {
  type: string;
  [key: string]: unknown;
}): ContentItem {
  if (part.type === 'text' && typeof part.text === 'string') {
    return { type: 'text', text: part.text };
  }
  if (
    part.type === 'image' &&
    typeof part.data === 'string' &&
    typeof part.mimeType === 'string'
  ) {
    return {
      type: 'file',
      mediaType: part.mimeType,
      data: { type: 'data', data: part.data },
    };
  }
  return { type: 'text', text: JSON.stringify(part) };
}

/**
 * Codex truncate_measured_output_iter under a token policy: text items spend
 * the budget in order, the first one over it keeps both ends, later ones are
 * counted as omitted, and media items stay.
 */
function truncateItems(items: ContentItem[]): ContentItem[] {
  const kept: ContentItem[] = [];
  let remaining = MODEL_OUTPUT_TOKENS;
  let omitted = 0;
  for (const item of items) {
    if (item.type !== 'text') {
      kept.push(item);
    } else if (item.text === '') {
      continue;
    } else if (remaining === 0) {
      omitted++;
    } else {
      const cost = approxTokens(Buffer.byteLength(item.text));
      if (cost <= remaining) {
        remaining -= cost;
        kept.push(item);
      } else {
        kept.push({ type: 'text', text: truncateMiddle(item.text, remaining) });
        remaining = 0;
      }
    }
  }
  if (omitted > 0) {
    kept.push({ type: 'text', text: `[omitted ${omitted} text items ...]` });
  }
  return kept;
}

/**
 * Codex plan_token_truncation (codex-rs/utils/string/src/truncate.rs): over
 * `maxTokens`, keep half of its bytes from each end on UTF-8 boundaries and
 * put the removed token count between them.
 */
function truncateMiddle(text: string, maxTokens: number) {
  const bytes = Buffer.from(text);
  const maxBytes = maxTokens * BYTES_PER_TOKEN;
  if (bytes.length <= maxBytes) return text;
  const isContinuation = (index: number) =>
    index < bytes.length && (bytes[index] & 0xc0) === 0x80;
  let headEnd = Math.floor(maxBytes / 2);
  while (isContinuation(headEnd)) headEnd--;
  let tailStart = bytes.length - (maxBytes - Math.floor(maxBytes / 2));
  while (isContinuation(tailStart)) tailStart++;
  const marker = `…${approxTokens(bytes.length - maxBytes)} tokens truncated…`;
  return `${bytes.subarray(0, headEnd).toString()}${marker}${bytes.subarray(tailStart).toString()}`;
}

/** Codex approx_tokens_from_byte_count. */
function approxTokens(bytes: number) {
  return Math.ceil(bytes / BYTES_PER_TOKEN);
}

/** Rust's `{:?}` of a whole-millisecond `Duration`: `300ms`, `1.5s`. */
function durationDebug(ms: number) {
  return ms < 1_000 ? `${ms}ms` : `${ms / 1_000}s`;
}

/** Rust's `{:.0?}` of a whole-millisecond `Duration`: `300ms`, `2s`. */
function roundedDurationDebug(ms: number) {
  return ms < 1_000 ? `${ms}ms` : `${Math.round(ms / 1_000)}s`;
}
