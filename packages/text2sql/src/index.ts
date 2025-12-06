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
export * from './lib/teach/teachings.ts';

if (import.meta.main) {
  // const { DatabaseSync } = await import('node:sqlite');
  // const sqliteClient = new DatabaseSync(
  //   '/Users/ezzabuzaid/Downloads/Chinook.db',
  // );
  // const text2sql = new Text2Sql({
  //   version: 'v2',
  //   history: new InMemoryHistory(),
  //   adapter: new Sqlite({
  //     grounding: [],
  //     execute: (sql) => sqliteClient.prepare(sql).all(),
  //   }),
  // });
  // console.dir(await text2sql.inspect(sqlQueryAgent), { depth: null });
  // const sql = await text2sql.toSql(
  //   'The top-selling products or categories each month last year given last record stored?. if the questions is wrong, show me full correct question I can ask.',
  // );
  // console.log('Generated SQL:');
  // console.log(sql);
  // await printer.readableStream(sql);
}
