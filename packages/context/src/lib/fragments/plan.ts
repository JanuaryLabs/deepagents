import dedent from 'dedent';
import z from 'zod';

import { type ContextFragment, fragment } from '../fragments.ts';
import {
  PLAN_FILE_PATH,
  PLAN_FOUNDATION_INSTRUCTIONS,
  PLAN_REVIEW_INSTRUCTIONS,
  createPlanReview,
  evidence,
  lastReview,
  latestEvidence,
  lineItems,
  nonEmptyString,
  parsePlanSchema,
  statementBasis,
  uniqueIds,
  validateDependencies,
} from './plan-shared.ts';
import type { WhenPredicate } from './reminders/src/types.ts';

const EXECUTION_PLAN_INSTRUCTIONS = dedent`
  Use an execution plan with this shape:
  - revision: a positive integer, incremented whenever the objective, criteria, constraints, assumptions, tasks, or dependencies change; recording lastReview alone does not increment it;
  - objective: { text, basis, source };
  - successCriteria: [{ id, text, basis, source, evidence: [{ summary, source }] }];
  - constraints and assumptions: [{ text, basis, source }];
  - tasks: [{ id, title, status, blockedBy, evidence }], where status is pending, in_progress, or completed;
  - lastReview, when present: { revision, decision, summary }.

  Use basis values explicit_requirement, discovered_constraint, inference, or assumption. Store only blockedBy dependency edges. Never store blocks, readiness, or a blocked task status; those are derived when the plan is read. A task may be in_progress only when every blocker is completed, and a completed task must include concrete evidence.

  Revise the plan when new evidence invalidates its objective, criteria, constraints, assumptions, sequencing, or dependencies. Before recording a complete decision or claiming completion, map every success criterion to concrete evidence. Completed task statuses alone do not prove completion.
`;

const EXECUTION_REVIEW_REMINDER = [
  'Re-read the current plan and consider the evidence gathered since the previous review.',
  '',
  'Is the current plan still valid given the latest evidence?',
  '',
  'If yes, continue. If not, revise it before taking another action.',
  'Before claiming completion, verify the success criteria against evidence.',
].join('\n');

const statement = z.strictObject({
  text: nonEmptyString,
  basis: statementBasis,
  source: nonEmptyString,
});
const successCriterion = statement.extend({
  id: nonEmptyString,
  evidence: z.array(evidence),
});
const task = z.strictObject({
  id: nonEmptyString,
  title: nonEmptyString,
  status: z.enum(['pending', 'in_progress', 'completed']),
  blockedBy: z.array(nonEmptyString),
  evidence: z.array(evidence),
});
const executionPlanState = z.strictObject({
  revision: z.number().int().positive(),
  objective: statement,
  successCriteria: z.array(successCriterion).min(1),
  constraints: z.array(statement),
  assumptions: z.array(statement),
  tasks: z.array(task),
  lastReview: lastReview.optional(),
});

type ExecutionPlanState = z.infer<typeof executionPlanState>;
type PlanTask = ExecutionPlanState['tasks'][number];

function validateExecutionPlan(
  state: ExecutionPlanState,
): Map<string, string[]> {
  uniqueIds(state.successCriteria, 'success criterion');
  const { byId: tasks, blocks } = validateDependencies(state.tasks, 'task');

  for (const item of state.tasks) {
    const incompleteBlockers = item.blockedBy.filter(
      (id) => tasks.get(id)?.status !== 'completed',
    );
    if (item.status !== 'pending' && incompleteBlockers.length > 0) {
      throw new Error(
        `task "${item.id}" is ${item.status} while blocked by ${incompleteBlockers.join(', ')}`,
      );
    }
    if (item.status === 'completed' && item.evidence.length === 0) {
      throw new Error(`completed task "${item.id}" has no evidence`);
    }
  }

  if (state.lastReview && state.lastReview.revision > state.revision) {
    throw new Error(
      `last review references future revision ${state.lastReview.revision}`,
    );
  }
  if (
    state.lastReview?.decision === 'complete' &&
    state.successCriteria.some(({ evidence }) => evidence.length === 0)
  ) {
    throw new Error(
      'a complete review requires evidence for every success criterion',
    );
  }

  return blocks;
}

