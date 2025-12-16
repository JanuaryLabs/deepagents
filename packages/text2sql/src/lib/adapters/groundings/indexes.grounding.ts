import type { TableIndex } from '../adapter.ts';
import { AbstractGrounding } from './abstract.grounding.ts';
import type { GroundingContext } from './context.ts';

/**
 * Configuration for IndexesGrounding.
 */
export interface IndexesGroundingConfig {
  // Future: filter which tables to collect indexes for
}

/**
 * Abstract base class for indexes grounding.
 *
 * Reads tables from the context and annotates them with index metadata.
 * This grounding must run AFTER TableGrounding since it reads from ctx.tables.
 *
 * Subclasses implement the database-specific hook:
 * - `getIndexes()` - fetch indexes for a table
 */
export abstract class IndexesGrounding extends AbstractGrounding {
  constructor(config: IndexesGroundingConfig = {}) {
    super('indexes');
  }

  /**
   * Fetch indexes for a specific table.
   */
  protected abstract getIndexes(tableName: string): Promise<TableIndex[]>;

  /**
   * Execute the grounding process.
   * Annotates tables in ctx.tables with their indexes and marks indexed columns.
   */
  async execute(ctx: GroundingContext) {
    for (const table of ctx.tables) {
      table.indexes = await this.getIndexes(table.name);
      // Mark columns that are part of indexes
      for (const index of table.indexes ?? []) {
        for (const colName of index.columns) {
          const column = table.columns.find((c) => c.name === colName);
          if (column) {
            column.isIndexed = true;
          }
        }
      }
    }
    // Return null - TableGrounding already describes indexes in its output
    return () => null;
  }
}
