import type { StreamTextTransform, Tool, ToolSet } from 'ai';

import { type AgentModel } from '@deepagents/agent';
import {
  type AgentSandbox,
  type ChatMessage,
  ContextEngine,
  type ContextFragment,
  agent,
  chat,
  errorRecoveryGuardrail,
  fragment,
} from '@deepagents/context';

import { validateAdapterNames } from './adapter-name.ts';
import type { Adapter } from './adapters/adapter.ts';
import { toSql } from './agents/sql.agent.ts';
import { JsonCache } from './file-cache.ts';
import { guidelines } from './instructions.ts';
import { type ExtractedPair, type PairProducer } from './synthesis/types.ts';

export type RenderingTools = Record<string, Tool<unknown, never>>;

export interface Text2SqlConfig {
  adapters: Record<string, Adapter>;
  sandbox: AgentSandbox;
  context: (...fragments: ContextFragment[]) => ContextEngine;
  version: string;
  tools?: RenderingTools;
  model: AgentModel;
  transform?: StreamTextTransform<ToolSet> | StreamTextTransform<ToolSet>[];
}

/**
 * Text2Sql — the caller owns the sandbox. Build one by passing
 * `hostExtensions: [sqlSandboxExtension({ main: adapter }), ...yourOwnExtensions]`
 * to `createRoutingSandbox`, layered over whichever backend you want
 * (virtual, Docker, Agent OS), then wrap with `createBashTool`. For file
 * event tracking, wrap the fs in `ObservedFs` before passing to the
 * backend and attach `drainFileEvents: () => observed.drain()` to the
 * resulting sandbox.
 */
export class Text2Sql {
  #config: Omit<Text2SqlConfig, 'tools'> & {
    tools: RenderingTools;
  };
  #introspection: Map<string, JsonCache<ContextFragment[]>>;

  constructor(config: Text2SqlConfig) {
    validateAdapterNames(Object.keys(config.adapters));
    this.#config = {
      ...config,
      tools: config.tools ?? {},
    };
    this.#introspection = new Map(
      Object.keys(config.adapters).map((name) => [
        name,
        new JsonCache<ContextFragment[]>(
          `introspection-${config.version}-${name}`,
        ),
      ]),
    );
  }

  #requireAdapter(name: string): Adapter {
    const adapter = this.#config.adapters[name];
    if (!adapter) {
      const available = Object.keys(this.#config.adapters).join(', ');
      throw new Error(`Unknown adapter "${name}". Available: ${available}`);
    }
    return adapter;
  }

  public async toSql(input: string, adapterName: string): Promise<string> {
    const adapter = this.#requireAdapter(adapterName);
    const fragments = await this.#indexAdapter(adapterName, adapter);
    const result = await toSql({
      input,
      adapter,
      fragments,
      model: this.#config.model,
    });
    return result.sql;
  }

  public async index(): Promise<ContextFragment[]> {
    const entries = Object.entries(this.#config.adapters);
    const wrapped = await Promise.all(
      entries.map(async ([name, adapter]) => {
        const schema = await this.#indexAdapter(name, adapter);
        return fragment(name, ...schema);
      }),
    );
    return wrapped;
  }

  async #indexAdapter(
    name: string,
    adapter: Adapter,
  ): Promise<ContextFragment[]> {
    const cache = this.#introspection.get(name);
    if (!cache) {
      throw new Error(`no introspection cache registered for "${name}"`);
    }
    const cached = await cache.read();
    if (cached) {
      return cached;
    }
    try {
      const fragments = await adapter.introspect();
      await cache.write(fragments);
      return fragments;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`introspecting adapter "${name}": ${reason}`, {
        cause: error,
      });
    }
  }

  public async toPairs<T extends PairProducer>(
    adapterName: string,
    factory: (adapter: Adapter) => T,
  ): Promise<ExtractedPair[]> {
    const adapter = this.#requireAdapter(adapterName);
    const producer = factory(adapter);
    return producer.toPairs();
  }

  public async chat(
    messages: ChatMessage[],
    options?: { abortSignal?: AbortSignal; generateTitle?: boolean },
  ) {
    if (messages.length === 0) {
      throw new Error('messages must not be empty');
    }

    const context = this.#config.context(
      ...guidelines(),
      ...(await this.index()),
    );

    const chatAgent = agent({
      name: 'text2sql',
      sandbox: this.#config.sandbox,
      model: this.#config.model,
      context,
      tools: this.#config.tools,
      guardrails: [errorRecoveryGuardrail],
      maxGuardrailRetries: 3,
    });

    return chat(chatAgent, messages, {
      abortSignal: options?.abortSignal,
      generateTitle: options?.generateTitle,
      transform: this.#config.transform,
    });
  }
}
