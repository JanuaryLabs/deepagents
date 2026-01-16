import { groq } from '@ai-sdk/groq';
import { NoObjectGeneratedError, NoOutputGeneratedError } from 'ai';
import dedent from 'dedent';
import pLimit from 'p-limit';
import pRetry from 'p-retry';
import z from 'zod';

import { type AgentModel } from '@deepagents/agent';
import {
  ContextEngine,
  InMemoryContextStore,
  fragment,
  guardrail,
  persona,
  structuredOutput,
  user,
} from '@deepagents/context';

import type { Adapter } from '../../adapters/adapter.ts';
import { UnanswerableSQLError, toSql } from '../../agents/sql.agent.ts';
import { type ExtractedPair, PairProducer } from '../types.ts';

/**
 * Techniques for evolving questions into more complex versions.
 * Each technique transforms the question in a specific way.
 */
export type DepthTechnique =
  | 'add-aggregation'
  | 'add-filter'
  | 'add-join'
  | 'add-reasoning'
  | 'hypothetical';

const techniqueInstructions: Record<DepthTechnique, string> = {
  'add-aggregation': dedent`
    Add aggregation requirements to the question.
    Transform it to require GROUP BY, COUNT, SUM, AVG, MIN, MAX, or similar operations.
    Examples:
    - "Show orders" → "Show total order count by customer"
    - "List products" → "What is the average price per category?"
    - "Get employees" → "How many employees are in each department?"
  `,
  'add-filter': dedent`
    Add filtering conditions to the question.
    Transform it to require WHERE clauses with specific conditions.
    Examples:
    - "Show orders" → "Show orders from the last 30 days"
    - "List customers" → "List customers who have made more than 5 purchases"
    - "Get products" → "Get products with price above $100"
  `,
  'add-join': dedent`
    Add requirements that need data from related tables.
    Transform it to require JOIN operations between multiple tables.
    Examples:
    - "Show orders" → "Show orders with customer names and addresses"
    - "List products" → "List products with their supplier information"
    - "Get employees" → "Get employees with their department and manager names"
  `,
  'add-reasoning': dedent`
    Add multi-step reasoning requirements.
    Transform it to require logical deduction, comparisons, or derived calculations.
    Examples:
    - "Show orders" → "Which customers have orders above the average order value?"
    - "List products" → "Which products are underperforming compared to their category average?"
    - "Get revenue" → "Which month had the highest growth compared to the previous month?"
  `,
  hypothetical: dedent`
    Add a hypothetical or speculative scenario.
    Transform it to require applying calculations or projections.
    Examples:
    - "Show revenue" → "What would revenue be if we increased all prices by 15%?"
    - "List inventory" → "How many days of stock remain at current sales rate?"
    - "Get costs" → "What would be the impact of a 10% discount on profit margins?"
  `,
};

export interface DepthEvolverOptions {
  techniques?: DepthTechnique[];
  count?: number;
  model?: AgentModel;
  concurrency?: number;
}

const evolverOutputSchema = z.object({
  evolvedQuestion: z
    .string()
    .describe('The evolved, more complex version of the original question'),
});

/**
 * Evolves a simple question into a more complex version using a specific technique.
 */
async function evolveQuestion(params: {
  question: string;
  sql: string;
  schema: string;
  technique: DepthTechnique;
  techniqueInstruction: string;
  model?: AgentModel;
}): Promise<{ evolvedQuestion: string }> {
  const context = new ContextEngine({
    store: new InMemoryContextStore(),
    chatId: `evolver-${crypto.randomUUID()}`,
    userId: 'system',
  });

  context.set(
    persona({
      name: 'question_evolver',
      role: 'You are an expert at evolving simple database questions into more complex ones. Your task is to take a basic question and transform it into a more sophisticated version that requires advanced SQL techniques to answer.',
      objective:
        'Transform simple questions into complex versions requiring advanced SQL techniques',
    }),
    fragment('original_question', params.question),
    fragment(
      'original_sql',
      params.sql,
      '(This shows what the original question required)',
    ),
    fragment('database_schema', params.schema),
    fragment(
      'technique',
      { name: params.technique },
      params.techniqueInstruction,
    ),
    fragment(
      'task',
      dedent`
        Evolve the original question using the "${params.technique}" technique.

        Requirements:
        1. The evolved question must be MORE COMPLEX than the original
        2. Apply the specific technique described above
        3. The evolved question must be answerable using the provided schema
        4. Use natural language - no SQL keywords
        5. Keep the question realistic and practical
        6. The evolved question should build upon the original topic/domain
      `,
    ),
    guardrail({
      rule: 'The evolved question MUST require more complex SQL than the original',
    }),
    guardrail({
      rule: 'Do not ask for data that does not exist in the schema',
    }),
    guardrail({
      rule: 'Keep the question grounded in the same domain as the original',
    }),
    guardrail({ rule: 'Make sure the question is clear and unambiguous' }),
    user(
      `Evolve this question using "${params.technique}": "${params.question}"`,
    ),
  );

  const evolverOutput = structuredOutput({
    model: params.model ?? groq('openai/gpt-oss-20b'),
    context,
    schema: evolverOutputSchema,
  });

  return evolverOutput.generate();
}

