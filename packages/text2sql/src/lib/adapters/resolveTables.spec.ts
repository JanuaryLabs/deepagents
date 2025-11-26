import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';

import { Sqlite } from './sqlite.ts';

/**
 * Comprehensive test-suite scaffold for Adapter.resolveTables business behavior.
 *
 * NOTE: This file contains only test definitions / TODOs describing the
 *       business scenarios and acceptance criteria. No test implementation
 *       or mocking is provided here — that will be implemented later.
 */

describe('resolveTables business scenarios', () => {
  test('returns the single matched table when no relationships exist — single explicit selection', async () => {
    const ddl = [`CREATE TABLE A(id INTEGER PRIMARY KEY);`];
    const { adapter, db } = await init_db(ddl);
    try {
      const out = await adapter.resolveTables(['A']);
      assert.deepEqual(new Set(out), new Set(['A']));
    } finally {
      db.close();
    }
  });

  test('returns multiple matched tables for a list filter when no relationships exist', async () => {
    const ddl = [
      `CREATE TABLE A(id INTEGER PRIMARY KEY);`,
      `CREATE TABLE B(id INTEGER PRIMARY KEY);`,
      `CREATE TABLE C(id INTEGER PRIMARY KEY);`,
    ];
    const { adapter, db } = await init_db(ddl);
    try {
      const out = await adapter.resolveTables(['A', 'C']);
      assert.deepEqual(new Set(out), new Set(['A', 'C']));
    } finally {
      db.close();
    }
  });

  test('supports RegExp filters and returns all matching tables (no relationships)', async () => {
    const ddl = [
      `CREATE TABLE Customer(id INTEGER PRIMARY KEY);`,
      `CREATE TABLE "Order"(id INTEGER PRIMARY KEY);`,
      `CREATE TABLE Product(id INTEGER PRIMARY KEY);`,
    ];
    const { adapter, db } = await init_db(ddl);
    try {
      const out = await adapter.resolveTables(/Cust/);
      assert.deepEqual(out, ['Customer']);
    } finally {
      db.close();
    }
  });

  test('returns the full connected component (transitive closure) when starting from one end of a chain', async () => {
    const ddl = [
      `CREATE TABLE C(id INTEGER PRIMARY KEY);`,
      `CREATE TABLE B(id INTEGER PRIMARY KEY, c_id INTEGER, FOREIGN KEY(c_id) REFERENCES C(id));`,
      `CREATE TABLE A(id INTEGER PRIMARY KEY, b_id INTEGER, FOREIGN KEY(b_id) REFERENCES B(id));`,
      `CREATE TABLE D(id INTEGER PRIMARY KEY);`,
    ];
    const { adapter, db } = await init_db(ddl);
    try {
      const out = await adapter.resolveTables(['A']);
      assert.deepEqual(new Set(out), new Set(['A', 'B', 'C']));
    } finally {
      db.close();
    }
  });

  test('returns union of multiple connected components when filter lists tables from different components', async () => {
    const ddl = [
      `CREATE TABLE C(id INTEGER PRIMARY KEY);`,
      `CREATE TABLE B(id INTEGER PRIMARY KEY, c_id INTEGER, FOREIGN KEY(c_id) REFERENCES C(id));`,
      `CREATE TABLE A(id INTEGER PRIMARY KEY, b_id INTEGER, FOREIGN KEY(b_id) REFERENCES B(id));`,
      `CREATE TABLE D(id INTEGER PRIMARY KEY, e_id INTEGER, FOREIGN KEY(e_id) REFERENCES E(id));`,
      `CREATE TABLE E(id INTEGER PRIMARY KEY);`,
    ];
    const { adapter, db } = await init_db(ddl);
    try {
      const out = await adapter.resolveTables(['A', 'E']);
      assert.deepEqual(new Set(out), new Set(['A', 'B', 'C', 'D', 'E']));
    } finally {
      db.close();
    }
  });

  test('handles cyclic relationships by returning the cycle once (no infinite loops)', async () => {
    const ddl = [
      `CREATE TABLE A(id INTEGER PRIMARY KEY, b_id INTEGER, FOREIGN KEY(b_id) REFERENCES B(id));`,
      `CREATE TABLE B(id INTEGER PRIMARY KEY, c_id INTEGER, FOREIGN KEY(c_id) REFERENCES C(id));`,
      `CREATE TABLE C(id INTEGER PRIMARY KEY, a_id INTEGER, FOREIGN KEY(a_id) REFERENCES A(id));`,
    ];
    const { adapter, db } = await init_db(ddl);
    try {
      const out = await adapter.resolveTables(['A']);
      assert.deepEqual(new Set(out), new Set(['A', 'B', 'C']));
    } finally {
      db.close();
    }
  });

  test('handles self-referencing foreign keys correctly (single table referencing itself)', async () => {
    const ddl = [
      `CREATE TABLE A(id INTEGER PRIMARY KEY, parent_id INTEGER, FOREIGN KEY(parent_id) REFERENCES A(id));`,
    ];
    const { adapter, db } = await init_db(ddl);
    try {
      const out = await adapter.resolveTables(['A']);
      assert.deepEqual(out, ['A']);
    } finally {
      db.close();
    }
  });

  test('treats composite foreign keys (grouped rows with same id) as a single relationship and avoids duplicates', async () => {
    const ddl = [
      `CREATE TABLE B(id1 INTEGER, id2 INTEGER, PRIMARY KEY(id1,id2));`,
      `CREATE TABLE A(a1 INTEGER, a2 INTEGER, b1 INTEGER, b2 INTEGER, FOREIGN KEY(b1,b2) REFERENCES B(id1,id2));`,
    ];
    const { adapter, db } = await init_db(ddl);
    try {
      const out = await adapter.resolveTables(['A']);
      assert.deepEqual(new Set(out), new Set(['A', 'B']));
    } finally {
      db.close();
    }
  });

  test('documents behavior when relationships reference unknown/external tables not present in allTables', async () => {
    // A references X but X is not created
    const ddl = [
      `CREATE TABLE A(id INTEGER PRIMARY KEY, x_id INTEGER, FOREIGN KEY(x_id) REFERENCES X(id));`,
    ];
    const { adapter, db } = await init_db(ddl);
    try {
      const out = await adapter.resolveTables(['A']);
      // current implementation includes referenced table even if not present in allTables
      assert.deepEqual(new Set(out), new Set(['A', 'X']));
    } finally {
      db.close();
    }
  });

  test('ignores filter names not present in allTables and expands only from found matches', async () => {
    const ddl = [
      `CREATE TABLE A(id INTEGER PRIMARY KEY, b_id INTEGER, FOREIGN KEY(b_id) REFERENCES B(id));`,
      `CREATE TABLE B(id INTEGER PRIMARY KEY);`,
    ];
    const { adapter, db } = await init_db(ddl);
    try {
      const out = await adapter.resolveTables(['A', 'Unknown']);
      assert.deepEqual(new Set(out), new Set(['A', 'B']));
    } finally {
      db.close();
    }
  });

  test('returns [] when filter is an empty array (explicit request for no tables)', async () => {
    const ddl = [
      `CREATE TABLE A(id INTEGER PRIMARY KEY);`,
      `CREATE TABLE B(id INTEGER PRIMARY KEY);`,
    ];
    const { adapter, db } = await init_db(ddl);
    try {
      const out = await adapter.resolveTables([]);
      assert.deepEqual(out, []);
    } finally {
      db.close();
    }
  });

  test('when RegExp matches multiple tables, resolveTables returns closure of all matched tables combined', async () => {
    const ddl = [
      `CREATE TABLE Customers(id INTEGER PRIMARY KEY);`,
      `CREATE TABLE CustomerOrders(id INTEGER PRIMARY KEY, customer_id INTEGER, FOREIGN KEY(customer_id) REFERENCES Customers(id));`,
      `CREATE TABLE Orders(id INTEGER PRIMARY KEY, co_id INTEGER, FOREIGN KEY(co_id) REFERENCES CustomerOrders(id));`,
      `CREATE TABLE Products(id INTEGER PRIMARY KEY, order_id INTEGER, FOREIGN KEY(order_id) REFERENCES Orders(id));`,
    ];
    const { adapter, db } = await init_db(ddl);
    try {
      const out = await adapter.resolveTables(/Customer/);
      assert.deepEqual(
        new Set(out),
        new Set(['Customers', 'CustomerOrders', 'Orders', 'Products']),
      );
    } finally {
      db.close();
    }
  });

  test('asserts on set equality rather than relying on array order to keep tests deterministic', async () => {
    const ddl = [
      `CREATE TABLE A(id INTEGER PRIMARY KEY);`,
      `CREATE TABLE B(id INTEGER PRIMARY KEY);`,
    ];
    const { adapter, db } = await init_db(ddl);
    try {
      const out = await adapter.resolveTables(['A', 'B']);
      assert.deepEqual(new Set(out), new Set(['A', 'B']));
    } finally {
      db.close();
    }
  });

  test('sanity test: resolves very large/deep connected components (defensive, not a performance benchmark)', async () => {
    // create a chain of 30 tables A1 -> A2 -> ... -> A30
    const N = 30;
    const names: string[] = [];
    const ddl: string[] = [];
    for (let i = 1; i <= N; i++) {
      const cur = `A${i}`;
      names.push(cur);
      if (i === N) {
        ddl.push(`CREATE TABLE ${cur}(id INTEGER PRIMARY KEY)`);
      } else {
        const next = `A${i + 1}`;
        ddl.push(
          `CREATE TABLE ${cur}(id INTEGER PRIMARY KEY, next_id INTEGER, FOREIGN KEY(next_id) REFERENCES ${next}(id))`,
        );
      }
    }

    const { adapter, db } = await init_db(ddl);
    try {
      const out = await adapter.resolveTables(['A1']);
      assert.equal(new Set(out).size, N);
      for (const n of names) assert.ok(out.includes(n));
    } finally {
      db.close();
    }
  });

  // Acceptance notes for each TODO (copy into implementation):
  // - Setup: which tables exist (allTables)
  // - Relationships: list of { table, from[], referenced_table, to[] }
  // - Filter: string[] or RegExp
  // - Expected output: explicit list (use set equality in assertions)
  // - Reason/Business rationale: why the behavior is required
});

/**
 * Create an in-memory sqlite database, apply DDL, and return a Sqlite adapter bound to it
 * along with the DatabaseSync instance for cleanup.
 */
// init_db provided by test/helpers/sqlite.test-utils

/**
 * Create an in-memory sqlite database, apply DDL, and return a Sqlite adapter bound to it
 * along with the DatabaseSync instance for cleanup.
 */
async function init_db(ddl: string | string[]) {
  const db = new DatabaseSync(':memory:');

  // enable foreign keys
  try {
    db.exec('PRAGMA foreign_keys = ON;');
  } catch {
    // ignore — best effort
  }

  if (Array.isArray(ddl)) {
    for (const stmt of ddl) {
      db.exec(stmt);
    }
  } else if (typeof ddl === 'string') {
    db.exec(ddl);
  }

  const adapter = new Sqlite({
    execute: (sql: string) => db.prepare(sql).all(),
  });
  return { adapter, db };
}
