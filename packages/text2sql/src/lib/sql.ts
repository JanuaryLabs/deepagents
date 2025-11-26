import {
  type InferUIMessageChunk,
  InvalidToolInputError,
  NoSuchToolError,
  ToolCallRepairError,
  type UIDataTypes,
  type UIMessage,
  type UIMessageChunk,
  type UITools,
  tool,
} from 'ai';
import dedent from 'dedent';
import { v7 } from 'uuid';
import z from 'zod';

import {
  type AgentModel,
  generate,
  pipe,
  stream,
  user,
} from '@deepagents/agent';

import type { Adapter } from './adapters/adapter.ts';
import { Sqlite } from './adapters/sqlite.ts';
import { BriefCache, generateBrief, toBrief } from './agents/brief.agent.ts';
import { explainerAgent } from './agents/explainer.agent.ts';
import { suggestionsAgent } from './agents/suggestions.agents.ts';
import { synthesizerAgent } from './agents/synthesizer.agent.ts';
import { teachablesAuthorAgent } from './agents/teachables.agent.ts';
import {
  type RenderingTools,
  text2sqlMonolith,
  text2sqlOnly,
} from './agents/text2sql.agent.ts';
import { History } from './history/history.ts';
import { UserProfileStore } from './memory/user-profile.ts';
import {
  type Teachables,
  toInstructions,
  toTeachables,
} from './teach/teachables.ts';

export class Text2Sql {
  #config: {
    adapter: Adapter;
    cache: BriefCache;
    history: History;
    tools?: RenderingTools;
    instructions: Teachables[];
  };
  constructor(config: {
    adapter: Adapter;
    cache: BriefCache;
    history: History;
    tools?: RenderingTools;
    instructions?: Teachables[];
  }) {
    this.#config = {
      ...config,
      instructions: config.instructions ?? [],
      tools: config.tools ?? {},
    };
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
      this.#config.adapter.introspect(),
      this.#config.adapter.info(),
    ]);
    const context = await generateBrief(introspection, this.#config.cache);

    return {
      generate: async () => {
        const { experimental_output: output } = await generate(
          text2sqlOnly,
          [user(input)],
          {
            adapterInfo: this.#config.adapter.formatInfo(adapterInfo),
            context,
            introspection,
            teachings: toInstructions(...this.#config.instructions),
          },
        );
        return output.sql;
      },
    };
  }

  public async inspect() {
    const [introspection, adapterInfo] = await Promise.all([
      this.#config.adapter.introspect(),
      this.#config.adapter.info(),
    ]);
    const context = await generateBrief(introspection, this.#config.cache);

    return text2sqlOnly.instructions({
      adapterInfo: this.#config.adapter.formatInfo(adapterInfo),
      context,
      introspection,
      teachings: toInstructions(...this.#config.instructions),
    });
  }

  public instruct(...dataset: Teachables[]) {
    this.#config.instructions.push(...dataset);
  }

  public async teach(input: string) {
    const [introspection, adapterInfo] = await Promise.all([
      this.#config.adapter.introspect(),
      this.#config.adapter.info(),
    ]);
    const context = await generateBrief(introspection, this.#config.cache);
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
      teachings: toInstructions(...this.#config.instructions),
    };
  }

  public async tag(input: string) {
    const [introspection, adapterInfo] = await Promise.all([
      this.#config.adapter.introspect(),
      this.#config.adapter.info(),
    ]);
    const pipeline = pipe(
      {
        input,
        adapter: this.#config.adapter,
        cache: this.#config.cache,
        introspection,
        adapterInfo: this.#config.adapter.formatInfo(adapterInfo),
        messages: [user(input)],
        renderingTools: this.#config.tools || {},
        teachings: toInstructions(...this.#config.instructions),
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
      this.#config.adapter.introspect(),
      this.#config.adapter.info(),
    ]);
    const context = await generateBrief(introspection, this.#config.cache);
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
      this.#config.adapter.introspect(),
      this.#config.adapter.info(),
    ]);
    //   console.log(text2sqlMonolith.instructions({
    //   adapterInfo: this.#config.adapter.formatInfo(adapterInfo),
    //   context: await generateBrief(introspection, this.#config.cache),
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
        teachings: toInstructions(...this.#config.instructions),
        adapter: this.#config.adapter,
        introspection,
        adapterInfo: this.#config.adapter.formatInfo(adapterInfo),
        context: await generateBrief(introspection, this.#config.cache),
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
    model?: AgentModel,
  ) {
    const [introspection, adapterInfo] = await Promise.all([
      this.#config.adapter.introspect(),
      this.#config.adapter.info(),
    ]);
    const chat = await this.#config.history.upsertChat({
      id: params.chatId,
      userId: params.userId,
      title: 'Chat ' + params.chatId,
    });

    const userProfileStore = new UserProfileStore(params.userId);
    const userProfileXml = await userProfileStore.toXml();

    const result = stream(
      text2sqlMonolith.clone({
        model: model,
        tools: {
          ...text2sqlMonolith.handoff.tools,
          ...this.#config.tools,
          update_user_profile: tool({
            description: `Update the user's profile with new facts, preferences, or present context.
            Use this when the user explicitly states a preference (e.g., "I like dark mode", "Call me Ezz")
            or when their working context changes (e.g., "I'm working on a hackathon").`,
            inputSchema: z.object({
              type: z
                .enum(['fact', 'preference', 'present'])
                .describe('The type of information to update.'),
              text: z
                .string()
                .describe(
                  'The content of the fact, preference, or present context.',
                ),
              action: z
                .enum(['add', 'remove'])
                .default('add')
                .describe('Whether to add or remove the item.'),
            }),
            execute: async ({ type, text, action }) => {
              if (action === 'remove') {
                await userProfileStore.remove(type, text);
                return `Removed ${type}: ${text}`;
              }

              await userProfileStore.add(type, text);
              return `Added ${type}: ${text}`;
            },
          }),
        },
      }),
      [...chat.messages.map((it) => it.content), ...messages],
      {
        teachings: toInstructions(...this.#config.instructions),
        adapter: this.#config.adapter,
        renderingTools: this.#config.tools || {},
        introspection,
        adapterInfo: this.#config.adapter.formatInfo(adapterInfo),
        context: await generateBrief(introspection, this.#config.cache),
        userProfile: userProfileXml,
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
  // const adapter = new Sqlite({
  //   execute: (sql) => sqliteClient.prepare(sql).all(),
  // });
  // console.log((await adapter.getTables()).map((t) => t.name));
  // console.log(await adapter.resolveTables(['ProductCategory']));
  //   const text2sql = new Text2Sql({
  //     instructions: teachings,
  //     cache: new BriefCache('brief'),
  //     history: new SqliteHistory('./text2sql_history.sqlite'),
  //     adapter: new Sqlite({
  //       execute: (sql) => sqliteClient.prepare(sql).all(),
  //     }),
  //   });
  //   const sql = await text2sql.chat(
  //     [
  //       user(
  //         'What is trending in sales lately, last calenar year, monthly timeframe?',
  //       ),
  //     ],
  //     {
  //       userId: 'default',
  //       chatId: '019a9b5a-f118-76a9-9dee-609e282c60b7',
  //     },
  //   );
  //   await printer.readableStream(sql);
}
