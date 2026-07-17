import type { Adapter } from '../adapter.ts';
import type { ConstraintGroundingConfig } from '../groundings/constraint.grounding.ts';
import type { IndexesGroundingConfig } from '../groundings/indexes.grounding.ts';
import type { InfoGroundingConfig } from '../groundings/info.grounding.ts';
import type { RowCountGroundingConfig } from '../groundings/row-count.grounding.ts';
import type { TableGroundingConfig } from '../groundings/table.grounding.ts';
import type { ViewGroundingConfig } from '../groundings/view.grounding.ts';
import { ClickHouse } from './clickhouse.ts';
import { ClickHouseConstraintGrounding } from './constraint.clickhouse.grounding.ts';
import { ClickHouseIndexesGrounding } from './indexes.clickhouse.grounding.ts';
import { ClickHouseInfoGrounding } from './info.clickhouse.grounding.ts';
import { ClickHouseRowCountGrounding } from './row-count.clickhouse.grounding.ts';
import { ClickHouseTableGrounding } from './table.clickhouse.grounding.ts';
import { ClickHouseViewGrounding } from './view.clickhouse.grounding.ts';

export * from './clickhouse.ts';
export { ClickHouseSqlPolicyAnalyzer } from './clickhouse.sql-policy.ts';

export function tables(config: TableGroundingConfig = {}) {
  return (adapter: Adapter) => new ClickHouseTableGrounding(adapter, config);
}

export function views(config: ViewGroundingConfig = {}) {
  return (adapter: Adapter) => new ClickHouseViewGrounding(adapter, config);
}

export function info(config: InfoGroundingConfig = {}) {
  return (adapter: Adapter) => new ClickHouseInfoGrounding(adapter, config);
}

export function indexes(config: IndexesGroundingConfig = {}) {
  return (adapter: Adapter) => new ClickHouseIndexesGrounding(adapter, config);
}

export function rowCount(config: RowCountGroundingConfig = {}) {
  return (adapter: Adapter) => new ClickHouseRowCountGrounding(adapter, config);
}

export function constraints(config: ConstraintGroundingConfig = {}) {
  return (adapter: Adapter) =>
    new ClickHouseConstraintGrounding(adapter, config);
}

export default {
  ClickHouse,
  constraints,
  indexes,
  info,
  rowCount,
  tables,
  views,
};
