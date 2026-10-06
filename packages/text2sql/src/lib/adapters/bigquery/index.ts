import { groundingFor } from '../adapter.ts';
import { type ConstraintGroundingConfig } from '../groundings/constraint.grounding.ts';
import { type IndexesGroundingConfig } from '../groundings/indexes.grounding.ts';
import { type InfoGroundingConfig } from '../groundings/info.grounding.ts';
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
export { BigQuerySqlPolicyAnalyzer } from './bigquery.sql-policy.ts';

export function tables(config: TableGroundingConfig = {}) {
  return groundingFor(
    BigQuery,
    (adapter) => new BigQueryTableGrounding(adapter, config),
  );
}

export function info(config: InfoGroundingConfig = {}) {
  return groundingFor(
    BigQuery,
    (adapter) => new BigQueryInfoGrounding(adapter),
  );
}

export function views(config: ViewGroundingConfig = {}) {
  return groundingFor(
    BigQuery,
    (adapter) => new BigQueryViewGrounding(adapter, config),
  );
}

export function indexes(config: IndexesGroundingConfig = {}) {
  return groundingFor(
    BigQuery,
    (adapter) => new BigQueryIndexesGrounding(adapter, config),
  );
}

export function rowCount(config: RowCountGroundingConfig = {}) {
  return groundingFor(
    BigQuery,
    (adapter) => new BigQueryRowCountGrounding(adapter, config),
  );
}

export function constraints(config: ConstraintGroundingConfig = {}) {
  return groundingFor(
    BigQuery,
    (adapter) => new BigQueryConstraintGrounding(adapter, config),
  );
}

export default {
  tables,
  info,
  views,
  indexes,
  rowCount,
  constraints,
  BigQuery,
};
