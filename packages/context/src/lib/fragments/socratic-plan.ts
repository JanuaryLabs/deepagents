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
import { socraticInquiry } from './socratic-inquiry.ts';

const SOCRATIC_PLAN_INSTRUCTIONS = dedent`
  Use a Socratic plan as an evolving question-and-answer inquiry, not an execution task list whose titles merely end in question marks. It has this shape:
  The only top-level keys are revision, objective, successCriteria, constraints, assumptions, inquiries, and lastReview.
  - revision: a positive integer, incremented whenever a question, answer, dependency, or review-driven conclusion changes; recording lastReview alone does not increment it;
  - objective: one question entry;
  - successCriteria: question entries with an id;
  - constraints: question entries;
  - assumptions: question entries;
  - inquiries: question entries with id, phase, status, and blockedBy;
  - lastReview: null before the first review, then { revision, decision, summary, nextQuestionId }.

  A question entry is { question, basis, source, answer }. Its answer is null until answered, then { text, basis, source, evidence: [{ summary, source }] }. Use basis values explicit_requirement, discovered_constraint, inference, or assumption for every basis field. Every question must end with a question mark and include an answer field. Never store an answer as a bare string. Use phase values domain, case, or bridge. Use inquiry status values open, answering, or answered. Store only blockedBy dependencies; readiness and reverse edges are derived. An inquiry may be answering only after every blocker is answered. An answered inquiry must have an evidence-backed answer. An open inquiry must have answer: null. nextQuestionId records the inquiry selected by that review; use null when the review selects none.

  After reading any required skill or workspace instructions, write the initial inquiry before substantive investigation. Begin with the governing objective question and verification questions. Create an initial inquiry proportional to complexity: about 2 questions for light work, 3-4 for medium work, and 5-7 for heavy work. Do not precompute every follow-up question. After each answer, ask what it changed, then add, revise, or remove later questions. Preserve consequential questions and answers as the decision log.

  Domain questions discover governing principles, relevant frameworks, and common failure modes. Case questions apply them to the actual source, runtime, constraints, and evidence. A bridge answer must begin with "Applying to this task:" and state the concrete action implied by the earlier answers. Execute from that bridge, then answer the success questions with verification evidence.

  Before recording a complete decision, every objective, success, constraint, assumption, and inquiry question must have an evidence-backed answer. Completion means the answers collectively establish the requested outcome; the presence of answered questions alone does not prove completion. Do not return a final answer until lastReview records a complete decision at the current revision with nextQuestionId: null.
`;

const SOCRATIC_REVIEW_REMINDER = [
  'Re-read the current Socratic plan and the evidence gathered since the previous review.',
  '',
  'What did the latest evidence answer?',
  'Does that answer invalidate another answer, assumption, dependency, or question?',
  'Which unanswered question would reduce the most consequential uncertainty next?',
  '',
  'Record the review and its nextQuestionId, then revise the inquiry before continuing when needed.',
  'Before claiming completion, verify that every required question has an evidence-backed answer and that the answers establish the requested outcome.',
].join('\n');

const questionText = nonEmptyString.refine((text) => text.endsWith('?'), {
  message: 'must end with a question mark',
});
const answer = z.strictObject({
  text: nonEmptyString,
  basis: statementBasis,
  source: nonEmptyString,
  evidence: z.array(evidence).min(1),
});
const question = z.strictObject({
  question: questionText,
  basis: statementBasis,
  source: nonEmptyString,
  answer: answer.nullable(),
});
const successQuestion = question.extend({ id: nonEmptyString });
const inquiry = question.extend({
  id: nonEmptyString,
  phase: z.enum(['domain', 'case', 'bridge']),
  status: z.enum(['open', 'answering', 'answered']),
  blockedBy: z.array(nonEmptyString),
});
const socraticLastReview = lastReview.extend({
  nextQuestionId: nonEmptyString.nullable(),
});
const socraticPlanState = z.strictObject({
  revision: z.number().int().positive(),
  objective: question,
  successCriteria: z.array(successQuestion).min(1),
  constraints: z.array(question),
  assumptions: z.array(question),
  inquiries: z.array(inquiry).min(1),
  lastReview: socraticLastReview.nullable().optional(),
});

type SocraticPlanState = z.infer<typeof socraticPlanState>;
type SocraticQuestion = z.infer<typeof question>;
type SocraticInquiry = SocraticPlanState['inquiries'][number];

