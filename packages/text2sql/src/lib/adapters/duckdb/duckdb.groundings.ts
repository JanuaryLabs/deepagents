import { z } from 'zod';

import type {
  AdapterInfo,
  ColumnStats,
  Relationship,
  Table,
  TableConstraint,
  TableIndex,
} from '../adapter.ts';
import {
  ColumnStatsGrounding,
  type ColumnStatsGroundingConfig,
} from '../groundings/column-stats.grounding.ts';
import {
  type Column,
  ColumnValuesGrounding,
  type ColumnValuesGroundingConfig,
} from '../groundings/column-values.grounding.ts';
import {
  ConstraintGrounding,
  type ConstraintGroundingConfig,
} from '../groundings/constraint.grounding.ts';
import {
  IndexesGrounding,
  type IndexesGroundingConfig,
} from '../groundings/indexes.grounding.ts';
import {
  InfoGrounding,
  type InfoGroundingConfig,
} from '../groundings/info.grounding.ts';
import {
  RowCountGrounding,
  type RowCountGroundingConfig,
} from '../groundings/row-count.grounding.ts';
import { numericValue, textValueRow } from '../groundings/rows.ts';
import {
  TableGrounding,
  type TableGroundingConfig,
} from '../groundings/table.grounding.ts';
import {
  type View,
  ViewGrounding,
  type ViewGroundingConfig,
} from '../groundings/view.grounding.ts';
import { formatDuckDBIdentifierPath } from './duckdb-identifiers.ts';
import type { DuckDB } from './duckdb.ts';

// Rows of DuckDB's catalog functions as the documented reader,
// getRowObjectsJson(), returns them: VARCHAR is a string, VARCHAR[] an array
// of strings, BOOLEAN a boolean, DOUBLE a number, and BIGINT a decimal string
// (a bigint under getRowObjectsJS()).

const tableNameRow = z.object({
  database_name: z.string(),
  schema_name: z.string(),
  table_name: z.string(),
});

const viewNameRow = z.object({
  database_name: z.string(),
  schema_name: z.string(),
  view_name: z.string(),
});

const columnRow = z.object({ column_name: z.string(), data_type: z.string() });

const columnNameRow = z.object({ column_name: z.string() });

/** duckdb_columns() filtered to columns that have a default. */
const columnDefaultRow = z.object({
  column_name: z.string(),
  column_default: z.string(),
});

const infoRow = z.object({
  version: z.string(),
  catalog: z.string(),
  schema: z.string(),
});

/** duckdb_views().sql: the CREATE VIEW statement. */
const viewSqlRow = z.object({ sql: z.string().nullable() });

/**
 * duckdb_constraints(). `expression` is set for CHECK only, `referenced_table`
 * for FOREIGN KEY only; `referenced_column_names` is empty for every other type.
 */
const constraintRow = z.object({
  constraint_name: z.string(),
  constraint_type: z.string(),
  expression: z.string().nullable(),
  constraint_column_names: z.array(z.string()),
  referenced_table: z.string().nullable(),
  referenced_column_names: z.array(z.string()),
});

type ConstraintRow = z.output<typeof constraintRow>;

const foreignKeyRow = constraintRow.extend({ table_name: z.string() });

/**
 * duckdb_indexes(). `expressions` is the indexed expressions cast to
 * VARCHAR[], or NULL when the cast fails.
 */
const indexRow = z.object({
  index_name: z.string(),
  expressions: z.array(z.string()).nullable(),
  is_unique: z.boolean(),
  is_primary: z.boolean(),
});

/** duckdb_tables().estimated_size: a BIGINT. */
const estimatedSizeRow = z.object({ estimated_size: numericValue.nullable() });

/**
 * MIN/MAX are cast to VARCHAR, so both are strings, or NULL for an empty or
 * all-NULL column; null_fraction is a DOUBLE and n_distinct a BIGINT count.
 */
const columnStatsRow = z.object({
  min_value: z.string().nullable(),
  max_value: z.string().nullable(),
  null_fraction: z.number().nullable(),
  n_distinct: numericValue,
});

