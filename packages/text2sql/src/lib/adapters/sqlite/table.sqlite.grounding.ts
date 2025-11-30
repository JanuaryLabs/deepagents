import type { Adapter, Relationship, Table } from '../adapter.ts';
import {
  TableGrounding,
  type TableGroundingConfig,
} from '../groundings/table.grounding.ts';

type ColumnRow = {
  name: string | null | undefined;
  type: string | null | undefined;
  pk?: number | null | undefined;
};

type ForeignKeyRow = {
  id: number | null | undefined;
  table: string | null | undefined;
  from: string | null | undefined;
  to: string | null | undefined;
};

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
    const rows = await this.#adapter.runQuery<{
      name: string | null | undefined;
    }>(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`);

    return rows
      .map((row) => row.name)
      .filter(
        (name): name is string =>
          typeof name === 'string' && !name.startsWith('sqlite_'),
      );
  }

  protected override async getTable(tableName: string): Promise<Table> {
    const columns = await this.#adapter.runQuery<ColumnRow>(
      `PRAGMA table_info(${this.#quoteIdentifier(tableName)})`,
    );

    return {
      name: tableName,
      rawName: tableName,
      columns: columns.map((col) => ({
        name: col.name ?? 'unknown',
        type: col.type ?? 'unknown',
      })),
    };
  }

  protected override async findOutgoingRelations(
    tableName: string,
  ): Promise<Relationship[]> {
    const rows = await this.#adapter.runQuery<ForeignKeyRow>(
      `PRAGMA foreign_key_list(${this.#quoteIdentifier(tableName)})`,
    );

    const groups = new Map<number, Relationship>();

    for (const row of rows) {
      if (
        row.id == null ||
        row.table == null ||
        row.from == null ||
        row.to == null
      ) {
        continue;
      }

      const id = Number(row.id);
      const existing = groups.get(id);
      if (!existing) {
        groups.set(id, {
          table: tableName,
          from: [String(row.from)],
          referenced_table: String(row.table),
          to: [String(row.to)],
        });
      } else {
        existing.from.push(String(row.from));
        existing.to.push(String(row.to));
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
