const DEFAULT_MIN_WAIT_TIMEOUT_MS = 10_000;
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_WAIT_TIMEOUT_MS = 3_600_000;

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

/** Host-level controls matching Codex MultiAgentV2 configuration. */
export interface MultiAgentV2HostConfig {
  minWaitTimeoutMs?: number;
  defaultWaitTimeoutMs?: number;
  maxWaitTimeoutMs?: number;
  /** Additional guidance appended to the spawn_agent tool description. */
  usageHintText?: string;
  /** Complete root guidance override. An empty string disables the hint. */
  rootAgentUsageHintText?: string;
  /** Complete child guidance override. An empty string disables the hint. */
  subagentUsageHintText?: string;
  /** Native OpenAI Responses namespace for the six collaboration tools. */
  toolNamespace?: string;
  /**
   * Keeps collaboration tools on the direct model surface instead of a nested
   * code-mode executor. Defaults to true. Zukhruf currently rejects false
   * because it has no nested code-mode executor in which to expose the tools.
   */
  nonCodeModeOnly?: boolean;
}

export interface ResolvedMultiAgentV2HostConfig {
  minWaitTimeoutMs: number;
  defaultWaitTimeoutMs: number;
  maxWaitTimeoutMs: number;
  usageHintText?: string;
  rootAgentUsageHintText?: string;
  subagentUsageHintText?: string;
  toolNamespace?: string;
  nonCodeModeOnly: boolean;
}

export function resolveMultiAgentV2HostConfig(
  input: MultiAgentV2HostConfig = {},
): ResolvedMultiAgentV2HostConfig {
  const minWaitTimeoutMs =
    input.minWaitTimeoutMs ?? DEFAULT_MIN_WAIT_TIMEOUT_MS;
  const defaultWaitTimeoutMs =
    input.defaultWaitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const maxWaitTimeoutMs =
    input.maxWaitTimeoutMs ?? DEFAULT_MAX_WAIT_TIMEOUT_MS;
  assertTimeout('minWaitTimeoutMs', minWaitTimeoutMs);
  assertTimeout('defaultWaitTimeoutMs', defaultWaitTimeoutMs);
  assertTimeout('maxWaitTimeoutMs', maxWaitTimeoutMs);
  if (minWaitTimeoutMs > maxWaitTimeoutMs) {
    throw new Error(
      'AgentRuntime: multiAgentV2.minWaitTimeoutMs must be at most maxWaitTimeoutMs',
    );
  }
  if (defaultWaitTimeoutMs < minWaitTimeoutMs) {
    throw new Error(
      'AgentRuntime: multiAgentV2.defaultWaitTimeoutMs must be at least minWaitTimeoutMs',
    );
  }
  if (defaultWaitTimeoutMs > maxWaitTimeoutMs) {
    throw new Error(
      'AgentRuntime: multiAgentV2.defaultWaitTimeoutMs must be at most maxWaitTimeoutMs',
    );
  }

  const toolNamespace = input.toolNamespace;
  if (
    toolNamespace !== undefined &&
    (toolNamespace.length === 0 || toolNamespace.trim() !== toolNamespace)
  ) {
    throw new Error(
      'AgentRuntime: multiAgentV2.toolNamespace cannot be empty or padded',
    );
  }
  if (toolNamespace !== undefined) validateToolNamespace(toolNamespace);

  const nonCodeModeOnly = input.nonCodeModeOnly ?? true;
  if (!nonCodeModeOnly) {
    throw new Error(
      'AgentRuntime: multiAgentV2.nonCodeModeOnly=false requires a nested code-mode executor, which Zukhruf does not provide',
    );
  }
  const tool = (name: string) =>
    toolNamespace === undefined ? name : `${toolNamespace}.${name}`;
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
  const shared = `Call ${collaborationTools} directly. They are intentionally unavailable inside nested code execution.

All agents share the same workspace, current working directory, and filesystem.`;

  return {
    minWaitTimeoutMs,
    defaultWaitTimeoutMs,
    maxWaitTimeoutMs,
    usageHintText: nonEmptyText(input.usageHintText),
    rootAgentUsageHintText:
      input.rootAgentUsageHintText === undefined
        ? defaultRootUsageHint(tool, shared)
        : nonEmptyText(input.rootAgentUsageHintText),
    subagentUsageHintText:
      input.subagentUsageHintText === undefined
        ? defaultSubagentUsageHint(tool, shared)
        : nonEmptyText(input.subagentUsageHintText),
    toolNamespace,
    nonCodeModeOnly,
  };
}

function assertTimeout(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `AgentRuntime: multiAgentV2.${name} must be a non-negative safe integer`,
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
      `AgentRuntime: multiAgentV2.toolNamespace "${namespace}" is a reserved tool namespace or invalid`,
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
): string {
  return `You are \`/root\`, the primary agent in a team of agents collaborating to fulfill the user's goals.

At the start of your turn, you are the active agent. You can spawn sub-agents to handle subtasks, and those agents can recursively spawn their own declared sub-agents. All agents are equally capable and receive the tools declared for their agent type.

Use \`${tool('spawn_agent')}\` to create an agent, \`${tool('followup_task')}\` to assign a new task and trigger a turn, and \`${tool('send_message')}\` to queue a message without triggering a turn. Use \`fork_turns\` to control how much parent history the child receives.

Child messages arrive as \`MESSAGE\` or \`FINAL_ANSWER\` mailbox envelopes with their task name, sender, and payload preserved.

${shared}`;
}

function defaultSubagentUsageHint(
  tool: (name: string) => string,
  shared: string,
): string {
  return `You are an agent in a team collaborating to complete a task.

You can spawn declared sub-agents recursively. All agents are equally capable and receive the tools declared for their agent type. Use \`${tool('spawn_agent')}\` to create one, \`${tool('followup_task')}\` to assign a new task and trigger a turn, and \`${tool('send_message')}\` to queue a message for another agent.

Your final response is delivered automatically to your parent agent. Mailbox messages arrive as \`NEW_TASK\`, \`MESSAGE\`, or \`FINAL_ANSWER\` envelopes with their task name, sender, and payload preserved.

${shared}`;
}
