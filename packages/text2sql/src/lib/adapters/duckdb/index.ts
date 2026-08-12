import type { Adapter } from '../adapter.ts';
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
  return (adapter: Adapter) =>
    new DuckDBTableGrounding(adapter as DuckDB, config);
}

export function info(config: InfoGroundingConfig = {}) {
  return (adapter: Adapter) =>
    new DuckDBInfoGrounding(adapter as DuckDB, config);
}

export function views(config: ViewGroundingConfig = {}) {
  return (adapter: Adapter) =>
    new DuckDBViewGrounding(adapter as DuckDB, config);
}

export function constraints(config: ConstraintGroundingConfig = {}) {
  return (adapter: Adapter) =>
    new DuckDBConstraintGrounding(adapter as DuckDB, config);
}

export function indexes(config: IndexesGroundingConfig = {}) {
  return (adapter: Adapter) =>
    new DuckDBIndexesGrounding(adapter as DuckDB, config);
}

export function rowCount(config: RowCountGroundingConfig = {}) {
  return (adapter: Adapter) =>
    new DuckDBRowCountGrounding(adapter as DuckDB, config);
}

export function columnStats(config: ColumnStatsGroundingConfig = {}) {
  return (adapter: Adapter) =>
    new DuckDBColumnStatsGrounding(adapter as DuckDB, config);
}

export function columnValues(config: ColumnValuesGroundingConfig = {}) {
  return (adapter: Adapter) =>
    new DuckDBColumnValuesGrounding(adapter as DuckDB, config);
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
