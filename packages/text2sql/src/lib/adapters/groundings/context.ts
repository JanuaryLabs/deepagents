import type {
  AdapterInfo,
  ColumnStats,
  OnProgress,
  Relationship,
  Table,
} from '../adapter.ts';
import type { View } from './view.grounding.ts';

/**
 * Column type for grounding operations.
 * Common interface between Table.columns and View.columns.
 */
export interface Column {
  name: string;
  type: string;
  kind?: 'LowCardinality' | 'Enum';
  values?: string[];
  stats?: ColumnStats;
}

/**
 * Entity with columns (Table or View).
 */
export interface ColumnContainer {
  name: string;
  columns: Column[];
}

/**
 * Shared context object passed to all groundings.
 * Groundings read from and write to this context.
 */
export interface GroundingContext {
  /** Tables discovered by TableGrounding */
  tables: Table[];

  /** Views discovered by ViewGrounding */
  views: View[];

  /** Relationships discovered by TableGrounding */
  relationships: Relationship[];

  /** Database info collected by InfoGrounding */
  info?: AdapterInfo;

  /** Shared cache for cross-grounding deduplication. Keyed by `type:key`. */
  cache: Map<string, unknown>;

  /** Optional progress sink for long-running introspection work. */
  onProgress?: OnProgress;
}

/**
 * Create a new empty grounding context.
 */
export function createGroundingContext(
  options: { onProgress?: OnProgress } = {},
): GroundingContext {
  return {
    tables: [],
    views: [],
    relationships: [],
    info: undefined,
    cache: new Map(),
    onProgress: options.onProgress,
  };
}
