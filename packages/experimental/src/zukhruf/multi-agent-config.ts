import { CodeModeTools } from './collaboration/code-mode-tools.ts';
import { DirectTools } from './collaboration/direct-tools.ts';
import type { ToolExposure } from './collaboration/tool-exposure.ts';
import { ToolNamespace } from './collaboration/tool-namespace.ts';
import { WaitBounds } from './collaboration/wait-bounds.ts';

/** Codex `DEFAULT_MULTI_AGENT_V2_MAX_CONCURRENT_THREADS_PER_SESSION`. */
const DEFAULT_MAX_CONCURRENT_THREADS_PER_SESSION = 4;
/** Verbatim Codex guidance (`core/src/session/multi_agents.rs`). */
const WAIT_AGENT_USAGE_HINT_TEXT =
  'When calling `wait_agent`, prefer longer waits (minutes) to avoid busy polling.';

/** Verbatim Codex `resolve_usage_hints` closing sentence. */
function concurrencySlotsText(maxConcurrency: number): string {
  return `There are ${maxConcurrency} available concurrency slots, meaning that up to ${maxConcurrency} agents can be active at once, including you.`;
}

/** Host-level controls matching Codex multi-agent configuration. */
export interface MultiAgentHostConfig {
  minWaitTimeoutMs?: number;
  defaultWaitTimeoutMs?: number;
  maxWaitTimeoutMs?: number;
  /**
   * Codex `max_concurrent_threads_per_session`: how many agents of one tree
   * may run turns at once, including the root. Defaults to 4.
   */
  maxConcurrentThreadsPerSession?: number;
  /** Additional guidance appended to the spawn_agent tool description. */
  usageHintText?: string;
  /** Complete root guidance override. An empty string disables the hint. */
  rootAgentUsageHintText?: string;
  /** Complete child guidance override. An empty string disables the hint. */
  subagentUsageHintText?: string;
  /** Native OpenAI Responses namespace for the six collaboration tools. */
  toolNamespace?: string;
  /**
   * Keeps collaboration tools on the direct model surface. Set false to expose
   * them through AI SDK code mode. Defaults to true.
   */
  nonCodeModeOnly?: boolean;
}

export interface ResolvedMultiAgentHostConfig {
  minWaitTimeoutMs: number;
  defaultWaitTimeoutMs: number;
  maxWaitTimeoutMs: number;
  maxConcurrentThreadsPerSession: number;
  usageHintText?: string;
  rootAgentUsageHintText?: string;
  subagentUsageHintText?: string;
  exposure: ToolExposure;
}

export function resolveMultiAgentHostConfig(
  input: MultiAgentHostConfig = {},
): ResolvedMultiAgentHostConfig {
  const waitBounds = new WaitBounds({
    minMs: input.minWaitTimeoutMs,
    defaultMs: input.defaultWaitTimeoutMs,
    maxMs: input.maxWaitTimeoutMs,
  });
  const maxConcurrentThreadsPerSession =
    input.maxConcurrentThreadsPerSession ??
    DEFAULT_MAX_CONCURRENT_THREADS_PER_SESSION;
  if (
    !Number.isSafeInteger(maxConcurrentThreadsPerSession) ||
    maxConcurrentThreadsPerSession < 1
  ) {
    throw new Error(
      'AgentRuntime: multiAgent.maxConcurrentThreadsPerSession must be a positive integer',
    );
  }
  const exposure = toolExposure(input);
  const shared = `${exposure.callLine([
    'spawn_agent',
    'send_message',
    'followup_task',
    'wait_agent',
    'interrupt_agent',
    'list_agents',
  ])}

All agents share the same workspace, current working directory, and filesystem.`;

  return {
    minWaitTimeoutMs: waitBounds.minMs,
    defaultWaitTimeoutMs: waitBounds.defaultMs,
    maxWaitTimeoutMs: waitBounds.maxMs,
    maxConcurrentThreadsPerSession,
    usageHintText: nonEmptyText(input.usageHintText),
    rootAgentUsageHintText:
      input.rootAgentUsageHintText === undefined
        ? defaultRootUsageHint(exposure, shared, maxConcurrentThreadsPerSession)
        : nonEmptyText(input.rootAgentUsageHintText),
    subagentUsageHintText:
      input.subagentUsageHintText === undefined
        ? defaultSubagentUsageHint(
            exposure,
            shared,
            maxConcurrentThreadsPerSession,
          )
        : nonEmptyText(input.subagentUsageHintText),
    exposure,
  };
}

function toolExposure(input: MultiAgentHostConfig): ToolExposure {
  const namespace =
    input.toolNamespace === undefined
      ? undefined
      : new ToolNamespace(input.toolNamespace);
  if (input.nonCodeModeOnly !== false) return new DirectTools(namespace);
  if (namespace !== undefined) {
    throw new Error(
      'AgentRuntime: multiAgent.toolNamespace cannot be combined with nonCodeModeOnly: false',
    );
  }
  return new CodeModeTools();
}

function nonEmptyText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.length === 0 ? undefined : value;
}

function defaultRootUsageHint(
  exposure: ToolExposure,
  shared: string,
  maxConcurrency: number,
): string {
  return `You are \`/root\`, the primary agent in a team of agents collaborating to fulfill the user's goals.

At the start of your turn, you are the active agent. You can spawn sub-agents to handle subtasks, and those agents can recursively spawn their own declared sub-agents. All agents are equally capable and receive the tools declared for their agent type.

Use \`${exposure.toolName('spawn_agent')}\` to create an agent, \`${exposure.toolName('followup_task')}\` to assign a new task and trigger a turn, and \`${exposure.toolName('send_message')}\` to queue a message without triggering a turn. You can decide how much context you want to propagate to your sub-agents with the \`fork_turns\` parameter.

Child messages arrive as \`MESSAGE\` or \`FINAL_ANSWER\` mailbox envelopes with their task name, sender, and payload preserved.

${shared}

${WAIT_AGENT_USAGE_HINT_TEXT}

${concurrencySlotsText(maxConcurrency)}`;
}

function defaultSubagentUsageHint(
  exposure: ToolExposure,
  shared: string,
  maxConcurrency: number,
): string {
  return `You are an agent in a team collaborating to complete a task.

You can spawn declared sub-agents recursively. All agents are equally capable and receive the tools declared for their agent type. Use \`${exposure.toolName('spawn_agent')}\` to create one, \`${exposure.toolName('followup_task')}\` to assign a new task and trigger a turn, and \`${exposure.toolName('send_message')}\` to queue a message for another agent.

Your final response is delivered automatically to your parent agent. Mailbox messages arrive as \`NEW_TASK\`, \`MESSAGE\`, or \`FINAL_ANSWER\` envelopes with their task name, sender, and payload preserved.

${shared}

${WAIT_AGENT_USAGE_HINT_TEXT}

${concurrencySlotsText(maxConcurrency)}`;
}
