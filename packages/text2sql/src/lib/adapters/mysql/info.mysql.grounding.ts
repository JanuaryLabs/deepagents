import type { Adapter, AdapterInfo } from '../adapter.ts';
import {
  InfoGrounding,
  type InfoGroundingConfig,
} from '../groundings/info.grounding.ts';

/**
 * MySQL/MariaDB implementation of InfoGrounding.
 *
 * Detects whether the database is MySQL or MariaDB based on version string.
 */
export class MysqlInfoGrounding extends InfoGrounding {
  #adapter: Adapter;

  constructor(adapter: Adapter, config: InfoGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
  }

  protected override async collectInfo(): Promise<AdapterInfo> {
    const [versionRows, dbRows] = await Promise.all([
      this.#adapter.runQuery<{ version: string }>(
        'SELECT VERSION() AS version',
      ),
      this.#adapter.runQuery<{ db: string | null }>('SELECT DATABASE() AS db'),
    ]);

    const version = versionRows[0]?.version;
    const database = dbRows[0]?.db ?? undefined;

    // Detect dialect: MariaDB version strings contain 'MariaDB'
    const isMariadb = version?.toLowerCase().includes('mariadb') ?? false;
    const dialect = isMariadb ? 'mariadb' : 'mysql';

    return {
      dialect,
      version,
      database,
      details: {
        parameterPlaceholder: '?',
      },
    };
  }
}
