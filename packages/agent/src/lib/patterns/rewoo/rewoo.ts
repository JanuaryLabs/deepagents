import { openai } from '@ai-sdk/openai';
import z from 'zod';

import { agent, instructions } from '../../agent.ts';
import { toOutput } from '../../stream_utils.ts';
import { execute } from '../../swarm.ts';
import {
  type Source as DDGSource,
  duckDuckGoSearch,
} from '../../tools/ddg-search.ts';

// ===============
// Types & Schemas
// ===============

const StatementSchema = z.object({
  id: z.string().regex(/^S\d+$/, 'Statement id must be like S1, S2, ...'),
  content: z.string().min(1),
});

const ToolNameSchema = z.enum(['web', 'news', 'images']);

const ToolCallSchema = z.object({
  id: z.string().regex(/^E\d+$/, 'Evidence id must be like E1, E2, ...'),
  tool: ToolNameSchema.describe('One of: web, news, images'),
  input: z
    .string()
    .min(1)
    .describe(
      'Concrete query/input for the tool; avoid unresolved placeholders',
    ),
  depends_on: z
    .array(z.string().regex(/^(S|E)\d+$/))
    .default([])
    .describe('Optional ids of statements/evidence this call builds on'),
});

export const RewooPlanSchema = z.object({
  statements: z
    .array(StatementSchema)
    .min(1)
    .describe('Reasoned statements (S1..Sn) that break down the task'),
  tool_calls: z
    .array(ToolCallSchema)
    .min(1)
    .describe('Concrete tool calls (E1..En) to gather evidence'),
  notes: z
    .string()
    .optional()
    .describe('Optional notes or constraints for execution'),
});

export type RewooPlan = z.infer<typeof RewooPlanSchema>;

export type Evidence = {
  id: string; // E1, E2...
  tool: z.infer<typeof ToolNameSchema>;
  input: string;
  summary: string; // compact textual synthesis of the tool output
  raw?: unknown; // raw structured tool output if available
};

// ===============
// Planner (ReWOO)
// ===============

// The planner follows the ReWOO idea: produce statements and explicit tool calls
// that will be executed to gather evidence (E1..En). The output is a strict JSON
// matching RewooPlanSchema – easy to parse and run.
export const rewooPlanner = agent({
  name: 'rewoo_planner',
  model: openai('gpt-4.1'),
  output: RewooPlanSchema,
  handoffDescription:
    'Decomposes a query into statements and concrete tool calls (ReWOO style).',
  prompt: instructions({
    purpose: [
      'Plan using ReWOO: create short Statements (S1..Sn) and explicit tool calls (E1..En).',
      'Each tool call should be executable now (no unresolved placeholders like #E1).',
      'Prefer concise, high-signal steps (typically 2–5 calls).',
    ],
    routine: [
      'Write Statements S1..Sn that break down the query',
      'Propose concrete tool_calls E1..En with tool and input',
      'Use depends_on to reference prior S/E ids when logically related',
      'Avoid speculative or circular dependencies',
      'Keep inputs directly usable (no templates needing substitution)',
    ],
  }),
});

// ========================
// Tool Executor (DDG-based)
// ========================

// A simple executor agent exposing DuckDuckGo search in three modes.
const rewooToolExecutor = agent({
  name: 'rewoo_tool_executor',
  model: openai('gpt-4o-mini'),
  toolChoice: 'required',
  handoffDescription: 'Executes web/news/image searches and returns findings.',
  prompt: instructions({
    purpose: [
      'Execute provided search tasks to gather factual snippets as evidence.',
      'Return results faithfully; do not fabricate.',
    ],
    routine: [
      'Run the requested search',
      'Return concise, relevant items only',
    ],
  }),
  tools: {
    ddg_search: duckDuckGoSearch,
  },
});

// =====================
// Solver (Final Answer)
// =====================

export const rewooSolver = agent({
  name: 'rewoo_solver',
  model: openai('gpt-4.1'),
  handoffDescription: 'Synthesizes final answers from statements + evidence.',
  prompt: instructions({
    purpose: [
      'Use the provided statements and evidence to answer the query.',
      'Cite evidence by id (E1, E2, ...) where appropriate.',
    ],
    routine: [
      'Read the user query',
      'Review statements S1..Sn for structure',
      'Review evidence E1..En summaries',
      'Compose a clear, grounded answer; avoid speculation',
    ],
  }),
});

// ======================
// Orchestration Function
// ======================

export async function runRewoo(query: string) {
  // 1) Plan
  const plan = await toOutput<RewooPlan>(execute(rewooPlanner, query, {}));

  // 2) Execute tool calls (in parallel)
  const evidences: Evidence[] = await Promise.all(
    plan.tool_calls.map(async (call) => {
      const source: DDGSource =
        call.tool === 'web' ? 'text' : call.tool === 'news' ? 'news' : 'images';

      const execInput = `Run ddg_search with { query: ${JSON.stringify(
        call.input,
      )}, source: ${JSON.stringify(source)}, maxResults: 5 }`;

      const res = execute(rewooToolExecutor, execInput, {});
      const text = await res.text;
      const summary = text?.slice(0, 1500) ?? '';
      return { id: call.id, tool: call.tool, input: call.input, summary };
    }),
  );

  // 3) Solve
  const solverInput = [
    `User query: ${query}`,
    '',
    '# Statements',
    ...plan.statements.map((s) => `${s.id}: ${s.content}`),
    '',
    '# Evidence',
    ...evidences.map((e) => `${e.id} (${e.tool}): ${e.summary}`),
  ].join('\n');

  const answer = await execute(rewooSolver, solverInput, {}).text;

  return { plan, evidences, answer } as const;
}

if (import.meta.main) {
  const query = 'What are the latest AI model releases this week?';

  const { plan, evidences, answer } = await runRewoo(query);

  console.log('\n===== REWOO PLAN =====');
  for (const s of plan.statements) console.log(`${s.id}: ${s.content}`);
  for (const c of plan.tool_calls)
    console.log(`${c.id}: ${c.tool} -> ${c.input}`);

  console.log('\n===== EVIDENCE =====');
  evidences.forEach((e) => {
    console.log(`${e.id} (${e.tool}): ${e.summary}`);
  });

  console.log('\n===== ANSWER =====');
  console.log(answer);
}