const CONSTRAINT_TYPES = new Map<string, TableConstraint['type']>([
  ['CHECK', 'CHECK'],
  ['UNIQUE', 'UNIQUE'],
  ['NOT NULL', 'NOT_NULL'],
  ['PRIMARY KEY', 'PRIMARY_KEY'],
  ['FOREIGN KEY', 'FOREIGN_KEY'],
]);

export class DuckDBTableGrounding extends TableGrounding {
  readonly #adapter: DuckDB;

  constructor(adapter: DuckDB, config: TableGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
  }

  protected override async applyFilter(): Promise<string[]> {
    const names = await super.applyFilter();
    const { catalogs, schemas } = await this.#adapter.scopedNamespaces();
    const result: string[] = [];
    for (const name of names) {
      const relation = await this.#adapter.resolveRelationName(name);
      if (
        catalogs.includes(relation.catalog) &&
        schemas.includes(relation.schema)
      ) {
        result.push(
          this.#adapter.formatRelationName(
            relation.catalog,
            relation.schema,
            relation.table,
          ),
        );
      }
    }
    return result;
  }

  protected override async getAllTableNames(): Promise<string[]> {
    const { catalogs, schemas } = await this.#adapter.scopedNamespaces();
    const rows = await this.#adapter.runQuery(
      `
      SELECT database_name, schema_name, table_name
      FROM duckdb_tables()
      WHERE NOT internal
        AND NOT temporary
        AND database_name IN (${sqlLiterals(this.#adapter, catalogs)})
        AND schema_name IN (${sqlLiterals(this.#adapter, schemas)})
      ORDER BY database_name, schema_name, table_name
    `,
      tableNameRow,
    );

    return rows.map((row) =>
      this.#adapter.formatRelationName(
        row.database_name,
        row.schema_name,
        row.table_name,
      ),
    );
  }

  protected override async getTable(tableName: string): Promise<Table> {
    const { catalog, schema, table } =
      await this.#adapter.resolveRelationName(tableName);
    const rows = await this.#adapter.runQuery(
      `
      SELECT column_name, data_type
      FROM duckdb_columns()
      WHERE database_name = '${this.#adapter.escapeString(catalog)}'
        AND schema_name = '${this.#adapter.escapeString(schema)}'
        AND table_name = '${this.#adapter.escapeString(table)}'
      ORDER BY column_index
    `,
      columnRow,
    );

    return {
      name: this.#adapter.formatRelationName(catalog, schema, table),
      schema: formatDuckDBIdentifierPath([catalog, schema]),
      rawName: table,
      columns: rows.map(columnFromRow),
    };
  }

  protected override async findOutgoingRelations(
    tableName: string,
  ): Promise<Relationship[]> {
    const relation = await this.#adapter.resolveRelationName(tableName);
    const rows = await foreignKeys(this.#adapter, relation, 'outgoing');
    return rows.map((row) => relationshipFromRow(this.#adapter, relation, row));
  }

  protected override async findIncomingRelations(
    tableName: string,
  ): Promise<Relationship[]> {
    const relation = await this.#adapter.resolveRelationName(tableName);
    const rows = await foreignKeys(this.#adapter, relation, 'incoming');
    return rows.map((row) => {
      const source = {
        catalog: relation.catalog,
        schema: relation.schema,
        table: row.table_name,
      };
      return relationshipFromRow(this.#adapter, source, row);
    });
  }
}

export class DuckDBInfoGrounding extends InfoGrounding {
  readonly #adapter: DuckDB;

  constructor(adapter: DuckDB, config: InfoGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
  }

  protected override async collectInfo(): Promise<AdapterInfo> {
    const rows = await this.#adapter.runQuery(
      `
      SELECT
        version() AS version,
        current_database() AS catalog,
        current_schema() AS schema
    `,
      infoRow,
    );
    const row = rows.at(0);
    return {
      dialect: 'duckdb',
      version: row?.version,
      database: row?.catalog,
      details: {
        currentSchema: row?.schema ?? 'unknown',
        identifierQualification: 'catalog.schema.table',
        parameterPlaceholders: ['$1', '$name'],
      },
    };
  }
}

export class DuckDBViewGrounding extends ViewGrounding {
  readonly #adapter: DuckDB;

  constructor(adapter: DuckDB, config: ViewGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
  }

  protected override async applyFilter(): Promise<string[]> {
    const names = await super.applyFilter();
    const { catalogs, schemas } = await this.#adapter.scopedNamespaces();
    const result: string[] = [];
    for (const name of names) {
      const relation = await this.#adapter.resolveRelationName(name);
      if (
        catalogs.includes(relation.catalog) &&
        schemas.includes(relation.schema)
      ) {
        result.push(
          this.#adapter.formatRelationName(
            relation.catalog,
            relation.schema,
            relation.table,
          ),
        );
      }
    }
    return result;
  }

  protected override async getAllViewNames(): Promise<string[]> {
    const { catalogs, schemas } = await this.#adapter.scopedNamespaces();
    const rows = await this.#adapter.runQuery(
      `
      SELECT database_name, schema_name, view_name
      FROM duckdb_views()
      WHERE NOT internal
        AND NOT temporary
        AND database_name IN (${sqlLiterals(this.#adapter, catalogs)})
        AND schema_name IN (${sqlLiterals(this.#adapter, schemas)})
      ORDER BY database_name, schema_name, view_name
    `,
      viewNameRow,
    );
    return rows.map((row) =>
      this.#adapter.formatRelationName(
        row.database_name,
        row.schema_name,
        row.view_name,
      ),
    );
  }

  protected override async getView(viewName: string): Promise<View> {
    const relation = await this.#adapter.resolveRelationName(viewName);
    const where = relationPredicate(this.#adapter, relation);
    const [columns, definitions] = await Promise.all([
      this.#adapter.runQuery(
        `
        SELECT column_name, data_type
        FROM duckdb_columns()
        WHERE ${where}
        ORDER BY column_index
      `,
        columnRow,
      ),
      this.includeDefinition
        ? this.#adapter.runQuery(
            `
            SELECT sql
            FROM duckdb_views()
            WHERE database_name = '${this.#adapter.escapeString(relation.catalog)}'
              AND schema_name = '${this.#adapter.escapeString(relation.schema)}'
              AND view_name = '${this.#adapter.escapeString(relation.table)}'
          `,
            viewSqlRow,
          )
        : Promise.resolve([]),
    ]);
    return {
      name: this.#adapter.formatRelationName(
        relation.catalog,
        relation.schema,
        relation.table,
      ),
      schema: formatDuckDBIdentifierPath([relation.catalog, relation.schema]),
      rawName: relation.table,
      definition: definitions.at(0)?.sql ?? undefined,
      columns: columns.map(columnFromRow),
    };
  }
}

