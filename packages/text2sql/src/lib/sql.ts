import {
  type InferUIMessageChunk,
  InvalidToolInputError,
  NoSuchToolError,
  ToolCallRepairError,
  type UIDataTypes,
  type UIMessage,
  type UIMessageChunk,
  type UITools,
  generateId,
} from 'ai';
import dedent from 'dedent';
import { v7 } from 'uuid';

import {
  type AgentModel,
  generate,
  pipe,
  stream,
  user,
} from '@deepagents/agent';

import type {
  Adapter,
  IntrospectOptions,
  Introspection,
} from './adapters/adapter.ts';
import {
  JsonCache,
  TmpCache,
  generateBrief,
  toBrief,
} from './agents/brief.agent.ts';
import { explainerAgent } from './agents/explainer.agent.ts';
import { suggestionsAgent } from './agents/suggestions.agents.ts';
import { synthesizerAgent } from './agents/synthesizer.agent.ts';
import { teachablesAuthorAgent } from './agents/teachables.agent.ts';
import {
  type RenderingTools,
  memoryTools,
  text2sqlMonolith,
  text2sqlOnly,
} from './agents/text2sql.agent.ts';
import { History } from './history/history.ts';
import { InMemoryTeachablesStore } from './memory/memory.store.ts';
import type { TeachablesStore } from './memory/store.ts';
import {
  type Teachables,
  teachable,
  toInstructions,
  toTeachables,
} from './teach/teachables.ts';
import teachings from './teach/teachings.ts';

