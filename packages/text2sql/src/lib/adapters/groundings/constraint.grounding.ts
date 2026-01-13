import type { TableConstraint } from '../adapter.ts';
import { AbstractGrounding } from './abstract.grounding.ts';
import type { GroundingContext } from './context.ts';

/**
 * Configuration for ConstraintGrounding.
 */
export interface ConstraintGroundingConfig {
  // Future: filter which tables/constraint types to collect
}

/**
 * Abstract base class for constraint grounding.
 *
 * Reads tables from the context and annotates them with constraints
 * (CHECK, UNIQUE, NOT_NULL, DEFAULT).
 * This grounding must run AFTER TableGrounding since it reads from ctx.tables.
 *
 * Subclasses implement the database-specific hook:
 * - `getConstraints()` - fetch constraints for a table
 */
export abstract class ConstraintGrounding extends AbstractGrounding {
  constructor(config: ConstraintGroundingConfig = {}) {
    super('constraint');
  }

  /**
   * Fetch constraints for a specific table.
   */
  protected abstract getConstraints(
    tableName: string,
  ): Promise<TableConstraint[]>;

  /**
   * Execute the grounding process.
   * Annotates tables in ctx.tables with their constraints.
   */
  async execute(ctx: GroundingContext): Promise<void> {
    for (const table of ctx.tables) {
      try {
        table.constraints = await this.getConstraints(table.name);
      } catch (error) {
        // Skip on error - table might not exist or be inaccessible
        console.warn('Error collecting constraints for', table.name, error);
      }
    }
  }
}
