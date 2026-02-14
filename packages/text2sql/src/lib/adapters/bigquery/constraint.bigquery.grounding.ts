import type { TableConstraint } from '../adapter.ts';
import {
  ConstraintGrounding,
  type ConstraintGroundingConfig,
} from '../groundings/constraint.grounding.ts';
import type { BigQuery } from './bigquery.ts';

type ColumnMetadataRow = {
  column_name: string | null;
  is_nullable: string | null;
  column_default: string | null;
};

type KeyColumnUsageRow = {
  constraint_name: string | null;
  constraint_type: string | null;
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

export interface BigQueryConstraintGroundingConfig extends ConstraintGroundingConfig {}

export class BigQueryConstraintGrounding extends ConstraintGrounding {
  #adapter: BigQuery;

  constructor(
    adapter: BigQuery,
    config: BigQueryConstraintGroundingConfig = {},
  ) {
    super(config);
    this.#adapter = adapter;
  }

  protected override async getConstraints(
    tableName: string,
  ): Promise<TableConstraint[]> {
    const { schema: dataset, table } = this.#adapter.parseTableName(tableName);

    const constraints: TableConstraint[] = [];

    // NOT NULL / DEFAULT (best effort from column metadata)
    const columnRows = await this.#adapter.runQuery<ColumnMetadataRow>(`
      SELECT column_name, is_nullable, column_default
      FROM ${this.#adapter.infoSchemaView(dataset, 'COLUMNS')}
      WHERE table_name = '${this.#adapter.escapeString(table)}'
      ORDER BY ordinal_position
    `);

    for (const row of columnRows) {
      const col = row.column_name;
      if (!col) continue;

      if ((row.is_nullable ?? '').toUpperCase() === 'NO') {
        constraints.push({
          name: `${tableName}.${col}.NOT_NULL`,
          type: 'NOT_NULL',
          columns: [col],
        });
      }

      if (row.column_default != null && row.column_default !== '') {
        constraints.push({
          name: `${tableName}.${col}.DEFAULT`,
          type: 'DEFAULT',
          columns: [col],
          defaultValue: row.column_default,
        });
      }
    }

    // PRIMARY KEY / FOREIGN KEY constraints
    const keyRows = await this.#adapter.runQuery<KeyColumnUsageRow>(`
      SELECT
        tc.constraint_name,
        tc.constraint_type,
        kcu.column_name,
        kcu.ordinal_position,
        kcu.position_in_unique_constraint
      FROM ${this.#adapter.infoSchemaView(dataset, 'TABLE_CONSTRAINTS')} AS tc
      JOIN ${this.#adapter.infoSchemaView(dataset, 'KEY_COLUMN_USAGE')} AS kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.constraint_schema = kcu.constraint_schema
      WHERE tc.table_name = '${this.#adapter.escapeString(table)}'
        AND tc.constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY')
      ORDER BY tc.constraint_name, kcu.ordinal_position
    `);

    const pkByName = new Map<string, string[]>();
    const fkByName = new Map<
      string,
      Array<{
        column: string;
        ordinal: number;
        pkOrdinal: number | null;
      }>
    >();

    for (const row of keyRows) {
      if (!row.constraint_name || !row.column_name) continue;
      const type = (row.constraint_type ?? '').toUpperCase();

      if (type === 'PRIMARY KEY') {
        const cols = pkByName.get(row.constraint_name) ?? [];
        cols.push(row.column_name);
        pkByName.set(row.constraint_name, cols);
        continue;
      }

      if (type === 'FOREIGN KEY') {
        const cols = fkByName.get(row.constraint_name) ?? [];
        cols.push({
          column: row.column_name,
          ordinal: row.ordinal_position ?? 0,
          pkOrdinal: row.position_in_unique_constraint,
        });
        fkByName.set(row.constraint_name, cols);
      }
    }

    for (const [name, cols] of pkByName.entries()) {
      constraints.push({
        name,
        type: 'PRIMARY_KEY',
        columns: cols,
      });
    }

    for (const [constraintName, cols] of fkByName.entries()) {
      const fk = await this.#buildForeignKeyConstraint({
        constraintDataset: dataset,
        constraintName,
        childTableName: `${dataset}.${table}`,
        childColumns: cols,
      });
      if (fk) constraints.push(fk);
    }

    return constraints;
  }

  async #buildForeignKeyConstraint(args: {
    constraintDataset: string;
    constraintName: string;
    childTableName: string;
    childColumns: Array<{
      column: string;
      ordinal: number;
      pkOrdinal: number | null;
    }>;
  }): Promise<TableConstraint | undefined> {
    const refRows = await this.#adapter.runQuery<ReferencedTableRow>(`
      SELECT DISTINCT table_schema, table_name
      FROM ${this.#adapter.infoSchemaView(args.constraintDataset, 'CONSTRAINT_COLUMN_USAGE')}
      WHERE constraint_name = '${this.#adapter.escapeString(args.constraintName)}'
    `);

    const referenced = refRows.find((r) => r.table_schema && r.table_name);
    if (!referenced?.table_schema || !referenced.table_name) {
      return undefined;
    }

    const referencedDataset = referenced.table_schema;
    const referencedTable = referenced.table_name;

    // Dataset scoping: never surface FK references outside configured datasets.
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
    if (!pkConstraintName) return undefined;

    const pkColumns = await this.#adapter.runQuery<PrimaryKeyColumnRow>(`
      SELECT column_name, ordinal_position
      FROM ${this.#adapter.infoSchemaView(referencedDataset, 'KEY_COLUMN_USAGE')}
      WHERE constraint_name = '${this.#adapter.escapeString(pkConstraintName)}'
        AND table_name = '${this.#adapter.escapeString(referencedTable)}'
      ORDER BY ordinal_position
    `);

    const pkByOrdinal = new Map<number, string>();
    for (const row of pkColumns) {
      if (!row.column_name || row.ordinal_position == null) continue;
      pkByOrdinal.set(row.ordinal_position, row.column_name);
    }

    const orderedChild = [...args.childColumns].sort(
      (a, b) => a.ordinal - b.ordinal,
    );

    const columns = orderedChild.map((c) => c.column);
    const referencedColumns = orderedChild.map((c) => {
      const pkOrdinal = c.pkOrdinal ?? c.ordinal;
      return pkByOrdinal.get(pkOrdinal) ?? 'unknown';
    });

    return {
      name: args.constraintName,
      type: 'FOREIGN_KEY',
      columns,
      referencedTable: `${referencedDataset}.${referencedTable}`,
      referencedColumns,
    };
  }
}
