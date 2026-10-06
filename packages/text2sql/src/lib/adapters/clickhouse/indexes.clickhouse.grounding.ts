import { z } from 'zod';

import type { Adapter, TableIndex } from '../adapter.ts';
import {
  IndexesGrounding,
  type IndexesGroundingConfig,
} from '../groundings/indexes.grounding.ts';
import { nameRow } from '../groundings/rows.ts';

/** `system.data_skipping_indices`: every selected column is a String. */
const dataSkippingIndexRow = z.object({
  name: z.string(),
  type: z.string(),
  expression: z.string(),
});

export class ClickHouseIndexesGrounding extends IndexesGrounding {
  readonly #adapter: Adapter;

  constructor(adapter: Adapter, config: IndexesGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
  }

  protected override async getIndexes(
    tableName: string,
  ): Promise<TableIndex[]> {
    const { schema, table } = this.#adapter.parseTableName(tableName);
    if (!schema) return [];

    const [primaryKeyRows, indexRows] = await Promise.all([
      this.#adapter.runQuery(
        `
        SELECT name
        FROM system.columns
        WHERE database = '${this.#adapter.escapeString(schema)}'
          AND table = '${this.#adapter.escapeString(table)}'
          AND is_in_primary_key = 1
        ORDER BY position
      `,
        nameRow,
      ),
      this.#adapter.runQuery(
        `
        SELECT name, type_full AS type, expr AS expression
        FROM system.data_skipping_indices
        WHERE database = '${this.#adapter.escapeString(schema)}'
          AND table = '${this.#adapter.escapeString(table)}'
        ORDER BY name
      `,
        dataSkippingIndexRow,
      ),
    ]);

    const indexes: TableIndex[] = [];
    if (primaryKeyRows.length > 0) {
      indexes.push({
        name: 'PRIMARY_KEY',
        columns: primaryKeyRows.map((row) => row.name),
        type: 'PRIMARY_KEY',
      });
    }
    indexes.push(
      ...indexRows.map((row) => ({
        name: row.name,
        columns: splitTopLevelExpressions(row.expression),
        type: row.type,
      })),
    );
    return indexes;
  }
}

function splitTopLevelExpressions(expression: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < expression.length; index++) {
    const character = expression[index];
    if (character === '(' || character === '[') depth++;
    if (character === ')' || character === ']') depth--;
    if (character === ',' && depth === 0) {
      parts.push(expression.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(expression.slice(start).trim());
  return parts.filter(Boolean);
}
