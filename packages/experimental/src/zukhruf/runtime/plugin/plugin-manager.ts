import type { Telemetry } from 'ai';

import type { AgentDeclaration } from '../../agent.ts';
import { createCollaborationSurface } from '../../collaboration/collaboration-tools.ts';
import type { AgentDeclarationRegistry } from '../../control-plane/agent-declaration-registry.ts';
import type { ConversationId } from '../../mailbox/types.ts';
import type { ResolvedMultiAgentHostConfig } from '../../multi-agent-config.ts';
import type { ZukhrufToolSet } from '../../tool.ts';
import type {
  AgentPluginBinding,
  AgentPluginDefinition,
  AgentPluginHost,
  AgentPluginInitialization,
  AgentPluginInstance,
  AgentPluginToolContext,
} from '../agent-runtime.ts';
import { PluginSkillComposition, type PluginSkills } from './agent-skills.ts';
import { PluginAgentComposition } from './plugin-agents.ts';
import { PluginBindings } from './plugin-bindings.ts';
import { PluginContextComposition } from './plugin-context-composition.ts';
import { PluginToolComposition } from './plugin-tool-composition.ts';

interface MaterializedAgentPlugin {
  readonly definition: AgentPluginDefinition;
  readonly instance: AgentPluginInstance;
}

interface RunningAgentPlugin {
  readonly definition: AgentPluginDefinition;
  readonly running: AgentPluginInitialization;
}

/**
 * A running phase comes only from the `initialize` of the instance that
 * `definition.create` returned, so it has the definition's running type.
 */
function initializedFrom<Running extends object>(
  plugin: RunningAgentPlugin,
  definition: AgentPluginDefinition<Running>,
): plugin is RunningAgentPlugin & {
  readonly running: AgentPluginInitialization & Running;
} {
  return plugin.definition === definition;
}

/** Owns plugin instances, their composed contributions, and initialization resources. */
export class PluginManager implements AsyncDisposable {
  readonly collaboration: ReturnType<typeof createCollaborationSurface>;
  readonly declarations: AgentDeclarationRegistry;
  readonly agentOwners: ReadonlyMap<string, string>;
  readonly tools: ZukhrufToolSet;
  readonly skillsByAgent: ReadonlyMap<string, PluginSkills>;
  readonly runtimeContext: Readonly<Record<string, unknown>>;

  readonly #plugins: readonly MaterializedAgentPlugin[];
  readonly #toolComposition: PluginToolComposition;
  readonly #resources = new AsyncDisposableStack();
  readonly #running: RunningAgentPlugin[] = [];

  constructor(
    root: AgentDeclaration,
    bindings: readonly AgentPluginBinding[] | undefined,
    multiAgent: ResolvedMultiAgentHostConfig,
  ) {
    let configuredRoot = root;
    const pluginBindings = new PluginBindings(root.plugins, bindings);
    const plugins: MaterializedAgentPlugin[] = [];
    if (root.plugins) {
      for (const definition of root.plugins) {
        plugins.push({
          definition,
          instance: definition.create(pluginBindings.resolve(definition)),
        });
      }
    }
    const pluginSkills = new PluginSkillComposition();
    const pluginContext = new PluginContextComposition();
    const collaboration = createCollaborationSurface(multiAgent);
    const toolComposition = new PluginToolComposition(
      collaboration.reservedToolNames,
    );
    for (const { definition, instance } of plugins) {
      if (instance.tools) {
        toolComposition.add(definition.name, instance.tools);
      }
      if (instance.skills) pluginSkills.add(instance.skills);
      if (instance.runtimeContext) {
        pluginContext.add(definition.name, instance.runtimeContext);
      }
    }
    for (const { instance } of plugins) {
      if (instance.configure)
        configuredRoot = instance.configure(configuredRoot);
    }
    const pluginAgents = new PluginAgentComposition(
      root,
      configuredRoot,
      plugins,
    );
    const declarations = pluginAgents.declarations;
    const pluginSkillsByAgent = pluginSkills.compose(declarations.values());
    const pluginTools = toolComposition.compose(declarations.values());
    this.#plugins = plugins;
    this.collaboration = collaboration;
    this.declarations = declarations;
    this.agentOwners = pluginAgents.owners;
    this.tools = pluginTools;
    this.skillsByAgent = pluginSkillsByAgent;
    this.runtimeContext = pluginContext.values;
    this.#toolComposition = toolComposition;
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.#resources.disposeAsync();
  }

  get<Running extends object>(
    definition: AgentPluginDefinition<Running>,
  ): AgentPluginInitialization & Running {
    if (!this.#plugins.some((plugin) => plugin.definition === definition)) {
      throw new Error(
        `AgentRuntime: plugin "${definition.name}" does not belong to this runtime`,
      );
    }
    const plugin = this.#running.find((candidate) =>
      initializedFrom(candidate, definition),
    );
    if (!plugin) {
      throw new Error(
        `AgentRuntime: plugin "${definition.name}" has no running phase, since its initialize() returned nothing`,
      );
    }
    return plugin.running;
  }

  configureTelemetry(
    context: AgentPluginToolContext,
    telemetry: AgentDeclaration['telemetry'],
  ) {
    const integrations: Telemetry[] = [];
    for (const { instance } of this.#plugins) {
      if (instance.telemetry) integrations.push(instance.telemetry(context));
    }
    return integrations.length === 0
      ? telemetry
      : { ...telemetry, integrations };
  }

  get reconcilesAvailability(): boolean {
    return this.#running.some(({ running }) =>
      Boolean(running.conversationAvailable),
    );
  }

  async startWorkers(workers: AsyncDisposableStack): Promise<void> {
    // Share the queue worker's disposal scope to preserve error suppression order.
    for (const { running } of this.#running) {
      if (running.work) workers.use(await running.work());
    }
  }

  async initialize(host: AgentPluginHost): Promise<void> {
    for (const { definition, instance } of this.#plugins) {
      const initialized = await instance.initialize?.(host);
      if (!initialized) continue;
      this.#running.push({ definition, running: initialized });
      this.#resources.defer(() => initialized[Symbol.asyncDispose]?.());
      if (initialized.tools) {
        this.#toolComposition.add(definition.name, initialized.tools);
      }
    }
    Object.assign(
      this.tools,
      this.#toolComposition.compose(this.declarations.values()),
    );
  }

  async conversationAvailable(conversation: ConversationId): Promise<void> {
    const errors: unknown[] = [];
    for (const { running } of this.#running) {
      try {
        await running.conversationAvailable?.(conversation);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `AgentRuntime: conversation availability reconciliation failed for "${conversation.chatId}": ${errors.map((error) => (Error.isError(error) ? error.message : String(error))).join('; ')}`,
      );
    }
  }
}
