import type { MCPClient } from '@ai-sdk/mcp';
import { untilAborted } from '@zukhruf/async';

import type { AgentPluginDefinition } from '../../runtime/agent-runtime.ts';
import { modelToolNames } from './model-tool-names.ts';

type McpTool = Awaited<ReturnType<MCPClient['tools']>>[string];

// Codex codex-rs/codex-mcp/src/rmcp_client.rs (DEFAULT_STARTUP_TIMEOUT,
// DEFAULT_TOOL_TIMEOUT).
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_TOOL_TIMEOUT_MS = 300_000;

/**
 * Connect once per runtime and contribute all of the server's AI SDK tools,
 * each named `mcp__<server>__<tool>` for the model. Connecting and listing
 * tools each have `connectTimeoutMs`; a server that misses it fails runtime
 * start. A tool call that outlasts `toolTimeoutMs` returns Codex's error
 * result to the model instead of failing the turn.
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
                withToolTimeout(name, toolName, tool, toolTimeoutMs),
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
 * Bounds each call by `timeoutMs` as well as the turn's own signal. A call
 * that times out returns the result Codex gives the model
 * (codex-rs/core/src/mcp_tool_call.rs, CallToolResult::from_error_text).
 */
function withToolTimeout(
  server: string,
  toolName: string,
  tool: McpTool,
  timeoutMs: number,
): McpTool {
  return {
    ...tool,
    async execute(input, callOptions) {
      const turn = callOptions?.abortSignal;
      const deadline = AbortSignal.timeout(timeoutMs);
      try {
        const result = await tool.execute(input, {
          toolCallId: '',
          messages: [],
          context: {},
          ...callOptions,
          abortSignal: turn ? AbortSignal.any([turn, deadline]) : deadline,
        });
        // MCPClient.toolsFromDefinitions builds every execute as an async
        // callTool; only the shared Tool type allows a streamed result.
        if (Symbol.asyncIterator in result) {
          throw new TypeError(`MCP tool ${toolName} streamed its result`);
        }
        return result;
      } catch (error) {
        if (turn?.aborted || !deadline.aborted) throw error;
        return {
          content: [
            {
              type: 'text',
              text: `tool call error: tool call failed for \`${server}/${toolName}\`\n\nCaused by:\n    timed out awaiting tools/call after ${roundedDurationDebug(timeoutMs)}`,
            },
          ],
          isError: true,
        };
      }
    },
  };
}

/** Rust's `{:?}` of a whole-millisecond `Duration`: `300ms`, `1.5s`. */
function durationDebug(ms: number) {
  return ms < 1_000 ? `${ms}ms` : `${ms / 1_000}s`;
}

/** Rust's `{:.0?}` of a whole-millisecond `Duration`: `300ms`, `2s`. */
function roundedDurationDebug(ms: number) {
  return ms < 1_000 ? `${ms}ms` : `${Math.round(ms / 1_000)}s`;
}
