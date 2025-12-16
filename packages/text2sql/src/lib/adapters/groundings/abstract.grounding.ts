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

export abstract class AbstractGrounding {
  tag: string;
  constructor(tag: string) {
    this.tag = tag;
  }

  abstract execute(ctx: GroundingContext): Promise<() => string | null>;
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
