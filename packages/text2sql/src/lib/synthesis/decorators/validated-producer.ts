import type { Adapter } from '../../adapters/adapter.ts';
import { type ExtractedPair, PairProducer } from '../types.ts';

export interface ValidatedProducerOptions {
  execute?: boolean;
  removeInvalid?: boolean;
}

export interface ValidatedPair extends ExtractedPair {
  rowCount?: number;
  error?: string;
}
/**
 * ValidatedProducer - Validate SQL from another producer.
 *
 * Wraps another PairProducer and validates each SQL query,
 * optionally executing to attach results.
 */
export class ValidatedProducer extends PairProducer<ValidatedPair> {
  /**
   * @param producer - Source producer to validate
   * @param adapter - Database adapter for SQL validation
   * @param options - Validation configuration
   */
  constructor(
    private producer: PairProducer,
    private adapter: Adapter,
    private options: ValidatedProducerOptions = {},
  ) {
    super();
  }

  /**
   * Produces pairs with SQL validation applied, optionally executing queries.
   * @returns Validated pairs with error/rowCount metadata attached
   */
  async *produce(): AsyncGenerator<ValidatedPair[]> {
    for await (const chunk of this.producer.produce()) {
      const validated: ValidatedPair[] = [];

      for (const pair of chunk) {
        const error = await this.adapter.validate(pair.sql);

        if (error) {
          if (!this.options.removeInvalid) {
            validated.push({
              ...pair,
              success: false,
              error,
            });
          }
          continue;
        }

        let rowCount: number | undefined;
        if (this.options.execute) {
          try {
            const result = await this.adapter.execute(pair.sql);
            rowCount = Array.isArray(result) ? result.length : undefined;
          } catch {
            // no op
          }
        }

        validated.push({
          ...pair,
          success: true,
          rowCount,
        });
      }

      if (validated.length) {
        yield validated;
      }
    }
  }
}
