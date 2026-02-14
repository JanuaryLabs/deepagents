import { type Adapter } from '../adapter.ts';
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
import { BigQuery } from './bigquery.ts';
import { BigQueryConstraintGrounding } from './constraint.bigquery.grounding.ts';
import { BigQueryIndexesGrounding } from './indexes.bigquery.grounding.ts';
import { BigQueryInfoGrounding } from './info.bigquery.grounding.ts';
import { BigQueryRowCountGrounding } from './row-count.bigquery.grounding.ts';
import { BigQueryTableGrounding } from './table.bigquery.grounding.ts';
import { BigQueryViewGrounding } from './view.bigquery.grounding.ts';

export * from './bigquery.ts';

export function tables(config: TableGroundingConfig = {}) {
  return (adapter: Adapter) =>
    new BigQueryTableGrounding(adapter as unknown as BigQuery, config);
}

export function info(config: InfoGroundingConfig = {}) {
  return (adapter: Adapter) => new BigQueryInfoGrounding(adapter as BigQuery);
}

export function views(config: ViewGroundingConfig = {}) {
  return (adapter: Adapter) => new BigQueryViewGrounding(adapter, config);
}

export function indexes(config: IndexesGroundingConfig = {}) {
  return (adapter: Adapter) => new BigQueryIndexesGrounding(adapter, config);
}

export function rowCount(config: RowCountGroundingConfig = {}) {
  return (adapter: Adapter) => new BigQueryRowCountGrounding(adapter, config);
}

export function constraints(config: ConstraintGroundingConfig = {}) {
  return (adapter: Adapter) =>
    new BigQueryConstraintGrounding(adapter as unknown as BigQuery, config);
}

export function report(config: ReportGroundingConfig = {}) {
  return (adapter: Adapter) => new ReportGrounding(adapter, config);
}

export default {
  tables,
  info,
  views,
  indexes,
  rowCount,
  constraints,
  report,
  BigQuery,
};
