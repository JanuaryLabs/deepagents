import type { Adapter, AdapterInfo } from '../adapter.ts';
import {
  InfoGrounding,
  type InfoGroundingConfig,
} from '../groundings/info.grounding.ts';

/**
 * SQL Server implementation of InfoGrounding.
 */
export class SqlServerInfoGrounding extends InfoGrounding {
  #adapter: Adapter;

  constructor(adapter: Adapter, config: InfoGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
  }

  protected override async collectInfo(): Promise<AdapterInfo> {
    const [versionRows, dbRows] = await Promise.all([
      this.#adapter.runQuery<{ version: string }>(
        'SELECT @@VERSION AS version',
      ),
      this.#adapter.runQuery<{ db: string }>('SELECT DB_NAME() AS db'),
    ]);

    return {
      dialect: 'sqlserver',
      version: versionRows[0]?.version,
      database: dbRows[0]?.db,
      details: {
        parameterPlaceholder: '@p1, @p2, @p3, ...',
        aliasRule:
          'When a table is aliased (FROM dbo.users AS users), always reference columns via the alias (users.id), never the schema-qualified name (dbo.users.id). SQL Server cannot resolve schema-qualified identifiers on aliased tables (error 4104).',
      },
    };
  }
}
