/**
 * Core types for the synthesis module.
 * Used for extracting and generating question/SQL pairs for training data.
 */

/**
 * A question/SQL pair extracted or synthesized for training data.
 */
export interface ExtractedPair {
  /** The natural language question */
  question: string;
  /** The SQL query that answers the question */
  sql: string;
  /** Preceding messages that informed this query (for context-dependent questions) */
  context?: string[];
  /** Whether the query executed successfully */
  success: boolean;
}

/**
 * Interface for all pair producers (extractors and synthesizers).
 * Implementations encapsulate their specific inputs and logic.
 */
export interface PairProducer {
  /**
   * Produce question/SQL pairs.
   */
  produce(): Promise<ExtractedPair[]>;
}

/**
 * Entry point for producing pairs from any source.
 */
export function toPairs(producer: PairProducer): Promise<ExtractedPair[]> {
  return producer.produce();
}
