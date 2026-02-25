import type { AdapterInfo } from '../adapter.ts';
import { InfoGrounding } from '../groundings/info.grounding.ts';
import type { BigQuery } from './bigquery.ts';

export class BigQueryInfoGrounding extends InfoGrounding {
  #adapter: BigQuery;

  constructor(adapter: BigQuery) {
    super();
    this.#adapter = adapter;
  }

  protected override async collectInfo(): Promise<AdapterInfo> {
    const qualifiedTable = this.#adapter.projectId
      ? 'project.dataset.table'
      : 'dataset.table';

    return {
      dialect: 'bigquery',
      database: this.#adapter.projectId,
      details: {
        identifierQuote: '`',
        identifiers: {
          qualifiedTable,
          nestedFieldPath: 'col.path.to.field',
        },
        parameters: {
          positional: '?',
          named: '@name',
        },
      },
    };
  }
}
