/**
 * SchemaSynthesizer - Generate pairs from database schema.
 *
 * Fully synthetic: generates natural language questions at specified
 * complexity levels, then generates SQL for each question.
 */
import type { Adapter } from '../../adapters/adapter.ts';
import type { QuestionComplexity } from '../../agents/synthetic/question.agent.ts';
import type { ExtractedPair, PairProducer } from '../types.ts';

export interface SchemaSynthesizerOptions {
  /** Number of pairs to generate */
  count: number;
  /** Complexity level(s) to generate */
  complexity?: QuestionComplexity | QuestionComplexity[];
  /** Validate generated SQL (default: true) */
  validateSql?: boolean;
}

export class SchemaSynthesizer implements PairProducer {
  constructor(
    private adapter: Adapter,
    private options: SchemaSynthesizerOptions,
  ) {}

  async produce(): Promise<ExtractedPair[]> {
    // TODO: Implement schema-based synthesis
    // 1. Get introspection from adapter
    // 2. Use questionGeneratorAgent to generate questions
    // 3. Use toSql to generate SQL for each question
    // 4. Optionally validate each SQL
    // 5. Return pairs
    throw new Error('Not implemented');
  }
}
