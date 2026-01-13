import type { Table, TableConstraint } from '../adapter.ts';
import { AbstractGrounding } from './abstract.grounding.ts';
import type { Column, ColumnContainer, GroundingContext } from './context.ts';

export type { Column, ColumnContainer };

/**
 * Result of column value detection.
 */
export type ColumnValuesResult = {
  kind: 'Enum' | 'LowCardinality';
  values: string[];
};

/**
 * Configuration for ColumnValuesGrounding.
 */
export interface ColumnValuesGroundingConfig {
  /** Maximum number of distinct values to consider low cardinality (default: 20) */
  lowCardinalityLimit?: number;
}

/**
 * Abstract base class for column values grounding.
 *
 * Discovers possible values for columns from three sources (in priority order):
 * 1. Native ENUM types (PostgreSQL, MySQL) → kind: 'Enum'
 * 2. CHECK constraints with IN clauses → kind: 'Enum'
 * 3. Low cardinality data scan → kind: 'LowCardinality'
 *
 * Subclasses implement database-specific hooks:
 * - `collectEnumValues()` - get values for native ENUM columns
 * - `collectLowCardinality()` - collect distinct values via data scan
 */
export abstract class ColumnValuesGrounding extends AbstractGrounding {
  protected lowCardinalityLimit: number;

  constructor(config: ColumnValuesGroundingConfig = {}) {
    super('columnValues');
    this.lowCardinalityLimit = config.lowCardinalityLimit ?? 20;
  }

  /**
   * Get values for native ENUM type columns.
   * Return undefined if column is not an ENUM type.
   * Default implementation returns undefined (no native ENUM support).
   */
  protected async collectEnumValues(
    _tableName: string,
    _column: Column,
  ): Promise<string[] | undefined> {
    return undefined;
  }

  /**
   * Collect distinct values for low cardinality columns via data scan.
   * Return undefined if column has too many distinct values.
   */
  protected abstract collectLowCardinality(
    tableName: string,
    column: Column,
  ): Promise<string[] | undefined>;

  /**
   * Parse CHECK constraint for enum-like IN clause.
   * Extracts values from patterns like:
   * - CHECK (status IN ('active', 'inactive'))
   * - CHECK ((status)::text = ANY (ARRAY['a'::text, 'b'::text]))
   * - CHECK (status = 'active' OR status = 'inactive')
   */
  protected parseCheckConstraint(
    constraint: TableConstraint,
    columnName: string,
  ): string[] | undefined {
    if (constraint.type !== 'CHECK' || !constraint.definition) {
      return undefined;
    }

    // Check if constraint applies to this column
    if (constraint.columns && !constraint.columns.includes(columnName)) {
      return undefined;
    }

    const def = constraint.definition;
    const escapedCol = this.escapeRegex(columnName);

    // Column pattern: matches column name with optional parens and type cast
    // e.g., "status", "(status)", "((status)::text)"
    const colPattern = `(?:\\(?\\(?${escapedCol}\\)?(?:::(?:text|varchar|character varying))?\\)?)`;

    // Pattern 1: column IN ('val1', 'val2', ...)
    const inMatch = def.match(
      new RegExp(`${colPattern}\\s+IN\\s*\\(([^)]+)\\)`, 'i'),
    );
    if (inMatch) {
      return this.extractStringValues(inMatch[1]);
    }

    // Pattern 2: PostgreSQL ANY(ARRAY[...])
    const anyMatch = def.match(
      new RegExp(
        `${colPattern}\\s*=\\s*ANY\\s*\\(\\s*(?:ARRAY)?\\s*\\[([^\\]]+)\\]`,
        'i',
      ),
    );
    if (anyMatch) {
      return this.extractStringValues(anyMatch[1]);
    }

    // Pattern 3: column = 'val1' OR column = 'val2' ...
    const orPattern = new RegExp(
      `\\b${this.escapeRegex(columnName)}\\b\\s*=\\s*'([^']*)'`,
      'gi',
    );
    const orMatches = [...def.matchAll(orPattern)];
    if (orMatches.length >= 2) {
      return orMatches.map((m) => m[1]);
    }

    return undefined;
  }

  /**
   * Extract string values from a comma-separated list.
   */
  private extractStringValues(input: string): string[] | undefined {
    const values: string[] = [];
    // Match quoted strings: 'value' or 'value'::type
    const matches = input.matchAll(/'([^']*)'/g);
    for (const match of matches) {
      values.push(match[1]);
    }
    return values.length > 0 ? values : undefined;
  }

  /**
   * Escape special regex characters in a string.
   */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Get the table from context by name.
   */
  private getTable(ctx: GroundingContext, name: string): Table | undefined {
    return ctx.tables.find((t) => t.name === name);
  }

  /**
   * Execute the grounding process.
   * Annotates columns in ctx.tables and ctx.views with values.
   */
  async execute(ctx: GroundingContext): Promise<void> {
    // Process both tables and views
    const allContainers: ColumnContainer[] = [...ctx.tables, ...ctx.views];

    for (const container of allContainers) {
      const table = this.getTable(ctx, container.name);

      for (const column of container.columns) {
        try {
          const result = await this.resolveColumnValues(
            container.name,
            column,
            table?.constraints,
          );
          if (result) {
            column.kind = result.kind;
            column.values = result.values;
          }
        } catch (error) {
          console.warn(
            'Error collecting column values for',
            container.name,
            column.name,
            error,
          );
        }
      }
    }
  }

  /**
   * Resolve column values from all sources in priority order.
   */
  private async resolveColumnValues(
    tableName: string,
    column: Column,
    constraints?: TableConstraint[],
  ): Promise<ColumnValuesResult | undefined> {
    // Priority 1: Native ENUM type
    const enumValues = await this.collectEnumValues(tableName, column);
    if (enumValues?.length) {
      return { kind: 'Enum', values: enumValues };
    }

    // Priority 2: CHECK constraint with IN clause
    if (constraints) {
      for (const constraint of constraints) {
        const checkValues = this.parseCheckConstraint(constraint, column.name);
        if (checkValues?.length) {
          return { kind: 'Enum', values: checkValues };
        }
      }
    }

    // Priority 3: Low cardinality data scan
    const lowCardValues = await this.collectLowCardinality(tableName, column);
    if (lowCardValues?.length) {
      return { kind: 'LowCardinality', values: lowCardValues };
    }

    return undefined;
  }
}
