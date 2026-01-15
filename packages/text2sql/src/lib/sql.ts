import {
  APICallError,
  InvalidToolInputError,
  NoSuchToolError,
  ToolCallRepairError,
  type UIMessage,
  generateId,
} from 'ai';

import { type AgentModel } from '@deepagents/agent';
import {
  ContextEngine,
  type ContextFragment,
  type ContextStore,
  agent,
  assistant,
  hint,
  styleGuide,
  user as userFragment,
} from '@deepagents/context';

import type { Adapter } from './adapters/adapter.ts';
import developerExports from './agents/developer.agent.ts';
import { toSql } from './agents/sql.agent.ts';
import { type RenderingTools, t_a_g } from './agents/text2sql.agent.ts';
import { JsonCache } from './file-cache.ts';
import { type ExtractedPair, type PairProducer } from './synthesis/types.ts';
import { type TeachingsOptions, guidelines } from './teach/teachings.ts';

export class Text2Sql {
  #config: {
    model: AgentModel;
    adapter: Adapter;
    store: ContextStore;
    tools?: RenderingTools;
    instructions: ContextFragment[];
    introspection: JsonCache<ContextFragment[]>;
  };

  constructor(config: {
    adapter: Adapter;
    store: ContextStore;
    version: string;
    tools?: RenderingTools;
    instructions?: ContextFragment[];
    model: AgentModel;
    /**
     * Configure teachings behavior
     * @see TeachingsOptions
     */
    teachingsOptions?: TeachingsOptions;
  }) {
    this.#config = {
      adapter: config.adapter,
      store: config.store,
      instructions: [
        ...guidelines(config.teachingsOptions),
        ...(config.instructions ?? []),
      ],
      tools: config.tools ?? {},
      model: config.model,
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
      instructions: this.#config.instructions,
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

  /**
   * Build instructions for rendering tools (hint + styleGuide).
   * Returns fragments to include when render_* tools are available.
   */
  #buildRenderingInstructions(): ContextFragment[] {
    const renderToolNames = Object.keys(this.#config.tools ?? {}).filter(
      (name) => name.startsWith('render_'),
    );

    if (!renderToolNames.length) {
      return [];
    }

    return [
      hint(`Rendering tools available: ${renderToolNames.join(', ')}.`),
      styleGuide({
        prefer:
          'Use render_* tools for trend/over time/monthly requests or chart asks',
        always:
          'Include text insight alongside visualizations. Prefer line charts for time-based data.',
      }),
    ];
  }

  public async chat(
    messages: UIMessage[],
    params: {
      chatId: string;
      userId: string;
    },
  ) {
    const schemaFragments = await this.index();

    const context = new ContextEngine({
      store: this.#config.store,
      chatId: params.chatId,
      userId: params.userId,
    }).set(
      ...this.#config.instructions,
      ...this.#buildRenderingInstructions(),
      ...schemaFragments,
    );

    const userMsg = messages.at(-1);
    if (userMsg) {
      context.set(userFragment(userMsg));
      await context.save();
    }

    const chatAgent = t_a_g.clone({
      model: this.#config.model,
      context,
      tools: { ...t_a_g.tools, ...this.#config.tools },
    });

    const result = await chatAgent.stream({});

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
      },
    });
  }

  /**
   * Developer chat interface - power-user mode for SQL generation.
   * Uses db_query tool for direct SQL execution (LLM writes SQL).
   */
  public async developer(
    messages: UIMessage[],
    params: {
      chatId: string;
      userId: string;
    },
  ) {
    const schemaFragments = await this.index();

    const context = new ContextEngine({
      store: this.#config.store,
      chatId: params.chatId,
      userId: params.userId,
    }).set(
      ...developerExports.fragments,
      ...this.#config.instructions,
      ...schemaFragments,
    );

    const userMsg = messages.at(-1);
    if (userMsg) {
      context.set(userFragment(userMsg));
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
