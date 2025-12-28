export * from './lib/adapters/adapter.ts';
export * from './lib/agents/developer.agent.ts';
export * from './lib/agents/suggestions.agents.ts';
export * from './lib/agents/text2sql.agent.ts';
export * from './lib/checkpoint.ts';
export * from './lib/file-cache.ts';
export * from './lib/history/history.ts';
export * from './lib/history/memory.history.ts';
export * from './lib/history/sqlite.history.ts';
export * from './lib/memory/memory.store.ts';
export * from './lib/memory/sqlite.store.ts';
export * from './lib/memory/store.ts';
export * from './lib/sql.ts';
export * from './lib/teach/teachings.ts';

// const prompt = `Build a dashboard to show reservation trends over time.`;

// if (import.meta.main) {
//   const { printer, user, input } = await import('@deepagents/agent');
//   const { Text2Sql } = await import('./lib/sql.ts');
//   const { InMemoryHistory } = await import('./lib/history/memory.history.ts');
//   const postgres = await import('./lib/adapters/postgres/index.ts');
//   const pg = await import('pg');
//   const pool = new pg.Pool({
//     ssl: true,
//     connectionString: process.env.DATASET_DATASOURCE,
//   });
//   const adapter = new postgres.Postgres({
//     execute: async (sql) => pool.query(sql).then((it) => it.rows),
//     grounding: [
//       postgres.info(),
//       postgres.tables(),
//       postgres.constraints(),
//       postgres.indexes(),
//     ],
//   });

//   const text2sql = new Text2Sql({
//     version: 'vc_v3',
//     adapter,
//     history: new InMemoryHistory(),
//   });
//   const result = await text2sql.bi([user(prompt)], {
//     chatId: 'test-chat-1',
//     userId: 'test-user-1',
//   });
//   await printer.readableStream(result);
//   // while (true) {
//   //   const result = await text2sql.chat([user(await input())], {
//   //     chatId: 'test-chat',
//   //     userId: 'test-user',
//   //   });

//   //   // console.log('Generated SQL:');
//   //   // console.log(sql);
//   //   await printer.readableStream(result);
//   // }
// }
