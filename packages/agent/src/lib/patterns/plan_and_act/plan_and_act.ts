import { groq } from '@ai-sdk/groq';
import { z } from 'zod';

import { agent, instructions } from '../../agent.ts';
import { generate } from '../../swarm.ts';

// ===============
// Types & Schemas
// ===============

// Schema for initial plan generation with Chain-of-Thought reasoning
const PlanningResponseSchema = z.object({
  reasoning: z
    .string()
    .describe('Step-by-step reasoning about how to approach the task'),
  plan: z.object({
    steps: z
      .array(z.string())
      .describe('Ordered list of high-level steps to accomplish the goal'),
    estimated_complexity: z
      .enum(['low', 'medium', 'high'])
      .describe('Estimated complexity of the task'),
  }),
});

// Schema for execution results
const ExecutionResultSchema = z.object({
  reasoning: z
    .string()
    .describe('Reasoning about how to execute this specific step'),
  action_taken: z
    .string()
    .describe('Description of the concrete action performed'),
  result: z.string().describe('The actual result or output from the action'),
  success: z.boolean().describe('Whether the step was completed successfully'),
});

// Schema for replanning decisions
const ReplanningDecisionSchema = z.object({
  reasoning: z
    .string()
    .describe('Analysis of current progress and what still needs to be done'),
  decision: z.discriminatedUnion('type', [
    z.object({
      type: z.literal('continue'),
      updated_plan: z
        .array(z.string())
        .describe('Updated list of remaining steps'),
      notes: z
        .string()
        .optional()
        .describe('Any important context or learnings to carry forward'),
    }),
    z.object({
      type: z.literal('complete'),
      final_answer: z
        .string()
        .describe('The comprehensive final answer to the original query'),
      summary: z.string().describe('Summary of what was accomplished'),
    }),
  ]),
});

// Types inferred from schemas
export type PlanningResponse = z.infer<typeof PlanningResponseSchema>;
export type ExecutionResult = z.infer<typeof ExecutionResultSchema>;
export type ReplanningDecision = z.infer<typeof ReplanningDecisionSchema>;

// State for tracking the plan-and-act process
export interface PlanAndActState {
  originalQuery: string;
  currentPlan: string[];
  executionHistory: Array<{
    stepIndex: number;
    step: string;
    execution: ExecutionResult;
    decision: ReplanningDecision;
  }>;
  isComplete: boolean;
  finalAnswer?: string;
}

// ===============
// Agent Definitions
// ===============

// PLANNER: Creates high-level plans with reasoning
const planner = agent({
  name: 'plan_and_act_planner',
  model: groq('openai/gpt-oss-120b'),
  output: PlanningResponseSchema,
  prompt: instructions({
    purpose: [
      'You are an expert planning agent that breaks down complex tasks into clear, actionable steps.',
      'You use Chain-of-Thought reasoning to analyze tasks before creating plans.',
      'Your plans focus on high-level strategy, not low-level implementation details.',
    ],
    routine: [
      'First, reason through the task step-by-step to understand what needs to be accomplished',
      'Break down the task into logical, sequential high-level steps',
      'Each step should be clear and actionable by an execution agent with tools',
      'Focus on the WHAT and WHY, not the HOW (execution details)',
      'Ensure steps build upon each other logically',
      'Consider what information might be needed and how steps relate to each other',
    ],
  }),
});

// EXECUTOR: Executes individual steps with available tools
const executor = agent({
  name: 'plan_and_act_executor',
  model: groq('openai/gpt-oss-120b'),
  output: ExecutionResultSchema,
  prompt: instructions({
    purpose: [
      'You are an execution agent that translates high-level plan steps into concrete actions.',
      'You have access to web search and can perform research and information gathering.',
      'You provide detailed results about what you accomplished.',
    ],
    routine: [
      'First, reason about how to best execute the given step',
      'Use available tools to gather information, search the web, or perform other actions',
      'Focus on producing concrete, useful results',
      'Be thorough but concise in your execution',
      'Clearly describe what action you took and what the result was',
      'Report whether the step was completed successfully',
    ],
  }),
  tools: {
    // web_search: duckDuckGoSearch,
  },
});

// REPLANNER: Decides whether to continue or complete based on progress
const replanner = agent({
  name: 'plan_and_act_replanner',
  model: groq('openai/gpt-oss-120b'),
  output: ReplanningDecisionSchema,
  prompt: instructions({
    purpose: [
      'You are a strategic replanning agent that analyzes progress and decides next steps.',
      'You determine if the original goal has been met or if more work is needed.',
      'You update plans dynamically based on execution results and changing context.',
    ],
    routine: [
      'Analyze the original query and what has been accomplished so far',
      'Review execution results to understand current state and available information',
      'Determine if the original goal has been sufficiently addressed',
      'If complete: provide a comprehensive final answer synthesizing all findings',
      'If incomplete: update the plan with remaining steps, incorporating new context',
      "Consider what information is now available that wasn't before",
      'Eliminate redundant steps and add necessary new ones',
    ],
  }),
});