export class Text2Sql {
  #config: {
    model?: AgentModel;
    adapter: Adapter;
    briefCache: TmpCache;
    history: History;
    tools?: RenderingTools;
    instructions: Teachables[];
    memory: TeachablesStore;
  };
  #introspectionCache: JsonCache<Introspection>;

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
      briefCache: new TmpCache('brief-' + config.version),
      history: config.history,
      instructions: [...teachings, ...(config.instructions ?? [])],
      tools: config.tools ?? {},
      model: config.model,
      memory: config.memory || new InMemoryTeachablesStore(),
    };
    this.#introspectionCache = new JsonCache<Introspection>(
      'introspection-' + config.version,
    );
  }
  async #getSql(
    stream: ReadableStream<
      InferUIMessageChunk<UIMessage<unknown, UIDataTypes, UITools>>
    >,
  ) {
    const chunks = (await Array.fromAsync(
      stream as AsyncIterable<UIMessageChunk>,
    )) as UIMessageChunk[];
    const sql = chunks.at(-1);
    if (sql && sql.type === 'data-text-delta') {
      return (sql.data as { text: string }).text;
    }
    throw new Error('No SQL generated');
  }

  public async explain(sql: string) {
    const { experimental_output } = await generate(
      explainerAgent,
      [user('Explain this SQL.')],
      { sql },
    );
    return experimental_output.explanation;
  }

  public async toSql(input: string) {
    const [introspection, adapterInfo] = await Promise.all([
      this.index(),
      this.#config.adapter.info(),
    ]);
    const context = await generateBrief(introspection, this.#config.briefCache);

    return {
      generate: async () => {
        const { experimental_output: output } = await generate(
          text2sqlOnly,
          [user(input)],
          {
            adapterInfo: this.#config.adapter.formatInfo(adapterInfo),
            context,
            introspection,
            teachings: toInstructions(
              'instructions',
              ...this.#config.instructions,
            ),
          },
        );
        return output.sql;
      },
    };
  }

  public async inspect() {
    const [introspection, adapterInfo] = await Promise.all([
      this.index(),
      this.#config.adapter.info(),
    ]);
    const context = await generateBrief(introspection, this.#config.briefCache);

    return text2sqlOnly.instructions({
      adapterInfo: this.#config.adapter.formatInfo(adapterInfo),
      context,
      introspection,
      teachings: toInstructions('instructions', ...this.#config.instructions),
    });
  }

  public instruct(...dataset: Teachables[]) {
    this.#config.instructions.push(...dataset);
  }

  public async index(options?: IntrospectOptions): Promise<Introspection> {
    const cached = await this.#introspectionCache.read();
    if (cached) {
      return cached;
    }
    const introspection = await this.#config.adapter.introspect(options);
    await this.#introspectionCache.write(introspection);
    return introspection;
  }

  public async teach(input: string) {
    const [introspection, adapterInfo] = await Promise.all([
      this.index(),
      this.#config.adapter.info(),
    ]);
    const context = await generateBrief(introspection, this.#config.briefCache);
    const { experimental_output } = await generate(
      teachablesAuthorAgent,
      [user(input)],
      {
        introspection,
        adapterInfo: this.#config.adapter.formatInfo(adapterInfo),
        context,
      },
    );
    const teachables = toTeachables(experimental_output.teachables);
    this.#config.instructions.push(...teachables);
    return {
      teachables,
      teachings: toInstructions('instructions', ...this.#config.instructions),
    };
  }

  public async tag(input: string) {
    const [introspection, adapterInfo] = await Promise.all([
      this.index(),
      this.#config.adapter.info(),
    ]);
    const pipeline = pipe(
      {
        input,
        adapter: this.#config.adapter,
        cache: this.#config.briefCache,
        introspection,
        adapterInfo: this.#config.adapter.formatInfo(adapterInfo),
        messages: [user(input)],
        renderingTools: this.#config.tools || {},
        teachings: toInstructions('instructions', ...this.#config.instructions),
      },
      toBrief(),
      async (state, update) => {
        const { experimental_output: output } = await generate(
          text2sqlOnly,
          state.messages,
          state,
        );
        update({
          messages: [
            user(
              dedent`
        Based on the data provided, please explain in clear, conversational language what insights this reveals.

        <user_question>${state.input}</user_question>
        <data>${JSON.stringify(this.#config.adapter.execute(output.sql))}</data>
        `,
            ),
          ],
        });
        return output.sql;
      },
      synthesizerAgent,
    );
    const stream = pipeline();
    return {
      generate: async () => {
        const sql = await this.#getSql(stream);
        return sql;
      },
      stream: () => {
        return stream;
      },
    };
  }

  public async suggest() {
    const [introspection, adapterInfo] = await Promise.all([
      this.index(),
      this.#config.adapter.info(),
    ]);
    const context = await generateBrief(introspection, this.#config.briefCache);
    const { experimental_output: output } = await generate(
      suggestionsAgent,
      [
        user(
          'Suggest high-impact business questions and matching SQL queries for this database.',
        ),
      ],
      {
        introspection,
        adapterInfo: this.#config.adapter.formatInfo(adapterInfo),
        context,
      },
    );
    return output.suggestions;
  }

  public async single(input: string) {
    const [introspection, adapterInfo] = await Promise.all([
      this.index(),
      this.#config.adapter.info(),
    ]);
    //   console.log(text2sqlMonolith.instructions({
    //   adapterInfo: this.#config.adapter.formatInfo(adapterInfo),
    //   context: await generateBrief(introspection, this.#config.briefCache),
    //   introspection,
    // }));
    return stream(
      text2sqlMonolith.clone({
        tools: {
          ...text2sqlMonolith.handoff.tools,
          ...this.#config.tools,
        },
      }),
      [user(input)],
      {
        teachings: toInstructions('instructions', ...this.#config.instructions),
        adapter: this.#config.adapter,
        introspection,
        adapterInfo: this.#config.adapter.formatInfo(adapterInfo),
        context: await generateBrief(introspection, this.#config.briefCache),
        renderingTools: this.#config.tools || {},
      },
    );
  }
  public async chat(
    messages: UIMessage[],
    params: {
      chatId: string;
      userId: string;
    },
  ) {
    const [introspection, adapterInfo, userTeachables] = await Promise.all([
      this.index({ onProgress: console.log }),
      this.#config.adapter.info(),
      this.#config.memory.toTeachables(params.userId),
    ]);
    const chat = await this.#config.history.upsertChat({
      id: params.chatId,
      userId: params.userId,
      title: 'Chat ' + params.chatId,
    });

    const result = stream(
      text2sqlMonolith.clone({
        model: this.#config.model,
        tools: {
          ...text2sqlMonolith.handoff.tools,
          ...memoryTools,
          ...this.#config.tools,
        },
      }),
      [...chat.messages.map((it) => it.content), ...messages],
      {
        teachings: toInstructions(
          'instructions',
          ...this.#config.instructions,
          teachable('user_profile', ...userTeachables),
        ),
        adapter: this.#config.adapter,
        renderingTools: this.#config.tools || {},
        introspection,
        adapterInfo: this.#config.adapter.formatInfo(adapterInfo),
        context: await generateBrief(introspection, this.#config.briefCache),
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
      originalMessages: messages,
      generateMessageId: generateId,
      onFinish: async ({ messages }) => {
        const userMessage = messages.at(-2);
        const botMessage = messages.at(-1);
        if (!userMessage || !botMessage) {
          throw new Error('Not implemented yet');
        }
        await this.#config.history.addMessage({
          id: v7(),
          chatId: params.chatId,
          role: userMessage.role,
          content: userMessage,
        });
        await this.#config.history.addMessage({
          id: v7(),
          chatId: params.chatId,
          role: botMessage.role,
          content: botMessage,
        });
      },
    });
  }
}
if (import.meta.main) {
  // const { DatabaseSync } = await import('node:sqlite');
  // const sqliteClient = new DatabaseSync('claude_creation.db', {
  //   readOnly: true,
  // });
  // const text2sql = new Text2Sql({
  //   version: 'v1',
  //   instructions: teachings,
  //   history: new InMemoryHistory(),
  //   adapter: new Sqlite({
  //     execute: (sql) => sqliteClient.prepare(sql).all(),
  //   }),
  //   memory: new SqliteTeachablesStore('memory_teachables.sqlite');
  // });
  // const sql = await text2sql.chat(
  //   [
  //     user(
  //       'What is trending in sales lately, last calenar year, monthly timeframe?',
  //     ),
  //   ],
  //   {
  //     userId: 'default',
  //     chatId: '019a9b5a-f118-76a9-9dee-609e282c60b7',
  //   },
  // );
  // await printer.readableStream(sql);
}
