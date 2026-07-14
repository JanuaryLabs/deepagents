import type { AgentDeclaration } from './agent.ts';

/** Immutable declaration lookup compiled once for one agent runtime. */
export class AgentDeclarationRegistry {
  readonly root: AgentDeclaration;

  readonly #declarations = new Map<string, AgentDeclaration>();

  constructor(root: AgentDeclaration) {
    this.root = root;
    this.#register(root, new Set());
  }

  get(name: string): AgentDeclaration | undefined {
    return this.#declarations.get(name);
  }

  #register(
    declaration: AgentDeclaration,
    visited: Set<AgentDeclaration>,
  ): void {
    if (visited.has(declaration)) return;
    visited.add(declaration);

    if (!declaration.name.trim()) {
      throw new Error('AgentRuntime: agent declaration name cannot be empty');
    }
    if (declaration.name !== declaration.name.trim()) {
      throw new Error(
        `AgentRuntime: agent declaration name "${declaration.name}" must not contain surrounding whitespace`,
      );
    }

    const existing = this.#declarations.get(declaration.name);
    if (existing && existing !== declaration) {
      throw new Error(
        `AgentRuntime: duplicate agent declaration name "${declaration.name}"`,
      );
    }
    this.#declarations.set(declaration.name, declaration);

    for (const subagent of declaration.subagents ?? []) {
      this.#register(subagent, visited);
    }
  }
}
