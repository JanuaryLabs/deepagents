import {
  BigQuery as BigQueryClient,
  type Dataset,
} from '@google-cloud/bigquery';
import { randomUUID } from 'node:crypto';

export interface BigQueryDataset extends AsyncDisposable {
  dataset: Dataset;
  /** Delete the owned dataset and its contents. */
  cleanup: () => Promise<void>;
}

/** Each acquisition owns an isolated dataset in the configured cloud project. */
export class BigQuery {
  readonly #client: BigQueryClient;
  readonly #location: string;

  constructor({
    projectId,
    location,
  }: {
    projectId: string;
    location: string;
  }) {
    this.#client = new BigQueryClient({ projectId });
    this.#location = location;
  }

  async dataset(): Promise<BigQueryDataset> {
    const [dataset] = await this.#client.createDataset(
      `test_${randomUUID().replaceAll('-', '')}`,
      { location: this.#location },
    );
    const resources = new AsyncDisposableStack();
    resources.defer(async () => {
      await dataset.delete({ force: true });
    });
    const cleanup = () => resources.disposeAsync();

    return { dataset, cleanup, [Symbol.asyncDispose]: cleanup };
  }
}
