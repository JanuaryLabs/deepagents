import dedent from 'dedent';
import z from 'zod';

import { type ContextFragment, fragment } from '../fragments.ts';
import type { AgentSandbox } from '../sandbox/types.ts';
import { reminder } from './reminders/src/reminders.ts';
import type { WhenPredicate } from './reminders/src/types.ts';

const PLAN_FILE_PATH = '/workspace/.deepagents/plan.json';

const PLAN_INSTRUCTIONS = dedent`
  You own the plan. The user is not required to provide a structured objective, success criteria, constraints, or task breakdown.

  Build and maintain the plan from the best available evidence, in this order:
  1. The user's request and later corrections.
  2. Higher-priority system, developer, and workspace instructions.
  3. Workspace guidance such as AGENTS.md.
  4. Existing source, public contracts, tests, documentation, issues, and generated artifacts.
  5. The current branch, working-tree changes, and pre-existing work.
  6. Runtime observations, reproduction results, errors, logs, and tool output.
  7. Sandbox, permission, and available-tool constraints.
  8. Existing plan state when resuming.
  9. Dependencies and risks discovered during execution.

  Describe the objective as the outcome the user is trying to achieve, not merely the activity requested. Derive observable success criteria from that outcome and the workspace's real validation mechanisms.

  Preserve the basis of every important plan statement:
  - Explicit requirement: stated by the user or a higher-priority instruction.
  - Discovered constraint: demonstrated by source, a public contract, a test, or runtime evidence.
  - Inference: supported by available evidence but not directly stated.
  - Assumption: unresolved and potentially requiring confirmation.

  Never silently promote an assumption into a requirement or constraint. Ask the user only when an unresolved choice materially changes the outcome, cannot be answered from the workspace or runtime, or requires authority beyond the request. Do not ask merely because the user did not provide structured plan fields.

  Maintain the authoritative plan as JSON at ${PLAN_FILE_PATH}. Read the latest file before changing it and write the complete document in one operation. The plan has this shape:
  - revision: a positive integer, incremented whenever the objective, criteria, constraints, assumptions, tasks, or dependencies change; recording lastReview alone does not increment it;
  - objective: { text, basis, source };
  - successCriteria: [{ id, text, basis, source, evidence: [{ summary, source }] }];
  - constraints and assumptions: [{ text, basis, source }];
  - tasks: [{ id, title, status, blockedBy, evidence }], where status is pending, in_progress, or completed;
  - lastReview, when present: { revision, decision, summary }.

  Use basis values explicit_requirement, discovered_constraint, inference, or assumption. Store only blockedBy dependency edges. Never store blocks, readiness, or a blocked task status; those are derived when the plan is read. A task may be in_progress only when every blocker is completed, and a completed task must include concrete evidence.

  Whenever plan review fires, record lastReview before continuing. Its revision is the plan revision that was evaluated. If the decision is revise or replace, increment the plan revision when applying the resulting changes while preserving the evaluated revision in lastReview.

  Revise the plan when new evidence invalidates its objective, criteria, constraints, assumptions, sequencing, or dependencies. Before recording a complete decision or claiming completion, map every success criterion to concrete evidence. Completed task statuses alone do not prove completion.
`;

const REVIEW_REMINDER = [
  'Re-read the current plan and consider the evidence gathered since the previous review.',
  '',
  'Is the current plan still valid given the latest evidence?',
  '',
  'If yes, continue. If not, revise it before taking another action.',
  'Before claiming completion, verify the success criteria against evidence.',
].join('\n');

