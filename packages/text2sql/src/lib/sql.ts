import {
  type InferUIMessageChunk,
  InvalidToolInputError,
  NoSuchToolError,
  ToolCallRepairError,
  type UIDataTypes,
  type UIMessage,
  type UIMessageChunk,
  type UITools,
} from 'ai';
import dedent from 'dedent';
import { v7 } from 'uuid';

import { generate, pipe, printer, stream, user } from '@deepagents/agent';

import type { Adapter } from './adapters/adapter.ts';
import { Sqlite } from './adapters/sqlite.ts';
import { BriefCache, generateBrief, toBrief } from './agents/brief.agent.ts';
import { suggestionsAgent } from './agents/suggestions.agents.ts';
import { synthesizerAgent } from './agents/synthesizer.agent.ts';
import { text2sqlMonolith, text2sqlOnly } from './agents/text2sql.agent.ts';
import { History } from './history/history.ts';
import { SqliteHistory } from './history/sqlite.history.ts';

export class Text2Sql {
  #config: {
    adapter: Adapter;
    cache: BriefCache;
    history: History;
  };
  constructor(config: {
    adapter: Adapter;
    cache: BriefCache;
    history: History;
  }) {
    this.#config = config;
  }
  async #getSql(
    stream: ReadableStream<
      InferUIMessageChunk<UIMessage<unknown, UIDataTypes, UITools>>
    >,
  ) {
    const chunks = (await Array.fromAsync(stream as any)) as UIMessageChunk[];
    const sql = chunks.at(-1);
    if (sql && sql.type === 'data-text-delta') {
      return (sql.data as { text: string }).text;
    }
    throw new Error('No SQL generated');
  }

  public async toSql(input: string) {
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
      },
      toBrief(),
      async (state) => {
        const { experimental_output: output } = await generate(
          text2sqlOnly,
          [user(state.input)],
          state,
        );
        return output.sql;
      },
    );

    return {
      generate: () => {
        const stream = pipeline();
        return this.#getSql(stream);
      },
      stream: () => {
        const stream = pipeline();
        return stream;
      },
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
    const introspectionPromise = this.#config.adapter.introspect();
    const adapterInfoPromise = this.#config.adapter.info();
    const [introspection, adapterInfo] = await Promise.all([
      introspectionPromise,
      adapterInfoPromise,
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
    return stream(text2sqlMonolith, [user(input)], {
      adapter: this.#config.adapter,
      introspection,
      adapterInfo: this.#config.adapter.formatInfo(adapterInfo),
      context: await generateBrief(introspection, this.#config.cache),
    });
  }
  public async chat(
    messages: UIMessage[],
    params: {
      chatId: string;
      userId: string;
    },
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

    const result = stream(
      text2sqlMonolith,
      [...chat.messages.map((it) => it.content), ...messages],
      {
        adapter: this.#config.adapter,
        introspection,
        adapterInfo: this.#config.adapter.formatInfo(adapterInfo),
        context: await generateBrief(introspection, this.#config.cache),
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
  const { DatabaseSync } = await import('node:sqlite');
  const sqliteClient = new DatabaseSync(
    '/Users/ezzabuzaid/Downloads/Chinook.db',
    { readOnly: true },
  );
  const history = new SqliteHistory('./text2sql_history.sqlite');
  const chats = await history.listChats('default');
  for (const chat of chats) {
    console.log(`- Chat ID: ${chat.id}, Title: ${chat.title}`);
  }
  const text2sql = new Text2Sql({
    cache: new BriefCache('brief'),
    history: history,
    adapter: new Sqlite({
      execute: (sql) => sqliteClient.prepare(sql).all(),
    }),
  });
  const sql = await text2sql.chat(
    [user('what was the question I asked you?')],
    {
      userId: 'default',
      chatId: '019a9b5a-f118-76a9-9dee-609e28ec60b3',
    },
  );
  await printer.readableStream(sql);
}
