import type { Adapter } from '../adapter.ts';
import {
  type Column,
  LowCardinalityGrounding,
  type LowCardinalityGroundingConfig,
} from '../groundings/low-cardinality.grounding.ts';

/**
 * SQLite implementation of LowCardinalityGrounding.
 */
export class SqliteLowCardinalityGrounding extends LowCardinalityGrounding {
  #adapter: Adapter;

  constructor(adapter: Adapter, config: LowCardinalityGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
  }

  protected override async collectLowCardinality(
    tableName: string,
    column: Column,
  ): Promise<{ kind: 'LowCardinality'; values: string[] } | undefined> {
    const tableIdentifier = this.#adapter.quoteIdentifier(tableName);
    const columnIdentifier = this.#adapter.quoteIdentifier(column.name);
    // Add one to limit to detect if it exceeds the threshold
    const queryLimit = this.limit + 1;

    const sql = `
      SELECT DISTINCT ${columnIdentifier} AS value
      FROM ${tableIdentifier}
      WHERE ${columnIdentifier} IS NOT NULL
      LIMIT ${queryLimit}
    `;

    const rows = await this.#adapter.runQuery<{ value: unknown }>(sql);

    if (!rows.length || rows.length > this.limit) {
      return undefined;
    }

    const values: string[] = [];
    for (const row of rows) {
      const formatted = this.#normalizeValue(row.value);
      if (formatted == null) {
        // Skip columns with non-normalizable values
        return undefined;
      }
      values.push(formatted);
    }

    if (!values.length) {
      return undefined;
    }

    return { kind: 'LowCardinality', values };
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
}
