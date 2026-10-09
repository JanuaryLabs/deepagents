import nodeSqlParser from 'node-sql-parser';

import { type ExtractedPair, PairProducer } from '../types.ts';

const { Parser } = nodeSqlParser;
const parser = new Parser();

const unqualify = (name: string) => name.split('.').pop()!.toLowerCase();

export interface FilteredProducerOptions {
  successOnly?: boolean;
  tables?: string[];
  dialect?: string;
  filter?: (pair: ExtractedPair) => boolean;
}

/**
 * FilteredProducer - Filter pairs from another producer.
 *
 * Wraps another PairProducer and filters the output based on criteria.
 */
export class FilteredProducer extends PairProducer {
  readonly #producer: PairProducer;
  readonly #options: FilteredProducerOptions;
  readonly #filterNames: Set<string>;

  /**
   * @param producer - Source producer to filter
   * @param options - Filter configuration
   */
  constructor(producer: PairProducer, options: FilteredProducerOptions = {}) {
    super();
    this.#producer = producer;
    this.#options = options;
    this.#filterNames = new Set(options.tables?.map(unqualify));
  }

  /**
   * Produces pairs filtered by success status, table usage, and custom predicates.
   * @returns Pairs matching all configured filter criteria
   */
  async *produce(): AsyncGenerator<ExtractedPair[]> {
    for await (const chunk of this.#producer.produce()) {
      const filtered = chunk.filter((pair) => {
        if (this.#options.successOnly !== false && !pair.success) {
          return false;
        }

        if (this.#options.tables?.length) {
          if (!this.matchesTables(pair.sql, this.#options.tables)) return false;
        }

        if (this.#options.filter && !this.#options.filter(pair)) {
          return false;
        }

        return true;
      });

      if (filtered.length) {
        yield filtered;
      }
    }
  }

  private matchesTables(sql: string, tables: string[]): boolean {
    const filterNames = this.#filterNames;
    try {
      const refs = parser.tableList(sql, {
        database: this.#options.dialect,
      });
      const sqlNames = refs.map((r) => r.split('::').pop()!.toLowerCase());
      return sqlNames.some((t) => filterNames.has(t));
    } catch {
      const sqlLower = sql.toLowerCase();
      return tables.some((t) => sqlLower.includes(t.toLowerCase()));
    }
  }
}
