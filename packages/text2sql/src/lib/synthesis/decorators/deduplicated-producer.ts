import nodeSqlParser from 'node-sql-parser';

import { type ExtractedPair, PairProducer } from '../types.ts';

const { Parser } = nodeSqlParser;
const parser = new Parser();

export interface DeduplicatedProducerOptions {
  strategy?: 'exact' | 'sql-only' | 'question-only';
  dialect?: string;
}

/**
 * DeduplicatedProducer - Remove duplicate pairs from another producer.
 *
 * Wraps another PairProducer and removes duplicates based on
 * exact match or semantic similarity.
 */
export class DeduplicatedProducer extends PairProducer {
  /**
   * @param producer - Source producer to deduplicate
   * @param options - Deduplication configuration
   */
  constructor(
    private producer: PairProducer,
    private options: DeduplicatedProducerOptions = {},
  ) {
    super();
  }

  /**
   * Produces pairs with duplicates removed based on the configured strategy.
   * @returns Unique pairs after deduplication
   */
  async *produce(): AsyncGenerator<ExtractedPair[]> {
    const { strategy = 'exact' } = this.options;
    const seen = new Set<string>();

    for await (const chunk of this.producer.produce()) {
      const unique: ExtractedPair[] = [];

      for (const pair of chunk) {
        let key: string;

        switch (strategy) {
          case 'sql-only':
            key = this.normalizeSQL(pair.sql);
            break;
          case 'question-only':
            key = pair.question.toLowerCase().trim();
            break;
          case 'exact':
          default:
            key = `${pair.question.toLowerCase().trim()}|||${this.normalizeSQL(pair.sql)}`;
        }

        if (!seen.has(key)) {
          seen.add(key);
          unique.push(pair);
        }
      }

      if (unique.length) {
        yield unique;
      }
    }
  }

  private normalizeSQL(sql: string): string {
    try {
      const ast = parser.astify(sql, { database: this.options.dialect });
      return parser
        .sqlify(ast, { database: this.options.dialect })
        .toLowerCase();
    } catch {
      return sql.toLowerCase().replace(/\s+/g, ' ').trim();
    }
  }
}
