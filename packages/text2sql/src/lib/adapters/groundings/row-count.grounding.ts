import type { Table } from '../adapter.ts';
import { AbstractGrounding } from './abstract.grounding.ts';
import type { GroundingContext } from './context.ts';

/**
 * Configuration for RowCountGrounding.
 */
export interface RowCountGroundingConfig {
  // Future: filter which tables to count
}

/**
 * Abstract base class for row count grounding.
 *
 * Reads tables from the context and annotates them with row counts and size hints.
 * This grounding must run AFTER TableGrounding since it reads from ctx.tables.
 *
 * Subclasses implement the database-specific hook:
 * - `getRowCount()` - get row count for a table
 */
export abstract class RowCountGrounding extends AbstractGrounding {
  constructor(config: RowCountGroundingConfig = {}) {
    super('rowCount');
  }

  /**
   * Get row count for a specific table.
   */
  protected abstract getRowCount(
    tableName: string,
  ): Promise<number | undefined>;

  /**
   * Execute the grounding process.
   * Annotates tables in ctx.tables with row counts and size hints.
   */
  async execute(ctx: GroundingContext): Promise<void> {
    for (const table of ctx.tables) {
      const count = await this.getRowCount(table.name);
      if (count != null) {
        table.rowCount = count;
        table.sizeHint = this.#classifyRowCount(count);
      }
    }
  }

  /**
   * Classify row count into a size hint category.
   */
  #classifyRowCount(count: number): Table['sizeHint'] {
    if (count < 100) return 'tiny';
    if (count < 1000) return 'small';
    if (count < 10000) return 'medium';
    if (count < 100000) return 'large';
    return 'huge';
  }
}
