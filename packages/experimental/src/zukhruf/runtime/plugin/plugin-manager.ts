import type { Telemetry } from 'ai';

import type { AgentDeclaration } from '../../agent.ts';
import { createCollaborationTools } from '../../collaboration/collaboration-tools.ts';
import type { AgentDeclarationRegistry } from '../../control-plane/agent-declaration-registry.ts';
import type { ConversationId } from '../../mailbox/types.ts';
import type { ResolvedMultiAgentHostConfig } from '../../multi-agent-config.ts';
import type { ZukhrufToolSet } from '../../tool.ts';
import type {
  AgentPluginBinding,
  AgentPluginDefinition,
  AgentPluginHost,
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

/** Owns plugin instances, their composed contributions, and initialization resources. */
export class PluginManager implements AsyncDisposable {
  readonly collaborationTools: ReturnType<typeof createCollaborationTools>;
  readonly declarations: AgentDeclarationRegistry;
  readonly agentOwners: ReadonlyMap<string, string>;
  readonly tools: ZukhrufToolSet;
  readonly skillsByAgent: ReadonlyMap<string, PluginSkills>;
  readonly runtimeContext: Readonly<Record<string, unknown>>;

  readonly #plugins: readonly MaterializedAgentPlugin[];
  readonly #toolComposition: PluginToolComposition;
  readonly #resources = new AsyncDisposableStack();

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
    const collaborationTools = createCollaborationTools(multiAgent);
    const reservedToolNames = Object.keys(collaborationTools);
    if (multiAgent.codeMode) reservedToolNames.push('code_mode');
    const toolComposition = new PluginToolComposition(reservedToolNames);
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
    this.collaborationTools = collaborationTools;
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

  get<Instance extends object>(
    definition: AgentPluginDefinition<Instance>,
  ): AgentPluginInstance & Instance {
    const plugin = this.#plugins.find(
      ({ definition: candidate }) => candidate === definition,
    );
    if (!plugin) {
      throw new Error(
        `AgentRuntime: plugin "${definition.name}" does not belong to this runtime`,
      );
    }
    return plugin.instance as AgentPluginInstance & Instance;
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
    return this.#plugins.some(({ instance }) =>
      Boolean(instance.conversationAvailable),
    );
  }

  async startWorkers(
    host: AgentPluginHost,
    workers: AsyncDisposableStack,
    waitForActive: boolean,
  ): Promise<void> {
    // Share the queue worker's disposal scope to preserve error suppression order.
    for (const { instance } of this.#plugins) {
      if (instance.work) workers.use(await instance.work(host, waitForActive));
    }
  }

  async initialize(host: AgentPluginHost): Promise<void> {
    for (const { definition, instance } of this.#plugins) {
      const initialized = await instance.initialize?.(host);
      if (!initialized) continue;
      this.#resources.use(initialized);
      if (initialized.tools) {
        this.#toolComposition.add(definition.name, initialized.tools);
      }
    }
    Object.assign(
      this.tools,
      this.#toolComposition.compose(this.declarations.values()),
    );
  }

  async conversationAvailable(
    host: AgentPluginHost,
    conversation: ConversationId,
  ): Promise<void> {
    const errors: unknown[] = [];
    for (const { instance } of this.#plugins) {
      try {
        await instance.conversationAvailable?.(host, conversation);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `AgentRuntime: conversation availability reconciliation failed for "${conversation.chatId}": ${errors.map((error) => (error instanceof Error ? error.message : String(error))).join('; ')}`,
      );
    }
  }
}
