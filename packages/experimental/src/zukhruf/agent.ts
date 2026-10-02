import type { TelemetryOptions } from 'ai';

import type { CompactOptions, CompactionTrigger } from '@deepagents/compaction';
import type {
  AgentModel,
  AgentSandbox,
  ContextFragment,
} from '@deepagents/context';

import type { AgentPluginDefinition } from './runtime/agent-runtime.ts';
import type { ZukhrufToolSet } from './tool.ts';

/**
 * Sandboxes are per-chat: the factory receives the conversation identity so
 * the backend can be named by `chatId` and re-attached across turns, workers,
 * and restarts (the container engine is the registry — no in-memory state).
 */
export interface SandboxContext {
  chatId: string;
  userId: string;
}

export type ZukhrufSandbox = AgentSandbox & {
  /** Absolute directory containing this conversation's files and skills. Omit to disable discovery. */
  readonly workingDirectory?: string;
};

/** Estimated input budget includes messages, instructions and tools; reserve output separately. */
export type AgentCompaction = Omit<
  CompactOptions,
  'messages' | 'abortSignal'
> & {
  /** Non-empty list, evaluated in order before each step. Any match requests compaction. */
  triggers: readonly CompactionTrigger[];
};

export interface AgentDeclaration {
  /**
   * Stable declaration identity persisted in conversation metadata.
   * It must be unique in one declaration graph and must not be renamed while
   * conversations created from that graph still exist.
   */
  name: string;
  description?: string;
  model: AgentModel;
  sandbox: (context: SandboxContext) => Promise<ZukhrufSandbox>;
  instructions: ContextFragment[];
  tools?: ZukhrufToolSet;
  /** Names of plugin-provided skills installed for this agent. */
  skills?: readonly string[];
  subagents?: AgentDeclaration[];
  /** Runtime plugins owned by this declaration when it is the root agent. */
  plugins?: readonly AgentPluginDefinition[];
  telemetry?: Omit<TelemetryOptions, 'integrations'>;
  /** Automatic compaction before model steps, with a durable conversation checkpoint. */
  compaction?: AgentCompaction;
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
