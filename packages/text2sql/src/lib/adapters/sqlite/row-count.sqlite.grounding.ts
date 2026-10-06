import { z } from 'zod';

import type { Adapter } from '../adapter.ts';
import {
  RowCountGrounding,
  type RowCountGroundingConfig,
} from '../groundings/row-count.grounding.ts';
import { sqliteInteger } from './sqlite-rows.ts';

const countRow = z.object({ count: sqliteInteger });

/**
 * SQLite implementation of RowCountGrounding.
 */
export class SqliteRowCountGrounding extends RowCountGrounding {
  #adapter: Adapter;

  constructor(adapter: Adapter, config: RowCountGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
  }

  protected override async getRowCount(
    tableName: string,
  ): Promise<number | undefined> {
    const rows = await this.#adapter.runQuery(
      `SELECT COUNT(*) as count FROM ${this.#adapter.quoteIdentifier(tableName)}`,
      countRow,
    );

    return rows[0]?.count;
  }
}
