import type { Adapter, TableConstraint } from '../adapter.ts';
import {
  ConstraintGrounding,
  type ConstraintGroundingConfig,
} from '../groundings/constraint.grounding.ts';

type ColumnMetadataRow = {
  name: string;
  type: string;
  default_kind: string;
  default_expression: string;
  is_in_primary_key: number | string;
};

export class ClickHouseConstraintGrounding extends ConstraintGrounding {
  readonly #adapter: Adapter;

  constructor(adapter: Adapter, config: ConstraintGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
  }

  protected override async getConstraints(
    tableName: string,
  ): Promise<TableConstraint[]> {
    const { schema, table } = this.#adapter.parseTableName(tableName);
    if (!schema) return [];

    const rows = await this.#adapter.runQuery<ColumnMetadataRow>(`
      SELECT name, type, default_kind, default_expression, is_in_primary_key
      FROM system.columns
      WHERE database = '${this.#adapter.escapeString(schema)}'
        AND table = '${this.#adapter.escapeString(table)}'
      ORDER BY position
    `);
    const constraints: TableConstraint[] = [];
    const primaryKey = rows
      .filter((row) => Number(row.is_in_primary_key) === 1)
      .map((row) => row.name);

    if (primaryKey.length > 0) {
      constraints.push({
        name: 'PRIMARY_KEY',
        type: 'PRIMARY_KEY',
        columns: primaryKey,
      });
    }

    for (const row of rows) {
      if (!hasNullableType(row.type)) {
        constraints.push({
          name: `${row.name}_not_null`,
          type: 'NOT_NULL',
          columns: [row.name],
        });
      }
      if (row.default_kind === 'DEFAULT' && row.default_expression) {
        constraints.push({
          name: `${row.name}_default`,
          type: 'DEFAULT',
          columns: [row.name],
          defaultValue: row.default_expression,
        });
      }
    }

    return constraints;
  }
}

function hasNullableType(type: string): boolean {
  return /(?:^|\()Nullable\(/.test(type);
}
