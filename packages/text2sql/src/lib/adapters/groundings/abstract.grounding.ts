import type { Adapter } from '../adapter.ts';
import type { GroundingContext } from './context.ts';

/**
 * Filter type for table names.
 * - string[]: explicit list of table names
 * - RegExp: pattern to match table names
 * - function: predicate to filter table names
 */
export type Filter = string[] | RegExp | ((tableName: string) => boolean);

export interface AdapterInfo {
  dialect: string;
  version?: string;
  database?: string;
  details?: Record<string, unknown>;
}
export type AdapterInfoProvider =
  | AdapterInfo
  | (() => Promise<AdapterInfo> | AdapterInfo);

/**
 * Abstract base class for database schema groundings.
 *
 * Groundings collect schema metadata into the shared GroundingContext.
 * Fragment generation is centralized in Adapter.introspect().
 */
export abstract class AbstractGrounding {
  /**
   * Grounding identifier for debugging/logging.
   */
  name: string;

  constructor(name: string) {
    this.name = name;
  }

  /**
   * Execute grounding to populate the shared context.
   * Groundings mutate ctx to add their collected data (tables, views, indexes, etc).
   * Fragment generation happens centrally in Adapter after all groundings complete.
   *
   * @param ctx - Shared context for accumulating schema data
   */
  abstract execute(ctx: GroundingContext): Promise<void>;
}

class SampleDataGrounding {
  // this will fetch sample data for tables matching the filter
}

class FunctionGrounding {
  #filter: Filter;
  #adapter: Adapter;
  constructor(adapter: Adapter, filter: Filter) {
    this.#filter = filter;
    this.#adapter = adapter;
  }
}