export class DuckDBConstraintGrounding extends ConstraintGrounding {
  readonly #adapter: DuckDB;

  constructor(adapter: DuckDB, config: ConstraintGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
  }

  protected override async getConstraints(
    tableName: string,
  ): Promise<TableConstraint[]> {
    const relation = await this.#adapter.resolveRelationName(tableName);
    const [rows, columns] = await Promise.all([
      this.#adapter.runQuery(
        `
        SELECT
          constraint_name,
          constraint_type,
          expression,
          constraint_column_names,
          referenced_table,
          referenced_column_names
        FROM duckdb_constraints()
        WHERE ${relationPredicate(this.#adapter, relation)}
        ORDER BY constraint_index
      `,
        constraintRow,
      ),
      this.#adapter.runQuery(
        `
        SELECT column_name, column_default
        FROM duckdb_columns()
        WHERE ${relationPredicate(this.#adapter, relation)}
          AND column_default IS NOT NULL
        ORDER BY column_index
      `,
        columnDefaultRow,
      ),
    ]);

    const constraints = rows.map((row) =>
      constraintFromRow(this.#adapter, relation, row),
    );
    for (const column of columns) {
      constraints.push({
        name: `${relation.table}_${column.column_name}_default`,
        type: 'DEFAULT',
        columns: [column.column_name],
        defaultValue: column.column_default,
      });
    }
    return constraints;
  }
}

export class DuckDBIndexesGrounding extends IndexesGrounding {
  readonly #adapter: DuckDB;

  constructor(adapter: DuckDB, config: IndexesGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
  }

