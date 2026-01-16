import { groq } from '@ai-sdk/groq';
import dedent from 'dedent';
import pLimit from 'p-limit';
import z from 'zod';

import { type AgentModel } from '@deepagents/agent';
import {
  ContextEngine,
  InMemoryContextStore,
  fragment,
  guardrail,
  persona as personaFragment,
  structuredOutput,
  user,
} from '@deepagents/context';

import { type ExtractedPair, PairProducer } from '../types.ts';
import type { Persona } from './persona-generator.ts';
import { styleInstructions } from './styles.ts';

export interface BreadthEvolverOptions {
  count: number;
  persona?: Persona;
  model?: AgentModel;
  concurrency?: number;
}

const paraphraserOutputSchema = z.object({
  paraphrases: z
    .array(
      z.string().describe('A paraphrased version of the original question'),
    )
    .min(1)
    .describe('List of paraphrased questions that would produce the same SQL'),
});

/**
 * Generates paraphrased versions of a question while preserving SQL equivalence.
 */
async function paraphraseQuestion(params: {
  question: string;
  sql: string;
  count: number;
  persona?: Persona;
  model?: AgentModel;
}): Promise<{ paraphrases: string[] }> {
  const context = new ContextEngine({
    store: new InMemoryContextStore(),
    chatId: `paraphraser-${crypto.randomUUID()}`,
    userId: 'system',
  });

  const personaInstruction = params.persona
    ? dedent`
        <persona role="${params.persona.role}">
          ${params.persona.perspective}

          Paraphrase the question as this persona would naturally ask it.
          Use their vocabulary, priorities, and framing style.
        </persona>
      `
    : '';

  const styleInstruction =
    params.persona?.styles && params.persona.styles.length > 0
      ? dedent`
        <communication_styles>
          Generate paraphrases using these communication styles: ${params.persona.styles.join(', ')}

          Style definitions:
          ${params.persona.styles.map((s) => `- ${s}: ${styleInstructions[s]}`).join('\n')}

          Distribute paraphrases across these styles for variety.
        </communication_styles>
      `
      : '';

  context.set(
    personaFragment({
      name: 'question_paraphraser',
      role: 'You are a linguistic expert specializing in paraphrasing database questions. Your task is to generate alternative phrasings of questions that preserve the exact same semantic meaning - they must all produce the identical SQL query.',
      objective:
        'Generate paraphrased versions of questions that preserve exact semantic meaning and produce identical SQL',
    }),
    fragment('original_question', params.question),
    fragment(
      'reference_sql',
      params.sql,
      'This SQL shows what the question is really asking - all paraphrases must ask for exactly this',
    ),
    ...(personaInstruction ? [fragment('persona', personaInstruction)] : []),
    ...(styleInstruction
      ? [fragment('communication_styles', styleInstruction)]
      : []),
    fragment(
      'task',
      dedent`
        Generate exactly ${params.count} paraphrased versions of the original question.

        Requirements:
        1. Each paraphrase must be semantically equivalent - it should produce the EXACT same SQL
        2. Vary the sentence structure, word choice, and phrasing style
        3. Use natural language without SQL keywords (SELECT, WHERE, JOIN, etc.)
        4. Keep paraphrases realistic - how actual users would ask
        5. Do not add or remove any conditions, filters, or requirements from the original
        ${params.persona?.styles?.length ? '6. Apply the specified communication styles to create diverse phrasings' : ''}
      `,
    ),
    guardrail({ rule: 'NEVER change what data is being requested' }),
    guardrail({
      rule: 'NEVER add filters, aggregations, or conditions not in the original',
    }),
    guardrail({
      rule: 'NEVER remove any specificity from the original question',
    }),
    guardrail({
      rule: 'All paraphrases must be answerable by the exact same SQL query',
    }),
    user(
      `Paraphrase this question ${params.count} times: "${params.question}"`,
    ),
  );

  const paraphraserOutput = structuredOutput({
    model: params.model ?? groq('openai/gpt-oss-20b'),
    context,
    schema: paraphraserOutputSchema,
  });

  return paraphraserOutput.generate();
}
/**
 * BreadthEvolver - Generate paraphrased variations of questions (in-breadth evolution).
 *
 * Takes existing question/SQL pairs and generates variations of the questions
 * while keeping the SQL identical. This creates training data diversity where
 * many different phrasings map to the same SQL query.
 *
 * Based on Microsoft's Evol-Instruct methodology for in-breadth evolution.
 */
export class BreadthEvolver extends PairProducer {
  #limit: ReturnType<typeof pLimit>;

  /**
   * @param source - Source pairs or producer to evolve
   * @param options - Evolution options including count, persona, and concurrency
   */
  constructor(
    private source: PairProducer | ExtractedPair[],
    private options: BreadthEvolverOptions,
  ) {
    super();
    this.#limit = pLimit(this.options.concurrency ?? 4);
  }

  /**
   * Batch pairs within each chunk for concurrent processing.
   * Uses pLimit for concurrency control, yields results per pair after chunk completes.
   */
  async *produce(): AsyncGenerator<ExtractedPair[]> {
    for await (const chunk of this.from(this.source)) {
      const tasks = chunk.map((pair) =>
        this.#limit(async () => {
          const result = await paraphraseQuestion({
            question: pair.question,
            sql: pair.sql,
            count: this.options.count,
            persona: this.options.persona,
            model: this.options.model,
          });

          return result.paraphrases.map((paraphrase: string) => ({
            question: paraphrase,
            sql: pair.sql,
            context: pair.context,
            success: pair.success,
          }));
        }),
      );

      const results = await Promise.all(tasks);
      yield results.flat();
    }
  }
}
