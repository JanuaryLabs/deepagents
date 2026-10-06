import type { Adapter, Relationship, Table } from '../adapter.ts';
import { nameRow } from '../groundings/rows.ts';
import {
  TableGrounding,
  type TableGroundingConfig,
} from '../groundings/table.grounding.ts';
import { foreignKeyListRow, tableInfoRow } from './sqlite-rows.ts';

/**
 * SQLite implementation of TableGrounding.
 *
 * SQLite requires caching all relationships for backward lookups because
 * PRAGMA foreign_key_list only returns outgoing FKs from a specific table.
 */
export class SqliteTableGrounding extends TableGrounding {
  #adapter: Adapter;
  #relationshipCache: Relationship[] | null = null;

  constructor(adapter: Adapter, config: TableGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
  }

  protected override async getAllTableNames(): Promise<string[]> {
    const rows = await this.#adapter.runQuery(
      `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
      nameRow,
    );

    return rows
      .map((row) => row.name)
      .filter((name) => !name.startsWith('sqlite_'));
  }

  protected override async getTable(tableName: string): Promise<Table> {
    const columns = await this.#adapter.runQuery(
      `PRAGMA table_info(${this.#quoteIdentifier(tableName)})`,
      tableInfoRow,
    );

    return {
      name: tableName,
      rawName: tableName,
      columns: columns.map((col) => ({ name: col.name, type: col.type })),
    };
  }

  protected override async findOutgoingRelations(
    tableName: string,
  ): Promise<Relationship[]> {
    const rows = await this.#adapter.runQuery(
      `PRAGMA foreign_key_list(${this.#quoteIdentifier(tableName)})`,
      foreignKeyListRow,
    );

    const groups = new Map<number, Relationship>();

    for (const row of rows) {
      if (row.to === null) {
        continue;
      }

      const existing = groups.get(row.id);
      if (!existing) {
        groups.set(row.id, {
          table: tableName,
          from: [row.from],
          referenced_table: row.table,
          to: [row.to],
        });
      } else {
        existing.from.push(row.from);
        existing.to.push(row.to);
      }
    }

    return Array.from(groups.values());
  }

  protected override async findIncomingRelations(
    tableName: string,
  ): Promise<Relationship[]> {
    // SQLite limitation: PRAGMA only shows outgoing FKs
    // Must scan all tables and cache the results
    if (!this.#relationshipCache) {
      this.#relationshipCache = await this.#loadAllRelationships();
    }
    return this.#relationshipCache.filter(
      (r) => r.referenced_table === tableName,
    );
  }

  async #loadAllRelationships(): Promise<Relationship[]> {
    const allNames = await this.getAllTableNames();
    const results: Relationship[] = [];
    for (const name of allNames) {
      results.push(...(await this.findOutgoingRelations(name)));
    }
    return results;
  }

  #quoteIdentifier(name: string) {
    return `'${name.replace(/'/g, "''")}'`;
  }
}
