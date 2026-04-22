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
} from '@deepagents/context';

import type { Adapter } from './adapters/adapter.ts';
import { toSql } from './agents/sql.agent.ts';
import { JsonCache } from './file-cache.ts';
import { guidelines } from './instructions.ts';
import { type ExtractedPair, type PairProducer } from './synthesis/types.ts';

export type RenderingTools = Record<string, Tool<unknown, never>>;

export interface Text2SqlConfig {
  adapter: Adapter;
  sandbox: AgentSandbox;
  context: (...fragments: ContextFragment[]) => ContextEngine;
  version: string;
  tools?: RenderingTools;
  model: AgentModel;
  transform?: StreamTextTransform<ToolSet> | StreamTextTransform<ToolSet>[];
}

/**
 * Text2Sql — the caller owns the sandbox. Build one by passing
 * `hostExtensions: [sqlSandboxExtension(adapter), ...yourOwnExtensions]` to
 * `createRoutingSandbox`, layered over whichever backend you want
 * (virtual, Docker, Agent OS), then wrap with `createBashTool`. For file
 * event tracking, wrap the fs in `ObservedFs` before passing to the
 * backend and attach `drainFileEvents: () => observed.drain()` to the
 * resulting sandbox.
 */
export class Text2Sql {
  #config: Text2SqlConfig & {
    introspection: JsonCache<ContextFragment[]>;
  };

  constructor(config: Text2SqlConfig) {
    this.#config = {
      ...config,
      tools: config.tools ?? {},
      introspection: new JsonCache<ContextFragment[]>(
        'introspection-' + config.version,
      ),
    };
  }

  public async toSql(input: string): Promise<string> {
    const schemaFragments = await this.index();
    const result = await toSql({
      input,
      adapter: this.#config.adapter,
      fragments: schemaFragments,
      model: this.#config.model,
    });
    return result.sql;
  }

  public async index(): Promise<ContextFragment[]> {
    const cached = await this.#config.introspection.read();
    if (cached) {
      return cached;
    }
    const fragments = await this.#config.adapter.introspect();
    await this.#config.introspection.write(fragments);
    return fragments;
  }

  public async toPairs<T extends PairProducer>(
    factory: (adapter: Adapter) => T,
  ): Promise<ExtractedPair[]> {
    const producer = factory(this.#config.adapter);
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
