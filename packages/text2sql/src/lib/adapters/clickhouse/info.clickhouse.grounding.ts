import type { Adapter, AdapterInfo } from '../adapter.ts';
import {
  InfoGrounding,
  type InfoGroundingConfig,
} from '../groundings/info.grounding.ts';

type InfoRow = {
  version: string;
  database: string;
};

export class ClickHouseInfoGrounding extends InfoGrounding {
  readonly #adapter: Adapter;

  constructor(adapter: Adapter, config: InfoGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
  }

  protected override async collectInfo(): Promise<AdapterInfo> {
    const rows = await this.#adapter.runQuery<InfoRow>(
      'SELECT version() AS version, currentDatabase() AS database',
    );
    const row = rows[0];
    return {
      dialect: 'clickhouse',
      version: row?.version,
      database: row?.database || undefined,
      details: {
        identifierQuote: '`',
        qualifiedTable: 'database.table',
      },
    };
  }
}
