import { CodeModeTools } from './collaboration/code-mode-tools.ts';
import { DirectTools } from './collaboration/direct-tools.ts';
import { Team } from './collaboration/team.ts';
import type { ToolExposure } from './collaboration/tool-exposure.ts';
import { ToolNamespace } from './collaboration/tool-namespace.ts';
import { WaitBounds } from './collaboration/wait-bounds.ts';

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

/** Temporary adapter from the host config to the team it describes (#4775). */
export function resolveMultiAgentHostConfig(input: MultiAgentHostConfig = {}) {
  const waitBounds = new WaitBounds({
    minMs: input.minWaitTimeoutMs,
    defaultMs: input.defaultWaitTimeoutMs,
    maxMs: input.maxWaitTimeoutMs,
  });
  return Team.codex({
    usageHintText: nonEmptyText(input.usageHintText),
    waitBounds,
    maxConcurrentThreads: input.maxConcurrentThreadsPerSession,
    exposure: toolExposure(input),
    guidance: {
      root: override(input.rootAgentUsageHintText),
      subagent: override(input.subagentUsageHintText),
    },
  });
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

function override(
  text: string | undefined,
): ((composed: string) => string | undefined) | undefined {
  if (text === undefined) return undefined;
  return () => nonEmptyText(text);
}

function nonEmptyText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.length === 0 ? undefined : value;
}
