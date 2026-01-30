import {
  APICallError,
  InvalidToolInputError,
  NoSuchToolError,
  type StreamTextTransform,
  type Tool,
  ToolCallRepairError,
  type ToolSet,
  type UIMessage,
  generateId,
} from 'ai';
import { type IFileSystem } from 'just-bash';

import { type AgentModel } from '@deepagents/agent';
import {
  ContextEngine,
  type ContextFragment,
  agent,
  assistant,
  errorRecoveryGuardrail,
  message,
} from '@deepagents/context';

import type { Adapter } from './adapters/adapter.ts';
import developerExports from './agents/developer.agent.ts';
import { createResultTools } from './agents/result-tools.ts';
import { toSql } from './agents/sql.agent.ts';
import { JsonCache } from './file-cache.ts';
import { TrackedFs } from './fs/tracked-fs.ts';
import { type TeachingsOptions, guidelines } from './instructions.ts';
import { type ExtractedPair, type PairProducer } from './synthesis/types.ts';

export type RenderingTools = Record<string, Tool<unknown, never>>;

export class Text2Sql {
  #config: {
    model: AgentModel;
    adapter: Adapter;
    context: (...fragments: ContextFragment[]) => ContextEngine;
    tools?: RenderingTools;
    introspection: JsonCache<ContextFragment[]>;
    teachingsOptions?: TeachingsOptions;
    transform?: StreamTextTransform<ToolSet> | StreamTextTransform<ToolSet>[];
    filesystem: IFileSystem;
  };

  constructor(config: {
    adapter: Adapter;
    context: (...fragments: ContextFragment[]) => ContextEngine;
    version: string;
    tools?: RenderingTools;
    model: AgentModel;
    transform?: StreamTextTransform<ToolSet> | StreamTextTransform<ToolSet>[];
    /** @see TeachingsOptions */
    teachingsOptions?: TeachingsOptions;
    filesystem: IFileSystem;
  }) {
    this.#config = {
      teachingsOptions: config.teachingsOptions,
      adapter: config.adapter,
      context: config.context,
      tools: config.tools ?? {},
      model: config.model,
      transform: config.transform,
      filesystem: config.filesystem,
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
      schemaFragments,
      instructions: [],
      model: this.#config.model,
    });
    return result.sql;
  }

  /**
   * Introspect the database schema and return context fragments.
   * Results are cached to avoid repeated introspection.
   */
  public async index(): Promise<ContextFragment[]> {
    const cached = await this.#config.introspection.read();
    if (cached) {
      return cached;
    }
    const fragments = await this.#config.adapter.introspect();
    await this.#config.introspection.write(fragments);
    return fragments;
  }

  /**
   * Generate training data pairs using a producer factory.
   * The factory receives the configured adapter, so users don't need to pass it manually.
   *
   * @example
   * // Generate questions for existing SQL
   * const pairs = await text2sql.toPairs(
   *   (adapter) => new SqlExtractor(sqls, adapter, { validateSql: true })
   * );
   *
   * @example
   * // Extract from chat history with validation
   * const pairs = await text2sql.toPairs(
   *   (adapter) => new ValidatedProducer(
   *     new MessageExtractor(messages),
   *     adapter
   *   )
   * );
   */
  public async toPairs<T extends PairProducer>(
    factory: (adapter: Adapter) => T,
  ): Promise<ExtractedPair[]> {
    const producer = factory(this.#config.adapter);
    return producer.toPairs();
  }

  public async chat(messages: UIMessage[]) {
    const trackedFs = new TrackedFs(this.#config.filesystem);

    const context = this.#config.context(
      ...guidelines(this.#config.teachingsOptions),
      ...(await this.index()),
    );

    const userMsg = messages.at(-1);
    if (userMsg) {
      context.set(message(userMsg));
      await context.save();
    }

    const { mounts: skillMounts } = context.getSkillMounts();

    const { tools } = await createResultTools({
      adapter: this.#config.adapter,
      skillMounts,
      filesystem: trackedFs,
    });

    const chatAgent = agent({
      name: 'text2sql',
      model: this.#config.model,
      context,
      tools: {
        ...tools,
        ...this.#config.tools,
      },
      guardrails: [errorRecoveryGuardrail],
      maxGuardrailRetries: 3,
    });

    const result = await chatAgent.stream(
      {},
      { transform: this.#config.transform },
    );

    return result.toUIMessageStream({
      onError: (error) => this.#formatError(error),
      sendStart: true,
      sendFinish: true,
      sendReasoning: true,
      sendSources: true,
      originalMessages: messages,
      generateMessageId: generateId,
      onFinish: async ({ responseMessage }) => {
        const createdFiles = trackedFs.getCreatedFiles();
        const messageWithMetadata = {
          ...responseMessage,
          metadata: {
            ...((responseMessage.metadata as object) ?? {}),
            createdFiles,
          },
        };
        context.set(assistant(messageWithMetadata));
        await context.save();
        await context.trackUsage(await result.totalUsage);
      },
    });
  }

  public async developer(messages: UIMessage[]) {
    const context = this.#config.context(
      ...guidelines(this.#config.teachingsOptions),
      ...developerExports.fragments,
      ...(await this.index()),
    );

    const userMsg = messages.at(-1);
    if (userMsg) {
      context.set(message(userMsg));
      await context.save();
    }

    const developerAgent = agent({
      name: 'developer',
      model: this.#config.model,
      context,
      tools: developerExports.tools,
    });

    const result = await developerAgent.stream({
      adapter: this.#config.adapter,
    });

    return result.toUIMessageStream({
      onError: (error) => this.#formatError(error),
      sendStart: true,
      sendFinish: true,
      sendReasoning: true,
      sendSources: true,
      generateMessageId: generateId,
      onFinish: async ({ responseMessage }) => {
        context.set(assistant(responseMessage));
        await context.save();
        await context.trackUsage(await result.totalUsage);
      },
    });
  }

  #formatError(error: unknown): string {
    if (NoSuchToolError.isInstance(error)) {
      return 'The model tried to call an unknown tool.';
    } else if (InvalidToolInputError.isInstance(error)) {
      return 'The model called a tool with invalid arguments.';
    } else if (ToolCallRepairError.isInstance(error)) {
      return 'The model tried to call a tool with invalid arguments, but it was repaired.';
    } else if (APICallError.isInstance(error)) {
      console.error('Upstream API call failed:', error);
      return `Upstream API call failed with status ${(error as APICallError).statusCode}: ${(error as APICallError).message}`;
    }
    return JSON.stringify(error);
  }
}
