import type { ColumnStats, Filter } from '../adapter.ts';
import { AbstractGrounding } from './abstract.grounding.ts';
import type { GroundingContext } from './context.ts';

/**
 * Represents a database view with its metadata.
 */
export interface View {
  name: string;
  schema?: string;
  rawName?: string;
  /** The SQL definition of the view (CREATE VIEW statement or query) */
  definition?: string;
  columns: {
    name: string;
    type: string;
    /** Low cardinality marker */
    kind?: 'LowCardinality';
    /** Distinct values for low cardinality columns */
    values?: string[];
    /** Column statistics (min, max, nullFraction) */
    stats?: ColumnStats;
  }[];
}

/**
 * Configuration for ViewGrounding.
 */
export interface ViewGroundingConfig {
  /** Filter to select views */
  filter?: Filter;
}

/**
 * Abstract base class for view grounding
 *
 * The `execute()` method implements the algorithm that discovers views.
 * Subclasses implement the database-specific hooks:
 * - `getAllViewNames()` - list all views
 * - `getView()` - get view metadata
 */
export abstract class ViewGrounding extends AbstractGrounding {
  #filter?: Filter;

  constructor(config: ViewGroundingConfig = {}) {
    super('view');
    this.#filter = config.filter;
  }

  /** Get all view names in the database */
  protected abstract getAllViewNames(): Promise<string[]>;

  /** Get full view metadata for a single view */
  protected abstract getView(viewName: string): Promise<View>;

  /**
   * Execute the grounding process.
   * Writes discovered views to the context.
   */
  async execute(ctx: GroundingContext): Promise<void> {
    const viewNames = await this.applyFilter();
    const views = await Promise.all(
      viewNames.map((name) => this.getView(name)),
    );
    ctx.views.push(...views);
  }

  /**
   * Apply the filter to get view names.
   * If filter is an explicit array, skip querying all view names.
   */
  protected async applyFilter(): Promise<string[]> {
    const filter = this.#filter;
    if (Array.isArray(filter)) {
      return filter;
    }
    const names = await this.getAllViewNames();
    if (!filter) {
      return names;
    }
    if (filter instanceof RegExp) {
      return names.filter((name) => filter.test(name));
    }
    return names.filter(filter);
  }
}
