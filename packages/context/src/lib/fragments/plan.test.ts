import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { type UIMessage, generateId, simulateReadableStream, tool } from 'ai';
import {
  MockLanguageModelV4,
  convertReadableStreamToArray as drain,
} from 'ai/test';
import { InMemoryFs } from 'just-bash';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import {
  ContextEngine,
  InMemoryContextStore,
  XmlRenderer,
  agent,
  chat,
  createBashTool,
  createVirtualSandbox,
  everyNToolCalls,
  isSyntheticReminderMessage,
  plan,
  socraticPlan,
  socraticPrompting,
} from '@deepagents/context';

const testUsage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
} as const;

type StepSpec =
  { tool: string; input?: Record<string, unknown> } | { text: string };

function scriptedModel(steps: StepSpec[]) {
  const model = new MockLanguageModelV4({
    doStream: async () => {
      const call = model.doStreamCalls.length;
      const spec = steps[Math.min(call - 1, steps.length - 1)];
      const id = `s${call}`;
      const chunks: LanguageModelV4StreamPart[] = [];
      if ('text' in spec) {
        chunks.push(
          { type: 'text-start', id },
          { type: 'text-delta', id, delta: spec.text },
          { type: 'text-end', id },
        );
      } else {
        chunks.push({
          type: 'tool-call',
          toolCallId: `c${call}`,
          toolName: spec.tool,
          input: JSON.stringify(spec.input ?? {}),
        });
      }
      chunks.push({
        type: 'finish',
        finishReason: {
          unified: 'text' in spec ? 'stop' : 'tool-calls',
          raw: '',
        },
        usage: testUsage,
      });
      return { stream: simulateReadableStream({ chunks }) };
    },
  });
  return model;
}

function userMessage(text: string): UIMessage {
  return { id: generateId(), role: 'user', parts: [{ type: 'text', text }] };
}

const noop = tool({
  description: 'Advance the scripted agent loop.',
  inputSchema: z.object({}),
  execute: async () => ({ ok: true }),
});

const discoverEnvironment = tool({
  description: 'Discover the target environment.',
  inputSchema: z.object({}),
  execute: async () => ({
    targetEnvironment: 'linux',
    invalidates: 'The current macOS-only assumption',
  }),
});