function parseExecutionPlan(value: unknown): {
  state: ExecutionPlanState;
  blocks: Map<string, string[]>;
} {
  const state = parsePlanSchema(executionPlanState, value);
  return { state, blocks: validateExecutionPlan(state) };
}

function formatTask(item: PlanTask, blocks: Map<string, string[]>): string {
  const blocked = blocks.get(item.id) ?? [];
  const suffix = blocked.length > 0 ? `; blocks ${blocked.join(', ')}` : '';
  return `${item.id}: ${item.title}${suffix}${latestEvidence(item.evidence)}`;
}

function formatExecutionPlanReview({
  state,
  blocks,
}: ReturnType<typeof parseExecutionPlan>): string {
  const tasks = new Map(state.tasks.map((item) => [item.id, item]));
  const active = state.tasks.filter(({ status }) => status === 'in_progress');
  const ready = state.tasks.filter(
    ({ status, blockedBy }) =>
      status === 'pending' &&
      blockedBy.every((id) => tasks.get(id)?.status === 'completed'),
  );
  const waiting = state.tasks.filter(
    ({ status, blockedBy }) =>
      status === 'pending' &&
      blockedBy.some((id) => tasks.get(id)?.status !== 'completed'),
  );
  const completed = state.tasks.filter(({ status }) => status === 'completed');

  return [
    `Current plan (revision ${state.revision})`,
    `Objective: ${state.objective.text} [${state.objective.basis}; ${state.objective.source}]`,
    '',
    'Success criteria:',
    ...lineItems(
      state.successCriteria.map(
        (criterion) =>
          `${criterion.evidence.length > 0 ? '[supported]' : '[unsupported]'} ${criterion.id}: ${criterion.text}${latestEvidence(criterion.evidence)}`,
      ),
    ),
    '',
    'Constraints:',
    ...lineItems(
      state.constraints.map(
        (item) => `${item.text} [${item.basis}; ${item.source}]`,
      ),
    ),
    '',
    'Assumptions:',
    ...lineItems(
      state.assumptions.map(
        (item) => `${item.text} [${item.basis}; ${item.source}]`,
      ),
    ),
    '',
    'Active tasks:',
    ...lineItems(active.map((item) => formatTask(item, blocks))),
    '',
    'Ready tasks:',
    ...lineItems(ready.map((item) => formatTask(item, blocks))),
    '',
    'Waiting tasks:',
    ...lineItems(
      waiting.map(
        (item) =>
          `${formatTask(item, blocks)}; waiting for ${item.blockedBy
            .filter((id) => tasks.get(id)?.status !== 'completed')
            .join(', ')}`,
      ),
    ),
    '',
    'Completed tasks:',
    ...lineItems(completed.map((item) => formatTask(item, blocks))),
    ...(state.lastReview
      ? [
          '',
          `Last review: ${state.lastReview.decision} at revision ${state.lastReview.revision} — ${state.lastReview.summary}`,
        ]
      : []),
    '',
    EXECUTION_REVIEW_REMINDER,
  ].join('\n');
}

function instructions(): ContextFragment {
  return fragment(
    'plan_instructions',
    PLAN_FOUNDATION_INSTRUCTIONS,
    EXECUTION_PLAN_INSTRUCTIONS,
    PLAN_REVIEW_INSTRUCTIONS,
  );
}

function review(options: { when: WhenPredicate }): ContextFragment {
  return createPlanReview(
    options,
    (value) => formatExecutionPlanReview(parseExecutionPlan(value)),
    EXECUTION_REVIEW_REMINDER,
  );
}

export const plan = { path: PLAN_FILE_PATH, instructions, review };
