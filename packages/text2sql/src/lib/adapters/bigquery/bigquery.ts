import {
  Adapter,
  type ExecuteFunction,
  type GroundingFn,
  type ValidateFunction,
} from '../adapter.ts';

export type BigQueryAdapterOptions = {
  execute: ExecuteFunction;
  /**
   * SQL validation is required for BigQuery.
   * Recommended implementation: BigQuery dry-run.
   */
  validate: ValidateFunction;
  grounding: GroundingFn[];
  /**
   * Datasets to introspect (scopes all metadata discovery).
   */
  datasets: string[];
  /**
   * Optional projectId used to qualify INFORMATION_SCHEMA references.
   * If omitted, the provided `execute()` implementation must supply a default project context.
   */
  projectId?: string;
};

type BigQueryError = {
  message?: string;
  reason?: string;
  code?: number | string;
};

function formatBigQueryError(sql: string, error: unknown) {
  const errorMessage =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : typeof error === 'object' && error !== null
          ? ((error as BigQueryError).message ?? JSON.stringify(error))
          : 'Unknown error occurred';

  return {
    error: errorMessage,
    error_type: 'BIGQUERY_ERROR',
    suggestion:
      'Validate the query (dry-run) and review table/dataset names, nested field paths, and parameter bindings.',
    sql_attempted: sql,
  };
}

export class BigQuery extends Adapter {
  #options: BigQueryAdapterOptions;
  #datasetSet: Set<string>;

  override readonly grounding: GroundingFn[];
  override readonly defaultSchema: string | undefined;
  override readonly systemSchemas: string[] = [];
  override readonly formatterLanguage = 'bigquery';

  constructor(options: BigQueryAdapterOptions) {
    super();

    if (!options || typeof options.execute !== 'function') {
      throw new Error('BigQuery adapter requires an execute(sql) function.');
    }
    if (typeof options.validate !== 'function') {
      throw new Error(
        'BigQuery adapter requires a validate(sql) function. Provide a BigQuery dry-run validator (recommended) so generated SQL can be validated before execution.',
      );
    }

    const datasets = (options.datasets ?? [])
      .map((d) => d.trim())
      .filter(Boolean);
    if (datasets.length === 0) {
      throw new Error(
        "BigQuery adapter requires a non-empty datasets list (e.g. datasets: ['analytics']). This scopes all introspection.",
      );
    }

    this.#options = { ...options, datasets };
    this.#datasetSet = new Set(datasets);
    this.grounding = options.grounding;
    this.defaultSchema = datasets.length === 1 ? datasets[0] : undefined;
  }

  get datasets(): readonly string[] {
    return this.#options.datasets;
  }

  get projectId(): string | undefined {
    return this.#options.projectId;
  }

  isDatasetAllowed(dataset: string): boolean {
    return this.#datasetSet.has(dataset);
  }

  /**
   * Build a fully-qualified BigQuery INFORMATION_SCHEMA view reference.
   * Uses standard BigQuery backtick quoting on the full path.
   */
  infoSchemaView(dataset: string, viewName: string): string {
    const projectPrefix = this.projectId ? `${this.projectId}.` : '';
    return `\`${projectPrefix}${dataset}.INFORMATION_SCHEMA.${viewName}\``;
  }

  override async execute(sql: string) {
    return this.#options.execute(sql);
  }

  override async validate(sql: string) {
    try {
      return await this.#options.validate(sql);
    } catch (error) {
      return JSON.stringify(formatBigQueryError(sql, error));
    }
  }

  override async runQuery<Row>(sql: string): Promise<Row[]> {
    const result = await this.#options.execute(sql);

    if (Array.isArray(result)) {
      return result as Row[];
    }

    if (
      result &&
      typeof result === 'object' &&
      'rows' in result &&
      Array.isArray((result as { rows?: unknown }).rows)
    ) {
      return (result as { rows: Row[] }).rows;
    }

    throw new Error(
      'BigQuery adapter execute() must return an array of rows or an object with a rows array when introspecting.',
    );
  }

  override quoteIdentifier(name: string): string {
    // BigQuery uses backticks. Quote each segment so dotted paths work for both
    // dataset.table qualification and nested field paths (e.g. user.address.city).
    return name
      .split('.')
      .map((part) => `\`${part.replace(/`/g, '``')}\``)
      .join('.');
  }

  override escape(value: string): string {
    return value.replace(/`/g, '``');
  }

  override buildSampleRowsQuery(
    tableName: string,
    columns: string[] | undefined,
    limit: number,
  ): string {
    const qualifiedTableName = this.#qualifyTableName(tableName);
    const tableIdentifier = this.quoteIdentifier(qualifiedTableName);
    const columnList = columns?.length
      ? columns
          .map((c) => (c === '*' ? '*' : this.quoteIdentifier(c)))
          .join(', ')
      : '*';

    return `SELECT ${columnList} FROM ${tableIdentifier} LIMIT ${limit}`;
  }

  #qualifyTableName(tableName: string): string {
    if (!this.projectId) {
      return tableName;
    }
    // If already qualified as project.dataset.table, keep as-is.
    if (tableName.split('.').length >= 3) {
      return tableName;
    }
    return `${this.projectId}.${tableName}`;
  }
}
