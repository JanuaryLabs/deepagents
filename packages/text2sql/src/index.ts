import { synthetic } from './lib/agents/synthetic/index.ts';

export * from './lib/adapters/adapter.ts';
export * from './lib/agents/suggestions.agents.ts';
export * from './lib/agents/text2sql.agent.ts';
export * from './lib/file-cache.ts';
export * from './lib/history/history.ts';
export * from './lib/history/memory.history.ts';
export * from './lib/history/sqlite.history.ts';
export * from './lib/memory/memory.store.ts';
export * from './lib/memory/sqlite.store.ts';
export * from './lib/memory/store.ts';
export * from './lib/sql.ts';
export * from './lib/synthesis/extractors/index.ts';
export * from './lib/teach/teachings.ts';

if (import.meta.main) {
  const { DatabaseSync } = await import('node:sqlite');
  const sqliteClient = new DatabaseSync(
    '/Users/ezzabuzaid/Downloads/Chinook.db',
  );
  const { Text2Sql } = await import('./lib/sql.ts');
  const { InMemoryHistory } = await import('./lib/history/memory.history.ts');
  const sqlite = await import('./lib/adapters/sqlite/index.ts');

  const adapter = new sqlite.Sqlite({
    grounding: [sqlite.tables(), sqlite.constraints()],
    execute: (sql) => sqliteClient.prepare(sql).all(),
  });

  const data = await synthetic()(adapter).generateDiverseQuestions();
  console.log(data);
  // console.dir(await text2sql.inspect(sqlQueryAgent), { depth: null });
  // const sql = await text2sql.toSql(
  //   'The top-selling products or categories each month last year given last record stored?. if the questions is wrong, show me full correct question I can ask.',
  // );
  // console.log('Generated SQL:');
  // console.log(sql);
  // await printer.readableStream(sql);
}
