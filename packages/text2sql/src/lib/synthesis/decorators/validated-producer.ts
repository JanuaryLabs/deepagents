/**
 * ValidatedProducer - Validate SQL from another producer.
 *
 * Wraps another PairProducer and validates each SQL query,
 * optionally executing to attach results.
 */
import type { Adapter } from '../../adapters/adapter.ts';
import type { ExtractedPair, PairProducer } from '../types.ts';

export interface ValidatedProducerOptions {
  /** Execute queries to get row counts (default: false) */
  execute?: boolean;
  /** Remove invalid pairs (default: false, just marks success=false) */
  removeInvalid?: boolean;
}

export interface ValidatedPair extends ExtractedPair {
  /** Number of rows returned (if executed) */
  rowCount?: number;
  /** Validation error message (if failed) */
  error?: string;
}

export class ValidatedProducer implements PairProducer {
  constructor(
    private producer: PairProducer,
    private adapter: Adapter,
    private options: ValidatedProducerOptions = {},
  ) {}

  async produce(): Promise<ValidatedPair[]> {
    const pairs = await this.producer.produce();
    const validated: ValidatedPair[] = [];

    for (const pair of pairs) {
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
          // Execution failed, but validation passed
        }
      }

      validated.push({
        ...pair,
        success: true,
        rowCount,
      });
    }

    return validated;
  }
}
