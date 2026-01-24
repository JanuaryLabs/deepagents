import type { Adapter, AdapterInfo } from '../adapter.ts';
import {
  InfoGrounding,
  type InfoGroundingConfig,
} from '../groundings/info.grounding.ts';

/**
 * PostgreSQL implementation of InfoGrounding.
 */
export class PostgresInfoGrounding extends InfoGrounding {
  #adapter: Adapter;

  constructor(adapter: Adapter, config: InfoGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
  }

  protected override async collectInfo(): Promise<AdapterInfo> {
    const [versionRows, dbRows] = await Promise.all([
      this.#adapter.runQuery<{ version: string }>(
        'SELECT version() AS version',
      ),
      this.#adapter.runQuery<{ db: string }>('SELECT current_database() AS db'),
    ]);

    return {
      dialect: 'postgresql',
      version: versionRows[0]?.version,
      database: dbRows[0]?.db,
      details: {
        parameterPlaceholder: '$1, $2, $3, ...',
        identifierQuoting:
          'PostgreSQL lowercases unquoted identifiers. To preserve mixed-case names, wrap table and column names in double quotes: SELECT "columnName" FROM "TableName"',
      },
    };
  }
}
