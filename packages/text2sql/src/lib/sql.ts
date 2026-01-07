import {
  APICallError,
  InvalidToolInputError,
  NoSuchToolError,
  ToolCallRepairError,
  type UIMessage,
  generateId,
} from 'ai';
import { v7 } from 'uuid';

import {
  type Agent,
  type AgentModel,
  generate,
  stream,
  user,
} from '@deepagents/agent';

import type { Adapter, IntrospectOptions } from './adapters/adapter.ts';
import { chat1Agent, chat1Tools } from './agents/chat1.agent.ts';
import { chat2Agent, chat2Tools } from './agents/chat2.agent.ts';
import { chat3Agent, chat3Tools } from './agents/chat3.agent.ts';
import { chat4Agent, chat4Tools } from './agents/chat4.agent.ts';
import { developerAgent } from './agents/developer.agent.ts';
import { explainerAgent } from './agents/explainer.agent.ts';
import { toSql as agentToSql } from './agents/sql.agent.ts';
import {
  type RenderingTools,
  memoryTools,
  t_a_g,
} from './agents/text2sql.agent.ts';
import { FileCache } from './file-cache.ts';
import { History } from './history/history.ts';
import type { TeachablesStore } from './memory/store.ts';
import { type ExtractedPair, type PairProducer } from './synthesis/types.ts';
import {
  type Teachables,
  guardrail,
  hint,
  persona,
  styleGuide,
  teachable,
  toInstructions,
} from './teach/teachables.ts';
import { type TeachingsOptions, guidelines } from './teach/teachings.ts';

export interface InspectionResult {
  /** The grounding/introspection data (database schema context as XML) */
  grounding: string;

  /** The full instructions XML that would be sent to the agent */
  instructions: string;

  /** User-specific teachables that were loaded */
  userTeachables: Teachables[];

  /** System teachings configured */
  systemTeachings: Teachables[];

  /** Tool names available to the agent */
  tools: string[];
}

