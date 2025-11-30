import { groq } from '@ai-sdk/groq';
import dedent from 'dedent';
import z from 'zod';

import { agent, thirdPersonPrompt } from '@deepagents/agent';

import type { Introspection } from '../adapters/adapter.ts';
import { type GeneratedTeachable } from '../teach/teachables.ts';

const teachableSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('term'),
    name: z.string(),
    definition: z.string(),
  }),
  z.object({
    type: z.literal('hint'),
    text: z.string(),
  }),
  z.object({
    type: z.literal('guardrail'),
    rule: z.string(),
    reason: z.string().optional(),
    action: z.string().optional(),
  }),
  z.object({
    type: z.literal('explain'),
    concept: z.string(),
    explanation: z.string(),
    therefore: z.string().optional(),
  }),
  z.object({
    type: z.literal('example'),
    question: z.string(),
    sql: z.string(),
    note: z.string().optional(),
  }),
  z.object({
    type: z.literal('clarification'),
    when: z.string(),
    ask: z.string(),
    reason: z.string(),
  }),
  z.object({
    type: z.literal('workflow'),
    task: z.string(),
    steps: z.array(z.string()).min(2),
    triggers: z.array(z.string()).optional(),
    notes: z.string().optional(),
  }),
  z.object({
    type: z.literal('quirk'),
    issue: z.string(),
    workaround: z.string(),
  }),
  z.object({
    type: z.literal('styleGuide'),
    prefer: z.string(),
    never: z.string().optional(),
    always: z.string().optional(),
  }),
  z.object({
    type: z.literal('analogy'),
    concept: z.array(z.string()).min(2),
    relationship: z.string(),
    insight: z.string().optional(),
    therefore: z.string().optional(),
    pitfall: z.string().optional(),
  }),
]) as z.ZodType<GeneratedTeachable>;

export const teachablesAuthorAgent = agent<
  { teachables: GeneratedTeachable[] },
  {
    context?: string;
    adapterInfo?: string;
  }
>({
  name: 'teachables-author',
  model: groq('openai/gpt-oss-20b'),
  output: z.object({
    teachables: z
      .array(teachableSchema)
      .min(3)
      .max(10)
      .describe(
        'A concise, high-value set of teachables grounded in the provided schema.',
      ),
  }),
  prompt: (state) => dedent`
    ${thirdPersonPrompt()}

    <identity>
      You design "teachables" for a Text2SQL system. Teachables become structured XML instructions.
      Choose only high-impact items that improve accuracy, safety, or clarity for this database.
    </identity>


    <teachables_catalog>
      term: name + definition for domain vocabulary.
      hint: behavioral rule/constraint to apply by default.
      guardrail: hard safety/performance boundary with action and optional reason.
      explain: deeper concept metaphor/explanation (+ optional therefore).
      example: question + SQL (+ optional note).
      clarification: when/ask/reason to prompt the user before querying.
      workflow: task + ordered steps (+ optional triggers/notes).
      quirk: data edge case with workaround.
      styleGuide: prefer/never/always guidance for SQL output.
      analogy: comparison of two concepts with relationship (+ optional insight/therefore/pitfall).
    </teachables_catalog>

    <instructions>
      - Ground everything in the provided schema/context; do not invent tables/columns.
      - Prefer guardrails + clarifications for performance, safety, and ambiguity.
      - Use examples only when a clear, schema-valid pattern is evident.
      - Keep the set lean (3-10 items) and non-duplicative; combine overlapping ideas.
      - Return JSON that satisfies the output schema; do not wrap in prose.
    </instructions>
  `,
});
