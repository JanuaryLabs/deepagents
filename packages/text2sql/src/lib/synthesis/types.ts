/**
 * A question/SQL pair extracted or synthesized for training data.
 */
export interface ExtractedPair {
  question: string;
  sql: string;
  context?: string[];
  success: boolean;
}

/**
 * Interface for all pair producers (extractors and synthesizers).
 * Implementations encapsulate their specific inputs and logic.
 */
export abstract class PairProducer<T extends ExtractedPair = ExtractedPair> {
  /**
   * Produce question/SQL pairs.
   */
  abstract produce(): AsyncGenerator<T[], void, unknown>;

  protected from(producer: PairProducer<ExtractedPair> | ExtractedPair[]) {
    return Array.isArray(producer)
      ? (async function* (pairs: ExtractedPair[]) {
          yield pairs;
        })(producer)
      : producer.produce();
  }
}

/**
 * Entry point for producing pairs from any source.
 */
export async function toPairs<T extends ExtractedPair>(
  producer: PairProducer<T>,
): Promise<T[]> {
  const pairs: T[] = [];
  for await (const chunk of producer.produce()) {
    pairs.push(...chunk);
  }
  return pairs;
}
