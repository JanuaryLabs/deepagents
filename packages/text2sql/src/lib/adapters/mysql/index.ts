import { type Adapter } from '../adapter.ts';
import { type ColumnStatsGroundingConfig } from '../groundings/column-stats.grounding.ts';
import { type ColumnValuesGroundingConfig } from '../groundings/column-values.grounding.ts';
import { type ConstraintGroundingConfig } from '../groundings/constraint.grounding.ts';
import { type IndexesGroundingConfig } from '../groundings/indexes.grounding.ts';
import { type InfoGroundingConfig } from '../groundings/info.grounding.ts';
import {
  ReportGrounding,
  type ReportGroundingConfig,
} from '../groundings/report.grounding.ts';
import { type RowCountGroundingConfig } from '../groundings/row-count.grounding.ts';
import { type TableGroundingConfig } from '../groundings/table.grounding.ts';
import type { ViewGroundingConfig } from '../groundings/view.grounding.ts';
import { MysqlColumnStatsGrounding } from './column-stats.mysql.grounding.ts';
import { MysqlColumnValuesGrounding } from './column-values.mysql.grounding.ts';
import { MysqlConstraintGrounding } from './constraint.mysql.grounding.ts';
import { MysqlIndexesGrounding } from './indexes.mysql.grounding.ts';
import { MysqlInfoGrounding } from './info.mysql.grounding.ts';
import { Mariadb, Mysql } from './mysql.ts';
import { MysqlRowCountGrounding } from './row-count.mysql.grounding.ts';
import { MysqlTableGrounding } from './table.mysql.grounding.ts';
import { MysqlViewGrounding } from './view.mysql.grounding.ts';

export * from './mysql.ts';

export function tables(config: TableGroundingConfig = {}) {
  return (adapter: Adapter) => new MysqlTableGrounding(adapter, config);
}

export function info(config: InfoGroundingConfig = {}) {
  return (adapter: Adapter) => new MysqlInfoGrounding(adapter, config);
}

export function views(config: ViewGroundingConfig = {}) {
  return (adapter: Adapter) => {
    return new MysqlViewGrounding(adapter, config);
  };
}

export function columnStats(config: ColumnStatsGroundingConfig = {}) {
  return (adapter: Adapter) => {
    return new MysqlColumnStatsGrounding(adapter, config);
  };
}

export function columnValues(config: ColumnValuesGroundingConfig = {}) {
  return (adapter: Adapter) => {
    return new MysqlColumnValuesGrounding(adapter, config);
  };
}

export function indexes(config: IndexesGroundingConfig = {}) {
  return (adapter: Adapter) => {
    return new MysqlIndexesGrounding(adapter, config);
  };
}

export function rowCount(config: RowCountGroundingConfig = {}) {
  return (adapter: Adapter) => {
    return new MysqlRowCountGrounding(adapter, config);
  };
}

export function constraints(config: ConstraintGroundingConfig = {}) {
  return (adapter: Adapter) => {
    return new MysqlConstraintGrounding(adapter, config);
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
  indexes,
  rowCount,
  constraints,
  report,
  Mysql,
  Mariadb,
};
