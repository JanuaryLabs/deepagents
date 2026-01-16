import { groq } from '@ai-sdk/groq';
import dedent from 'dedent';
import z from 'zod';

import { type AgentModel } from '@deepagents/agent';
import {
  ContextEngine,
  type ContextFragment,
  InMemoryContextStore,
  analogy,
  clarification,
  example,
  explain,
  fragment,
  guardrail,
  hint,
  persona,
  quirk,
  structuredOutput,
  styleGuide,
  term,
  user,
  workflow,
} from '@deepagents/context';

const outputSchema = z.object({
  terms: z
    .array(z.object({ name: z.string(), definition: z.string() }))
    .optional()
    .describe('Domain terminology definitions'),
  hints: z
    .array(z.object({ text: z.string() }))
    .optional()
    .describe('Helpful hints for SQL generation'),
  guardrails: z
    .array(
      z.object({
        rule: z.string(),
        reason: z.string().optional(),
        action: z.string().optional(),
      }),
    )
    .optional()
    .describe('Safety rules and constraints'),
  explains: z
    .array(
      z.object({
        concept: z.string(),
        explanation: z.string(),
        therefore: z.string().optional(),
      }),
    )
    .optional()
    .describe('Concept explanations'),
  examples: z
    .array(
      z.object({
        question: z.string(),
        answer: z.string(),
        note: z.string().optional(),
      }),
    )
    .optional()
    .describe('Example question-answer pairs'),
  clarifications: z
    .array(z.object({ when: z.string(), ask: z.string(), reason: z.string() }))
    .optional()
    .describe('When to ask for clarification'),
  workflows: z
    .array(
      z.object({
        task: z.string(),
        steps: z.array(z.string()).min(1),
        triggers: z.array(z.string()).optional(),
        notes: z.string().optional(),
      }),
    )
    .optional()
    .describe('Multi-step workflows'),
  quirks: z
    .array(z.object({ issue: z.string(), workaround: z.string() }))
    .optional()
    .describe('Known issues and workarounds'),
  styleGuides: z
    .array(
      z.object({
        prefer: z.string(),
        never: z.string().optional(),
        always: z.string().optional(),
      }),
    )
    .optional()
    .describe('SQL style preferences'),
  analogies: z
    .array(
      z.object({
        concepts: z.array(z.string()).min(2),
        relationship: z.string(),
        insight: z.string().optional(),
        therefore: z.string().optional(),
        pitfall: z.string().optional(),
      }),
    )
    .optional()
    .describe('Concept analogies'),
});

type TeachablesOutput = z.infer<typeof outputSchema>;

export interface GenerateToTeachingsOptions {
  model?: AgentModel;
}

export async function toTeachings(
  input: { schema: string; context?: string },
  options?: GenerateToTeachingsOptions,
): Promise<ContextFragment[]> {
  const context = new ContextEngine({
    store: new InMemoryContextStore(),
    chatId: `teachables-gen-${crypto.randomUUID()}`,
    userId: 'system',
  });

  context.set(
    persona({
      name: 'teachables-author',
      role: 'You design "fragments" for a Text2SQL system. Fragments become structured XML instructions.',
      objective:
        'Choose only high-impact items that improve accuracy, safety, or clarity for this database',
    }),
    fragment('database_schema', input.schema),
    ...(input.context ? [fragment('additional_context', input.context)] : []),
    fragment(
      'output_structure',
      dedent`
        Output a JSON object with these optional arrays (include only relevant ones):
        - terms: [{ name: string, definition: string }] - Domain terminology
        - hints: [{ text: string }] - Helpful SQL generation hints
        - guardrails: [{ rule: string, reason?: string, action?: string }] - Safety constraints
        - explains: [{ concept: string, explanation: string, therefore?: string }] - Concept explanations
        - examples: [{ question: string, answer: string, note?: string }] - Q&A examples
        - clarifications: [{ when: string, ask: string, reason: string }] - Clarification triggers
        - workflows: [{ task: string, steps: string[], triggers?: string[], notes?: string }] - Multi-step tasks
        - quirks: [{ issue: string, workaround: string }] - Known issues
        - styleGuides: [{ prefer: string, never?: string, always?: string }] - SQL style rules
        - analogies: [{ concepts: string[], relationship: string, insight?: string, therefore?: string, pitfall?: string }]
      `,
    ),
    fragment(
      'task',
      dedent`
        1. Analyze the schema to infer domain, relationships, and sensitive columns.
        2. Generate 3-10 fragments total across all categories, prioritizing:
           - guardrails for PII columns (email, ssn, phone, etc)
           - hints for status/enum columns
           - clarifications for ambiguous terms
        3. Ground everything in the schema - do not invent tables/columns.
        4. Only include categories that are relevant to this schema.
      `,
    ),
    user(
      `Analyze this database schema and generate fragments that will help an AI generate accurate SQL queries.`,
    ),
  );

  const teachablesOutput = structuredOutput({
    model: options?.model ?? groq('openai/gpt-oss-20b'),
    context,
    schema: outputSchema,
  });

  const result = await teachablesOutput.generate();

  const fragments: ContextFragment[] = [];

  // Convert generated output to ContextFragments
  result.terms?.forEach((t) => fragments.push(term(t.name, t.definition)));
  result.hints?.forEach((h) => fragments.push(hint(h.text)));
  result.guardrails?.forEach((g) =>
    fragments.push(
      guardrail({ rule: g.rule, reason: g.reason, action: g.action }),
    ),
  );
  result.explains?.forEach((e) =>
    fragments.push(
      explain({
        concept: e.concept,
        explanation: e.explanation,
        therefore: e.therefore,
      }),
    ),
  );
  result.examples?.forEach((e) =>
    fragments.push(
      example({ question: e.question, answer: e.answer, note: e.note }),
    ),
  );
  result.clarifications?.forEach((c) =>
    fragments.push(
      clarification({ when: c.when, ask: c.ask, reason: c.reason }),
    ),
  );
  result.workflows?.forEach((w) =>
    fragments.push(
      workflow({
        task: w.task,
        steps: w.steps,
        triggers: w.triggers,
        notes: w.notes,
      }),
    ),
  );
  result.quirks?.forEach((q) =>
    fragments.push(quirk({ issue: q.issue, workaround: q.workaround })),
  );
  result.styleGuides?.forEach((s) =>
    fragments.push(
      styleGuide({ prefer: s.prefer, never: s.never, always: s.always }),
    ),
  );
  result.analogies?.forEach((a) =>
    fragments.push(
      analogy({
        concepts: a.concepts,
        relationship: a.relationship,
        insight: a.insight,
        therefore: a.therefore,
        pitfall: a.pitfall,
      }),
    ),
  );

  return fragments;
}
