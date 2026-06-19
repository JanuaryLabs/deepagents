import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { render } from '@deepagents/context';
import { FileIndexLock, Text2Sql } from '@deepagents/text2sql';
import { Sqlite, info, tables } from '@deepagents/text2sql/sqlite';

function sqliteAdapter(ddl: string) {
  const db = new DatabaseSync(':memory:');
  db.exec(ddl);
  return new Sqlite({
    execute: (sql: string) => db.prepare(sql).all(),
    grounding: [tables(), info()],
  });
}

describe('index() database name label', () => {
  it('labels the adapter block with its configured name as a <db> value, ahead of the schema', async () => {
    const text2Sql = new Text2Sql({
      adapters: {
        analytics: sqliteAdapter(
          `CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT);`,
        ),
      },
      lock: new FileIndexLock({ namespace: randomUUID() }),
    });

    const fragments = await text2Sql.index();

    // index() keeps its contract: one fragment per adapter, named after the key.
    assert.equal(fragments.length, 1);
    assert.equal(fragments[0].name, 'analytics');

    const out = render('system', ...fragments);

    // The name is now a labeled value, not merely the wrapper tag.
    assert.match(out, /<database>analytics<\/database>/);
    // ...and it renders as a clean leaf, not the double-nested
    // <database><database>...</database></database> that fragment('database', name) produces.
    assert.doesNotMatch(out, /<database>\s*<database>/);
    const labelIdx = out.indexOf('<database>analytics</database>');
    const tableIdx = out.indexOf('<table>');
    assert.ok(
      labelIdx >= 0 && tableIdx > labelIdx,
      'label should precede the schema it describes',
    );
  });

  it('labels every adapter block independently in a multi-adapter index', async () => {
    const text2Sql = new Text2Sql({
      adapters: {
        sales: sqliteAdapter(`CREATE TABLE orders (id INTEGER);`),
        analytics: sqliteAdapter(`CREATE TABLE events (id INTEGER);`),
      },
      lock: new FileIndexLock({ namespace: randomUUID() }),
    });

    const out = render('system', ...(await text2Sql.index()));

    assert.match(out, /<sales>[\s\S]*?<database>sales<\/database>/);
    assert.match(out, /<analytics>[\s\S]*?<database>analytics<\/database>/);
  });
});
