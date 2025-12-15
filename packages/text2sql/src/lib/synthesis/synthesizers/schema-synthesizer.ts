import pLimit from 'p-limit';

import type { AgentModel } from '@deepagents/agent';

import type { Adapter } from '../../adapters/adapter.ts';
import {
  type QuestionComplexity,
  generateQuestions,
} from '../../agents/question.agent.ts';
import { toSql } from '../../agents/sql.agent.ts';
import type { Teachables } from '../../teach/teachables.ts';
import { type ExtractedPair, PairProducer } from '../types.ts';
import type { Persona } from './persona-generator.ts';

export interface SchemaSynthesizerOptions {
  count: number;
  complexity?: QuestionComplexity | QuestionComplexity[];
  personas?: Persona[];
  teachings?: Teachables[];
  model?: AgentModel;
  concurrency?: number;
}
/**
 * SchemaSynthesizer - Generate pairs from database schema.
 *
 * Fully synthetic: generates natural language questions at specified
 * complexity levels and personas, then generates SQL for each question.
 * Iterates through all persona × complexity combinations.
 */
export class SchemaSynthesizer extends PairProducer {
  #complexities: QuestionComplexity[] = [];
  #personas: (Persona | undefined)[] = [];
  #limit: ReturnType<typeof pLimit>;

  /**
   * @param adapter - Database adapter for schema introspection and SQL validation
   * @param options - Synthesis configuration including count, complexity, and concurrency
   */
  constructor(
    private adapter: Adapter,
    private options: SchemaSynthesizerOptions,
  ) {
    super();
    this.#complexities = Array.isArray(this.options.complexity)
      ? this.options.complexity
      : [this.options.complexity ?? 'medium'];

    this.#personas = this.options.personas ?? [undefined];
    this.#limit = pLimit(this.options.concurrency ?? 5);
  }

  /**
   * Generates question-SQL pairs by iterating through all persona × complexity combinations.
   * Uses parallel processing bounded by the configured concurrency limit.
   * Yields results as each combination completes (streaming pattern).
   * @returns Generated pairs from all combinations
   */
  async *produce(): AsyncGenerator<ExtractedPair[]> {
    const introspection = await this.adapter.introspect();

    const combinations = this.#personas.flatMap((persona) =>
      this.#complexities.map((complexity) => ({ persona, complexity })),
    );

    // Process each combination and yield immediately as it completes
    // pLimit handles concurrency - no need to create all promises upfront
    for (const { persona, complexity } of combinations) {
      const pairs = await this.#processCombination(
        introspection,
        persona,
        complexity,
      );
      if (pairs.length) {
        yield pairs;
      }
    }
  }

  /**
   * Processes a single persona × complexity combination by generating questions
   * and converting each to SQL in parallel.
   */
  async #processCombination(
    introspection: Awaited<ReturnType<Adapter['introspect']>>,
    persona: Persona | undefined,
    complexity: QuestionComplexity,
  ): Promise<ExtractedPair[]> {
    const personaContext = persona
      ? `As ${persona.role}, ${persona.perspective}\n\nGenerate questions this persona would ask.`
      : undefined;

    const prompt = personaContext
      ? `${personaContext}\n\nGenerate ${this.options.count} questions at ${complexity} complexity.`
      : undefined;

    const { questions } = await this.#limit(() =>
      generateQuestions({
        introspection,
        complexity,
        count: this.options.count,
        prompt,
        model: this.options.model,
      }),
    );

    const pairs = await Promise.all(
      questions.map(async (question) => {
        const result = await this.#limit(() =>
          toSql({
            input: question,
            adapter: this.adapter,
            introspection,
            instructions: this.options.teachings ?? [],
            model: this.options.model,
          }),
        );

        return {
          question,
          sql: result.sql,
          success: !result.errors || result.errors.length === 0,
        };
      }),
    );

    return pairs;
  }
}
