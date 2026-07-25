import type { Filter, IntrospectionPhase } from '../adapter.ts';
import type { GroundingContext } from './context.ts';

export type { AdapterInfo, AdapterInfoProvider, Filter } from '../adapter.ts';

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
  phase?: IntrospectionPhase;

  constructor(name: string, phase?: IntrospectionPhase) {
    this.name = name;
    this.phase = phase;
  }

  /**
   * Execute grounding to populate the shared context.
   * Groundings mutate ctx to add their collected data (tables, views, indexes, etc).
   * Fragment generation happens centrally in Adapter after all groundings complete.
   *
   * @param ctx - Shared context for accumulating schema data
   */
  abstract execute(ctx: GroundingContext): Promise<void>;

  /**
   * Populate ctx with the tables/views this grounding makes available for scope
   * resolution. Annotators decorate entities other groundings produced and add
   * no membership, so the default is a no-op; entity-producing groundings
   * override it. This lets scope resolution skip the annotators' metadata scans.
   *
   * @param _ctx - Shared context for accumulating entity membership
   */
  async contributeEntities(_ctx: GroundingContext): Promise<void> {}
}
