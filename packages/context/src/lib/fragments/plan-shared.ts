import dedent from 'dedent';
import z from 'zod';

import type { ContextFragment } from '../fragments.ts';
import { reminder } from './reminders/src/reminders.ts';
import type { WhenPredicate } from './reminders/src/types.ts';

export const PLAN_FILE_PATH = '/workspace/.deepagents/plan.json';

export const PLAN_FOUNDATION_INSTRUCTIONS = dedent`
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

  Maintain the authoritative plan as JSON at ${PLAN_FILE_PATH}. Read the latest file before changing it and write the complete document in one operation.
`;

export const PLAN_REVIEW_INSTRUCTIONS = dedent`
  Whenever plan review fires, record lastReview before continuing. Its revision is the plan revision that was evaluated. If the decision is revise or replace, increment the plan revision when applying the resulting changes while preserving the evaluated revision in lastReview.
`;

export const nonEmptyString = z.string().trim().min(1);
export const statementBasis = z.enum([
  'explicit_requirement',
  'discovered_constraint',
  'inference',
  'assumption',
]);
export const evidence = z.strictObject({
  summary: nonEmptyString,
  source: nonEmptyString,
});
export const lastReview = z.strictObject({
  revision: z.number().int().positive(),
  decision: z.enum(['continue', 'revise', 'replace', 'complete', 'blocked']),
  summary: nonEmptyString,
});

export type Evidence = z.infer<typeof evidence>;

export function parsePlanSchema<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;

  const issues = result.error.issues
    .slice(0, 5)
    .map(({ path, message }) => `${path.join('.') || 'plan'}: ${message}`);
  const remaining = result.error.issues.length - issues.length;
  throw new Error(
    `schema errors: ${issues.join('; ')}${remaining > 0 ? `; ${remaining} more` : ''}`,
  );
}

export function uniqueIds<T extends { id: string }>(
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

export function validateDependencies<
  T extends { id: string; blockedBy: string[] },
>(
  items: T[],
  label: string,
): { byId: Map<string, T>; blocks: Map<string, string[]> } {
  const byId = uniqueIds(items, label);
  const blocks = new Map(items.map(({ id }) => [id, [] as string[]]));

  for (const item of items) {
    const blockers = new Set<string>();
    for (const blocker of item.blockedBy) {
      if (blocker === item.id) {
        throw new Error(`${label} "${item.id}" cannot block itself`);
      }
      if (!byId.has(blocker)) {
        throw new Error(
          `${label} "${item.id}" references missing blocker "${blocker}"`,
        );
      }
      if (blockers.has(blocker)) {
        throw new Error(`${label} "${item.id}" repeats blocker "${blocker}"`);
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
    for (const blocker of byId.get(id)?.blockedBy ?? []) visit(blocker);
    stack.pop();
    visiting.delete(id);
    visited.add(id);
  };
  for (const { id } of items) visit(id);

  return { byId, blocks };
}

export function lineItems(items: string[]): string[] {
  return items.length > 0 ? items.map((item) => `- ${item}`) : ['- none'];
}

export function latestEvidence(items: Evidence[]): string {
  const latest = items.at(-1);
  return latest ? ` Evidence: ${latest.summary} (${latest.source})` : '';
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 500 ? `${message.slice(0, 497)}...` : message;
}

function parsePlanJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid JSON: ${message}`, { cause: error });
  }
}

export function createPlanReview(
  options: { when: WhenPredicate },
  formatPlanReview: (value: unknown) => string,
  reviewReminder: string,
): ContextFragment {
  return reminder(
    async ({ sandbox }) => {
      let raw: string;
      try {
        raw = await sandbox!.sandbox.readFile(PLAN_FILE_PATH);
      } catch (error) {
        return [
          `The plan file at ${PLAN_FILE_PATH} could not be read: ${errorMessage(error)}`,
          'Create or repair it before taking another action.',
          '',
          reviewReminder,
        ].join('\n');
      }

      try {
        return formatPlanReview(parsePlanJson(raw));
      } catch (error) {
        return [
          `The plan file at ${PLAN_FILE_PATH} is invalid: ${errorMessage(error)}`,
          'Repair the plan before taking another action.',
          '',
          reviewReminder,
        ].join('\n');
      }
    },
    { when: options.when, target: 'steer' },
  );
}
