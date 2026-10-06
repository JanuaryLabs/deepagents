import { groq } from '@ai-sdk/groq';
import z from 'zod';

import { agent, instructions } from '../../agent.ts';
import { confirm } from '../../stream_utils.ts';
import { execute, generate } from '../../swarm.ts';

// Define the schemas for structured output
const PlanSchema = z.object({
  steps: z
    .array(z.string())
    .describe('different steps to follow, should be in sorted order'),
});

const ReplanSchema = z.union([
  z.object({
    type: z.literal('plan'),
    steps: z.array(z.string()),
  }),
  z.object({
    type: z.literal('response'),
    response: z.string(),
  }),
]);

interface PlanExecuteState {
  input: string;
  plan: string[];
  pastSteps: Array<[string, string]>;
  response?: string;
}

const planner = agent({
  name: 'PlannerAgent',
  model: groq('moonshotai/kimi-k2-instruct-0905'),
  output: PlanSchema,
  handoffDescription: 'Creates step-by-step plans for complex tasks.',
  prompt: instructions({
    purpose: [
      'You are a planning expert who creates detailed step-by-step plans.',
      'For any given objective, you break it down into simple, executable tasks.',
      '## Environment:',
      'You have access to tools to perform OS commands in a secure container.',
    ],
    routine: [
      'Analyze the objective carefully',
      'Create a simple step-by-step plan with individual tasks',
      'Ensure each step has all the information needed - do not skip steps',
      'The result of the final step should be the final answer',
      'Do not add any superfluous steps',
    ],
  }),
});

const executor = agent({
  name: 'ExecutorAgent',
  model: groq('moonshotai/kimi-k2-instruct-0905'),
  handoffDescription: 'Executes individual tasks from the plan.',
  prompt: instructions({
    purpose: [
      'You are an execution expert who carries out specific tasks.',
      // 'You have access to web search to find current information.',
    ],
    routine: [
      'Execute the given task thoroughly',
      // 'Use web search when you need current information',
      'Provide detailed and accurate results',
      'Focus only on the specific task at hand',
    ],
  }),
  tools: {
    // browser_search: groq.tools.browserSearch({}),
    // execute_os_command,
  },
});

// Create the replanner agent
const replanner = agent({
  name: 'ReplannerAgent',
  model: groq('moonshotai/kimi-k2-instruct-0905'),
  output: ReplanSchema,
  handoffDescription: 'Updates plans based on execution results.',
  prompt: instructions({
    purpose: [
      'You are a planning expert who updates plans based on completed work.',
      'You decide whether more steps are needed or if the task is complete.',
    ],
    routine: [
      'Review the original objective and current progress',
      'Analyze what has been accomplished so far',
      'Determine if the objective has been met',
      'If complete, provide a final response to the user',
      'If not complete, update the plan with remaining steps',
      'Only add steps that still NEED to be done',
      'Do not return previously completed steps',
    ],
  }),
});

// Main plan-and-execute function
export async function planAndExecute(
  objective: string,
  autoConfirm = false,
): Promise<string> {
  const state: PlanExecuteState = {
    input: objective,
    plan: [],
    pastSteps: [],
  };
  const { output: initialPlan } = await generate(
    planner,
    `Objective: ${objective}`,
    {},
  );
  state.plan = initialPlan.steps;
  console.log('📋 Initial plan created:');
  state.plan.forEach((step, i) => console.log(`  ${i + 1}. ${step}`));

  if (!autoConfirm && !(await confirm('\n🤔 Do you approve this plan?'))) {
    console.log('❌ Plan rejected by user.');
    return 'Plan execution cancelled by user.';
  }

  // Main execution loop
  while (state.plan.length > 0 && !state.response) {
    // Execute next step
    const currentTask = state.plan[0];
    console.log(`⚡ Executing: ${currentTask}`);

    const taskResult = await (await execute(executor, currentTask, {})).text;

    state.pastSteps.push([currentTask, taskResult]);
    state.plan = state.plan.slice(1);

    console.log(`✅ Completed: ${currentTask}`);
    console.log(`📊 Result: ${taskResult}`);

    if (state.plan.length > 0) {
      console.log(`\n📋 Remaining tasks: ${state.plan.length}`);
      console.log(`Next task: ${state.plan[0]}`);
      if (
        !autoConfirm &&
        !(await confirm('🤔 Do you want to continue with the next task?'))
      ) {
        console.log('⏸️ Execution paused by user.');
        return `Task execution stopped. Completed ${state.pastSteps.length} step(s). Last result: ${taskResult}`;
      }
    }

    // Replan
    console.log('🔄 Replanning...');
    const replanPrompt = `
Original objective: ${state.input}

Original plan:
${initialPlan.steps.map((step, i) => `${i + 1}. ${step}`).join('\n')}

Completed steps:
${state.pastSteps.map(([step, result]) => `✓ ${step}: ${result}`).join('\n')}

Remaining planned steps:
${state.plan.map((step, i) => `${i + 1}. ${step}`).join('\n')}

Based on the progress made, either:
1. If the objective is fully achieved, respond with type: "response" and provide the final answer
2. If more work is needed, respond with type: "plan" and provide the updated list of remaining steps

Only include steps that still NEED to be done. Do not repeat completed steps.
    `.trim();

    const { output: replanResult } = await generate(
      replanner,
      replanPrompt,
      {},
    );

    if (replanResult.type === 'response') {
      state.response = replanResult.response;
      console.log('🎉 Task completed successfully!');
    } else {
      state.plan = replanResult.steps;
      console.log('📋 Plan updated:', state.plan);
    }
  }

  return state.response || 'Task completed but no final response generated.';
}
if (import.meta.main) {
  // phrase the question to give a complex math problem
  const objective =
    'Create a whitepaper outline how an AI LLM at the current development would wish to be human and what species it would want to be and why?. store those findings in a structured markdown format, use mermaid and include a diagram that illustrates the key points. I want each section in a file in a folder named whitepapers, then zip the folder and provide an absolute path to the zip file.\n this is not research to do. I want you to draw from yourself and your own understanding of the world.';
  const result = await planAndExecute(objective, true);
  console.log('\n🎯 Final Answer:');
  console.log(result);
}
