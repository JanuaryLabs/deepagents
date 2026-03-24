import type { FragmentObject } from '@deepagents/context';

import type { Adapter } from '../adapter.ts';
import type { GroundingContext } from './context.ts';

/**
 * Filter type for table names.
 * - string[]: explicit list of table names
 * - RegExp: pattern to match table names
 * - function: predicate to filter table names
 */
export type Filter = string[] | RegExp | ((tableName: string) => boolean);

/**
 * Per-entity column filter.
 * Maps entity name (table or view) to a Filter that selects which columns to keep.
 * Entities not listed in the record keep all their columns.
 */
export type ColumnsFilter = Record<string, Filter>;

/**
 * Filter a columns array using a Filter.
 * Keeps columns whose name matches the filter.
 */
export function filterColumns<T extends { name: string }>(
  columns: T[],
  filter: Filter,
): T[] {
  if (Array.isArray(filter)) {
    return columns.filter((col) => filter.includes(col.name));
  }
  if (filter instanceof RegExp) {
    return columns.filter((col) => filter.test(col.name));
  }
  return columns.filter((col) => filter(col.name));
}

/**
 * Apply per-entity column filtering.
 * Returns the entity unchanged if no filter matches its name.
 */
export function applyColumnFilter<
  T extends { name: string; columns: { name: string }[] },
>(entity: T, columnsConfig?: ColumnsFilter): T {
  if (!columnsConfig) return entity;
  const filter = columnsConfig[entity.name];
  if (!filter) return entity;
  return { ...entity, columns: filterColumns(entity.columns, filter) } as T;
}

export interface AdapterInfo {
  dialect: string;
  version?: string;
  database?: string;
  details?: FragmentObject;
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
