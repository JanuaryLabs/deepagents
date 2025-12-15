import { groq } from '@ai-sdk/groq';
import { defaultSettingsMiddleware, wrapLanguageModel } from 'ai';
import dedent from 'dedent';
import z from 'zod';

import { type AgentModel, agent, generate, user } from '@deepagents/agent';

import {
  type GeneratedTeachable,
  type Teachables,
  toTeachables,
} from '../teach/teachables.ts';

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
        concept: z.array(z.string()).min(2),
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

const teachablesAuthorAgent = agent<
  TeachablesOutput,
  { schema: string; context?: string }
>({
  name: 'teachables-author',
  model: wrapLanguageModel({
    model: groq('openai/gpt-oss-20b'),
    middleware: defaultSettingsMiddleware({
      settings: { temperature: 0.4, topP: 0.95 },
    }),
  }),
  output: outputSchema,
  prompt: (state) => dedent`
    <identity>
      You design "teachables" for a Text2SQL system. Teachables become structured XML instructions.
      Choose only high-impact items that improve accuracy, safety, or clarity for this database.
    </identity>

    <database_schema>
    ${state?.schema}
    </database_schema>

    ${state?.context ? `<additional_context>${state.context}</additional_context>` : ''}

    <output_structure>
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
      - analogies: [{ concept: string[], relationship: string, insight?: string, therefore?: string, pitfall?: string }]
    </output_structure>

    <instructions>
      1. Analyze the schema to infer domain, relationships, and sensitive columns.
      2. Generate 3-10 teachables total across all categories, prioritizing:
         - guardrails for PII columns (email, ssn, phone, etc)
         - hints for status/enum columns
         - clarifications for ambiguous terms
      3. Ground everything in the schema - do not invent tables/columns.
      4. Only include categories that are relevant to this schema.
    </instructions>
  `,
});

export interface GenerateToTeachingsOptions {
  model?: AgentModel;
}

export async function toTeachings(
  input: { schema: string; context?: string },
  options?: GenerateToTeachingsOptions,
): Promise<Teachables[]> {
  const { experimental_output: result } = await generate(
    teachablesAuthorAgent.clone({ model: options?.model }),
    [
      user(
        `Analyze this database schema and generate teachings that will help an AI generate accurate SQL queries.`,
      ),
    ],
    input,
  );

  const generated: GeneratedTeachable[] = [
    ...(result.terms?.map((t) => ({ type: 'term' as const, ...t })) ?? []),
    ...(result.hints?.map((h) => ({ type: 'hint' as const, ...h })) ?? []),
    ...(result.guardrails?.map((g) => ({ type: 'guardrail' as const, ...g })) ??
      []),
    ...(result.explains?.map((e) => ({ type: 'explain' as const, ...e })) ??
      []),
    ...(result.examples?.map((e) => ({ type: 'example' as const, ...e })) ??
      []),
    ...(result.clarifications?.map((c) => ({
      type: 'clarification' as const,
      ...c,
    })) ?? []),
    ...(result.workflows?.map((w) => ({ type: 'workflow' as const, ...w })) ??
      []),
    ...(result.quirks?.map((q) => ({ type: 'quirk' as const, ...q })) ?? []),
    ...(result.styleGuides?.map((s) => ({
      type: 'styleGuide' as const,
      ...s,
    })) ?? []),
    ...(result.analogies?.map((a) => ({ type: 'analogy' as const, ...a })) ??
      []),
  ];

  return toTeachables(generated);
}
