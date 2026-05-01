import nodeSqlParser from 'node-sql-parser';
import assert from 'node:assert';
import { describe, it } from 'node:test';

const { Parser } = nodeSqlParser;
const parser = new Parser();

type Outcome = { ok: true } | { ok: false; message: string };

function probe(sql: string, dialect: string): Outcome {
  try {
    parser.astify(sql, { database: dialect });
    return { ok: true };
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err))
      .split('\n')[0]
      .trim();
    return { ok: false, message };
  }
}

describe('node-sql-parser dialect divergences (documents WHY we cascade sqlite -> mysql)', () => {
  // Source-grounded notes (node-sql-parser v5.4.0):
  //
  // sqlite.pegjs:2-99   `reservedMap` includes COUNT, PERSIST, GLOBAL, SESSION, LOCAL, etc.
  // sqlite.pegjs:2329   `ident` rule rejects names where `reservedMap[name.toUpperCase()] === true`
  //                     via a PEG negative semantic predicate, with no fallback for unquoted reserved words.
  // mysql.pegjs:2-XX    `reservedMap` does NOT include COUNT/PERSIST, so the same `ident` rule succeeds.
  //
  // sqlite.pegjs:1620   `table_base` includes alternative `ident_name LPAREN expr_list RPAREN` for
  //                     table-valued function calls (json_each, json_tree, etc.) in FROM.
  // mysql.pegjs:2645    `table_base` only allows DUAL / table_name / parenthesized subquery / VALUES /
  //                     LATERAL subquery — no TVF alternative, so `json_each('...')` cannot reduce.

  describe('queries that fail under sqlite but pass under mysql', () => {
    const queries: Array<{ name: string; sql: string }> = [
      { name: 'unquoted identifier "persist"', sql: 'SELECT * FROM persist' },
      {
        name: 'function name COUNT applied to identifier "count"',
        sql: 'SELECT SUM(count) AS total FROM integers',
      },
    ];

    for (const { name, sql } of queries) {
      it(`[${name}] sqlite rejects, mysql accepts`, () => {
        const sqliteOutcome = probe(sql, 'sqlite');
        const mysqlOutcome = probe(sql, 'mysql');

        console.log(`SQL: ${sql}`);
        console.log(
          `  sqlite -> ${
            sqliteOutcome.ok ? 'ok' : `FAIL: ${sqliteOutcome.message}`
          }`,
        );
        console.log(
          `  mysql  -> ${
            mysqlOutcome.ok ? 'ok' : `FAIL: ${mysqlOutcome.message}`
          }`,
        );

        assert.strictEqual(
          sqliteOutcome.ok,
          false,
          'expected sqlite parser to reject this query',
        );
        assert.strictEqual(
          mysqlOutcome.ok,
          true,
          'expected mysql parser to accept this query',
        );
      });
    }
  });

  describe('queries that pass under sqlite but fail under mysql', () => {
    const queries: Array<{ name: string; sql: string }> = [
      {
        name: 'json_each(...) as a FROM-clause table source',
        sql: "SELECT value FROM json_each('[1,2,3]')",
      },
      {
        name: 'comma-joined json_each in CTE',
        sql: `WITH t AS (SELECT 'a,b' AS s)
              SELECT value FROM t, json_each('["a","b"]')`,
      },
    ];

    for (const { name, sql } of queries) {
      it(`[${name}] sqlite accepts, mysql rejects`, () => {
        const sqliteOutcome = probe(sql, 'sqlite');
        const mysqlOutcome = probe(sql, 'mysql');

        console.log(`SQL: ${sql.replace(/\s+/g, ' ').slice(0, 120)}`);
        console.log(
          `  sqlite -> ${
            sqliteOutcome.ok ? 'ok' : `FAIL: ${sqliteOutcome.message}`
          }`,
        );
        console.log(
          `  mysql  -> ${
            mysqlOutcome.ok ? 'ok' : `FAIL: ${mysqlOutcome.message}`
          }`,
        );

        assert.strictEqual(
          sqliteOutcome.ok,
          true,
          'expected sqlite parser to accept this query',
        );
        assert.strictEqual(
          mysqlOutcome.ok,
          false,
          'expected mysql parser to reject this query',
        );
      });
    }
  });

  describe('queries that pass under both dialects (cascade picks sqlite, fast path)', () => {
    const queries = [
      'SELECT * FROM users',
      'SELECT id, name FROM users WHERE id = 1',
    ];

    for (const sql of queries) {
      it(`[${sql}] both parsers accept`, () => {
        assert.strictEqual(probe(sql, 'sqlite').ok, true);
        assert.strictEqual(probe(sql, 'mysql').ok, true);
      });
    }
  });
});
