/**
 * SchemaSynthesizer - Generate pairs from database schema.
 *
 * Fully synthetic: generates natural language questions at specified
 * complexity levels, then generates SQL for each question.
 */
import { generate, user } from '@deepagents/agent';

import type { Adapter } from '../../adapters/adapter.ts';
import {
  type QuestionComplexity,
  questionGeneratorAgent,
} from '../../agents/synthetic/question.agent.ts';
import { toSql } from '../../agents/synthetic/sql.agent.ts';
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
    const introspection = await this.adapter.introspect();
    const pairs: ExtractedPair[] = [];

    // Determine complexities to use
    const complexities = Array.isArray(this.options.complexity)
      ? this.options.complexity
      : [this.options.complexity ?? 'medium'];

    // Calculate questions per complexity level
    const perComplexity = Math.ceil(this.options.count / complexities.length);

    for (const complexity of complexities) {
      // Generate questions using questionGeneratorAgent
      const { experimental_output } = await generate(
        questionGeneratorAgent,
        [user(`Generate ${perComplexity} questions at ${complexity} complexity.`)],
        {
          introspection,
          complexity,
          count: perComplexity,
        },
      );

      const questions = experimental_output.questions;

      // Generate SQL for each question
      for (const question of questions) {
        const result = await toSql({
          input: question,
          adapter: this.adapter,
          introspection,
          instructions: [],
        });

        // Determine success based on validation
        let success = true;
        if (this.options.validateSql !== false) {
          // toSql already validates - check if there were errors
          success = !result.errors || result.errors.length === 0;
        }

        pairs.push({
          question,
          sql: result.sql,
          success,
        });
      }
    }

    return pairs;
  }
}
