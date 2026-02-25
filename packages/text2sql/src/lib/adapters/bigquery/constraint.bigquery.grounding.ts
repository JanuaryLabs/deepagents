import type { Table, TableConstraint } from '../adapter.ts';
import {
  ConstraintGrounding,
  type ConstraintGroundingConfig,
} from '../groundings/constraint.grounding.ts';
import type { GroundingContext } from '../groundings/context.ts';
import { type FKChildColumn, resolveForeignKey } from './bigquery-fk.ts';
import type { BigQuery } from './bigquery.ts';

type ColumnMetadataRow = {
  table_name: string | null;
  column_name: string | null;
  is_nullable: string | null;
  column_default: string | null;
};

type KeyColumnUsageRow = {
  table_name: string | null;
  constraint_name: string | null;
  constraint_type: string | null;
  column_name: string | null;
  ordinal_position: number | null;
  position_in_unique_constraint: number | null;
};

export interface BigQueryConstraintGroundingConfig extends ConstraintGroundingConfig {}

export class BigQueryConstraintGrounding extends ConstraintGrounding {
  #adapter: BigQuery;
  #cache?: Map<string, unknown>;

  constructor(
    adapter: BigQuery,
    config: BigQueryConstraintGroundingConfig = {},
  ) {
    super(config);
    this.#adapter = adapter;
  }

  override async execute(ctx: GroundingContext): Promise<void> {
    this.#cache = ctx.cache;
    const byDataset = new Map<string, Table[]>();
    for (const table of ctx.tables) {
      const { schema: dataset } = this.#adapter.parseTableName(table.name);
      const list = byDataset.get(dataset) ?? [];
      list.push(table);
      byDataset.set(dataset, list);
    }

    for (const [dataset, tables] of byDataset) {
      try {
        await this.#batchConstraints(dataset, tables);
      } catch (error) {
        console.warn(
          'Error collecting constraints for dataset',
          dataset,
          error,
        );
      }
    }
  }

  async #batchConstraints(dataset: string, tables: Table[]): Promise<void> {
    const tableNames = tables.map(
      (t) => this.#adapter.parseTableName(t.name).table,
    );
    const inList = tableNames
      .map((n) => `'${this.#adapter.escapeString(n)}'`)
      .join(', ');

    const constraintsByTable = new Map<string, TableConstraint[]>();
    for (const name of tableNames) {
      constraintsByTable.set(name, []);
    }

    await this.#batchColumnMetadata(dataset, inList, constraintsByTable);
    await this.#batchKeyConstraints(dataset, inList, constraintsByTable);

    for (const table of tables) {
      const rawName = this.#adapter.parseTableName(table.name).table;
      table.constraints = constraintsByTable.get(rawName) ?? [];
    }
  }

  async #batchColumnMetadata(
    dataset: string,
    inList: string,
    constraintsByTable: Map<string, TableConstraint[]>,
  ): Promise<void> {
    const rows = await this.#adapter.runQuery<ColumnMetadataRow>(`
      SELECT table_name, column_name, is_nullable, column_default
      FROM ${this.#adapter.infoSchemaView(dataset, 'COLUMNS')}
      WHERE table_name IN (${inList})
      ORDER BY table_name, ordinal_position
    `);

    for (const row of rows) {
      if (!row.table_name || !row.column_name) continue;
      const constraints = constraintsByTable.get(row.table_name);
      if (!constraints) continue;

      if ((row.is_nullable ?? '').toUpperCase() === 'NO') {
        constraints.push({
          name: `${dataset}.${row.table_name}.${row.column_name}.NOT_NULL`,
          type: 'NOT_NULL',
          columns: [row.column_name],
        });
      }

      if (row.column_default != null && row.column_default !== '') {
        constraints.push({
          name: `${dataset}.${row.table_name}.${row.column_name}.DEFAULT`,
          type: 'DEFAULT',
          columns: [row.column_name],
          defaultValue: row.column_default,
        });
      }
    }
  }

  async #batchKeyConstraints(
    dataset: string,
    inList: string,
    constraintsByTable: Map<string, TableConstraint[]>,
  ): Promise<void> {
    const rows = await this.#adapter.runQuery<KeyColumnUsageRow>(`
      SELECT
        tc.table_name,
        tc.constraint_name,
        tc.constraint_type,
        kcu.column_name,
        kcu.ordinal_position,
        kcu.position_in_unique_constraint
      FROM ${this.#adapter.infoSchemaView(dataset, 'TABLE_CONSTRAINTS')} AS tc
      JOIN ${this.#adapter.infoSchemaView(dataset, 'KEY_COLUMN_USAGE')} AS kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.constraint_schema = kcu.constraint_schema
      WHERE tc.table_name IN (${inList})
        AND tc.constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY')
      ORDER BY tc.table_name, tc.constraint_name, kcu.ordinal_position
    `);

    const pkByTable = new Map<string, Map<string, string[]>>();
    const fkByTable = new Map<string, Map<string, FKChildColumn[]>>();

    for (const row of rows) {
      if (!row.table_name || !row.constraint_name || !row.column_name) continue;
      const type = (row.constraint_type ?? '').toUpperCase();

      if (type === 'PRIMARY KEY') {
        const tableMap = pkByTable.get(row.table_name) ?? new Map();
        const cols = tableMap.get(row.constraint_name) ?? [];
        cols.push(row.column_name);
        tableMap.set(row.constraint_name, cols);
        pkByTable.set(row.table_name, tableMap);
      } else if (type === 'FOREIGN KEY') {
        const tableMap = fkByTable.get(row.table_name) ?? new Map();
        const cols = tableMap.get(row.constraint_name) ?? [];
        cols.push({
          column: row.column_name,
          ordinal: row.ordinal_position ?? 0,
          pkOrdinal: row.position_in_unique_constraint,
        });
        tableMap.set(row.constraint_name, cols);
        fkByTable.set(row.table_name, tableMap);
      }
    }

    for (const [tableName, pkMap] of pkByTable) {
      const constraints = constraintsByTable.get(tableName);
      if (!constraints) continue;
      for (const [name, cols] of pkMap) {
        constraints.push({ name, type: 'PRIMARY_KEY', columns: cols });
      }
    }

    for (const [tableName, fkMap] of fkByTable) {
      const constraints = constraintsByTable.get(tableName);
      if (!constraints) continue;

      for (const [constraintName, childColumns] of fkMap) {
        try {
          const resolution = await resolveForeignKey(
            this.#adapter,
            dataset,
            constraintName,
            childColumns,
            this.#cache,
          );
          if (resolution) {
            constraints.push({
              name: constraintName,
              type: 'FOREIGN_KEY',
              columns: resolution.childColumns,
              referencedTable: `${resolution.referencedDataset}.${resolution.referencedTable}`,
              referencedColumns: resolution.referencedColumns,
            });
          }
        } catch (err) {
          console.warn(
            `Failed to resolve FK constraint ${constraintName}:`,
            err,
          );
        }
      }
    }
  }

  protected override async getConstraints(
    _tableName: string,
  ): Promise<TableConstraint[]> {
    return [];
  }
}
