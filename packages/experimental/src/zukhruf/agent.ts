import type { ProviderOptions } from '@ai-sdk/provider-utils';
import type { TelemetryOptions } from 'ai';

import type { CompactOptions, CompactionTrigger } from '@deepagents/compaction';
import type {
  AgentControls,
  AgentModel,
  AgentSandbox,
  BashToolkitTools,
  ChatSandbox,
  ContextFragment,
  CreateAgent,
  SandboxContext,
  SandboxEnvironment,
  StoppableSandboxEnvironment,
} from '@deepagents/context';

import type {
  AgentPluginDefinition,
  AgentPluginToolContext,
} from './runtime/agent-runtime.ts';
import type { ZukhrufToolSet } from './tool.ts';

/**
 * Needs both file tools: the uploads plugin tells the model to read attached
 * images with `readFile`.
 */
export type ZukhrufSandbox = AgentSandbox<BashToolkitTools, ChatSandbox> & {
  /** Absolute directory containing this conversation's files and skills. Omit to disable discovery. */
  readonly workingDirectory?: string;
};

/**
 * An agent's sandboxes in an environment that can stop them: where each
 * chat's sandbox lives, how long it keeps running once its chat is idle, and
 * how a chat's handle is opened and wrapped in the Bash toolkit.
 */
export interface StoppableSandboxDeclaration {
  /** Where each chat's sandbox lives; its `stop` and `delete` reach the sandboxes `open` opened. */
  readonly environment: StoppableSandboxEnvironment;
  /**
   * Milliseconds a chat's sandbox keeps running once the chat is idle, after
   * which the runtime stops it and keeps its files: `0` stops it as soon as
   * the chat is idle, `false` never stops it.
   */
  readonly idleTimeoutMs: number | false;
  /** Opens the chat's sandbox and wraps it in the Bash toolkit. */
  open(chat: SandboxContext): Promise<ZukhrufSandbox>;
}

/**
 * An agent's sandboxes in an environment that cannot stop them, so they have
 * no idle time.
 */
export interface SessionSandboxDeclaration {
  /** Where each chat's sandbox lives; its `delete` reaches the sandboxes `open` opened. */
  readonly environment: SandboxEnvironment & { readonly stop?: never };
  readonly idleTimeoutMs?: never;
  /** Opens the chat's sandbox and wraps it in the Bash toolkit. */
  open(chat: SandboxContext): Promise<ZukhrufSandbox>;
}

/** An agent's sandboxes: a stoppable environment's carry an idle time, any other's none. */
export type ZukhrufSandboxDeclaration =
  StoppableSandboxDeclaration | SessionSandboxDeclaration;

/** Estimated input budget includes messages, instructions and tools; reserve output separately. */
export type AgentCompaction = Omit<
  CompactOptions,
  'messages' | 'abortSignal'
> & {
  /** Non-empty list, evaluated in order before each step. Any match requests compaction. */
  triggers: readonly CompactionTrigger[];
};

export interface AgentDeclaration extends AgentControls<ZukhrufToolSet> {
  /**
   * Stable declaration identity persisted in conversation metadata.
   * It must be unique in one declaration graph and must not be renamed while
   * conversations created from that graph still exist.
   */
  name: string;
  description?: string;
  model: AgentModel;
  /**
   * Sandboxes are per-chat: the environment names each chat's sandbox from
   * its namespace and `chatId`, so every turn, worker and restart opens the
   * same one (the backend is the registry — no in-memory state).
   */
  sandbox: ZukhrufSandboxDeclaration;
  /** Native agent-loop termination; omitted uses the context agent default. */
  stopWhen?: CreateAgent['stopWhen'];
  instructions: ContextFragment[];
  tools?: ZukhrufToolSet;
  /** Names of plugin-provided skills installed for this agent. */
  skills?: readonly string[];
  subagents?: AgentDeclaration[];
  /** Runtime plugins owned by this declaration when it is the root agent. */
  plugins?: readonly AgentPluginDefinition[];
  telemetry?: Omit<TelemetryOptions, 'integrations'>;
  /**
   * The AI SDK's call-level provider options, sent on every step of a turn.
   * A function is evaluated once per turn, so a value can depend on the
   * conversation; its rejection fails the turn.
   */
  providerOptions?:
    | ProviderOptions
    | ((
        context: AgentPluginToolContext,
      ) => ProviderOptions | PromiseLike<ProviderOptions>);
  /** Automatic compaction before model steps, with a durable conversation checkpoint. */
  compaction?: AgentCompaction;
  /**
   * Generates a session's title with this model when this declaration is the
   * root agent; a sub-agent's chat never calls it. The first message titles
   * every chat at once either way, and the generated title replaces it only
   * while no one has renamed the session.
   */
  title?: { model: AgentModel };
}

export interface DefinedAgentDeclaration extends AgentDeclaration {
  tools: ZukhrufToolSet;
  subagents: AgentDeclaration[];
  plugins: readonly AgentPluginDefinition[];
}

export function defineAgent(
  declaration: AgentDeclaration,
): DefinedAgentDeclaration {
  if (declaration.compaction) {
    const { targetTokens, triggers } = declaration.compaction;
    if (!Number.isSafeInteger(targetTokens) || targetTokens < 1) {
      throw new RangeError(
        'compaction targetTokens must be a positive safe integer.',
      );
    }
    if (
      !Array.isArray(triggers) ||
      triggers.length === 0 ||
      triggers.some((trigger) => typeof trigger !== 'function')
    ) {
      throw new TypeError(
        'compaction triggers must be a non-empty array of functions.',
      );
    }
  }
  return {
    ...declaration,
    tools: declaration.tools ?? {},
    subagents: declaration.subagents ? [...declaration.subagents] : [],
    plugins: declaration.plugins ? [...declaration.plugins] : [],
  };
}
