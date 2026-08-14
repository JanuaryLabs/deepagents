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

type TableNameRow = {
  database_name: unknown;
  schema_name: unknown;
  table_name: unknown;
};

type ColumnRow = {
  column_name: unknown;
  data_type: unknown;
};

type ConstraintRow = {
  constraint_name: unknown;
  constraint_type: unknown;
  expression: unknown;
  constraint_column_names: unknown;
  referenced_table: unknown;
  referenced_column_names: unknown;
};

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
    const rows = await this.#adapter.runQuery<TableNameRow>(`
      SELECT database_name, schema_name, table_name
      FROM duckdb_tables()
      WHERE NOT internal
        AND NOT temporary
        AND database_name IN (${sqlLiterals(this.#adapter, catalogs)})
        AND schema_name IN (${sqlLiterals(this.#adapter, schemas)})
      ORDER BY database_name, schema_name, table_name
    `);

    return rows.map((row) => {
      if (
        typeof row.database_name !== 'string' ||
        typeof row.schema_name !== 'string' ||
        typeof row.table_name !== 'string'
      ) {
        throw new Error('DuckDB table catalog returned an unknown row shape.');
      }
      return this.#adapter.formatRelationName(
        row.database_name,
        row.schema_name,
        row.table_name,
      );
    });
  }

  protected override async getTable(tableName: string): Promise<Table> {
    const { catalog, schema, table } =
      await this.#adapter.resolveRelationName(tableName);
    const rows = await this.#adapter.runQuery<ColumnRow>(`
      SELECT column_name, data_type
      FROM duckdb_columns()
      WHERE database_name = '${this.#adapter.escapeString(catalog)}'
        AND schema_name = '${this.#adapter.escapeString(schema)}'
        AND table_name = '${this.#adapter.escapeString(table)}'
      ORDER BY column_index
    `);

    return {
      name: this.#adapter.formatRelationName(catalog, schema, table),
      schema: formatDuckDBIdentifierPath([catalog, schema]),
      rawName: table,
      columns: rows.map((row) => {
        if (
          typeof row.column_name !== 'string' ||
          typeof row.data_type !== 'string'
        ) {
          throw new Error(
            'DuckDB column catalog returned an unknown row shape.',
          );
        }
        return { name: row.column_name, type: row.data_type };
      }),
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
        table: requiredString(row.table_name, 'table_name'),
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
    const rows = await this.#adapter.runQuery<{
      version: unknown;
      catalog: unknown;
      schema: unknown;
    }>(`
      SELECT
        version() AS version,
        current_database() AS catalog,
        current_schema() AS schema
    `);
    const row = rows[0];
    return {
      dialect: 'duckdb',
      version: typeof row?.version === 'string' ? row.version : undefined,
      database: typeof row?.catalog === 'string' ? row.catalog : undefined,
      details: {
        currentSchema: typeof row?.schema === 'string' ? row.schema : 'unknown',
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
    const rows = await this.#adapter.runQuery<{
      database_name: unknown;
      schema_name: unknown;
      view_name: unknown;
    }>(`
      SELECT database_name, schema_name, view_name
      FROM duckdb_views()
      WHERE NOT internal
        AND NOT temporary
        AND database_name IN (${sqlLiterals(this.#adapter, catalogs)})
        AND schema_name IN (${sqlLiterals(this.#adapter, schemas)})
      ORDER BY database_name, schema_name, view_name
    `);
    return rows.map((row) =>
      this.#adapter.formatRelationName(
        requiredString(row.database_name, 'database_name'),
        requiredString(row.schema_name, 'schema_name'),
        requiredString(row.view_name, 'view_name'),
      ),
    );
  }

  protected override async getView(viewName: string): Promise<View> {
    const relation = await this.#adapter.resolveRelationName(viewName);
    const where = relationPredicate(this.#adapter, relation);
    const [columns, definitions] = await Promise.all([
      this.#adapter.runQuery<ColumnRow>(`
        SELECT column_name, data_type
        FROM duckdb_columns()
        WHERE ${where}
        ORDER BY column_index
      `),
      this.includeDefinition
        ? this.#adapter.runQuery<{ sql: unknown }>(`
            SELECT sql
            FROM duckdb_views()
            WHERE database_name = '${this.#adapter.escapeString(relation.catalog)}'
              AND schema_name = '${this.#adapter.escapeString(relation.schema)}'
              AND view_name = '${this.#adapter.escapeString(relation.table)}'
          `)
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
      definition:
        typeof definitions[0]?.sql === 'string'
          ? definitions[0].sql
          : undefined,
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
      this.#adapter.runQuery<ConstraintRow>(`
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
      `),
      this.#adapter.runQuery<{
        column_name: unknown;
        column_default: unknown;
      }>(`
        SELECT column_name, column_default
        FROM duckdb_columns()
        WHERE ${relationPredicate(this.#adapter, relation)}
          AND column_default IS NOT NULL
        ORDER BY column_index
      `),
    ]);

    const constraints = rows.map((row) =>
      constraintFromRow(this.#adapter, relation, row),
    );
    for (const column of columns) {
      if (
        typeof column.column_name === 'string' &&
        typeof column.column_default === 'string'
      ) {
        constraints.push({
          name: `${relation.table}_${column.column_name}_default`,
          type: 'DEFAULT',
          columns: [column.column_name],
          defaultValue: column.column_default,
        });
      }
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
      this.#adapter.runQuery<{
        index_name: unknown;
        expressions: unknown;
        is_unique: unknown;
        is_primary: unknown;
      }>(`
        SELECT
          index_name,
          TRY_CAST(expressions AS VARCHAR[]) AS expressions,
          is_unique,
          is_primary
        FROM duckdb_indexes()
        WHERE ${relationPredicate(this.#adapter, relation)}
        ORDER BY index_name
      `),
      this.#adapter.runQuery<{ column_name: unknown }>(`
        SELECT column_name
        FROM duckdb_columns()
        WHERE ${relationPredicate(this.#adapter, relation)}
        ORDER BY column_index
      `),
    ]);
    const tableColumns = columnRows.map((row) =>
      requiredString(row.column_name, 'column_name'),
    );

    return rows.flatMap((row): TableIndex[] => {
      if (typeof row.index_name !== 'string') {
        throw new Error('DuckDB index catalog returned an unknown row shape.');
      }
      if (
        !Array.isArray(row.expressions) ||
        row.expressions.some((expression) => typeof expression !== 'string')
      ) {
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
              unique: row.is_unique === true,
              type: row.is_primary === true ? 'PRIMARY' : undefined,
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
    const rows = await this.#adapter.runQuery<{ estimated_size: unknown }>(`
      SELECT estimated_size
      FROM duckdb_tables()
      WHERE ${relationPredicate(this.#adapter, relation)}
    `);
    return this.#adapter.toNumber(rows[0]?.estimated_size);
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
    const rows = await this.#adapter.runQuery<{
      min_value: unknown;
      max_value: unknown;
      null_fraction: unknown;
      n_distinct: unknown;
    }>(`
      SELECT
        CAST(MIN(${identifier}) AS VARCHAR) AS min_value,
        CAST(MAX(${identifier}) AS VARCHAR) AS max_value,
        CASE
          WHEN COUNT(*) = 0 THEN NULL
          ELSE COUNT(*) FILTER (WHERE ${identifier} IS NULL)::DOUBLE / COUNT(*)
        END AS null_fraction,
        COUNT(DISTINCT ${identifier}) AS n_distinct
      FROM ${relation}
    `);
    const row = rows[0];
    if (!row) return undefined;
    return {
      min: typeof row.min_value === 'string' ? row.min_value : undefined,
      max: typeof row.max_value === 'string' ? row.max_value : undefined,
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
    const rows = await this.#adapter.runQuery<{ value: unknown }>(`
      SELECT DISTINCT CAST(${identifier} AS VARCHAR) AS value
      FROM ${relation}
      WHERE ${identifier} IS NOT NULL
      ORDER BY value
      LIMIT ${this.lowCardinalityLimit + 1}
    `);
    if (rows.length === 0 || rows.length > this.lowCardinalityLimit) {
      return undefined;
    }
    if (rows.some((row) => typeof row.value !== 'string')) return undefined;
    return rows.map((row) => row.value as string);
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

function columnFromRow(row: ColumnRow): { name: string; type: string } {
  return {
    name: requiredString(row.column_name, 'column_name'),
    type: requiredString(row.data_type, 'data_type'),
  };
}

async function foreignKeys(
  adapter: DuckDB,
  relation: { catalog: string; schema: string; table: string },
  direction: 'outgoing' | 'incoming',
): Promise<Array<ConstraintRow & { table_name: unknown }>> {
  const predicate =
    direction === 'outgoing'
      ? `table_name = '${adapter.escapeString(relation.table)}'`
      : `referenced_table = '${adapter.escapeString(relation.table)}'`;
  return adapter.runQuery(`
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
  `);
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
    from: stringArray(row.constraint_column_names, 'constraint_column_names'),
    referenced_table: adapter.formatRelationName(
      source.catalog,
      source.schema,
      requiredString(row.referenced_table, 'referenced_table'),
    ),
    to: stringArray(row.referenced_column_names, 'referenced_column_names'),
  };
}

function constraintFromRow(
  adapter: DuckDB,
  relation: { catalog: string; schema: string; table: string },
  row: ConstraintRow,
): TableConstraint {
  const type = requiredString(row.constraint_type, 'constraint_type');
  const mapped = CONSTRAINT_TYPES.get(type);
  if (!mapped) throw new Error(`Unknown DuckDB constraint type: ${type}`);
  const referenced =
    mapped === 'FOREIGN_KEY'
      ? adapter.formatRelationName(
          relation.catalog,
          relation.schema,
          requiredString(row.referenced_table, 'referenced_table'),
        )
      : undefined;
  return {
    name: requiredString(row.constraint_name, 'constraint_name'),
    type: mapped,
    columns: stringArray(
      row.constraint_column_names,
      'constraint_column_names',
    ),
    definition:
      mapped === 'CHECK' && typeof row.expression === 'string'
        ? row.expression
        : undefined,
    referencedTable: referenced,
    referencedColumns:
      mapped === 'FOREIGN_KEY'
        ? stringArray(row.referenced_column_names, 'referenced_column_names')
        : undefined,
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

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`DuckDB catalog field ${field} must be a string.`);
  }
  return value;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`DuckDB catalog field ${field} must be a string array.`);
  }
  return value as string[];
}
