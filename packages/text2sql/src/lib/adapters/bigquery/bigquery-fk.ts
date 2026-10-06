import { z } from 'zod';

import { constraintNameRow, int64 } from './bigquery-rows.ts';
import type { BigQuery } from './bigquery.ts';

/** CONSTRAINT_COLUMN_USAGE: the table a foreign key references. */
const referencedTableRow = z.object({
  table_schema: z.string().nullable(),
  table_name: z.string().nullable(),
});

/** KEY_COLUMN_USAGE columns of the referenced primary key. */
const primaryKeyColumnRow = z.object({
  column_name: z.string().nullable(),
  ordinal_position: int64.nullable(),
});

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

/**
 * A resolution kept in the grounding context's shared cache, read back through
 * this schema because that cache holds unknown values.
 */
const fkResolution = z.object({
  referencedDataset: z.string(),
  referencedTable: z.string(),
  referencedColumns: z.array(z.string()),
  childColumns: z.array(z.string()),
});

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
    const cached = fkResolution.optional().parse(cache.get(cacheKey));
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
  const refRows = await adapter.runQuery(
    `
    SELECT DISTINCT table_schema, table_name
    FROM ${adapter.infoSchemaView(constraintDataset, 'CONSTRAINT_COLUMN_USAGE')}
    WHERE constraint_name = '${adapter.escapeString(constraintName)}'
  `,
    referencedTableRow,
  );

  const referenced = refRows.find((r) => r.table_schema && r.table_name);
  if (!referenced?.table_schema || !referenced.table_name) {
    return undefined;
  }

  const referencedDataset = referenced.table_schema;
  const referencedTable = referenced.table_name;

  if (!adapter.isDatasetAllowed(referencedDataset)) {
    return undefined;
  }

  const pkConstraintRows = await adapter.runQuery(
    `
    SELECT constraint_name
    FROM ${adapter.infoSchemaView(referencedDataset, 'TABLE_CONSTRAINTS')}
    WHERE constraint_type = 'PRIMARY KEY'
      AND table_name = '${adapter.escapeString(referencedTable)}'
    LIMIT 1
  `,
    constraintNameRow,
  );

  const pkConstraintName = pkConstraintRows[0]?.constraint_name;
  if (!pkConstraintName) return undefined;

  const pkColumnRows = await adapter.runQuery(
    `
    SELECT column_name, ordinal_position
    FROM ${adapter.infoSchemaView(referencedDataset, 'KEY_COLUMN_USAGE')}
    WHERE constraint_name = '${adapter.escapeString(pkConstraintName)}'
      AND table_name = '${adapter.escapeString(referencedTable)}'
    ORDER BY ordinal_position
  `,
    primaryKeyColumnRow,
  );

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
