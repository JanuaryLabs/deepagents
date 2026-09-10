/** Composes plugin context while reserving the runtime's own namespace. */
export class PluginContextComposition {
  readonly values: Record<string, unknown> = {};
  readonly #owners = new Map<string, string>([['zukhruf', 'the runtime']]);

  add(plugin: string, context: Readonly<Record<string, unknown>>): void {
    for (const [name, value] of Object.entries(context)) {
      const owner = this.#owners.get(name);
      if (owner) {
        throw new Error(
          `AgentRuntime: runtime context "${name}" from plugin "${plugin}" conflicts with ${owner}`,
        );
      }
      this.#owners.set(name, `plugin "${plugin}"`);
      this.values[name] = value;
    }
  }
}