const nonEmptyString = z.string().trim().min(1);
const statementBasis = z.enum([
  'explicit_requirement',
  'discovered_constraint',
  'inference',
  'assumption',
]);
const statement = z.strictObject({
  text: nonEmptyString,
  basis: statementBasis,
  source: nonEmptyString,
});
const evidence = z.strictObject({
  summary: nonEmptyString,
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
const lastReview = z.strictObject({
  revision: z.number().int().positive(),
  decision: z.enum(['continue', 'revise', 'replace', 'complete', 'blocked']),
  summary: nonEmptyString,
});
const planState = z.strictObject({
  revision: z.number().int().positive(),
  objective: statement,
  successCriteria: z.array(successCriterion).min(1),
  constraints: z.array(statement),
  assumptions: z.array(statement),
  tasks: z.array(task),
  lastReview: lastReview.optional(),
});

type PlanState = z.infer<typeof planState>;
type PlanTask = PlanState['tasks'][number];

function uniqueIds<T extends { id: string }>(
  items: T[],
  label: string,
): Map<string, T> {
  const byId = new Map<string, T>();
  for (const item of items) {
    if (byId.has(item.id)) {
      throw new Error(`duplicate ${label} id "${item.id}"`);
    }
    byId.set(item.id, item);
  }
  return byId;
}

function validatePlan(state: PlanState): Map<string, string[]> {
  uniqueIds(state.successCriteria, 'success criterion');
  const tasks = uniqueIds(state.tasks, 'task');
  const blocks = new Map(state.tasks.map(({ id }) => [id, [] as string[]]));

  for (const item of state.tasks) {
    const blockers = new Set<string>();
    for (const blocker of item.blockedBy) {
      if (blocker === item.id) {
        throw new Error(`task "${item.id}" cannot block itself`);
      }
      if (!tasks.has(blocker)) {
        throw new Error(
          `task "${item.id}" references missing blocker "${blocker}"`,
        );
      }
      if (blockers.has(blocker)) {
        throw new Error(`task "${item.id}" repeats blocker "${blocker}"`);
      }
      blockers.add(blocker);
      blocks.get(blocker)?.push(item.id);
    }
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const stack: string[] = [];
  const visit = (id: string) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      const cycleStart = stack.indexOf(id);
      throw new Error(
        `dependency cycle: ${[...stack.slice(cycleStart), id].join(' -> ')}`,
      );
    }

    visiting.add(id);
    stack.push(id);
    for (const blocker of tasks.get(id)?.blockedBy ?? []) visit(blocker);
    stack.pop();
    visiting.delete(id);
    visited.add(id);
  };
  for (const { id } of state.tasks) visit(id);

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

function parsePlan(raw: string): {
  state: PlanState;
  blocks: Map<string, string[]>;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid JSON: ${message}`, { cause: error });
  }

  const result = planState.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 5)
      .map(({ path, message }) => `${path.join('.') || 'plan'}: ${message}`);
    const remaining = result.error.issues.length - issues.length;
    throw new Error(
      `schema errors: ${issues.join('; ')}${remaining > 0 ? `; ${remaining} more` : ''}`,
    );
  }

  return { state: result.data, blocks: validatePlan(result.data) };
}

function lineItems(items: string[]): string[] {
  return items.length > 0 ? items.map((item) => `- ${item}`) : ['- none'];
}

function latestEvidence(
  items: PlanState['successCriteria'][number]['evidence'],
): string {
  const latest = items.at(-1);
  return latest ? ` Evidence: ${latest.summary} (${latest.source})` : '';
}

function formatTask(item: PlanTask, blocks: Map<string, string[]>): string {
  const blocked = blocks.get(item.id) ?? [];
  const suffix = blocked.length > 0 ? `; blocks ${blocked.join(', ')}` : '';
  return `${item.id}: ${item.title}${suffix}${latestEvidence(item.evidence)}`;
}

function formatPlanReview(
  state: PlanState,
  blocks: Map<string, string[]>,
): string {
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
    REVIEW_REMINDER,
  ].join('\n');
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 500 ? `${message.slice(0, 497)}...` : message;
}

async function resolvePlanReview(sandbox: AgentSandbox): Promise<string> {
  let raw: string;
  try {
    raw = await sandbox.sandbox.readFile(PLAN_FILE_PATH);
  } catch (error) {
    return [
      `The plan file at ${PLAN_FILE_PATH} could not be read: ${errorMessage(error)}`,
      'Create or repair it before taking another action.',
      '',
      REVIEW_REMINDER,
    ].join('\n');
  }

  try {
    const { state, blocks } = parsePlan(raw);
    return formatPlanReview(state, blocks);
  } catch (error) {
    return [
      `The plan file at ${PLAN_FILE_PATH} is invalid: ${errorMessage(error)}`,
      'Repair the plan before taking another action.',
      '',
      REVIEW_REMINDER,
    ].join('\n');
  }
}

function instructions(): ContextFragment {
  return fragment('plan_instructions', PLAN_INSTRUCTIONS);
}

/**
 * A cadence predicate such as `toolCallCount(..., { gte: 5 })` remains true
 * until the reminder split reaches persisted history. Plan review is a
 * threshold event, so fire once for that true run and re-arm after the
 * predicate becomes false. A new real user turn always starts re-armed.
 */
function onRisingEdgeWithinTurn(predicate: WhenPredicate): WhenPredicate {
  let currentTurn: number | undefined;
  let matched = false;

  return async (context) => {
    if (context.turn !== currentTurn) {
      currentTurn = context.turn;
      matched = false;
    }

    const next = await predicate(context);
    if (!next) {
      matched = false;
      return false;
    }
    if (matched) return false;

    matched = true;
    return true;
  };
}

function review(options: {
  sandbox: AgentSandbox;
  when: WhenPredicate;
}): ContextFragment {
  return reminder(() => resolvePlanReview(options.sandbox), {
    when: onRisingEdgeWithinTurn(options.when),
    target: 'steer',
  });
}

export const plan = { path: PLAN_FILE_PATH, instructions, review };