  protected override async getIndexes(
    tableName: string,
  ): Promise<TableIndex[]> {
    const relation = await this.#adapter.resolveRelationName(tableName);
    const [rows, columnRows] = await Promise.all([
      this.#adapter.runQuery(
        `
        SELECT
          index_name,
          TRY_CAST(expressions AS VARCHAR[]) AS expressions,
          is_unique,
          is_primary
        FROM duckdb_indexes()
        WHERE ${relationPredicate(this.#adapter, relation)}
        ORDER BY index_name
      `,
        indexRow,
      ),
      this.#adapter.runQuery(
        `
        SELECT column_name
        FROM duckdb_columns()
        WHERE ${relationPredicate(this.#adapter, relation)}
        ORDER BY column_index
      `,
        columnNameRow,
      ),
    ]);
    const tableColumns = columnRows.map((row) => row.column_name);

    return rows.flatMap((row): TableIndex[] => {
      if (row.expressions === null) {
        return [];
      }
      const columns = row.expressions.map((expression) =>
        tableColumns.find(
          (column) =>
            expression === column ||
            expression === this.#adapter.quoteIdentifier(column),
        ),
      );
      return columns.length > 0 &&
        columns.every((column): column is string => column !== undefined)
        ? [
            {
              name: row.index_name,
              columns,
              unique: row.is_unique,
              type: row.is_primary ? 'PRIMARY' : undefined,
            },
          ]
        : [];
    });
  }
}

export class DuckDBRowCountGrounding extends RowCountGrounding {
  readonly #adapter: DuckDB;

  constructor(adapter: DuckDB, config: RowCountGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
  }

  protected override async getRowCount(
    tableName: string,
  ): Promise<number | undefined> {
    const relation = await this.#adapter.resolveRelationName(tableName);
    const rows = await this.#adapter.runQuery(
      `
      SELECT estimated_size
      FROM duckdb_tables()
      WHERE ${relationPredicate(this.#adapter, relation)}
    `,
      estimatedSizeRow,
    );
    return this.#adapter.toNumber(rows.at(0)?.estimated_size);
  }
}

export class DuckDBColumnStatsGrounding extends ColumnStatsGrounding {
  readonly #adapter: DuckDB;

  constructor(adapter: DuckDB, config: ColumnStatsGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
  }

  protected override async collectStats(
    tableName: string,
    column: Column,
  ): Promise<ColumnStats | undefined> {
    if (
      !/int|real|numeric|double|float|decimal|date|time|bool/i.test(column.type)
    ) {
      return undefined;
    }
    const relation = this.#adapter.quoteRelationName(tableName);
    const identifier = this.#adapter.quoteIdentifier(column.name);
    const rows = await this.#adapter.runQuery(
      `
      SELECT
        CAST(MIN(${identifier}) AS VARCHAR) AS min_value,
        CAST(MAX(${identifier}) AS VARCHAR) AS max_value,
        CASE
          WHEN COUNT(*) = 0 THEN NULL
          ELSE COUNT(*) FILTER (WHERE ${identifier} IS NULL)::DOUBLE / COUNT(*)
        END AS null_fraction,
        COUNT(DISTINCT ${identifier}) AS n_distinct
      FROM ${relation}
    `,
      columnStatsRow,
    );
    const row = rows.at(0);
    if (!row) return undefined;
    return {
      min: row.min_value ?? undefined,
      max: row.max_value ?? undefined,
      nullFraction: this.#adapter.toNumber(row.null_fraction),
      nDistinct: this.#adapter.toNumber(row.n_distinct),
    };
  }
}

export class DuckDBColumnValuesGrounding extends ColumnValuesGrounding {
  readonly #adapter: DuckDB;

  constructor(adapter: DuckDB, config: ColumnValuesGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
  }

  protected override async collectEnumValues(
    _tableName: string,
    column: Column,
  ): Promise<string[] | undefined> {
    return parseEnumLabels(column.type);
  }

