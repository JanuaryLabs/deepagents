import type { TelemetryOptions } from 'ai';

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
  subagents?: AgentDeclaration[];
  /** Runtime plugins owned by this declaration when it is the root agent. */
  plugins?: readonly AgentPluginDefinition[];
  telemetry?: Omit<TelemetryOptions, 'integrations'>;
}

export interface DefinedAgentDeclaration extends AgentDeclaration {
  tools: ZukhrufToolSet;
  subagents: AgentDeclaration[];
  plugins: readonly AgentPluginDefinition[];
}

export function defineAgent(
  declaration: AgentDeclaration,
): DefinedAgentDeclaration {
  return {
    ...declaration,
    tools: declaration.tools ?? {},
    subagents: declaration.subagents ? [...declaration.subagents] : [],
    plugins: declaration.plugins ? [...declaration.plugins] : [],
  };
}
