import { groundingFor } from '../adapter.ts';
import type { ColumnStatsGroundingConfig } from '../groundings/column-stats.grounding.ts';
import type { ColumnValuesGroundingConfig } from '../groundings/column-values.grounding.ts';
import type { ConstraintGroundingConfig } from '../groundings/constraint.grounding.ts';
import type { IndexesGroundingConfig } from '../groundings/indexes.grounding.ts';
import type { InfoGroundingConfig } from '../groundings/info.grounding.ts';
import type { RowCountGroundingConfig } from '../groundings/row-count.grounding.ts';
import type { TableGroundingConfig } from '../groundings/table.grounding.ts';
import type { ViewGroundingConfig } from '../groundings/view.grounding.ts';
import {
  DuckDBColumnStatsGrounding,
  DuckDBColumnValuesGrounding,
  DuckDBConstraintGrounding,
  DuckDBIndexesGrounding,
  DuckDBInfoGrounding,
  DuckDBRowCountGrounding,
  DuckDBTableGrounding,
  DuckDBViewGrounding,
} from './duckdb.groundings.ts';
import { DuckDB } from './duckdb.ts';

export * from './duckdb.ts';
export { DuckDBSqlPolicyAnalyzer } from './duckdb.sql-policy.ts';

export function tables(config: TableGroundingConfig = {}) {
  return groundingFor(
    DuckDB,
    (adapter) => new DuckDBTableGrounding(adapter, config),
  );
}

export function info(config: InfoGroundingConfig = {}) {
  return groundingFor(
    DuckDB,
    (adapter) => new DuckDBInfoGrounding(adapter, config),
  );
}

export function views(config: ViewGroundingConfig = {}) {
  return groundingFor(
    DuckDB,
    (adapter) => new DuckDBViewGrounding(adapter, config),
  );
}

export function constraints(config: ConstraintGroundingConfig = {}) {
  return groundingFor(
    DuckDB,
    (adapter) => new DuckDBConstraintGrounding(adapter, config),
  );
}

export function indexes(config: IndexesGroundingConfig = {}) {
  return groundingFor(
    DuckDB,
    (adapter) => new DuckDBIndexesGrounding(adapter, config),
  );
}

export function rowCount(config: RowCountGroundingConfig = {}) {
  return groundingFor(
    DuckDB,
    (adapter) => new DuckDBRowCountGrounding(adapter, config),
  );
}

export function columnStats(config: ColumnStatsGroundingConfig = {}) {
  return groundingFor(
    DuckDB,
    (adapter) => new DuckDBColumnStatsGrounding(adapter, config),
  );
}

export function columnValues(config: ColumnValuesGroundingConfig = {}) {
  return groundingFor(
    DuckDB,
    (adapter) => new DuckDBColumnValuesGrounding(adapter, config),
  );
}

export default {
  tables,
  info,
  views,
  constraints,
  indexes,
  rowCount,
  columnStats,
  columnValues,
  DuckDB,
};