// ===============
// Main Function
// ===============

/**
 * Implements the Plan-and-Act framework from the whitepaper.
 * Separates high-level planning from low-level execution with dynamic replanning.
 */
export async function runPlanAndAct(
  query: string,
  maxIterations = 10,
): Promise<{
  plan: PlanningResponse;
  history: PlanAndActState['executionHistory'];
  answer: string;
}> {
  console.log(`🎯 Starting Plan-and-Act for: "${query}"`);

  // Step 1: Generate initial plan
  console.log('\n📋 PLANNING PHASE');
  const { experimental_output: initialPlanResponse } = await generate(
    planner,
    `Create a plan to accomplish this task: ${query}`,
    {},
  );

  console.log('💭 Reasoning:', initialPlanResponse.reasoning);
  console.log(
    '📝 Plan:',
    initialPlanResponse.plan.steps.map((s, i) => `${i + 1}. ${s}`).join('\n'),
  );

  // Initialize state
  const state: PlanAndActState = {
    originalQuery: query,
    currentPlan: [...initialPlanResponse.plan.steps],
    executionHistory: [],
    isComplete: false,
  };

  // Step 2: Execute plan with dynamic replanning
  console.log('\n⚡ EXECUTION PHASE');
  let iterations = 0;

  while (
    !state.isComplete &&
    iterations < maxIterations &&
    state.currentPlan.length > 0
  ) {
    iterations++;
    const currentStep = state.currentPlan[0];
    const stepIndex = state.executionHistory.length;

    console.log(`\n--- Iteration ${iterations} ---`);
    console.log(`🔄 Executing Step ${stepIndex + 1}: ${currentStep}`);

    // Execute the current step
    const { experimental_output: executionResult } = await generate(
      executor,
      `Execute this step: ${currentStep}

Context: You are working on this overall task: "${query}"
Previous steps completed: ${state.executionHistory.length}`,
      {},
    );

    console.log(`💭 Execution reasoning: ${executionResult.reasoning}`);
    console.log(`🎬 Action taken: ${executionResult.action_taken}`);
    console.log(`📊 Result: ${executionResult.result}`);
    console.log(`✅ Success: ${executionResult.success}`);

    // Remove the completed step from current plan
    state.currentPlan.shift();

    // Prepare context for replanning
    const contextForReplanning = `
Original task: ${query}

Initial plan:
${initialPlanResponse.plan.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}

Progress so far:
${state.executionHistory
  .map(
    (h, i) =>
      `Step ${i + 1}: ${h.step}
  → Action: ${h.execution.action_taken}
  → Result: ${h.execution.result}
  → Success: ${h.execution.success}`,
  )
  .join('\n\n')}

Just completed:
Step ${stepIndex + 1}: ${currentStep}
→ Action: ${executionResult.action_taken}
→ Result: ${executionResult.result}
→ Success: ${executionResult.success}

Remaining planned steps:
${state.currentPlan.map((s, i) => `${i + 1}. ${s}`).join('\n')}

Analyze the progress and decide whether to continue with more steps or provide the final answer.`;

    // Replan based on execution results
    console.log('\n🔄 REPLANNING PHASE');
    const { experimental_output: replanningDecision } = await generate(
      replanner,
      contextForReplanning,
      {},
    );

    // Record this execution cycle
    state.executionHistory.push({
      stepIndex,
      step: currentStep,
      execution: executionResult,
      decision: replanningDecision,
    });

    // Process replanning decision
    if (replanningDecision.decision.type === 'complete') {
      console.log(`🎉 Task completed!`);
      console.log(`📝 Summary: ${replanningDecision.decision.summary}`);
      state.isComplete = true;
      state.finalAnswer = replanningDecision.decision.final_answer;
    } else {
      console.log(`▶️ Continuing with updated plan`);
      state.currentPlan = replanningDecision.decision.updated_plan;
      if (replanningDecision.decision.notes) {
        console.log(`📝 Notes: ${replanningDecision.decision.notes}`);
      }
      console.log(
        `📋 Updated plan:`,
        state.currentPlan.map((s, i) => `${i + 1}. ${s}`).join('\n'),
      );
    }
  }

  // Handle cases where we exit the loop without completion
  if (!state.isComplete) {
    if (iterations >= maxIterations) {
      console.log(`⏰ Maximum iterations (${maxIterations}) reached`);
      state.finalAnswer = `Task partially completed after ${maxIterations} iterations. Please review the progress made.`;
    } else if (state.currentPlan.length === 0) {
      console.log(`✅ All planned steps completed`);
      state.finalAnswer = 'All planned steps have been executed successfully.';
    }
    state.isComplete = true;
  }

  return {
    plan: initialPlanResponse,
    history: state.executionHistory,
    answer:
      state.finalAnswer || 'Task completed but no final answer was generated.',
  };
}
