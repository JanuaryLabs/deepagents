import type { Adapter } from '../adapter.ts';
import {
  type Column,
  ColumnValuesGrounding,
  type ColumnValuesGroundingConfig,
} from '../groundings/column-values.grounding.ts';

type ColumnTypeRow = {
  COLUMN_TYPE: string | null;
};

/**
 * MySQL/MariaDB implementation of ColumnValuesGrounding.
 *
 * Detects:
 * 1. Native ENUM types - parses values from COLUMN_TYPE
 * 2. Low cardinality columns - via data scan
 */
export class MysqlColumnValuesGrounding extends ColumnValuesGrounding {
  #adapter: Adapter;

  constructor(adapter: Adapter, config: ColumnValuesGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
  }

  /**
   * Detect native MySQL ENUM types and extract their values.
   */
  protected override async collectEnumValues(
    tableName: string,
    column: Column,
  ): Promise<string[] | undefined> {
    const { schema, table } = this.#adapter.parseTableName(tableName);
    const database = schema || (await this.#getCurrentDatabase());

    const rows = await this.#adapter.runQuery<ColumnTypeRow>(`
      SELECT COLUMN_TYPE
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = '${this.#adapter.escapeString(database)}'
        AND TABLE_NAME = '${this.#adapter.escapeString(table)}'
        AND COLUMN_NAME = '${this.#adapter.escapeString(column.name)}'
    `);

    const columnType = rows[0]?.COLUMN_TYPE;
    if (!columnType) return undefined;

    // Check if it's an ENUM type: enum('val1','val2','val3')
    const enumMatch = columnType.match(/^enum\((.+)\)$/i);
    if (!enumMatch) return undefined;

    // Parse enum values
    return this.#parseEnumValues(enumMatch[1]);
  }

  /**
   * Collect distinct values for low cardinality columns.
   */
  protected override async collectLowCardinality(
    tableName: string,
    column: Column,
  ): Promise<string[] | undefined> {
    const { schema, table } = this.#adapter.parseTableName(tableName);
    const database = schema || (await this.#getCurrentDatabase());

    const tableIdentifier = `${this.#adapter.quoteIdentifier(database)}.${this.#adapter.quoteIdentifier(table)}`;
    const columnIdentifier = this.#adapter.quoteIdentifier(column.name);
    const limit = this.lowCardinalityLimit + 1;

    try {
      const rows = await this.#adapter.runQuery<{ value: unknown }>(`
        SELECT DISTINCT ${columnIdentifier} AS value
        FROM ${tableIdentifier}
        WHERE ${columnIdentifier} IS NOT NULL
        LIMIT ${limit}
      `);

      if (!rows.length || rows.length > this.lowCardinalityLimit) {
        return undefined;
      }

      const values: string[] = [];
      for (const row of rows) {
        const formatted = this.#normalizeValue(row.value);
        if (formatted === null) {
          return undefined;
        }
        values.push(formatted);
      }

      return values.length > 0 ? values : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Parse ENUM values from the COLUMN_TYPE string.
   * Input: "'val1','val2','val3'"
   * Output: ['val1', 'val2', 'val3']
   */
  #parseEnumValues(enumString: string): string[] {
    const values: string[] = [];
    // Match quoted strings, handling escaped quotes
    const regex = /'((?:[^'\\]|\\.|'')*)'/g;
    let match;
    while ((match = regex.exec(enumString)) !== null) {
      // Unescape any escaped quotes
      const value = match[1]
        .replace(/''/g, "'")
        .replace(/\\'/g, "'")
        .replace(/\\\\/g, '\\');
      values.push(value);
    }
    return values;
  }

  #normalizeValue(value: unknown): string | null {
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value === 'string') {
      return value;
    }
    if (typeof value === 'number' || typeof value === 'bigint') {
      return String(value);
    }
    if (typeof value === 'boolean') {
      return value ? 'true' : 'false';
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
      return value.toString('utf-8');
    }
    return null;
  }

  async #getCurrentDatabase(): Promise<string> {
    const rows = await this.#adapter.runQuery<{ db: string | null }>(
      'SELECT DATABASE() AS db',
    );
    return rows[0]?.db ?? '';
  }
}
