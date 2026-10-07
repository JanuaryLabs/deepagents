import { groq } from '@ai-sdk/groq';
import dedent from 'dedent';
import z from 'zod';

import { type AgentModel } from '@deepagents/agent';
import {
  ContextEngine,
  type ContextFragment,
  InMemoryContextStore,
  XmlRenderer,
  fragment,
  guardrail,
  persona as personaFragment,
  structuredOutput,
  user,
} from '@deepagents/context';

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

const outputSchema = z.object({
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
          .array(z.enum(ALL_STYLES))
          .min(1)
          .max(3)
          .describe(
            'Typical communication styles for this persona (1-3 styles)',
          ),
      }),
    )
    .min(1)
    .describe('List of personas who would query this database'),
});

/**
 * Generate personas by analyzing database schema.
 * Analyzes the schema to infer who would query this database and what
 * they care about. Generated personas can be used with BreadthEvolver
 * to create diverse question paraphrases from different perspectives.
 *
 * @param schemaFragments - Schema fragments from adapter.introspect()
 * @param options - Generation options including count and model
 * @returns Array of personas with roles and perspectives
 */
export async function generatePersonas(
  schemaFragments: ContextFragment[],
  options?: PersonaGeneratorOptions,
): Promise<Persona[]> {
  const schema = new XmlRenderer().render(schemaFragments);
  const count = options?.count ?? 5;

  const context = new ContextEngine({
    store: new InMemoryContextStore(),
    chatId: `persona-gen-${crypto.randomUUID()}`,
    userId: 'system',
  });

  context.set(
    personaFragment({
      name: 'persona_generator',
      role: 'You are an expert at understanding database schemas and inferring who would use them.',
      objective:
        'Generate realistic personas representing users who would query this database',
    }),
    fragment('database_schema', schema),
    fragment(
      'task',
      dedent`
        Analyze the database schema and generate realistic personas representing
        the different types of users who would query this database.

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
      `,
    ),
    fragment(
      'example',
      dedent`
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
      `,
    ),
    guardrail({
      rule: 'Only generate personas relevant to the actual schema provided',
    }),
    guardrail({
      rule: 'Do not invent tables or data that do not exist in the schema',
    }),
    guardrail({
      rule: 'Ensure perspectives are specific to the domain, not generic',
    }),
    user(
      `Generate exactly ${count} distinct personas who would query this database.`,
    ),
  );

  const personaOutput = structuredOutput({
    model: options?.model ?? groq('openai/gpt-oss-20b'),
    context,
    schema: outputSchema,
  });

  const output = await personaOutput.generate();
  return output.personas;
}
