import { groq } from '@ai-sdk/groq';
import { defaultSettingsMiddleware, wrapLanguageModel } from 'ai';
import dedent from 'dedent';
import pLimit from 'p-limit';
import z from 'zod';

import {
  type AgentModel,
  agent,
  generate,
  toOutput,
  user,
} from '@deepagents/agent';

import { type ExtractedPair, PairProducer } from '../types.ts';
import type { Persona } from './persona-generator.ts';
import { styleInstructions } from './styles.ts';

export interface BreadthEvolverOptions {
  count: number;
  persona?: Persona;
  model?: AgentModel;
  concurrency?: number;
}

type ParaphraserState = {
  question: string;
  sql: string;
  count: number;
  persona?: Persona;
};

type ParaphraserOutput = {
  paraphrases: string[];
};

const paraphraserAgent = agent<ParaphraserOutput, ParaphraserState>({
  name: 'question_paraphraser',
  model: wrapLanguageModel({
    model: groq('openai/gpt-oss-20b'),
    middleware: defaultSettingsMiddleware({
      settings: { temperature: 0.9, topP: 0.95, frequencyPenalty: 0.2 },
    }),
  }),
  logging: process.env.AGENT_LOGGING === 'true',
  output: z.object({
    paraphrases: z
      .array(
        z.string().describe('A paraphrased version of the original question'),
      )
      .min(1)
      .describe(
        'List of paraphrased questions that would produce the same SQL',
      ),
  }),
  prompt: (state) => {
    const personaInstruction = state?.persona
      ? dedent`
        <persona role="${state.persona.role}">
          ${state.persona.perspective}

          Paraphrase the question as this persona would naturally ask it.
          Use their vocabulary, priorities, and framing style.
        </persona>
      `
      : '';

    const styleInstruction =
      state?.persona?.styles && state.persona.styles.length > 0
        ? dedent`
        <communication_styles>
          Generate paraphrases using these communication styles: ${state.persona.styles.join(', ')}

          Style definitions:
          ${state.persona.styles.map((s) => `- ${s}: ${styleInstructions[s]}`).join('\n')}

          Distribute paraphrases across these styles for variety.
        </communication_styles>
      `
        : '';

    return dedent`
      <identity>
        You are a linguistic expert specializing in paraphrasing database questions.
        Your task is to generate alternative phrasings of questions that preserve
        the exact same semantic meaning - they must all produce the identical SQL query.
      </identity>

      <original_question>
        ${state?.question}
      </original_question>

      <reference_sql>
        ${state?.sql}
        (This SQL shows what the question is really asking - all paraphrases must ask for exactly this)
      </reference_sql>

      ${personaInstruction}

      ${styleInstruction}

      <task>
        Generate exactly ${state?.count} paraphrased versions of the original question.

        Requirements:
        1. Each paraphrase must be semantically equivalent - it should produce the EXACT same SQL
        2. Vary the sentence structure, word choice, and phrasing style
        3. Use natural language without SQL keywords (SELECT, WHERE, JOIN, etc.)
        4. Keep paraphrases realistic - how actual users would ask
        5. Do not add or remove any conditions, filters, or requirements from the original
        ${state?.persona?.styles?.length ? '6. Apply the specified communication styles to create diverse phrasings' : ''}
      </task>

      <guardrails>
        - NEVER change what data is being requested
        - NEVER add filters, aggregations, or conditions not in the original
        - NEVER remove any specificity from the original question
        - All paraphrases must be answerable by the exact same SQL query
      </guardrails>
    `;
  },
});
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
          const { paraphrases } = await toOutput(
            generate(
              paraphraserAgent.clone({ model: this.options.model }),
              [
                user(
                  `Paraphrase this question ${this.options.count} times: "${pair.question}"`,
                ),
              ],
              {
                question: pair.question,
                sql: pair.sql,
                count: this.options.count,
                persona: this.options.persona,
              },
            ),
          );

          return paraphrases.map((paraphrase) => ({
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