describe('plan instructions', () => {
  it('renders stable planning rules without baking in the recurring review', async () => {
    const context = new ContextEngine({
      store: new InMemoryContextStore(),
      chatId: 'plan-instructions',
      userId: 'user',
    }).set(
      plan.instructions(),
      plan.review({
        when: () => true,
      }),
    );

    const { systemPrompt } = await context.resolve({
      renderer: new XmlRenderer(),
    });

    assert.match(systemPrompt, /<plan_instructions>/);
    assert.match(
      systemPrompt,
      /The user is not required to provide a structured objective/,
    );
    assert.match(systemPrompt, /Explicit requirement:/);
    assert.match(systemPrompt, /Discovered constraint:/);
    assert.match(systemPrompt, /Inference:/);
    assert.match(systemPrompt, /Assumption:/);
    assert.match(
      systemPrompt,
      /Do not ask merely because the user did not provide structured plan fields/,
    );
    assert.match(
      systemPrompt,
      /Completed task statuses alone do not prove completion/,
    );
    assert.match(systemPrompt, new RegExp(plan.path.replaceAll('.', '\\.')));
    assert.match(systemPrompt, /Store only blockedBy dependency edges/);
    assert.match(systemPrompt, /Never store blocks, readiness/);
    assert.match(
      systemPrompt,
      /Whenever plan review fires, record lastReview before continuing/,
    );
    assert.match(
      systemPrompt,
      /recording lastReview alone does not increment it/,
    );
    assert.doesNotMatch(
      systemPrompt,
      /Is the current plan still valid given the latest evidence\?/,
    );
    assert.doesNotMatch(systemPrompt, /<socratic_inquiry>/);
  });

  it('renders the shared Socratic workflow and durable inquiry contract', async () => {
    const context = new ContextEngine({
      store: new InMemoryContextStore(),
      chatId: 'socratic-plan-instructions',
      userId: 'user',
    }).set(socraticPlan.instructions());

    const { systemPrompt } = await context.resolve({
      renderer: new XmlRenderer(),
    });

    assert.match(systemPrompt, /<socratic_inquiry>/);
    assert.match(systemPrompt, /Interrogate the domain/);
    assert.match(systemPrompt, /Apply to the specific case/);
    assert.match(systemPrompt, /Bridge and execute/);
    assert.match(systemPrompt, /Applying to this task:/);
    assert.match(systemPrompt, /Match inquiry depth to task complexity/);
    assert.doesNotMatch(systemPrompt, /kind: &quot;socratic&quot;/);
    assert.match(systemPrompt, /question, basis, source, answer/);
    assert.match(systemPrompt, /inquiries:/);
    assert.match(
      systemPrompt,
      /The only top-level keys are revision, objective, successCriteria, constraints, assumptions, inquiries, and lastReview/,
    );
    assert.doesNotMatch(systemPrompt, /- answer:/);
    assert.match(systemPrompt, /- constraints:/);
    assert.match(systemPrompt, /- assumptions:/);
    assert.doesNotMatch(systemPrompt, /constraints and assumptions:/);
    assert.match(
      systemPrompt,
      /Use basis values explicit_requirement, discovered_constraint, inference, or assumption/,
    );
    assert.match(
      systemPrompt,
      /nextQuestionId records the inquiry selected by that review/,
    );
    assert.match(systemPrompt, /Never store an answer as a bare string/);
    assert.match(
      systemPrompt,
      /write the initial inquiry before substantive investigation/,
    );
    assert.match(
      systemPrompt,
      /Do not return a final answer until lastReview records a complete decision at the current revision/,
    );
    assert.match(systemPrompt, /Do not precompute every follow-up question/);
  });

  it('updates the public Socratic fragment from the same workflow', async () => {
    const context = new ContextEngine({
      store: new InMemoryContextStore(),
      chatId: 'socratic-prompting',
      userId: 'user',
    }).set(...socraticPrompting());

    const { systemPrompt } = await context.resolve({
      renderer: new XmlRenderer(),
    });

    assert.match(systemPrompt, /Skip Socratic inquiry for mechanical tasks/);
    assert.match(systemPrompt, /Interrogate the domain/);
    assert.match(systemPrompt, /Apply to the specific case/);
    assert.match(systemPrompt, /Bridge and execute/);
    assert.match(systemPrompt, /Applying to this task:/);
  });

  it('recites and validates a durable Socratic question-and-answer plan', async () => {
    await using backend = await createVirtualSandbox({ fs: new InMemoryFs() });
    const sandbox = await createBashTool({ sandbox: backend });
    const answer = {
      text: 'The existing plan file and reminder can be reused.',
      basis: 'discovered_constraint',
      source: 'plan source inspection',
      evidence: [
        {
          summary: 'plan.review reads and validates the sandbox plan file',
          source: 'packages/context/src/lib/fragments/socratic-plan.ts',
        },
      ],
    };
    const socraticPlanState = {
      revision: 1,
      objective: {
        question: 'How can planning become a durable Socratic inquiry?',
        basis: 'explicit_requirement',
        source: 'user request',
        answer: null,
      },
      successCriteria: [
        {
          id: 'SC1',
          question: 'Does the plan preserve questions, answers, and evidence?',
          basis: 'inference',
          source: 'user request',
          answer: null,
        },
      ],
      constraints: [
        {
          question: 'Which existing plan boundary must remain unchanged?',
          basis: 'explicit_requirement',
          source: 'user request',
          answer,
        },
      ],
      assumptions: [
        {
          question: 'Can the existing review cadence drive the inquiry?',
          basis: 'assumption',
          source: 'initial design',
          answer: null,
        },
      ],
      inquiries: [
        {
          id: 'Q1',
          phase: 'domain',
          question: 'What durable planning primitives already exist?',
          basis: 'inference',
          source: 'user request',
          status: 'answered',
          blockedBy: [],
          answer,
        },
        {
          id: 'Q2',
          phase: 'case',
          question: 'What must change for this specific plan?',
          basis: 'inference',
          source: 'answer to Q1',
          status: 'answering',
          blockedBy: ['Q1'],
          answer: null,
        },
        {
          id: 'Q3',
          phase: 'bridge',
          question: 'How should those answers be applied to this task?',
          basis: 'inference',
          source: 'answer to Q2',
          status: 'open',
          blockedBy: ['Q2'],
          answer: null,
        },
      ],
      lastReview: {
        revision: 1,
        decision: 'continue',
        summary: 'The domain question is answered; apply it to this case.',
        nextQuestionId: 'Q2',
      },
    };
    await sandbox.sandbox.writeFiles([
      { path: socraticPlan.path, content: JSON.stringify(socraticPlanState) },
    ]);
    const invalidPlan = {
      ...socraticPlanState,
      inquiries: [
        { ...socraticPlanState.inquiries[0], answer: null },
        ...socraticPlanState.inquiries.slice(1),
      ],
    };
    const model = scriptedModel([
      { tool: 'noop' },
      { tool: 'noop' },
      { tool: 'noop' },
      { tool: 'noop' },
      { tool: 'noop' },
      {
        tool: 'writeFile',
        input: {
          path: socraticPlan.path,
          content: JSON.stringify(invalidPlan),
        },
      },
      { tool: 'noop' },
      { tool: 'noop' },
      { tool: 'noop' },
      { tool: 'noop' },
      { text: 'The invalid answer state was detected.' },
    ]);
    const context = new ContextEngine({
      store: new InMemoryContextStore(),
      chatId: 'socratic-plan-review',
      userId: 'user',
    }).set(
      socraticPlan.instructions(),
      socraticPlan.review({ when: everyNToolCalls(5) }),
    );
    const chatAgent = agent({
      sandbox,
      name: 'socratic-plan-review',
      context,
      model,
      tools: { noop },
    });

    await context.continue(userMessage('Work through this Socratically.'));
    await drain(await chat(chatAgent));

    const prompts = model.doStreamCalls.map((call) =>
      JSON.stringify(call.prompt),
    );
    const review = prompts.find((prompt) =>
      prompt.includes('Current Socratic plan (revision 1)'),
    );
    assert.ok(review, 'expected the Socratic plan to be recited');
    assert.match(review, /Governing question:/);
    assert.match(review, /Q1 \[domain\]: What durable planning primitives/);
    assert.match(review, /Answer: The existing plan file and reminder/);
    assert.match(review, /Next question: Q2/);
    assert.ok(
      prompts.some((prompt) =>
        prompt.includes('is answered without an answer'),
      ),
      'expected an answered inquiry without an answer to be rejected',
    );
  });

  it('creates, reviews, revises, repairs, completes, and resumes a sandbox plan', async () => {
    await using backend = await createVirtualSandbox({ fs: new InMemoryFs() });
    const sandbox = await createBashTool({ sandbox: backend });
    const initialPlan = {
      revision: 1,
      objective: {
        text: 'Deliver the requested environment support',
        basis: 'inference',
        source: 'ordinary user request',
      },
      successCriteria: [
        {
          id: 'SC1',
          text: 'The requested environment is supported and verified',
          basis: 'inference',
          source: 'ordinary user request',
          evidence: [],
        },
      ],
      constraints: [],
      assumptions: [
        {
          text: 'The target environment is macOS',
          basis: 'assumption',
          source: 'initial workspace inspection',
        },
      ],
      tasks: [
        {
          id: 'T1',
          title: 'Discover the target environment',
          status: 'in_progress',
          blockedBy: [],
          evidence: [],
        },
        {
          id: 'T2',
          title: 'Implement and verify target environment support',
          status: 'pending',
          blockedBy: ['T1'],
          evidence: [],
        },
      ],
    };
    const revisedPlan = {
      ...initialPlan,
      revision: 2,
      constraints: [
        {
          text: 'The target environment is Linux',
          basis: 'discovered_constraint',
          source: 'discoverEnvironment tool result',
        },
      ],
      assumptions: [],
      tasks: [
        {
          ...initialPlan.tasks[0],
          status: 'completed',
          evidence: [
            {
              summary: 'The target environment is Linux',
              source: 'discoverEnvironment tool result',
            },
          ],
        },
        {
          ...initialPlan.tasks[1],
          status: 'in_progress',
        },
      ],
      lastReview: {
        revision: 1,
        decision: 'revise',
        summary:
          'Runtime evidence invalidated the initial macOS-only assumption',
      },
    };
    const unsupportedCompletion = {
      ...revisedPlan,
      tasks: [
        revisedPlan.tasks[0],
        {
          ...revisedPlan.tasks[1],
          status: 'completed',
          evidence: [
            {
              summary: 'Linux support was implemented',
              source: 'agent tool history',
            },
          ],
        },
      ],
      lastReview: {
        revision: 2,
        decision: 'complete',
        summary: 'Work appears complete',
      },
    };
    const completedPlan = {
      ...unsupportedCompletion,
      revision: 3,
      successCriteria: [
        {
          ...unsupportedCompletion.successCriteria[0],
          evidence: [
            {
              summary: 'Linux support verification passed',
              source: 'verification tool result',
            },
          ],
        },
      ],
      lastReview: {
        revision: 3,
        decision: 'complete',
        summary: 'Every success criterion has concrete verification evidence',
      },
    };
    const writePlan = (content: unknown): StepSpec => ({
      tool: 'writeFile',
      input: { path: plan.path, content: JSON.stringify(content) },
    });
    const model = scriptedModel([
      writePlan(initialPlan),
      { tool: 'discoverEnvironment' },
      { tool: 'noop' },
      { tool: 'noop' },
      { tool: 'noop' },
      { tool: 'noop' },
      writePlan(revisedPlan),
      { tool: 'noop' },
      { tool: 'noop' },
      { tool: 'noop' },
      { tool: 'noop' },
      { tool: 'noop' },
      writePlan(unsupportedCompletion),
      { tool: 'noop' },
      { tool: 'noop' },
      { tool: 'noop' },
      { tool: 'noop' },
      { tool: 'noop' },
      writePlan(completedPlan),
      { text: 'Completed with verified evidence.' },
    ]);
    const store = new InMemoryContextStore();
    const context = new ContextEngine({
      store,
      chatId: 'plan-end-to-end',
      userId: 'user',
    }).set(
      plan.instructions(),
      plan.review({
        when: everyNToolCalls(5),
      }),
    );
    const chatAgent = agent({
      sandbox,
      name: 'plan-end-to-end',
      context,
      model,
      tools: { discoverEnvironment, noop },
    });

    await context.continue(
      userMessage('Please add support for the environment I actually use.'),
    );
    await drain(await chat(chatAgent));

    const prompts = model.doStreamCalls.map((call) =>
      JSON.stringify(call.prompt),
    );
    const firstReviewIndex = prompts.findIndex((prompt) =>
      prompt.includes('Current plan (revision 1)'),
    );
    assert.equal(firstReviewIndex, 5);
    const firstReview = prompts[firstReviewIndex];
    assert.match(firstReview, /targetEnvironment/);
    assert.match(firstReview, /linux/);
    assert.match(
      firstReview,
      /T2: Implement and verify target environment support; waiting for T1/,
    );

    const revisedReviewIndex = prompts.findIndex((prompt) =>
      prompt.includes('Current plan (revision 2)'),
    );
    assert.equal(
      revisedReviewIndex,
      10,
      'the revised plan must be recited at the next cadence, not immediately',
    );
    const revisedReview = prompts[revisedReviewIndex];
    assert.match(
      revisedReview,
      /Active tasks:\\n- T2: Implement and verify target environment support/,
    );
    assert.match(
      revisedReview,
      /T1: Discover the target environment; blocks T2/,
    );
    assert.ok(
      prompts.some((prompt) =>
        prompt.includes(
          'a complete review requires evidence for every success criterion',
        ),
      ),
      'unsupported completion must produce a repair recitation',
    );

    const branch = await store.getActiveBranch('plan-end-to-end');
    assert.ok(branch?.headMessageId);
    const syntheticReviews = (
      await store.getMessageChain(branch.headMessageId)
    ).filter(
      (entry) =>
        entry.name === 'user' &&
        isSyntheticReminderMessage(entry.data as UIMessage),
    );
    assert.equal(syntheticReviews.length, 3);
    assert.deepEqual(
      JSON.parse(await sandbox.sandbox.readFile(plan.path)),
      completedPlan,
    );

    const resumedModel = scriptedModel([
      { tool: 'noop' },
      { tool: 'noop' },
      { tool: 'noop' },
      { tool: 'noop' },
      { tool: 'noop' },
      { tool: 'noop' },
      { text: 'The persisted plan is complete.' },
    ]);
    const resumedContext = new ContextEngine({
      store: new InMemoryContextStore(),
      chatId: 'plan-resume',
      userId: 'user',
    }).set(
      plan.instructions(),
      plan.review({
        when: everyNToolCalls(5),
      }),
    );
    const resumedAgent = agent({
      sandbox,
      name: 'plan-resume',
      context: resumedContext,
      model: resumedModel,
      tools: { noop },
    });

    await resumedContext.continue(userMessage('Resume the existing work.'));
    await drain(await chat(resumedAgent));

    const resumedReview = resumedModel.doStreamCalls
      .map((call) => JSON.stringify(call.prompt))
      .find((prompt) => prompt.includes('Current plan (revision 3)'));
    assert.ok(resumedReview, 'expected the persisted plan to be recited');
    assert.match(resumedReview, /\[supported\] SC1/);
    assert.match(resumedReview, /Last review: complete at revision 3/);
  });
});
