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
import { SqlServerColumnStatsGrounding } from './column-stats.sqlserver.grounding.ts';
import { SqlServerConstraintGrounding } from './constraint.sqlserver.grounding.ts';
import { SqlServerIndexesGrounding } from './indexes.sqlserver.grounding.ts';
import { SqlServerInfoGrounding } from './info.sqlserver.grounding.ts';
import { SqlServerColumnValuesGrounding } from './column-values.sqlserver.grounding.ts';
import { SqlServerRowCountGrounding } from './row-count.sqlserver.grounding.ts';
import { SqlServer } from './sqlserver.ts';
import { SqlServerTableGrounding } from './table.sqlserver.grounding.ts';
import { SqlServerViewGrounding } from './view.sqlserver.grounding.ts';

export * from './sqlserver.ts';

export function tables(config: TableGroundingConfig = {}) {
  return (adapter: Adapter) => new SqlServerTableGrounding(adapter, config);
}

export function info(config: InfoGroundingConfig = {}) {
  return (adapter: Adapter) => new SqlServerInfoGrounding(adapter, config);
}

export function views(config: ViewGroundingConfig = {}) {
  return (adapter: Adapter) => {
    return new SqlServerViewGrounding(adapter, config);
  };
}

export function columnStats(config: ColumnStatsGroundingConfig = {}) {
  return (adapter: Adapter) => {
    return new SqlServerColumnStatsGrounding(adapter, config);
  };
}

export function columnValues(config: ColumnValuesGroundingConfig = {}) {
  return (adapter: Adapter) => {
    return new SqlServerColumnValuesGrounding(adapter, config);
  };
}

/** @deprecated Use columnValues() instead */
export const lowCardinality = columnValues;

export function indexes(config: IndexesGroundingConfig = {}) {
  return (adapter: Adapter) => {
    return new SqlServerIndexesGrounding(adapter, config);
  };
}

export function rowCount(config: RowCountGroundingConfig = {}) {
  return (adapter: Adapter) => {
    return new SqlServerRowCountGrounding(adapter, config);
  };
}

export function constraints(config: ConstraintGroundingConfig = {}) {
  return (adapter: Adapter) => {
    return new SqlServerConstraintGrounding(adapter, config);
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
  SqlServer,
};
