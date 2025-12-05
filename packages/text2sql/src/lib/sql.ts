import {
  InvalidToolInputError,
  NoSuchToolError,
  type Tool,
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
import { explainerAgent } from './agents/explainer.agent.ts';
import {
  type RenderingTools,
  memoryTools,
  sqlQueryAgent,
  t_a_g,
} from './agents/text2sql.agent.ts';
import { FileCache } from './file-cache.ts';
import { History } from './history/history.ts';
import type { TeachablesStore } from './memory/store.ts';
import {
  type Teachables,
  hint,
  persona,
  styleGuide,
  teachable,
  toInstructions,
} from './teach/teachables.ts';
import teachings from './teach/teachings.ts';

/** Extract SQL from markdown fenced code block if present */
function extractSql(output: string): string {
  const match = output.match(/```sql\n?([\s\S]*?)```/);
  return match ? match[1].trim() : output.trim();
}

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
    briefCache: FileCache;
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
  }) {
    this.#config = {
      adapter: config.adapter,
      briefCache: new FileCache('brief-' + config.version),
      history: config.history,
      instructions: [...teachings, ...(config.instructions ?? [])],
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

  public async toSql(
    query: string,
    options?: {
      tools?: RenderingTools;
      /** Enable db_query tool (default: false). When false, agent cannot execute queries. */
      enableDbQuery?: boolean;
      /** Enable get_sample_rows tool (default: true). Helps agent understand data formats. */
      enableSampleRows?: boolean;
    },
  ): Promise<string> {
    const introspection = await this.index();

    // Build tools based on options - exclude db_query by default to force SQL-only output
    const baseTools = t_a_g.handoff.tools;
    const toolsConfig: Record<string, Tool> = {
      validate_query: baseTools.validate_query,
      scratchpad: baseTools.scratchpad,
    };

    if (options?.enableSampleRows !== false) {
      toolsConfig.get_sample_rows = baseTools.get_sample_rows;
    }

    if (options?.enableDbQuery) {
      toolsConfig.db_query = baseTools.db_query;
    }

    const { text } = await generate(
      sqlQueryAgent.clone({
        model: this.#config.model,
        tools: toolsConfig,
      }),
      [user(query)],
      {
        teachings: toInstructions(
          'instructions',
          persona({
            name: 'Freya',
            role: 'You are an expert SQL query generator, answering business questions with accurate queries.',
            tone: 'Your tone should be concise and business-friendly.',
          }),
          ...this.#config.instructions,
        ),
        adapter: this.#config.adapter,
        introspection,
      },
    );

    return extractSql(text);
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
        teachings: toInstructions(
          'instructions',
          persona({
            name: 'Freya',
            role: 'You are an expert SQL query generator, answering business questions with accurate queries.',
            tone: 'Your tone should be concise and business-friendly.',
          }),
          ...allInstructions,
        ),
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

    return result.toUIMessageStream({
      onError: (error) => {
        if (NoSuchToolError.isInstance(error)) {
          return 'The model tried to call a unknown tool.';
        } else if (InvalidToolInputError.isInstance(error)) {
          return 'The model called a tool with invalid arguments.';
        } else if (ToolCallRepairError.isInstance(error)) {
          return 'The model tried to call a tool with invalid arguments, but it was repaired.';
        } else {
          return 'An unknown error occurred.';
        }
      },
      sendStart: true,
      sendFinish: true,
      sendReasoning: true,
      sendSources: true,
      originalMessages: originalMessage,
      generateMessageId: generateId,
      onFinish: async ({ responseMessage, isContinuation }) => {
        // Get user message from the input array (already known before the call)
        // Don't save if this is a continuation of an existing message
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

        // Use responseMessage directly - guaranteed to have the assistant's reply
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
