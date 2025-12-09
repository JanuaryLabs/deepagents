/**
 * DeduplicatedProducer - Remove duplicate pairs from another producer.
 *
 * Wraps another PairProducer and removes duplicates based on
 * exact match or semantic similarity.
 */
import type { ExtractedPair, PairProducer } from '../types.ts';

export interface DeduplicatedProducerOptions {
  /** Deduplication strategy */
  strategy?: 'exact' | 'sql-only' | 'question-only';
}

export class DeduplicatedProducer implements PairProducer {
  constructor(
    private producer: PairProducer,
    private options: DeduplicatedProducerOptions = {},
  ) {}

  async produce(): Promise<ExtractedPair[]> {
    const pairs = await this.producer.produce();
    const { strategy = 'exact' } = this.options;

    const seen = new Set<string>();
    const unique: ExtractedPair[] = [];

    for (const pair of pairs) {
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

    return unique;
  }

  private normalizeSQL(sql: string): string {
    return sql.toLowerCase().replace(/\s+/g, ' ').trim();
  }
}
