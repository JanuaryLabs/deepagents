/**
 * FilteredProducer - Filter pairs from another producer.
 *
 * Wraps another PairProducer and filters the output based on criteria.
 */
import type { ExtractedPair, PairProducer } from '../types.ts';

export interface FilteredProducerOptions {
  /** Only include successful queries (default: true) */
  successOnly?: boolean;
  /** Filter by tables used in SQL */
  tables?: string[];
  /** Custom filter function */
  filter?: (pair: ExtractedPair) => boolean;
}

export class FilteredProducer implements PairProducer {
  constructor(
    private producer: PairProducer,
    private options: FilteredProducerOptions = {},
  ) {}

  async produce(): Promise<ExtractedPair[]> {
    const pairs = await this.producer.produce();

    return pairs.filter((pair) => {
      // Success filter
      if (this.options.successOnly !== false && !pair.success) {
        return false;
      }

      // Table filter
      if (this.options.tables?.length) {
        const sqlLower = pair.sql.toLowerCase();
        const hasTable = this.options.tables.some((t) =>
          sqlLower.includes(t.toLowerCase()),
        );
        if (!hasTable) return false;
      }

      // Custom filter
      if (this.options.filter && !this.options.filter(pair)) {
        return false;
      }

      return true;
    });
  }
}
