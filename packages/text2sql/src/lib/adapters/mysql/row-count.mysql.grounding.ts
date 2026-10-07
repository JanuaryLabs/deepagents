import { z } from 'zod';

import type { Adapter } from '../adapter.ts';
import {
  RowCountGrounding,
  type RowCountGroundingConfig,
} from '../groundings/row-count.grounding.ts';
import { numericValue } from '../groundings/rows.ts';
import { currentDatabaseRow } from './mysql-rows.ts';

/**
 * COUNT(*) is a BIGINT: a number with mysql2, a decimal string with its
 * bigNumberStrings option or the mysql CLI, a bigint with the mariadb connector.
 */
const countRow = z.object({ count: numericValue });

/**
 * MySQL/MariaDB implementation of RowCountGrounding.
 *
 * Uses COUNT(*) for accurate row counts.
 */
export class MysqlRowCountGrounding extends RowCountGrounding {
  #adapter: Adapter;

  constructor(adapter: Adapter, config: RowCountGroundingConfig = {}) {
    super(config);
    this.#adapter = adapter;
  }

  protected override async getRowCount(
    tableName: string,
  ): Promise<number | undefined> {
    const { schema, table } = this.#adapter.parseTableName(tableName);
    const database = schema || (await this.#getCurrentDatabase());

    const tableIdentifier = `${this.#adapter.quoteIdentifier(database)}.${this.#adapter.quoteIdentifier(table)}`;

    try {
      const rows = await this.#adapter.runQuery(
        `SELECT COUNT(*) AS count FROM ${tableIdentifier}`,
        countRow,
      );

      return this.#adapter.toNumber(rows[0]?.count);
    } catch {
      return undefined;
    }
  }

  async #getCurrentDatabase(): Promise<string> {
    const rows = await this.#adapter.runQuery(
      'SELECT DATABASE() AS db',
      currentDatabaseRow,
    );
    return rows[0]?.db ?? '';
  }
}
