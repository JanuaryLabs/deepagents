import type {
  InferUIMessageChunk,
  UIDataTypes,
  UIMessage,
  UIMessageChunk,
  UITools,
} from 'ai';
import dedent from 'dedent';

import { generate, pipe, printer, stream, user } from '@deepagents/agent';

import type { Adapter } from './adapters/adapter.ts';
import { Sqlite } from './adapters/sqlite.ts';
import { BriefCache, generateBrief, toBrief } from './agents/brief.agent.ts';
import { synthesizerAgent } from './agents/synthesizer.agent.ts';
import { text2sqlMonolith, text2sqlOnly } from './agents/text2sql.agent.ts';
import { suggestionsAgent } from './agents/suggestions.agents.ts';

export class Text2Sql {
  #config: { adapter: Adapter; cache: BriefCache };
  constructor(config: { adapter: Adapter; cache: BriefCache }) {
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
      context: await generateBrief(introspection, this.#config.cache)
    });
  }
  public async chat(messages: UIMessage[]) {
    const [introspection, adapterInfo] = await Promise.all([
      this.#config.adapter.introspect(),
      this.#config.adapter.info(),
    ]);
    return stream(text2sqlMonolith, messages, {
      adapter: this.#config.adapter,
      introspection,
      adapterInfo: this.#config.adapter.formatInfo(adapterInfo),
      context: await generateBrief(introspection, this.#config.cache)
    });
  }
}
if (import.meta.main) {
  const { DatabaseSync } = await import('node:sqlite');
  const sqliteClient = new DatabaseSync(
    '/Users/ezzabuzaid/Downloads/Chinook.db',
    {
      readOnly: true,
      open: true,
    },
  );
  const text2sql = new Text2Sql({
    adapter: new Sqlite({
      execute: (sql) => sqliteClient.prepare(sql).all(),
    }),
    cache: new BriefCache('brief'),
  });
  const sql = await text2sql.single(
    'What tracks have a unit price greater than $1.00?',
  );
  await printer.stdout(sql);
}
