import type { AgentDeclaration } from '../../agent.ts';
import type { ZukhrufToolSet } from '../../tool.ts';

/** Collects shared tool contributions and publishes validated snapshots. */
export class PluginToolComposition {
  readonly #tools: ZukhrufToolSet = {};
  readonly #owners: Map<string, string>;

  constructor(reservedNames: readonly string[]) {
    this.#owners = new Map(reservedNames.map((name) => [name, 'the runtime']));
  }

  add(plugin: string, tools: ZukhrufToolSet): void {
    for (const [name, tool] of Object.entries(tools)) {
      const owner = this.#owners.get(name);
      if (owner) {
        throw new Error(
          `AgentRuntime: plugin tool "${name}" from "${plugin}" conflicts with ${owner}`,
        );
      }
      this.#owners.set(name, `plugin "${plugin}"`);
      this.#tools[name] = tool;
    }
  }

  compose(declarations: Iterable<AgentDeclaration>): ZukhrufToolSet {
    for (const declaration of declarations) {
      if (!declaration.tools) continue;
      for (const name of Object.keys(declaration.tools)) {
        const owner = this.#owners.get(name);
        if (owner) {
          throw new Error(
            `AgentRuntime: tool "${name}" on agent "${declaration.name}" conflicts with ${owner}`,
          );
        }
      }
    }
    return { ...this.#tools };
  }
}
