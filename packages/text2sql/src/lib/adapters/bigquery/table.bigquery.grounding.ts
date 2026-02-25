import type { Relationship, Table } from '../adapter.ts';
import type { GroundingContext } from '../groundings/context.ts';
import {
  TableGrounding,
  type TableGroundingConfig,
} from '../groundings/table.grounding.ts';
import { type FKChildColumn, resolveForeignKey } from './bigquery-fk.ts';
import type { BigQuery } from './bigquery.ts';

type TableNameRow = {
  table_name: string | null;
};

type ColumnFieldPathRow = {
  field_path: string | null;
  data_type: string | null;
  ordinal_position: number | null;
};

type ForeignKeyKeyColumnRow = {
  constraint_name: string | null;
  column_name: string | null;
  ordinal_position: number | null;
  position_in_unique_constraint: number | null;
};

export interface BigQueryTableGroundingConfig extends TableGroundingConfig {}

export class BigQueryTableGrounding extends TableGrounding {
  #adapter: BigQuery;
  #cache?: Map<string, unknown>;

  constructor(adapter: BigQuery, config: BigQueryTableGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
  }

  override async execute(ctx: GroundingContext): Promise<void> {
    this.#cache = ctx.cache;
    await super.execute(ctx);
    ctx.tables = ctx.tables.filter((t) => t.columns.length > 0);

    const tableNames = new Set(ctx.tables.map((t) => t.name));
    ctx.relationships = ctx.relationships.filter(
      (r) => tableNames.has(r.table) && tableNames.has(r.referenced_table),
    );
  }