export class Text2Sql {
  #config: {
    model?: AgentModel;
    adapter: Adapter;
    history: History;
    tools?: RenderingTools;
    instructions: Teachables[];
    memory?: TeachablesStore;
    introspection: FileCache;
  };

  constructor(config: {
    adapter: Adapter;
    history: History;
    version: string;
    tools?: RenderingTools;
    instructions?: Teachables[];
    model?: AgentModel;
    memory?: TeachablesStore;
    /**
     * Configure teachings behavior
     * @see TeachingsOptions
     */
    teachingsOptions?: TeachingsOptions;
  }) {
    this.#config = {
      adapter: config.adapter,
      history: config.history,
      instructions: [
        ...guidelines(config.teachingsOptions),
        ...(config.instructions ?? []),
      ],
      tools: config.tools ?? {},
      model: config.model,
      memory: config.memory,
      introspection: new FileCache('introspection-' + config.version),
    };
  }

  public async explain(sql: string) {
    const { experimental_output } = await generate(
      explainerAgent,
      [user('Explain this SQL.')],
      { sql },
    );
    return experimental_output.explanation;
  }

  public async toSql(input: string): Promise<string> {
    const introspection = await this.index();

    const result = await agentToSql({
      input,
      adapter: this.#config.adapter,
      introspection,
      instructions: this.#config.instructions,
      model: this.#config.model,
    });

    return result.sql;
  }

  public instruct(...dataset: Teachables[]) {
    this.#config.instructions.push(...dataset);
  }

  public async inspect(agent: Agent) {
    const [grounding] = await Promise.all([this.index() as Promise<string>]);

    const renderToolNames = Object.keys(this.#config.tools ?? {}).filter(
      (name) => name.startsWith('render_'),
    );
    const allInstructions = [
      ...this.#config.instructions,
      guardrail({
        rule: 'ALWAYS use `get_sample_rows` before writing queries that filter or compare against string columns.',
        reason: 'Prevents SQL errors from wrong value formats.',
        action:
          "Target specific columns (e.g., get_sample_rows('table', ['status', 'type'])).",
      }),
      ...(renderToolNames.length
        ? [
            hint(`Rendering tools available: ${renderToolNames.join(', ')}.`),
            styleGuide({
              prefer:
                'Use render_* tools for trend/over time/monthly requests or chart asks',
              always:
                'Include text insight alongside visualizations. Prefer line charts for time-based data.',
            }),
          ]
        : []),
    ];

    const tools = Object.keys({
      ...agent.handoff.tools,
      ...(this.#config.memory ? memoryTools : {}),
      ...this.#config.tools,
    });

    return {
      tools,
      prompt: agent.instructions({
        introspection: grounding,
        teachings: toInstructions('instructions', ...allInstructions),
      }),
    };
  }

  public async index(options?: IntrospectOptions) {
    const cached = await this.#config.introspection.get();
    if (cached) {
      return cached;
    }
    const introspection = await this.#config.adapter.introspect();
    await this.#config.introspection.set(introspection);
    return introspection;
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

  // public async suggest() {
  //   const [introspection, adapterInfo] = await Promise.all([
  //     this.index(),
  //     this.#config.adapter.introspect(),
  //   ]);
  //   const { experimental_output: output } = await generate(
  //     suggestionsAgent,
  //     [
  //       user(
  //         'Suggest high-impact business questions and matching SQL queries for this database.',
  //       ),
  //     ],
  //     {
  //     },
  //   );
  //   return output.suggestions;
  // }

  public async chat(
    messages: UIMessage[],
    params: {
      chatId: string;
      userId: string;
    },
  ) {
    const [introspection, userTeachables] = await Promise.all([
      this.index({ onProgress: console.log }),
      this.#config.memory
        ? this.#config.memory.toTeachables(params.userId)
        : [],
    ]);
    const chat = await this.#config.history.upsertChat({
      id: params.chatId,
      userId: params.userId,
      title: 'Chat ' + params.chatId,
    });

    // Build instructions with conditional rendering hint
    const renderToolNames = Object.keys(this.#config.tools ?? {}).filter(
      (name) => name.startsWith('render_'),
    );
    const instructions = [
      ...this.#config.instructions,
      guardrail({
        rule: 'ALWAYS use `get_sample_rows` before writing queries that filter or compare against string columns.',
        reason: 'Prevents SQL errors from wrong value formats.',
        action:
          "Target specific columns (e.g., get_sample_rows('table', ['status', 'type'])).",
      }),
      ...(renderToolNames.length
        ? [
            hint(`Rendering tools available: ${renderToolNames.join(', ')}.`),
            styleGuide({
              prefer:
                'Use render_* tools for trend/over time/monthly requests or chart asks',
              always:
                'Include text insight alongside visualizations. Prefer line charts for time-based data.',
            }),
          ]
        : []),
    ];
    const originalMessage = [
      ...chat.messages.map((it) => it.content),
      ...messages,
    ];
    const result = stream(
      t_a_g.clone({
        model: this.#config.model,
        tools: {
          ...t_a_g.handoff.tools,
          ...(this.#config.memory ? memoryTools : {}),
          ...this.#config.tools,
        },
      }),
      originalMessage,
      {
        teachings: toInstructions(
          'instructions',
          persona({
            name: 'Freya',
            role: 'You are an expert SQL query generator, answering business questions with accurate queries.',
            tone: 'Your tone should be concise and business-friendly.',
          }),
          ...instructions,
          teachable('user_profile', ...userTeachables),
        ),
        adapter: this.#config.adapter,
        introspection,
        memory: this.#config.memory,
        userId: params.userId,
      },
    );

    return this.#createUIMessageStream(
      result,
      messages,
      params,
      originalMessage,
    );
  }

  /**
   * Chat1 - Combined tool, no peek.
   *
   * Uses a single `query_database` tool that:
   * 1. Takes a natural language question
   * 2. Internally calls toSql() to generate validated SQL
   * 3. Executes the SQL
   * 4. Returns both SQL and results
   *
   * The agent does NOT see the SQL before execution.
   */
  public async chat1(
    messages: UIMessage[],
    params: {
      chatId: string;
      userId: string;
    },
  ) {
    const [introspection, userTeachables] = await Promise.all([
      this.index({ onProgress: console.log }),
      this.#config.memory
        ? this.#config.memory.toTeachables(params.userId)
        : [],
    ]);
    const chat = await this.#config.history.upsertChat({
      id: params.chatId,
      userId: params.userId,
      title: 'Chat ' + params.chatId,
    });

    const renderToolNames = Object.keys(this.#config.tools ?? {}).filter(
      (name) => name.startsWith('render_'),
    );
    const instructions = [
      ...this.#config.instructions,
      ...(renderToolNames.length
        ? [
            hint(`Rendering tools available: ${renderToolNames.join(', ')}.`),
            styleGuide({
              prefer:
                'Use render_* tools for trend/over time/monthly requests or chart asks',
              always:
                'Include text insight alongside visualizations. Prefer line charts for time-based data.',
            }),
          ]
        : []),
    ];

    const originalMessage = [
      ...chat.messages.map((it) => it.content),
      ...messages,
    ];

    const result = stream(
      chat1Agent.clone({
        model: this.#config.model,
        tools: {
          ...chat1Tools,
          ...(this.#config.memory ? memoryTools : {}),
          ...this.#config.tools,
        },
      }),
      originalMessage,
      {
        teachings: toInstructions(
          'instructions',
          ...instructions,
          teachable('user_profile', ...userTeachables),
        ),
        adapter: this.#config.adapter,
        introspection,
        instructions: this.#config.instructions,
        memory: this.#config.memory,
        userId: params.userId,
      },
    );

    return this.#createUIMessageStream(
      result,
      messages,
      params,
      originalMessage,
    );
  }

  /**
   * Chat2 - Separate generate + execute tools (with peek).
   *
   * Uses two separate tools:
   * 1. `generate_sql` - Takes a question, returns validated SQL
   * 2. `execute_sql` - Takes SQL, executes it
   *
   * The agent sees the SQL before execution and can review/refine.
   */
  public async chat2(
    messages: UIMessage[],
    params: {
      chatId: string;
      userId: string;
    },
  ) {
    const [introspection, userTeachables] = await Promise.all([
      this.index({ onProgress: console.log }),
      this.#config.memory
        ? this.#config.memory.toTeachables(params.userId)
        : [],
    ]);
    const chat = await this.#config.history.upsertChat({
      id: params.chatId,
      userId: params.userId,
      title: 'Chat ' + params.chatId,
    });

    const renderToolNames = Object.keys(this.#config.tools ?? {}).filter(
      (name) => name.startsWith('render_'),
    );
    const instructions = [
      ...this.#config.instructions,
      ...(renderToolNames.length
        ? [
            hint(`Rendering tools available: ${renderToolNames.join(', ')}.`),
            styleGuide({
              prefer:
                'Use render_* tools for trend/over time/monthly requests or chart asks',
              always:
                'Include text insight alongside visualizations. Prefer line charts for time-based data.',
            }),
          ]
        : []),
    ];

    const originalMessage = [
      ...chat.messages.map((it) => it.content),
      ...messages,
    ];

    const result = stream(
      chat2Agent.clone({
        model: this.#config.model,
        tools: {
          ...chat2Tools,
          ...(this.#config.memory ? memoryTools : {}),
          ...this.#config.tools,
        },
      }),
      originalMessage,
      {
        teachings: toInstructions(
          'instructions',
          ...instructions,
          teachable('user_profile', ...userTeachables),
        ),
        adapter: this.#config.adapter,
        introspection,
        instructions: this.#config.instructions,
        memory: this.#config.memory,
        userId: params.userId,
      },
    );

    return this.#createUIMessageStream(
      result,
      messages,
      params,
      originalMessage,
    );
  }

  /**
   * Chat3 - Agent conversation/collaboration.
   *
   * Enables richer interaction where the SQL agent can:
   * - Surface confidence levels
   * - State assumptions
   * - Request clarification when uncertain
   */
  public async chat3(
    messages: UIMessage[],
    params: {
      chatId: string;
      userId: string;
    },
  ) {
    const [introspection, userTeachables] = await Promise.all([
      this.index({ onProgress: console.log }),
      this.#config.memory
        ? this.#config.memory.toTeachables(params.userId)
        : [],
    ]);
    const chat = await this.#config.history.upsertChat({
      id: params.chatId,
      userId: params.userId,
      title: 'Chat ' + params.chatId,
    });

    const renderToolNames = Object.keys(this.#config.tools ?? {}).filter(
      (name) => name.startsWith('render_'),
    );
    const instructions = [
      ...this.#config.instructions,
      ...(renderToolNames.length
        ? [
            hint(`Rendering tools available: ${renderToolNames.join(', ')}.`),
            styleGuide({
              prefer:
                'Use render_* tools for trend/over time/monthly requests or chart asks',
              always:
                'Include text insight alongside visualizations. Prefer line charts for time-based data.',
            }),
          ]
        : []),
    ];

    const originalMessage = [
      ...chat.messages.map((it) => it.content),
      ...messages,
    ];

    const result = stream(
      chat3Agent.clone({
        model: this.#config.model,
        tools: {
          ...chat3Tools,
          ...(this.#config.memory ? memoryTools : {}),
          ...this.#config.tools,
        },
      }),
      originalMessage,
      {
        teachings: toInstructions(
          'instructions',

          ...instructions,
          teachable('user_profile', ...userTeachables),
        ),
        adapter: this.#config.adapter,
        introspection,
        instructions: this.#config.instructions,
        memory: this.#config.memory,
        userId: params.userId,
      },
    );

    return this.#createUIMessageStream(
      result,
      messages,
      params,
      originalMessage,
    );
  }

  /**
   * Chat4 - Question decomposition approach.
   *
   * Breaks down questions into semantic components before SQL generation:
   * - entities: Key concepts mentioned
   * - filters: Filtering criteria
   * - aggregation: Type of aggregation
   * - breakdown: Semantic parts of the question
   *
   * This helps ensure all aspects of the question are addressed.
   */
  public async chat4(
    messages: UIMessage[],
    params: {
      chatId: string;
      userId: string;
    },
  ) {
    const [introspection, userTeachables] = await Promise.all([
      this.index({ onProgress: console.log }),
      this.#config.memory
        ? this.#config.memory.toTeachables(params.userId)
        : [],
    ]);
    const chat = await this.#config.history.upsertChat({
      id: params.chatId,
      userId: params.userId,
      title: 'Chat ' + params.chatId,
    });

    const renderToolNames = Object.keys(this.#config.tools ?? {}).filter(
      (name) => name.startsWith('render_'),
    );
    const instructions = [
      ...this.#config.instructions,
      ...(renderToolNames.length
        ? [
            hint(`Rendering tools available: ${renderToolNames.join(', ')}.`),
            styleGuide({
              prefer:
                'Use render_* tools for trend/over time/monthly requests or chart asks',
              always:
                'Include text insight alongside visualizations. Prefer line charts for time-based data.',
            }),
          ]
        : []),
    ];

    const originalMessage = [
      ...chat.messages.map((it) => it.content),
      ...messages,
    ];

    const result = stream(
      chat4Agent.clone({
        model: this.#config.model,
        tools: {
          ...chat4Tools,
          ...(this.#config.memory ? memoryTools : {}),
          ...this.#config.tools,
        },
      }),
      originalMessage,
      {
        teachings: toInstructions(
          'instructions',
          ...instructions,
          teachable('user_profile', ...userTeachables),
        ),
        adapter: this.#config.adapter,
        introspection,
        instructions: this.#config.instructions,
        memory: this.#config.memory,
        userId: params.userId,
      },
    );

    return this.#createUIMessageStream(
      result,
      messages,
      params,
      originalMessage,
    );
  }

  /**
   * Developer-focused conversational interface for SQL generation.
   *
   * Provides power-user tools for query building without execution:
   * - generate_sql: Convert natural language to validated SQL
   * - validate_sql: Check SQL syntax
   * - explain_sql: Get plain-English explanations
   * - show_schema: Explore database schema on demand
   *
   * @example
   * ```typescript
   * const result = await text2sql.developer(
   *   [user("Generate a query to find top customers by revenue")],
   *   { chatId: 'dev-session-1', userId: 'dev-1' }
   * );
   * // Agent responds with SQL, can validate, explain, or refine iteratively
   * ```
   */
  public async developer(
    messages: UIMessage[],
    params: {
      chatId: string;
      userId: string;
    },
  ) {
    const [introspection, userTeachables] = await Promise.all([
      this.index({ onProgress: console.log }),
      this.#config.memory
        ? this.#config.memory.toTeachables(params.userId)
        : [],
    ]);

    return withChat(
      this.#config.history,
      params,
      messages,
      (originalMessages) =>
        stream(
          developerAgent.clone({
            model: this.#config.model,
          }),
          originalMessages,
          {
            teachings: toInstructions(
              'instructions',
              ...this.#config.instructions,
              teachable('user_profile', ...userTeachables),
            ),
            adapter: this.#config.adapter,
            introspection,
            instructions: this.#config.instructions,
          },
        ),
    );
  }

  /**
   * Helper to create UI message stream with common error handling and persistence.
   */
  #createUIMessageStream(
    result: ReturnType<typeof stream>,
    messages: UIMessage[],
    params: { chatId: string; userId: string },
    originalMessages: UIMessage[],
  ) {
    return result.toUIMessageStream({
      onError: (error) => {
        if (NoSuchToolError.isInstance(error)) {
          return 'The model tried to call an unknown tool.';
        } else if (InvalidToolInputError.isInstance(error)) {
          return 'The model called a tool with invalid arguments.';
        } else if (ToolCallRepairError.isInstance(error)) {
          return 'The model tried to call a tool with invalid arguments, but it was repaired.';
        } else if (APICallError.isInstance(error)) {
          console.error('Upstream API call failed:', error);
          return `Upstream API call failed with status ${error.statusCode}: ${error.message}`;
        } else {
          return JSON.stringify(error);
        }
      },
      sendStart: true,
      sendFinish: true,
      sendReasoning: true,
      sendSources: true,
      originalMessages: originalMessages,
      generateMessageId: generateId,
      onFinish: async ({ responseMessage, isContinuation }) => {
        const userMessage = messages.at(-1);
        if (!isContinuation && userMessage) {
          console.log(
            'Saving user message to history:',
            JSON.stringify(userMessage),
          );
          await this.#config.history.addMessage({
            id: v7(),
            chatId: params.chatId,
            role: userMessage.role,
            content: userMessage,
          });
        }

        await this.#config.history.addMessage({
          id: v7(),
          chatId: params.chatId,
          role: responseMessage.role,
          content: responseMessage,
        });
      },
    });
  }
}

