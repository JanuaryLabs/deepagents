const DEFAULT_MIN_WAIT_TIMEOUT_MS = 10_000;
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_WAIT_TIMEOUT_MS = 3_600_000;
/** Codex `DEFAULT_MULTI_AGENT_V2_MAX_CONCURRENT_THREADS_PER_SESSION`. */
const DEFAULT_MAX_CONCURRENT_THREADS_PER_SESSION = 4;
/** Verbatim Codex guidance (`core/src/session/multi_agents.rs`). */
const WAIT_AGENT_USAGE_HINT_TEXT =
  'When calling `wait_agent`, prefer longer waits (minutes) to avoid busy polling.';

/** Verbatim Codex `resolve_usage_hints` closing sentence. */
function concurrencySlotsText(maxConcurrency: number): string {
  return `There are ${maxConcurrency} available concurrency slots, meaning that up to ${maxConcurrency} agents can be active at once, including you.`;
}

const RESERVED_TOOL_NAMESPACES = new Set([
  'api_tool',
  'browser',
  'computer',
  'container',
  'file_search',
  'functions',
  'image_gen',
  'multi_tool_use',
  'python',
  'python_user_visible',
  'submodel_delegator',
  'terminal',
  'tool_search',
  'web',
]);

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
  toolNamespace?: string;
  codeMode: boolean;
}

export function resolveMultiAgentHostConfig(
  input: MultiAgentHostConfig = {},
): ResolvedMultiAgentHostConfig {
  const minWaitTimeoutMs =
    input.minWaitTimeoutMs ?? DEFAULT_MIN_WAIT_TIMEOUT_MS;
  const defaultWaitTimeoutMs =
    input.defaultWaitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const maxWaitTimeoutMs =
    input.maxWaitTimeoutMs ?? DEFAULT_MAX_WAIT_TIMEOUT_MS;
  assertTimeout('minWaitTimeoutMs', minWaitTimeoutMs);
  assertTimeout('defaultWaitTimeoutMs', defaultWaitTimeoutMs);
  assertTimeout('maxWaitTimeoutMs', maxWaitTimeoutMs);
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
  if (minWaitTimeoutMs > maxWaitTimeoutMs) {
    throw new Error(
      'AgentRuntime: multiAgent.minWaitTimeoutMs must be at most maxWaitTimeoutMs',
    );
  }
  if (defaultWaitTimeoutMs < minWaitTimeoutMs) {
    throw new Error(
      'AgentRuntime: multiAgent.defaultWaitTimeoutMs must be at least minWaitTimeoutMs',
    );
  }
  if (defaultWaitTimeoutMs > maxWaitTimeoutMs) {
    throw new Error(
      'AgentRuntime: multiAgent.defaultWaitTimeoutMs must be at most maxWaitTimeoutMs',
    );
  }

  const toolNamespace = input.toolNamespace;
  if (
    toolNamespace !== undefined &&
    (toolNamespace.length === 0 || toolNamespace.trim() !== toolNamespace)
  ) {
    throw new Error(
      'AgentRuntime: multiAgent.toolNamespace cannot be empty or padded',
    );
  }
  if (toolNamespace !== undefined) validateToolNamespace(toolNamespace);

  const codeMode = input.nonCodeModeOnly === false;
  const tool = (name: string) =>
    codeMode
      ? `tools.${name}`
      : toolNamespace === undefined
        ? name
        : `${toolNamespace}.${name}`;
  const collaborationTools = [
    'spawn_agent',
    'send_message',
    'followup_task',
    'wait_agent',
    'interrupt_agent',
    'list_agents',
  ]
    .map((name) => `\`${tool(name)}\``)
    .join(', ');
  const shared = codeMode
    ? `Call ${collaborationTools} from \`code_mode\`.

All agents share the same workspace, current working directory, and filesystem.`
    : `Call ${collaborationTools} directly. They are intentionally unavailable inside nested code execution.

All agents share the same workspace, current working directory, and filesystem.`;

  return {
    minWaitTimeoutMs,
    defaultWaitTimeoutMs,
    maxWaitTimeoutMs,
    maxConcurrentThreadsPerSession,
    usageHintText: nonEmptyText(input.usageHintText),
    rootAgentUsageHintText:
      input.rootAgentUsageHintText === undefined
        ? defaultRootUsageHint(tool, shared, maxConcurrentThreadsPerSession)
        : nonEmptyText(input.rootAgentUsageHintText),
    subagentUsageHintText:
      input.subagentUsageHintText === undefined
        ? defaultSubagentUsageHint(tool, shared, maxConcurrentThreadsPerSession)
        : nonEmptyText(input.subagentUsageHintText),
    toolNamespace,
    codeMode,
  };
}

function assertTimeout(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `AgentRuntime: multiAgent.${name} must be a non-negative safe integer`,
    );
  }
}

function validateToolNamespace(namespace: string): void {
  if (
    namespace.length > 64 ||
    !/^[a-zA-Z0-9_-]+$/.test(namespace) ||
    namespace === 'mcp' ||
    namespace.startsWith('mcp__') ||
    RESERVED_TOOL_NAMESPACES.has(namespace)
  ) {
    throw new Error(
      `AgentRuntime: multiAgent.toolNamespace "${namespace}" is a reserved tool namespace or invalid`,
    );
  }
}

function nonEmptyText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.length === 0 ? undefined : value;
}

function defaultRootUsageHint(
  tool: (name: string) => string,
  shared: string,
  maxConcurrency: number,
): string {
  return `You are \`/root\`, the primary agent in a team of agents collaborating to fulfill the user's goals.

At the start of your turn, you are the active agent. You can spawn sub-agents to handle subtasks, and those agents can recursively spawn their own declared sub-agents. All agents are equally capable and receive the tools declared for their agent type.

Use \`${tool('spawn_agent')}\` to create an agent, \`${tool('followup_task')}\` to assign a new task and trigger a turn, and \`${tool('send_message')}\` to queue a message without triggering a turn. Every spawn must set \`fork_turns\` to \`none\`, \`all\`, or a positive count of recent turns.

Child messages arrive as \`MESSAGE\` or \`FINAL_ANSWER\` mailbox envelopes with their task name, sender, and payload preserved.

${shared}

${WAIT_AGENT_USAGE_HINT_TEXT}

${concurrencySlotsText(maxConcurrency)}`;
}

function defaultSubagentUsageHint(
  tool: (name: string) => string,
  shared: string,
  maxConcurrency: number,
): string {
  return `You are an agent in a team collaborating to complete a task.

You can spawn declared sub-agents recursively. All agents are equally capable and receive the tools declared for their agent type. Use \`${tool('spawn_agent')}\` to create one, \`${tool('followup_task')}\` to assign a new task and trigger a turn, and \`${tool('send_message')}\` to queue a message for another agent.

Your final response is delivered automatically to your parent agent. Mailbox messages arrive as \`NEW_TASK\`, \`MESSAGE\`, or \`FINAL_ANSWER\` envelopes with their task name, sender, and payload preserved.

${shared}

${WAIT_AGENT_USAGE_HINT_TEXT}

${concurrencySlotsText(maxConcurrency)}`;
}
