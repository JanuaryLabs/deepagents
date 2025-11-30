import { type Adapter } from '../adapter.ts';
import { type ColumnStatsGroundingConfig } from '../groundings/column-stats.grounding.ts';
import { type ConstraintGroundingConfig } from '../groundings/constraint.grounding.ts';
import { type IndexesGroundingConfig } from '../groundings/indexes.grounding.ts';
import { type InfoGroundingConfig } from '../groundings/info.grounding.ts';
import { type LowCardinalityGroundingConfig } from '../groundings/low-cardinality.grounding.ts';
import {
  ReportGrounding,
  type ReportGroundingConfig,
} from '../groundings/report.grounding.ts';
import { type RowCountGroundingConfig } from '../groundings/row-count.grounding.ts';
import { type TableGroundingConfig } from '../groundings/table.grounding.ts';
import type { ViewGroundingConfig } from '../groundings/view.grounding.ts';
import { PostgresColumnStatsGrounding } from './column-stats.postgres.grounding.ts';
import { PostgresConstraintGrounding } from './constraint.postgres.grounding.ts';
import { PostgresIndexesGrounding } from './indexes.postgres.grounding.ts';
import { PostgresInfoGrounding } from './info.postgres.grounding.ts';
import { PostgresLowCardinalityGrounding } from './low-cardinality.postgres.grounding.ts';
import { Postgres } from './postgres.ts';
import { PostgresRowCountGrounding } from './row-count.postgres.grounding.ts';
import { PostgresTableGrounding } from './table.postgres.grounding.ts';
import { PostgresViewGrounding } from './view.postgres.grounding.ts';

export * from './postgres.ts';

export function tables(config: TableGroundingConfig = {}) {
  return (adapter: Adapter) => new PostgresTableGrounding(adapter, config);
}

export function info(config: InfoGroundingConfig = {}) {
  return (adapter: Adapter) => new PostgresInfoGrounding(adapter, config);
}

export function views(config: ViewGroundingConfig = {}) {
  return (adapter: Adapter) => {
    return new PostgresViewGrounding(adapter, config);
  };
}

export function columnStats(config: ColumnStatsGroundingConfig = {}) {
  return (adapter: Adapter) => {
    return new PostgresColumnStatsGrounding(adapter, config);
  };
}

export function lowCardinality(config: LowCardinalityGroundingConfig = {}) {
  return (adapter: Adapter) => {
    return new PostgresLowCardinalityGrounding(adapter, config);
  };
}

export function indexes(config: IndexesGroundingConfig = {}) {
  return (adapter: Adapter) => {
    return new PostgresIndexesGrounding(adapter, config);
  };
}

export function rowCount(config: RowCountGroundingConfig = {}) {
  return (adapter: Adapter) => {
    return new PostgresRowCountGrounding(adapter, config);
  };
}

export function constraints(config: ConstraintGroundingConfig = {}) {
  return (adapter: Adapter) => {
    return new PostgresConstraintGrounding(adapter, config);
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
  lowCardinality,
  indexes,
  rowCount,
  constraints,
  report,
  Postgres,
};
