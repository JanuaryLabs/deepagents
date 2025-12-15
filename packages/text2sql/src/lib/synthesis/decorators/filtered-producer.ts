import { type ExtractedPair, PairProducer } from '../types.ts';

export interface FilteredProducerOptions {
  successOnly?: boolean;
  tables?: string[];
  filter?: (pair: ExtractedPair) => boolean;
}

/**
 * FilteredProducer - Filter pairs from another producer.
 *
 * Wraps another PairProducer and filters the output based on criteria.
 */
export class FilteredProducer extends PairProducer {
  /**
   * @param producer - Source producer to filter
   * @param options - Filter configuration
   */
  constructor(
    private producer: PairProducer,
    private options: FilteredProducerOptions = {},
  ) {
    super();
  }

  /**
   * Produces pairs filtered by success status, table usage, and custom predicates.
   * @returns Pairs matching all configured filter criteria
   */
  async *produce(): AsyncGenerator<ExtractedPair[]> {
    for await (const chunk of this.producer.produce()) {
      const filtered = chunk.filter((pair) => {
        if (this.options.successOnly !== false && !pair.success) {
          return false;
        }

        if (this.options.tables?.length) {
          const sqlLower = pair.sql.toLowerCase();
          const hasTable = this.options.tables.some((t) =>
            sqlLower.includes(t.toLowerCase()),
          );
          if (!hasTable) return false;
        }

        if (this.options.filter && !this.options.filter(pair)) {
          return false;
        }

        return true;
      });

      if (filtered.length) {
        yield filtered;
      }
    }
  }
}
