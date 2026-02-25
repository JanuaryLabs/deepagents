import type { BigQuery } from './bigquery.ts';

export type ReferencedTableRow = {
  table_schema: string | null;
  table_name: string | null;
};

export type PrimaryKeyConstraintRow = {
  constraint_name: string | null;
};

export type PrimaryKeyColumnRow = {
  column_name: string | null;
  ordinal_position: number | null;
};

export type FKChildColumn = {
  column: string;
  ordinal: number;
  pkOrdinal: number | null;
};

export interface FKResolution {
  referencedDataset: string;
  referencedTable: string;
  referencedColumns: string[];
  childColumns: string[];
}

const FK_CACHE_PREFIX = 'fk:';

export async function resolveForeignKey(
  adapter: BigQuery,
  constraintDataset: string,
  constraintName: string,
  childColumns: FKChildColumn[],
  cache?: Map<string, unknown>,
): Promise<FKResolution | undefined> {
  const cacheKey = `${FK_CACHE_PREFIX}${constraintDataset}:${constraintName}`;
  if (cache?.has(cacheKey)) {
    const cached = cache.get(cacheKey) as FKResolution | undefined;
    if (!cached) return undefined;
    return {
      ...cached,
      childColumns: [...childColumns]
        .sort((a, b) => a.ordinal - b.ordinal)
        .map((c) => c.column),
    };
  }
  const result = await resolveFK(
    adapter,
    constraintDataset,
    constraintName,
    childColumns,
  );
  cache?.set(cacheKey, result);
  return result;
}

async function resolveFK(
  adapter: BigQuery,
  constraintDataset: string,
  constraintName: string,
  childColumns: FKChildColumn[],
): Promise<FKResolution | undefined> {
  const refRows = await adapter.runQuery<ReferencedTableRow>(`
    SELECT DISTINCT table_schema, table_name
    FROM ${adapter.infoSchemaView(constraintDataset, 'CONSTRAINT_COLUMN_USAGE')}
    WHERE constraint_name = '${adapter.escapeString(constraintName)}'
  `);

  const referenced = refRows.find((r) => r.table_schema && r.table_name);
  if (!referenced?.table_schema || !referenced.table_name) {
    return undefined;
  }

  const referencedDataset = referenced.table_schema;
  const referencedTable = referenced.table_name;

  if (!adapter.isDatasetAllowed(referencedDataset)) {
    return undefined;
  }

  const pkConstraintRows = await adapter.runQuery<PrimaryKeyConstraintRow>(`
    SELECT constraint_name
    FROM ${adapter.infoSchemaView(referencedDataset, 'TABLE_CONSTRAINTS')}
    WHERE constraint_type = 'PRIMARY KEY'
      AND table_name = '${adapter.escapeString(referencedTable)}'
    LIMIT 1
  `);

  const pkConstraintName = pkConstraintRows[0]?.constraint_name;
  if (!pkConstraintName) return undefined;

  const pkColumnRows = await adapter.runQuery<PrimaryKeyColumnRow>(`
    SELECT column_name, ordinal_position
    FROM ${adapter.infoSchemaView(referencedDataset, 'KEY_COLUMN_USAGE')}
    WHERE constraint_name = '${adapter.escapeString(pkConstraintName)}'
      AND table_name = '${adapter.escapeString(referencedTable)}'
    ORDER BY ordinal_position
  `);

  const pkByOrdinal = new Map<number, string>();
  for (const row of pkColumnRows) {
    if (!row.column_name || row.ordinal_position == null) continue;
    pkByOrdinal.set(row.ordinal_position, row.column_name);
  }

  const ordered = [...childColumns].sort((a, b) => a.ordinal - b.ordinal);

  return {
    referencedDataset,
    referencedTable,
    referencedColumns: ordered.map((c) => {
      const pkOrdinal = c.pkOrdinal ?? c.ordinal;
      return pkByOrdinal.get(pkOrdinal) ?? 'unknown';
    }),
    childColumns: ordered.map((c) => c.column),
  };
}
