import type { Adapter, AdapterInfo } from '../adapter.ts';
import {
  InfoGrounding,
  type InfoGroundingConfig,
} from '../groundings/info.grounding.ts';
import { versionRow } from '../groundings/rows.ts';

/**
 * SQLite implementation of InfoGrounding.
 */
export class SqliteInfoGrounding extends InfoGrounding {
  #adapter: Adapter;

  constructor(adapter: Adapter, config: InfoGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
  }

  protected override async collectInfo(): Promise<AdapterInfo> {
    const rows = await this.#adapter.runQuery(
      'SELECT sqlite_version() AS version',
      versionRow,
    );

    return {
      dialect: 'sqlite',
      version: rows[0]?.version,
      details: {
        parameterPlaceholder: '?',
      },
    };
  }
}
