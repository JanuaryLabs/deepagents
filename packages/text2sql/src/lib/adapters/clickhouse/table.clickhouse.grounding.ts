import type { Adapter, Relationship, Table } from '../adapter.ts';
import {
  TableGrounding,
  type TableGroundingConfig,
} from '../groundings/table.grounding.ts';

type ColumnRow = {
  name: string;
  type: string;
};

export class ClickHouseTableGrounding extends TableGrounding {
  readonly #adapter: Adapter;

  constructor(adapter: Adapter, config: TableGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
  }

  protected override async getAllTableNames(): Promise<string[]> {
    const rows = await this.#adapter.runQuery<{ name: string }>(`
      SELECT concat(database, '.', name) AS name
      FROM system.tables
      WHERE database NOT IN ('system', 'information_schema', 'INFORMATION_SCHEMA')
        AND is_temporary = 0
        AND engine != 'View'
      ORDER BY database, name
    `);
    return rows.map((row) => row.name);
  }

  protected override async getTable(tableName: string): Promise<Table> {
    const { schema, table } = this.#adapter.parseTableName(tableName);
    if (!schema) {
      throw new Error(
        `ClickHouse table grounding requires a qualified table name: ${tableName}`,
      );
    }
    const rows = await this.#adapter.runQuery<ColumnRow>(`
      SELECT name, type
      FROM system.columns
      WHERE database = '${this.#adapter.escapeString(schema)}'
        AND table = '${this.#adapter.escapeString(table)}'
      ORDER BY position
    `);
    return {
      name: tableName,
      schema,
      rawName: table,
      columns: rows.map((row) => ({ name: row.name, type: row.type })),
    };
  }

  protected override async findOutgoingRelations(): Promise<Relationship[]> {
    return [];
  }

  protected override async findIncomingRelations(): Promise<Relationship[]> {
    return [];
  }
}