  protected override async collectLowCardinality(
    tableName: string,
    column: Column,
  ): Promise<string[] | undefined> {
    if (/\b(?:BLOB|STRUCT|MAP|LIST|UNION|ARRAY)\b/i.test(column.type)) {
      return undefined;
    }
    const relation = this.#adapter.quoteRelationName(tableName);
    const identifier = this.#adapter.quoteIdentifier(column.name);
    const rows = await this.#adapter.runQuery(
      `
      SELECT DISTINCT CAST(${identifier} AS VARCHAR) AS value
      FROM ${relation}
      WHERE ${identifier} IS NOT NULL
      ORDER BY value
      LIMIT ${this.lowCardinalityLimit + 1}
    `,
      textValueRow,
    );
    if (rows.length === 0 || rows.length > this.lowCardinalityLimit) {
      return undefined;
    }
    return rows.map((row) => row.value);
  }
}

function sqlLiterals(adapter: DuckDB, values: readonly string[]): string {
  return values.map((value) => `'${adapter.escapeString(value)}'`).join(', ');
}

function relationPredicate(
  adapter: DuckDB,
  relation: { catalog: string; schema: string; table: string },
): string {
  return `database_name = '${adapter.escapeString(relation.catalog)}'
    AND schema_name = '${adapter.escapeString(relation.schema)}'
    AND table_name = '${adapter.escapeString(relation.table)}'`;
}

function columnFromRow(row: z.output<typeof columnRow>): {
  name: string;
  type: string;
} {
  return { name: row.column_name, type: row.data_type };
}

async function foreignKeys(
  adapter: DuckDB,
  relation: { catalog: string; schema: string; table: string },
  direction: 'outgoing' | 'incoming',
): Promise<z.output<typeof foreignKeyRow>[]> {
  const predicate =
    direction === 'outgoing'
      ? `table_name = '${adapter.escapeString(relation.table)}'`
      : `referenced_table = '${adapter.escapeString(relation.table)}'`;
  return adapter.runQuery(
    `
    SELECT
      table_name,
      constraint_name,
      constraint_type,
      expression,
      constraint_column_names,
      referenced_table,
      referenced_column_names
    FROM duckdb_constraints()
    WHERE database_name = '${adapter.escapeString(relation.catalog)}'
      AND schema_name = '${adapter.escapeString(relation.schema)}'
      AND constraint_type = 'FOREIGN KEY'
      AND ${predicate}
    ORDER BY table_name, constraint_index
  `,
    foreignKeyRow,
  );
}

function relationshipFromRow(
  adapter: DuckDB,
  source: { catalog: string; schema: string; table: string },
  row: ConstraintRow,
): Relationship {
  return {
    table: adapter.formatRelationName(
      source.catalog,
      source.schema,
      source.table,
    ),
    from: row.constraint_column_names,
    referenced_table: adapter.formatRelationName(
      source.catalog,
      source.schema,
      requiredString(row.referenced_table, 'referenced_table'),
    ),
    to: row.referenced_column_names,
  };
}

function constraintFromRow(
  adapter: DuckDB,
  relation: { catalog: string; schema: string; table: string },
  row: ConstraintRow,
): TableConstraint {
  const mapped = CONSTRAINT_TYPES.get(row.constraint_type);
  if (!mapped) {
    throw new Error(`Unknown DuckDB constraint type: ${row.constraint_type}`);
  }
  const referenced =
    mapped === 'FOREIGN_KEY'
      ? adapter.formatRelationName(
          relation.catalog,
          relation.schema,
          requiredString(row.referenced_table, 'referenced_table'),
        )
      : undefined;
  return {
    name: row.constraint_name,
    type: mapped,
    columns: row.constraint_column_names,
    definition:
      mapped === 'CHECK' && row.expression !== null
        ? row.expression
        : undefined,
    referencedTable: referenced,
    referencedColumns:
      mapped === 'FOREIGN_KEY' ? row.referenced_column_names : undefined,
  };
}

function parseEnumLabels(type: string): string[] | undefined {
  const body = /^ENUM\((.*)\)$/i.exec(type)?.[1];
  if (body === undefined) return undefined;
  const labels = [...body.matchAll(/'((?:''|[^'])*)'/g)].map((match) =>
    match[1]!.replaceAll("''", "'"),
  );
  return labels.length > 0 ? labels : undefined;
}

function requiredString(value: string | null, field: string): string {
  if (value === null) {
    throw new Error(`DuckDB catalog field ${field} must be a string.`);
  }
  return value;
}
