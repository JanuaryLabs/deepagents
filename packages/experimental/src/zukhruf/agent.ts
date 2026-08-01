import type { generateText } from 'ai';

import type {
  AgentModel,
  AgentSandbox,
  ContextFragment,
} from '@deepagents/context';

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
  model: AgentModel;
  sandbox: (context: SandboxContext) => Promise<ZukhrufSandbox>;
  instructions: ContextFragment[];
  tools?: ZukhrufToolSet;
  subagents?: AgentDeclaration[];
  telemetry?: Parameters<typeof generateText>[0]['telemetry'];
}

export interface DefinedAgentDeclaration extends AgentDeclaration {
  tools: ZukhrufToolSet;
  subagents: AgentDeclaration[];
}

export function defineAgent(
  declaration: AgentDeclaration,
): DefinedAgentDeclaration {
  return {
    name: declaration.name,
    model: declaration.model,
    sandbox: declaration.sandbox,
    instructions: declaration.instructions,
    tools: declaration.tools ?? {},
    subagents: declaration.subagents ?? [],
    telemetry: declaration.telemetry,
  };
}
