import { type Adapter } from '../adapter.ts';
import { type ColumnStatsGroundingConfig } from '../groundings/column-stats.grounding.ts';
import { type ConstraintGroundingConfig } from '../groundings/constraint.grounding.ts';
import { type IndexesGroundingConfig } from '../groundings/indexes.grounding.ts';
import { type InfoGroundingConfig } from '../groundings/info.grounding.ts';
import { type ColumnValuesGroundingConfig } from '../groundings/column-values.grounding.ts';
import {
  ReportGrounding,
  type ReportGroundingConfig,
} from '../groundings/report.grounding.ts';
import { type RowCountGroundingConfig } from '../groundings/row-count.grounding.ts';
import { type TableGroundingConfig } from '../groundings/table.grounding.ts';
import type { ViewGroundingConfig } from '../groundings/view.grounding.ts';
import { SqliteColumnStatsGrounding } from './column-stats.sqlite.grounding.ts';
import { SqliteConstraintGrounding } from './constraint.sqlite.grounding.ts';
import { SqliteIndexesGrounding } from './indexes.sqlite.grounding.ts';
import { SqliteInfoGrounding } from './info.sqlite.grounding.ts';
import { SqliteColumnValuesGrounding } from './column-values.sqlite.grounding.ts';
import { SqliteRowCountGrounding } from './row-count.sqlite.grounding.ts';
import { Sqlite } from './sqlite.ts';
import { SqliteTableGrounding } from './table.sqlite.grounding.ts';
import { SqliteViewGrounding } from './view.sqlite.grounding.ts';

export * from './sqlite.ts';

export function tables(config: TableGroundingConfig = {}) {
  return (adapter: Adapter) => new SqliteTableGrounding(adapter, config);
}

export function info(config: InfoGroundingConfig = {}) {
  return (adapter: Adapter) => new SqliteInfoGrounding(adapter, config);
}

export function views(config: ViewGroundingConfig = {}) {
  return (adapter: Adapter) => {
    return new SqliteViewGrounding(adapter, config);
  };
}

export function columnStats(config: ColumnStatsGroundingConfig = {}) {
  return (adapter: Adapter) => {
    return new SqliteColumnStatsGrounding(adapter, config);
  };
}

export function columnValues(config: ColumnValuesGroundingConfig = {}) {
  return (adapter: Adapter) => {
    return new SqliteColumnValuesGrounding(adapter, config);
  };
}

/** @deprecated Use columnValues() instead */
export const lowCardinality = columnValues;

export function indexes(config: IndexesGroundingConfig = {}) {
  return (adapter: Adapter) => {
    return new SqliteIndexesGrounding(adapter, config);
  };
}

export function rowCount(config: RowCountGroundingConfig = {}) {
  return (adapter: Adapter) => {
    return new SqliteRowCountGrounding(adapter, config);
  };
}

export function constraints(config: ConstraintGroundingConfig = {}) {
  return (adapter: Adapter) => {
    return new SqliteConstraintGrounding(adapter, config);
  };
}

export function report(config: ReportGroundingConfig = {}) {
  return (adapter: Adapter) => new ReportGrounding(adapter, config);
}

export default {
  tables,
  info,
  views,
  columnStats,
  columnValues,
  lowCardinality,
  indexes,
  rowCount,
  constraints,
  report,
  Sqlite,
};