  protected override async applyFilter(): Promise<string[]> {
    const names = await super.applyFilter();
    return names.filter((name) => this.#isTableInScope(name));
  }

  protected override async getAllTableNames(): Promise<string[]> {
    const names: string[] = [];

    for (const dataset of this.#adapter.datasets) {
      const rows = await this.#adapter.runQuery<TableNameRow>(`
        SELECT table_name
        FROM ${this.#adapter.infoSchemaView(dataset, 'TABLES')}
        WHERE table_type = 'BASE TABLE'
        ORDER BY table_name
      `);

      for (const row of rows) {
        if (!row.table_name) continue;
        names.push(`${dataset}.${row.table_name}`);
      }
    }

    return names;
  }

  protected override async getTable(tableName: string): Promise<Table> {
    const { schema: dataset, table } = this.#adapter.parseTableName(tableName);

    const rows = await this.#adapter.runQuery<ColumnFieldPathRow>(`
      SELECT
        f.field_path,
        f.data_type,
        c.ordinal_position
      FROM ${this.#adapter.infoSchemaView(dataset, 'COLUMN_FIELD_PATHS')} AS f
      JOIN ${this.#adapter.infoSchemaView(dataset, 'COLUMNS')} AS c
        ON f.table_name = c.table_name
        AND f.column_name = c.column_name
      WHERE f.table_name = '${this.#adapter.escapeString(table)}'
      ORDER BY c.ordinal_position, f.field_path
    `);

    const seen = new Set<string>();
    const columns = rows
      .map((r) => ({
        name: r.field_path ?? 'unknown',
        type: r.data_type ?? 'unknown',
        ordinal: r.ordinal_position ?? 0,
      }))
      .filter((c) => {
        if (!c.name) return false;
        if (seen.has(c.name)) return false;
        seen.add(c.name);
        return true;
      })
      .map((c) => ({ name: c.name, type: c.type }));

    return {
      name: `${dataset}.${table}`,
      schema: dataset,
      rawName: table,
      columns,
    };
  }

  protected override async findOutgoingRelations(
    tableName: string,
  ): Promise<Relationship[]> {
    const { schema: dataset, table } = this.#adapter.parseTableName(tableName);

    const rows = await this.#adapter.runQuery<ForeignKeyKeyColumnRow>(`
      SELECT
        kcu.constraint_name,
        kcu.column_name,
        kcu.ordinal_position,
        kcu.position_in_unique_constraint
      FROM ${this.#adapter.infoSchemaView(dataset, 'TABLE_CONSTRAINTS')} AS tc
      JOIN ${this.#adapter.infoSchemaView(dataset, 'KEY_COLUMN_USAGE')} AS kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.constraint_schema = kcu.constraint_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_name = '${this.#adapter.escapeString(table)}'
      ORDER BY kcu.constraint_name, kcu.ordinal_position
    `);

    const byConstraint = new Map<string, FKChildColumn[]>();

    for (const row of rows) {
      if (!row.constraint_name || !row.column_name) continue;
      const list = byConstraint.get(row.constraint_name) ?? [];
      list.push({
        column: row.column_name,
        ordinal: row.ordinal_position ?? 0,
        pkOrdinal: row.position_in_unique_constraint,
      });
      byConstraint.set(row.constraint_name, list);
    }

    const rels: Relationship[] = [];
    for (const [constraintName, columns] of byConstraint.entries()) {
      const resolution = await resolveForeignKey(
        this.#adapter,
        dataset,
        constraintName,
        columns,
        this.#cache,
      );
      if (resolution) {
        rels.push({
          table: `${dataset}.${table}`,
          from: resolution.childColumns,
          referenced_table: `${resolution.referencedDataset}.${resolution.referencedTable}`,
          to: resolution.referencedColumns,
        });
      }
    }

    return rels;
  }

  protected override async findIncomingRelations(
    tableName: string,
  ): Promise<Relationship[]> {
    const { schema: referencedDataset, table: referencedTable } =
      this.#adapter.parseTableName(tableName);

    const rels: Relationship[] = [];

    for (const constraintDataset of this.#adapter.datasets) {
      const rows = await this.#adapter.runQuery<{
        constraint_name: string | null;
      }>(`
        SELECT DISTINCT constraint_name
        FROM ${this.#adapter.infoSchemaView(constraintDataset, 'CONSTRAINT_COLUMN_USAGE')}
        WHERE table_schema = '${this.#adapter.escapeString(referencedDataset)}'
          AND table_name = '${this.#adapter.escapeString(referencedTable)}'
      `);

      for (const row of rows) {
        if (!row.constraint_name) continue;
        const rel = await this.#resolveIncomingRelationship(
          constraintDataset,
          row.constraint_name,
          referencedDataset,
          referencedTable,
        );
        if (rel) rels.push(rel);
      }
    }

    return rels;
  }

  async #resolveIncomingRelationship(
    constraintDataset: string,
    constraintName: string,
    expectedReferencedDataset: string,
    expectedReferencedTable: string,
  ): Promise<Relationship | undefined> {
    const keyRows = await this.#adapter.runQuery<
      ForeignKeyKeyColumnRow & { child_table_name: string | null }
    >(`
      SELECT
        kcu.constraint_name,
        tc.table_name AS child_table_name,
        kcu.column_name,
        kcu.ordinal_position,
        kcu.position_in_unique_constraint
      FROM ${this.#adapter.infoSchemaView(constraintDataset, 'TABLE_CONSTRAINTS')} AS tc
      JOIN ${this.#adapter.infoSchemaView(constraintDataset, 'KEY_COLUMN_USAGE')} AS kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.constraint_schema = kcu.constraint_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.constraint_name = '${this.#adapter.escapeString(constraintName)}'
      ORDER BY kcu.ordinal_position
    `);

    if (keyRows.length === 0) return undefined;
    const childTable = keyRows[0]?.child_table_name;
    if (!childTable) return undefined;

    const childColumns: FKChildColumn[] = keyRows
      .filter((r) => r.column_name)
      .map((r) => ({
        column: r.column_name ?? 'unknown',
        ordinal: r.ordinal_position ?? 0,
        pkOrdinal: r.position_in_unique_constraint,
      }));

    const resolution = await resolveForeignKey(
      this.#adapter,
      constraintDataset,
      constraintName,
      childColumns,
      this.#cache,
    );

    if (
      !resolution ||
      resolution.referencedDataset !== expectedReferencedDataset ||
      resolution.referencedTable !== expectedReferencedTable
    ) {
      return undefined;
    }

    return {
      table: `${constraintDataset}.${childTable}`,
      from: resolution.childColumns,
      referenced_table: `${resolution.referencedDataset}.${resolution.referencedTable}`,
      to: resolution.referencedColumns,
    };
  }

  #isTableInScope(tableName: string): boolean {
    const { schema } = this.#adapter.parseTableName(tableName);
    return this.#adapter.isDatasetAllowed(schema);
  }
}