export async function withChat(
  history: History,
  params: { chatId: string; userId: string },
  messages: UIMessage[],
  streamFn: (originalMessages: UIMessage[]) => ReturnType<typeof stream>,
) {
  const chat = await history.upsertChat({
    id: params.chatId,
    userId: params.userId,
    title: 'Chat ' + params.chatId,
  });
  const originalMessages = [
    ...chat.messages.map((it) => it.content),
    ...messages,
  ];
  const result = streamFn(originalMessages);
  return result.toUIMessageStream({
    onError: (error) => {
      if (NoSuchToolError.isInstance(error)) {
        return 'The model tried to call an unknown tool.';
      } else if (InvalidToolInputError.isInstance(error)) {
        return 'The model called a tool with invalid arguments.';
      } else if (ToolCallRepairError.isInstance(error)) {
        return 'The model tried to call a tool with invalid arguments, but it was repaired.';
      } else if (APICallError.isInstance(error)) {
        console.error('Upstream API call failed:', error);
        return `Upstream API call failed with status ${error.statusCode}: ${error.message}`;
      } else {
        return JSON.stringify(error);
      }
    },
    sendStart: true,
    sendFinish: true,
    sendReasoning: true,
    sendSources: true,
    originalMessages: originalMessages,
    generateMessageId: generateId,
    onFinish: async ({ responseMessage, isContinuation }) => {
      const userMessage = messages.at(-1);
      if (!isContinuation && userMessage) {
        console.log(
          'Saving user message to history:',
          JSON.stringify(userMessage),
        );

        await history.addMessage({
          id: v7(),
          chatId: params.chatId,
          role: userMessage.role,
          content: userMessage,
        });
      }

      await history.addMessage({
        id: v7(),
        chatId: params.chatId,
        role: responseMessage.role,
        content: responseMessage,
      });
    },
  });
}
