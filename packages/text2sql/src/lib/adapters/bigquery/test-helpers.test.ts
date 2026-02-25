import { BigQuery } from '@deepagents/text2sql/bigquery';

export type SqlResponder = (sql: string) => unknown;

export type SqlMatcher = {
  matches: (sql: string) => boolean;
  respond: () => unknown;
};

export function createExecuteStub(responder: SqlResponder) {
  const calls: string[] = [];
  const execute = (sql: string) => {
    calls.push(sql);
    return responder(sql);
  };
  return { execute, calls };
}

export function buildResponder(matchers: SqlMatcher[]): SqlResponder {
  return (sql: string) => {
    for (const m of matchers) {
      if (m.matches(sql)) return m.respond();
    }
    throw new Error(`Unexpected SQL in test stub:\n${sql}`);
  };
}

export function createTestAdapter(options: {
  responder: SqlResponder;
  datasets?: string[];
  projectId?: string;
  grounding?: ConstructorParameters<typeof BigQuery>[0]['grounding'];
  validate?: (sql: string) => Promise<string | void> | string | void;
}) {
  const { execute, calls } = createExecuteStub(options.responder);
  const adapter = new BigQuery({
    datasets: options.datasets ?? ['analytics'],
    execute,
    validate: options.validate ?? (async () => undefined),
    grounding: options.grounding ?? [],
    projectId: options.projectId,
  });
  return { adapter, execute, calls };
}

export function requireOne<T>(items: T[], message: string): T {
  if (items.length !== 1) {
    throw new Error(`${message}. Expected 1, got ${items.length}`);
  }
  return items[0]!;
}

export function tableListingMatcher(
  dataset: string,
  tableNames: { table_name: string | null }[],
): SqlMatcher {
  return {
    matches: (sql) =>
      sql.includes(`${dataset}.INFORMATION_SCHEMA.TABLES`) &&
      sql.includes("WHERE table_type = 'BASE TABLE'"),
    respond: () => tableNames,
  };
}

export function columnFieldPathsMatcher(
  dataset: string,
  tableName: string,
  columns: {
    field_path: string | null;
    data_type: string | null;
    ordinal_position: number | null;
  }[],
): SqlMatcher {
  return {
    matches: (sql) =>
      sql.includes(`${dataset}.INFORMATION_SCHEMA.COLUMN_FIELD_PATHS`) &&
      sql.includes(`WHERE f.table_name = '${tableName}'`),
    respond: () => columns,
  };
}

export function fkDiscoveryMatcher(
  dataset: string,
  tableName: string,
  rows: {
    constraint_name: string | null;
    column_name: string | null;
    ordinal_position: number | null;
    position_in_unique_constraint: number | null;
  }[],
): SqlMatcher {
  return {
    matches: (sql) =>
      sql.includes(`${dataset}.INFORMATION_SCHEMA.TABLE_CONSTRAINTS`) &&
      sql.includes('JOIN') &&
      sql.includes('KEY_COLUMN_USAGE') &&
      sql.includes("tc.constraint_type = 'FOREIGN KEY'") &&
      sql.includes(`tc.table_name = '${tableName}'`),
    respond: () => rows,
  };
}

export function constraintColumnUsageMatcher(
  dataset: string,
  constraintName: string,
  rows: { table_schema: string | null; table_name: string | null }[],
): SqlMatcher {
  return {
    matches: (sql) =>
      sql.includes(`${dataset}.INFORMATION_SCHEMA.CONSTRAINT_COLUMN_USAGE`) &&
      sql.includes(`constraint_name = '${constraintName}'`),
    respond: () => rows,
  };
}

export function pkConstraintMatcher(
  dataset: string,
  tableName: string,
  constraintName: string | null,
): SqlMatcher {
  return {
    matches: (sql) =>
      sql.includes(`${dataset}.INFORMATION_SCHEMA.TABLE_CONSTRAINTS`) &&
      sql.includes("constraint_type = 'PRIMARY KEY'") &&
      sql.includes(`table_name = '${tableName}'`) &&
      sql.includes('LIMIT 1'),
    respond: () =>
      constraintName ? [{ constraint_name: constraintName }] : [],
  };
}

export function pkColumnUsageMatcher(
  dataset: string,
  constraintName: string,
  tableName: string,
  columns: { column_name: string | null; ordinal_position: number | null }[],
): SqlMatcher {
  return {
    matches: (sql) =>
      sql.includes(`${dataset}.INFORMATION_SCHEMA.KEY_COLUMN_USAGE`) &&
      sql.includes(`constraint_name = '${constraintName}'`) &&
      sql.includes(`table_name = '${tableName}'`),
    respond: () => columns,
  };
}

export function columnMetadataMatcher(
  dataset: string,
  rows: {
    table_name: string | null;
    column_name: string | null;
    is_nullable: string | null;
    column_default: string | null;
  }[],
): SqlMatcher {
  return {
    matches: (sql) =>
      sql.includes(`${dataset}.INFORMATION_SCHEMA.COLUMNS`) &&
      sql.includes(
        'SELECT table_name, column_name, is_nullable, column_default',
      ) &&
      sql.includes('table_name IN'),
    respond: () => rows,
  };
}

