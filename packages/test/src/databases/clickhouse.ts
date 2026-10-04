import { timebox } from '../async/timebox.ts';
import type { Container } from '../docker/container.ts';
import { Docker } from '../docker/docker.ts';

/** Each start owns a dedicated ClickHouse server and its disposable container. */
export class ClickHouse {
  readonly #docker = new Docker();
  readonly #image: string;

  constructor({ image }: { image: string }) {
    this.#image = image;
  }

  start(): Promise<Container> {
    return this.#docker.start({
      image: this.#image,
      internalPort: 8123,
      memory: '2g',
      env: { CLICKHOUSE_SKIP_USER_SETUP: '1' },
      healthy: ({ exec }) =>
        timebox(() => exec(['clickhouse-client', '--query', 'SELECT 1']), {
          maxRetryTime: 60_000,
        }),
    });
  }
}