function validateSocraticPlan(state: SocraticPlanState): Map<string, string[]> {
  uniqueIds(state.successCriteria, 'success question');
  const { byId: inquiries, blocks } = validateDependencies(
    state.inquiries,
    'inquiry',
  );

  for (const item of state.inquiries) {
    const incompleteBlockers = item.blockedBy.filter(
      (id) => inquiries.get(id)?.status !== 'answered',
    );
    if (item.status !== 'open' && incompleteBlockers.length > 0) {
      throw new Error(
        `inquiry "${item.id}" is ${item.status} while blocked by ${incompleteBlockers.join(', ')}`,
      );
    }
    if (item.status === 'open' && item.answer) {
      throw new Error(`open inquiry "${item.id}" already has an answer`);
    }
    if (item.status === 'answered' && !item.answer) {
      throw new Error(`inquiry "${item.id}" is answered without an answer`);
    }
    if (
      item.phase === 'bridge' &&
      item.answer &&
      !item.answer.text.startsWith('Applying to this task:')
    ) {
      throw new Error(
        `bridge inquiry "${item.id}" answer must start with "Applying to this task:"`,
      );
    }
  }

  if (state.lastReview && state.lastReview.revision > state.revision) {
    throw new Error(
      `last review references future revision ${state.lastReview.revision}`,
    );
  }

  const nextQuestionId = state.lastReview?.nextQuestionId;
  if (nextQuestionId) {
    const next = inquiries.get(nextQuestionId);
    if (!next) {
      throw new Error(
        `last review references missing next question "${nextQuestionId}"`,
      );
    }
    if (state.lastReview?.revision === state.revision) {
      if (next.status === 'answered') {
        throw new Error(
          `last review next question "${nextQuestionId}" is already answered`,
        );
      }
      const incompleteBlockers = next.blockedBy.filter(
        (id) => inquiries.get(id)?.status !== 'answered',
      );
      if (incompleteBlockers.length > 0) {
        throw new Error(
          `last review next question "${nextQuestionId}" is blocked by ${incompleteBlockers.join(', ')}`,
        );
      }
    }
  }

  if (state.lastReview?.decision === 'complete') {
    if (state.lastReview.revision !== state.revision) {
      throw new Error(
        'a complete Socratic review must reference the current revision',
      );
    }
    const unansweredStatements = [
      state.objective,
      ...state.successCriteria,
      ...state.constraints,
      ...state.assumptions,
    ].some(({ answer }) => answer === null);
    if (
      unansweredStatements ||
      state.inquiries.some(({ status }) => status !== 'answered')
    ) {
      throw new Error(
        'a complete Socratic review requires an answer for every required question',
      );
    }
    if (state.lastReview.nextQuestionId !== null) {
      throw new Error('a complete Socratic review cannot name a next question');
    }
  }

  return blocks;
}

function parseSocraticPlan(value: unknown): {
  state: SocraticPlanState;
  blocks: Map<string, string[]>;
} {
  const state = parsePlanSchema(socraticPlanState, value);
  return { state, blocks: validateSocraticPlan(state) };
}

function formatAnswer(answer: SocraticQuestion['answer']): string {
  return answer
    ? `Answer: ${answer.text} [${answer.basis}; ${answer.source}]${latestEvidence(answer.evidence)}`
    : 'Answer: unanswered';
}

function formatQuestion(item: SocraticQuestion): string {
  return `${item.question} [${item.basis}; ${item.source}]\n  ${formatAnswer(item.answer)}`;
}

function formatInquiry(
  item: SocraticInquiry,
  blocks: Map<string, string[]>,
): string {
  const blocked = blocks.get(item.id) ?? [];
  const suffix = blocked.length > 0 ? `; blocks ${blocked.join(', ')}` : '';
  return `${item.id} [${item.phase}]: ${item.question} [${item.basis}; ${item.source}]${suffix}\n  ${formatAnswer(item.answer)}`;
}

function formatSocraticPlanReview({
  state,
  blocks,
}: ReturnType<typeof parseSocraticPlan>): string {
  const inquiries = new Map(state.inquiries.map((item) => [item.id, item]));
  const active = state.inquiries.filter(({ status }) => status === 'answering');
  const ready = state.inquiries.filter(
    ({ status, blockedBy }) =>
      status === 'open' &&
      blockedBy.every((id) => inquiries.get(id)?.status === 'answered'),
  );
  const waiting = state.inquiries.filter(
    ({ status, blockedBy }) =>
      status === 'open' &&
      blockedBy.some((id) => inquiries.get(id)?.status !== 'answered'),
  );
  const answered = state.inquiries.filter(
    ({ status }) => status === 'answered',
  );

  return [
    `Current Socratic plan (revision ${state.revision})`,
    `Governing question: ${formatQuestion(state.objective)}`,
    '',
    'Success questions:',
    ...lineItems(
      state.successCriteria.map(
        (item) => `${item.id}: ${formatQuestion(item)}`,
      ),
    ),
    '',
    'Constraint questions:',
    ...lineItems(state.constraints.map(formatQuestion)),
    '',
    'Assumption questions:',
    ...lineItems(state.assumptions.map(formatQuestion)),
    '',
    'Active inquiries:',
    ...lineItems(active.map((item) => formatInquiry(item, blocks))),
    '',
    'Ready inquiries:',
    ...lineItems(ready.map((item) => formatInquiry(item, blocks))),
    '',
    'Waiting inquiries:',
    ...lineItems(
      waiting.map(
        (item) =>
          `${formatInquiry(item, blocks)}; waiting for ${item.blockedBy
            .filter((id) => inquiries.get(id)?.status !== 'answered')
            .join(', ')}`,
      ),
    ),
    '',
    'Answered inquiries:',
    ...lineItems(answered.map((item) => formatInquiry(item, blocks))),
    ...(state.lastReview
      ? [
          '',
          `Last review: ${state.lastReview.decision} at revision ${state.lastReview.revision} — ${state.lastReview.summary}`,
          `Next question: ${state.lastReview.nextQuestionId ?? 'none'}`,
        ]
      : []),
    '',
    SOCRATIC_REVIEW_REMINDER,
  ].join('\n');
}

function instructions(): ContextFragment {
  return fragment(
    'plan_instructions',
    PLAN_FOUNDATION_INSTRUCTIONS,
    socraticInquiry(),
    SOCRATIC_PLAN_INSTRUCTIONS,
    PLAN_REVIEW_INSTRUCTIONS,
  );
}

function review(options: { when: WhenPredicate }): ContextFragment {
  return createPlanReview(
    options,
    (value) => formatSocraticPlanReview(parseSocraticPlan(value)),
    SOCRATIC_REVIEW_REMINDER,
  );
}

export const socraticPlan = { path: PLAN_FILE_PATH, instructions, review };