export function keyConstraintsMatcher(
  dataset: string,
  rows: {
    table_name: string | null;
    constraint_name: string | null;
    constraint_type: string | null;
    column_name: string | null;
    ordinal_position: number | null;
    position_in_unique_constraint: number | null;
  }[],
): SqlMatcher {
  return {
    matches: (sql) =>
      sql.includes(`${dataset}.INFORMATION_SCHEMA.TABLE_CONSTRAINTS`) &&
      sql.includes("tc.constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY')") &&
      sql.includes('tc.table_name IN'),
    respond: () => rows,
  };
}

export function tableStorageMatcher(
  dataset: string,
  rows: { table_name: string | null; total_rows: number | string | null }[],
): SqlMatcher {
  return {
    matches: (sql) =>
      sql.includes(`${dataset}.INFORMATION_SCHEMA.TABLE_STORAGE`) &&
      sql.includes('table_name IN'),
    respond: () => rows,
  };
}

export function legacyTablesMatcher(
  dataset: string,
  rows: { table_name: string | null; row_count: number | string | null }[],
): SqlMatcher {
  return {
    matches: (sql) =>
      sql.includes(`\`${dataset}\`.__TABLES__`) && sql.includes('table_id IN'),
    respond: () => rows,
  };
}

export function tableStorageThrowsMatcher(dataset: string): SqlMatcher {
  return {
    matches: (sql) =>
      sql.includes(`${dataset}.INFORMATION_SCHEMA.TABLE_STORAGE`),
    respond: () => {
      throw new Error('TABLE_STORAGE not available');
    },
  };
}

export function legacyTablesThrowsMatcher(dataset: string): SqlMatcher {
  return {
    matches: (sql) => sql.includes(`\`${dataset}\`.__TABLES__`),
    respond: () => {
      throw new Error('__TABLES__ not available');
    },
  };
}

export function indexHintsMatcher(
  dataset: string,
  rows: {
    table_name: string | null;
    column_name: string | null;
    is_partitioning_column: string | null;
    clustering_ordinal_position: number | null;
  }[],
): SqlMatcher {
  return {
    matches: (sql) =>
      sql.includes(`${dataset}.INFORMATION_SCHEMA.COLUMNS`) &&
      sql.includes('clustering_ordinal_position') &&
      sql.includes('table_name IN'),
    respond: () => rows,
  };
}

export function viewListingMatcher(
  dataset: string,
  viewNames: { table_name: string | null }[],
): SqlMatcher {
  return {
    matches: (sql) =>
      sql.includes(`${dataset}.INFORMATION_SCHEMA.TABLES`) &&
      sql.includes("table_type IN ('VIEW', 'MATERIALIZED VIEW')") &&
      sql.includes('SELECT table_name'),
    respond: () => viewNames,
  };
}

export function viewDdlMatcher(
  dataset: string,
  viewName: string,
  ddl: string | null,
): SqlMatcher {
  return {
    matches: (sql) =>
      sql.includes(`${dataset}.INFORMATION_SCHEMA.TABLES`) &&
      sql.includes('SELECT ddl') &&
      sql.includes(`table_name = '${viewName}'`),
    respond: () => (ddl != null ? [{ ddl }] : []),
  };
}

export function viewColumnsMatcher(
  dataset: string,
  viewName: string,
  columns: { column_name: string | null; data_type: string | null }[],
): SqlMatcher {
  return {
    matches: (sql) =>
      sql.includes(`${dataset}.INFORMATION_SCHEMA.COLUMNS`) &&
      sql.includes('SELECT column_name, data_type') &&
      sql.includes(`table_name = '${viewName}'`),
    respond: () => columns,
  };
}

export function incomingFkLookupMatcher(
  constraintDataset: string,
  referencedDataset: string,
  referencedTable: string,
  rows: { constraint_name: string | null }[],
): SqlMatcher {
  return {
    matches: (sql) =>
      sql.includes(
        `${constraintDataset}.INFORMATION_SCHEMA.CONSTRAINT_COLUMN_USAGE`,
      ) &&
      sql.includes(`table_schema = '${referencedDataset}'`) &&
      sql.includes(`table_name = '${referencedTable}'`),
    respond: () => rows,
  };
}

export function incomingFkKeyColumnsMatcher(
  constraintDataset: string,
  constraintName: string,
  rows: {
    constraint_name: string | null;
    child_table_name: string | null;
    column_name: string | null;
    ordinal_position: number | null;
    position_in_unique_constraint: number | null;
  }[],
): SqlMatcher {
  return {
    matches: (sql) =>
      sql.includes(
        `${constraintDataset}.INFORMATION_SCHEMA.TABLE_CONSTRAINTS`,
      ) &&
      sql.includes('JOIN') &&
      sql.includes('KEY_COLUMN_USAGE') &&
      sql.includes("tc.constraint_type = 'FOREIGN KEY'") &&
      sql.includes(`tc.constraint_name = '${constraintName}'`),
    respond: () => rows,
  };
}

export function minimalTableMatchers(
  dataset: string,
  tableName: string,
  columns: {
    field_path: string;
    data_type: string;
    ordinal_position: number;
  }[],
): SqlMatcher[] {
  return [
    tableListingMatcher(dataset, [{ table_name: tableName }]),
    columnFieldPathsMatcher(dataset, tableName, columns),
    fkDiscoveryMatcher(dataset, tableName, []),
  ];
}
