import type { Relationship, Table } from '../adapter.ts';
import {
  TableGrounding,
  type TableGroundingConfig,
} from '../groundings/table.grounding.ts';
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

type ReferencedTableRow = {
  table_schema: string | null;
  table_name: string | null;
};

type PrimaryKeyConstraintRow = {
  constraint_name: string | null;
};

type PrimaryKeyColumnRow = {
  column_name: string | null;
  ordinal_position: number | null;
};

export interface BigQueryTableGroundingConfig extends TableGroundingConfig {}

export class BigQueryTableGrounding extends TableGrounding {
  #adapter: BigQuery;

  constructor(adapter: BigQuery, config: BigQueryTableGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
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

    const byConstraint = new Map<
      string,
      Array<{
        column: string;
        ordinal: number;
        pkOrdinal: number | null;
      }>
    >();

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
      const rel = await this.#buildForeignKeyRelationship({
        constraintDataset: dataset,
        childDataset: dataset,
        childTable: table,
        constraintName,
        childColumns: columns,
      });
      if (rel) rels.push(rel);
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
        const rel = await this.#buildForeignKeyRelationshipFromConstraintName(
          constraintDataset,
          row.constraint_name,
        );
        if (
          rel &&
          rel.referenced_table === `${referencedDataset}.${referencedTable}`
        ) {
          rels.push(rel);
        }
      }
    }

    return rels;
  }

  #isTableInScope(tableName: string): boolean {
    const { schema } = this.#adapter.parseTableName(tableName);
    return this.#adapter.isDatasetAllowed(schema);
  }

  async #buildForeignKeyRelationshipFromConstraintName(
    constraintDataset: string,
    constraintName: string,
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

    const childColumns = keyRows
      .filter((r) => r.column_name)
      .map((r) => ({
        column: r.column_name ?? 'unknown',
        ordinal: r.ordinal_position ?? 0,
        pkOrdinal: r.position_in_unique_constraint,
      }));

    return this.#buildForeignKeyRelationship({
      constraintDataset,
      childDataset: constraintDataset,
      childTable,
      constraintName,
      childColumns,
    });
  }

  async #buildForeignKeyRelationship(args: {
    constraintDataset: string;
    childDataset: string;
    childTable: string;
    constraintName: string;
    childColumns: Array<{
      column: string;
      ordinal: number;
      pkOrdinal: number | null;
    }>;
  }): Promise<Relationship | undefined> {
    const refTableRows = await this.#adapter.runQuery<ReferencedTableRow>(`
      SELECT DISTINCT table_schema, table_name
      FROM ${this.#adapter.infoSchemaView(args.constraintDataset, 'CONSTRAINT_COLUMN_USAGE')}
      WHERE constraint_name = '${this.#adapter.escapeString(args.constraintName)}'
    `);

    const referenced = refTableRows.find((r) => r.table_schema && r.table_name);
    if (!referenced?.table_schema || !referenced.table_name) {
      return undefined;
    }

    const referencedDataset = referenced.table_schema;
    const referencedTable = referenced.table_name;

    // Dataset scoping: never traverse relationships outside configured datasets.
    if (!this.#adapter.isDatasetAllowed(referencedDataset)) {
      return undefined;
    }

    const pkConstraintRows = await this.#adapter
      .runQuery<PrimaryKeyConstraintRow>(`
      SELECT constraint_name
      FROM ${this.#adapter.infoSchemaView(referencedDataset, 'TABLE_CONSTRAINTS')}
      WHERE constraint_type = 'PRIMARY KEY'
        AND table_name = '${this.#adapter.escapeString(referencedTable)}'
      LIMIT 1
    `);

    const pkConstraintName = pkConstraintRows[0]?.constraint_name;
    if (!pkConstraintName) {
      return undefined;
    }

    const pkColumnRows = await this.#adapter.runQuery<PrimaryKeyColumnRow>(`
      SELECT column_name, ordinal_position
      FROM ${this.#adapter.infoSchemaView(referencedDataset, 'KEY_COLUMN_USAGE')}
      WHERE constraint_name = '${this.#adapter.escapeString(pkConstraintName)}'
        AND table_name = '${this.#adapter.escapeString(referencedTable)}'
      ORDER BY ordinal_position
    `);

    const pkByOrdinal = new Map<number, string>();
    for (const row of pkColumnRows) {
      if (!row.column_name || row.ordinal_position == null) continue;
      pkByOrdinal.set(row.ordinal_position, row.column_name);
    }

    const orderedChild = [...args.childColumns].sort(
      (a, b) => a.ordinal - b.ordinal,
    );
    const from = orderedChild.map((c) => c.column);
    const to = orderedChild.map((c) => {
      const pkOrdinal = c.pkOrdinal ?? c.ordinal;
      return pkByOrdinal.get(pkOrdinal) ?? 'unknown';
    });

    return {
      table: `${args.childDataset}.${args.childTable}`,
      from,
      referenced_table: `${referencedDataset}.${referencedTable}`,
      to,
    };
  }
}