const ALL_TECHNIQUES: DepthTechnique[] = [
  'add-aggregation',
  'add-filter',
  'add-join',
  'add-reasoning',
  'hypothetical',
];
/**
 * DepthEvolver - Evolve questions into more complex versions (in-depth evolution).
 *
 * Takes existing question/SQL pairs and evolves them into more complex versions
 * using specific techniques. Both the question AND SQL change - the evolved
 * question requires a more sophisticated query to answer.
 *
 * Based on Microsoft's Evol-Instruct methodology for in-depth evolution.
 */
export class DepthEvolver extends PairProducer {
  #limit: ReturnType<typeof pLimit>;

  /**
   * @param source - Source pairs or producer to evolve
   * @param adapter - Database adapter for SQL generation
   * @param options - Evolution options including techniques, count, and concurrency
   */
  constructor(
    private source: PairProducer | ExtractedPair[],
    private adapter: Adapter,
    private options?: DepthEvolverOptions,
  ) {
    super();
    this.#limit = pLimit(this.options?.concurrency ?? 4);
  }

  /**
   * Yields evolved pairs as each completes (streaming pattern).
   * Removes batch barrier - no longer waits for all evolutions before yielding.
   */
  async *produce(): AsyncGenerator<ExtractedPair[]> {
    // TODO: Update to use fragments and render them
    // const schemaFragments = await this.adapter.introspect();
    // const introspection = new XmlRenderer().render(schemaFragments);
    const introspection = '' as any; // Placeholder - synthesis needs to be updated to use fragments
    const count = this.options?.count ?? 1;
    const techniques = this.options?.techniques ?? ALL_TECHNIQUES;

    let pairIndex = 0;
    for await (const chunk of this.from(this.source)) {
      for (const pair of chunk) {
        const tasks = Array.from({ length: count }, (_, i) => {
          const technique = this.options?.techniques
            ? techniques[i % techniques.length]
            : techniques[(pairIndex * count + i) % techniques.length];
          return this.#limit(() =>
            this.#processTask(pair, technique, introspection),
          );
        });

        const results = await Promise.all(tasks);
        yield results;
        pairIndex++;
      }
    }
  }

  async #processTask(
    pair: ExtractedPair,
    technique: DepthTechnique,
    introspection: string,
  ) {
    const output = await withRetry(() =>
      evolveQuestion({
        question: pair.question,
        sql: pair.sql,
        schema: introspection,
        technique,
        techniqueInstruction: techniqueInstructions[technique],
        model: this.options?.model,
      }),
    );

    const evolvedQuestion = output.evolvedQuestion;
    try {
      // TODO: Update to use schemaFragments instead of introspection string
      const sqlResult = await toSql({
        input: evolvedQuestion,
        adapter: this.adapter,
        schemaFragments: [], // Placeholder - needs to pass actual fragments
        instructions: [],
        model: this.options?.model,
      });

      return {
        question: evolvedQuestion,
        sql: sqlResult.sql,
        context: pair.context,
        success: !sqlResult.errors || sqlResult.errors.length === 0,
      };
    } catch (error) {
      if (UnanswerableSQLError.isInstance(error)) {
        return {
          question: evolvedQuestion,
          sql: '',
          context: pair.context,
          success: false,
          errors: [
            `Cannot answer the question ${evolvedQuestion} because ${error.message}`,
          ],
        };
      }
      throw error;
    }
  }
}

async function withRetry<T>(computation: () => Promise<T>): Promise<T> {
  return pRetry(computation, {
    retries: 3,
    shouldRetry: (context) => {
      console.log({
        NoObjectGeneratedError: NoObjectGeneratedError.isInstance(
          context.error,
        ),
        NoOutputGeneratedError: NoOutputGeneratedError.isInstance(
          context.error,
        ),
      });
      return (
        NoObjectGeneratedError.isInstance(context.error) ||
        NoOutputGeneratedError.isInstance(context.error)
      );
    },
    onFailedAttempt(context) {
      console.log(
        `Attempt ${context.attemptNumber} failed. There are ${context.retriesLeft} retries left.`,
      );
      console.dir(context.error, { depth: null });
    },
  });
}
