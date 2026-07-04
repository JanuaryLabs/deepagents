import type { ToolSet } from 'ai';

import type {
  AgentModel,
  AgentSandbox,
  ContextFragment,
} from '@deepagents/context';

/**
 * Sandboxes are per-chat: the factory receives the conversation identity so
 * the backend can be named by `chatId` and re-attached across turns, workers,
 * and restarts (the container engine is the registry — no in-memory state).
 */
export interface SandboxContext {
  chatId: string;
  userId: string;
}

export interface AgentDeclaration {
  name: string;
  model: AgentModel;
  sandbox: (context: SandboxContext) => Promise<AgentSandbox>;
  instructions: ContextFragment[];
  tools?: ToolSet;
}

export function defineAgent(declaration: {
  model: AgentModel;
  sandbox: (context: SandboxContext) => Promise<AgentSandbox>;
  instructions: ContextFragment[];
  tools?: ToolSet;
  name?: string;
}): AgentDeclaration {
  return {
    name: declaration.name ?? 'agent',
    model: declaration.model,
    sandbox: declaration.sandbox,
    instructions: declaration.instructions,
    tools: declaration.tools,
  };
}
