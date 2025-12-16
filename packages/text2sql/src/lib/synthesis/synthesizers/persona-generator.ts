import { groq } from '@ai-sdk/groq';
import { defaultSettingsMiddleware, wrapLanguageModel } from 'ai';
import dedent from 'dedent';
import z from 'zod';

import { type AgentModel, agent, generate, user } from '@deepagents/agent';

import type { Adapter } from '../../adapters/adapter.ts';
import { ALL_STYLES, type NLStyle } from './styles.ts';

export interface Persona {
  role: string;
  perspective: string;
  styles: NLStyle[];
}

export interface PersonaGeneratorOptions {
  count?: number;
  model?: AgentModel;
}

type PersonaGeneratorState = {
  schema: string;
  count: number;
};

type PersonaGeneratorOutput = {
  personas: Persona[];
};

const personaGeneratorAgent = agent<
  PersonaGeneratorOutput,
  PersonaGeneratorState
>({
  name: 'persona_generator',
  model: wrapLanguageModel({
    model: groq('openai/gpt-oss-20b'),
    middleware: defaultSettingsMiddleware({
      settings: { temperature: 0.8, topP: 0.95, presencePenalty: 0.2 },
    }),
  }),
  logging: process.env.AGENT_LOGGING === 'true',
  output: z.object({
    personas: z
      .array(
        z.object({
          role: z.string().describe('The job title or role of this persona'),
          perspective: z
            .string()
            .describe(
              'Rich description of what this persona cares about when querying the database',
            ),
          styles: z
            .array(z.enum(ALL_STYLES as [NLStyle, ...NLStyle[]]))
            .min(1)
            .max(3)
            .describe(
              'Typical communication styles for this persona (1-3 styles)',
            ),
        }),
      )
      .min(1)
      .describe('List of personas who would query this database'),
  }),
  prompt: (state) => {
    return dedent`
      <identity>
        You are an expert at understanding database schemas and inferring who would use them.
        Your task is to analyze a database schema and generate realistic personas representing
        the different types of users who would query this database.
      </identity>

      <database_schema>
        ${state?.schema}
      </database_schema>

      <task>
        Generate exactly ${state?.count} distinct personas who would query this database.

        For each persona, provide:
        1. **role**: Their job title or role (e.g., "Financial Analyst", "Customer Support Rep")
        2. **perspective**: A rich description of what they care about, including:
           - What questions they typically ask
           - What metrics/data points matter to them
           - How they prefer data formatted or presented
           - Their priorities (speed vs accuracy, detail vs summary)
           - Domain-specific concerns relevant to their role
        3. **styles**: 1-3 communication styles typical for this persona. Choose from:
           - formal: Professional business language, complete sentences
           - colloquial: Casual everyday speech, contractions
           - imperative: Commands like "Show me...", "Get...", "List..."
           - interrogative: Questions like "What is...", "How many..."
           - descriptive: Verbose, detailed phrasing
           - concise: Brief, minimal words
           - vague: Ambiguous, hedging language
           - metaphorical: Figurative language, analogies
           - conversational: Chat-like, casual tone

        Requirements:
        - Personas should be realistic for the given schema
        - Each persona should have distinct concerns and priorities
        - Perspectives should be detailed enough to guide question paraphrasing
        - Cover different levels of technical expertise (some technical, some business-focused)
        - Styles should match how this persona would naturally communicate
      </task>

      <example>
        For an e-commerce schema with orders, customers, products tables:

        {
          "role": "Customer Support Rep",
          "perspective": "As customer support, I care about:\\n- Quick lookups by order ID or customer email\\n- Order status and shipping tracking\\n- Return and refund history\\n- Customer contact details and order history\\n- I need fast answers, not complex analysis",
          "styles": ["imperative", "concise"]
        }

        {
          "role": "Inventory Manager",
          "perspective": "As inventory manager, I care about:\\n- Current stock levels and reorder points\\n- Product availability across warehouses\\n- Slow-moving inventory identification\\n- Supplier lead times and pending orders\\n- I need accurate counts, often aggregated by location",
          "styles": ["formal", "interrogative"]
        }
      </example>

      <guardrails>
        - Only generate personas relevant to the actual schema provided
        - Do not invent tables or data that don't exist in the schema
        - Ensure perspectives are specific to the domain, not generic
      </guardrails>
    `;
  },
});
/**
 * PersonaGenerator - Generate relevant personas from database schema.
 *
 * Analyzes the schema to infer who would query this database and what
 * they care about. Generated personas can be used with BreadthEvolver
 * to create diverse question paraphrases from different perspectives.
 */
export class PersonaGenerator {
  /**
   * @param adapter - Database adapter for schema introspection
   * @param options - Generation options including count and model
   */
  constructor(
    private adapter: Adapter,
    private options?: PersonaGeneratorOptions,
  ) {}

  /**
   * Generates personas by analyzing the database schema to infer user types.
   * @returns Array of personas with roles and perspectives
   */
  async generate(): Promise<Persona[]> {
    const schema = await this.adapter.introspect();
    const count = this.options?.count ?? 5;

    const { experimental_output } = await generate(
      personaGeneratorAgent.clone({
        model: this.options?.model,
      }),
      [user(`Generate ${count} personas for this database schema.`)],
      {
        schema,
        count,
      },
    );

    return experimental_output.personas;
  }
}
