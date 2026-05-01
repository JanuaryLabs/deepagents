import type { ColumnStats } from '../adapter.ts';
import { AbstractGrounding } from './abstract.grounding.ts';
import type { Column, ColumnContainer, GroundingContext } from './context.ts';

/**
 * Configuration for ColumnStatsGrounding.
 */
export interface ColumnStatsGroundingConfig {
  // Future: filter which tables/columns to collect stats for
}

/**
 * Abstract base class for column statistics grounding.
 *
 * Reads tables and views from the context and annotates their columns
 * with statistics (min, max, nullFraction).
 *
 * Subclasses implement database-specific hooks:
 * - `collectStats()` - collect min/max/nullFraction for a column
 */
export abstract class ColumnStatsGrounding extends AbstractGrounding {
  constructor(config: ColumnStatsGroundingConfig = {}) {
    super('columnStats', 'column_stats');
  }

  /**
   * Collect min/max/nullFraction statistics for a column.
   * Return undefined to skip this column.
   */
  protected abstract collectStats(
    tableName: string,
    column: Column,
  ): Promise<ColumnStats | undefined>;

  /**
   * Execute the grounding process.
   * Annotates columns in ctx.tables and ctx.views with statistics.
   */
  async execute(ctx: GroundingContext): Promise<void> {
    // Process both tables and views
    const allContainers: ColumnContainer[] = [...ctx.tables, ...ctx.views];
    const total = allContainers.length;
    for (let i = 0; i < allContainers.length; i++) {
      const container = allContainers[i];
      ctx.onProgress?.({
        type: 'phase:progress',
        phase: 'column_stats',
        table: container.name,
        message: `Collecting stats for ${container.name}...`,
        current: i + 1,
        total,
      });
      for (const column of container.columns) {
        // Collect min/max/nullFraction
        try {
          const stats = await this.collectStats(container.name, column);
          if (stats) {
            column.stats = stats;
          }
        } catch (error) {
          // Skip on error
          console.warn(
            'Error collecting stats for',
            container.name,
            column.name,
            error,
          );
        }
      }
    }
  }
}
