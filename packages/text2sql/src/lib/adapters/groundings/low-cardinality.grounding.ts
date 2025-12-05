import { AbstractGrounding } from '../grounding.ticket.ts';
import type { Column, ColumnContainer, GroundingContext } from './context.ts';

export type { Column, ColumnContainer };

/**
 * Configuration for LowCardinalityGrounding.
 */
export interface LowCardinalityGroundingConfig {
  /** Maximum number of distinct values to consider "low cardinality". Default: 20 */
  limit?: number;
}

/**
 * Abstract base class for low cardinality column grounding.
 *
 * Reads tables and views from the context and annotates their columns
 * with low cardinality values (columns with few distinct values).
 *
 * Subclasses implement database-specific hooks:
 * - `collectLowCardinality()` - collect distinct values for low cardinality columns
 */
export abstract class LowCardinalityGrounding extends AbstractGrounding {
  protected readonly limit: number;

  constructor(config: LowCardinalityGroundingConfig = {}) {
    super('low_cardinality');
    this.limit = config.limit ?? 20;
  }

  /**
   * Collect distinct values for low cardinality columns.
   * Return undefined if column has too many distinct values.
   */
  protected abstract collectLowCardinality(
    tableName: string,
    column: Column,
  ): Promise<{ kind: 'LowCardinality'; values: string[] } | undefined>;

  /**
   * Execute the grounding process.
   * Annotates columns in ctx.tables and ctx.views with low cardinality values.
   */
  async execute(ctx: GroundingContext) {
    // Process both tables and views
    const allContainers: ColumnContainer[] = [...ctx.tables, ...ctx.views];
    for (const container of allContainers) {
      for (const column of container.columns) {
        // Collect low cardinality values
        try {
          const lowCard = await this.collectLowCardinality(
            container.name,
            column,
          );
          if (lowCard) {
            column.kind = lowCard.kind;
            column.values = lowCard.values;
          }
        } catch (error) {
          // Skip on error
          console.warn(
            'Error collecting low cardinality values for',
            container.name,
            column.name,
            error,
          );
        }
      }
    }
    return () => this.#describe();
  }

  #describe() {
    return null;
  }
}
