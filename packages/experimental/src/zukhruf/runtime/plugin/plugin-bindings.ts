import type {
  AgentPluginBinding,
  AgentPluginBindings,
  AgentPluginCapability,
  AgentPluginDefinition,
} from '../agent-runtime.ts';

/** Validates plugin declarations and supplies each plugin's declared bindings. */
export class PluginBindings {
  readonly #values: Map<AgentPluginCapability<unknown>, unknown>;

  constructor(
    definitions: readonly AgentPluginDefinition[] | undefined,
    bindings: readonly AgentPluginBinding[] | undefined,
  ) {
    const pluginNames = new Set<string>();
    const capabilities = new Map<
      string,
      { capability: AgentPluginCapability<unknown>; plugin: string }
    >();
    if (definitions) {
      for (const definition of definitions) {
        if (!definition.name.trim()) {
          throw new Error('AgentRuntime: plugin name cannot be empty');
        }
        if (definition.name !== definition.name.trim()) {
          throw new Error(
            `AgentRuntime: plugin name "${definition.name}" must not contain surrounding whitespace`,
          );
        }
        if (pluginNames.has(definition.name)) {
          throw new Error(
            `AgentRuntime: duplicate plugin name "${definition.name}"`,
          );
        }
        pluginNames.add(definition.name);
        if (!definition.capabilities) continue;
        const declaredCapabilities = new Set<AgentPluginCapability<unknown>>();
        for (const capability of definition.capabilities) {
          if (declaredCapabilities.has(capability)) {
            throw new Error(
              `AgentRuntime: plugin "${definition.name}" declares duplicate capability "${capability.name}"`,
            );
          }
          declaredCapabilities.add(capability);
          if (!capability.name.trim()) {
            throw new Error(
              `AgentRuntime: capability name from plugin "${definition.name}" cannot be empty`,
            );
          }
          if (capability.name !== capability.name.trim()) {
            throw new Error(
              `AgentRuntime: capability "${capability.name}" from plugin "${definition.name}" must not contain surrounding whitespace`,
            );
          }
          const existing = capabilities.get(capability.name);
          if (existing && existing.capability !== capability) {
            throw new Error(
              `AgentRuntime: capability "${capability.name}" from plugin "${definition.name}" conflicts with plugin "${existing.plugin}"`,
            );
          }
          if (!existing) {
            capabilities.set(capability.name, {
              capability,
              plugin: definition.name,
            });
          }
        }
      }
    }
    this.#values = new Map<AgentPluginCapability<unknown>, unknown>();
    const bindingNames = new Set<string>();
    if (bindings) {
      for (const binding of bindings) {
        if (bindingNames.has(binding.capability.name)) {
          throw new Error(
            `AgentRuntime: duplicate binding for capability "${binding.capability.name}"`,
          );
        }
        bindingNames.add(binding.capability.name);
        const required = capabilities.get(binding.capability.name);
        if (!required || required.capability !== binding.capability) {
          throw new Error(
            `AgentRuntime: unused binding for capability "${binding.capability.name}"`,
          );
        }
        this.#values.set(binding.capability, binding.value);
      }
    }
  }

  resolve(definition: AgentPluginDefinition): AgentPluginBindings {
    const declared = new Set(definition.capabilities);
    if (definition.capabilities) {
      for (const capability of definition.capabilities) {
        if (!this.#values.has(capability)) {
          throw new Error(
            `AgentRuntime: plugin "${definition.name}" requires missing capability "${capability.name}"`,
          );
        }
      }
    }
    return {
      get: <Value>(capability: AgentPluginCapability<Value>): Value => {
        if (!declared.has(capability)) {
          throw new Error(
            `AgentRuntime: plugin "${definition.name}" did not declare capability "${capability.name}"`,
          );
        }
        return this.#values.get(capability) as Value;
      },
    };
  }
}
