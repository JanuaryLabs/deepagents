import { groq } from '@ai-sdk/groq';
import { openai } from '@ai-sdk/openai';
import { tool } from 'ai';
import { exec } from 'node:child_process';
import z from 'zod';

import { type Agent, agent, instructions } from '../../agent.ts';
import { printer, toState } from '../../stream_utils.ts';
import { execute } from '../../swarm.ts';

const tool_exec_cmd = tool({
  description:
    'Execute a find command to search for files and directories in the filesystem',
  inputSchema: z.object({
    command: z
      .string()
      .describe('The find command to execute, e.g., "find . -name \'*.txt\'"'),
  }),
  execute: async ({ command }) => {
    const allowed_commands = ['find', 'ls', 'cat', 'grep', 'head', 'tail'];
    const command_name = command.split(' ')[0];
    if (!allowed_commands.includes(command_name)) {
      return `Command "${command_name}" is not allowed. Only the following commands are permitted: ${allowed_commands.join(
        ', ',
      )}.`;
    }
    return new Promise<string>((resolve, reject) => {
      exec(command, (error, stdout, stderr) => {
        if (error) {
          reject(`Error: ${error.message}`);
          return;
        }
        if (stderr) {
          reject(`Stderr: ${stderr}`);
          return;
        }
        resolve(stdout);
      });
    });
  },
});
interface PlanExecuteState {
  input: string;
  plan: string[];
  pastSteps: Array<[string, string]>;
  response?: string;
}

const planner = agent<unknown, PlanExecuteState>({
  model: openai('gpt-4.1-nano'),
  name: 'PlannerAgent',
  handoffDescription:
    'Use this agent to create step-by-step plans for complex tasks.',
  prompt: instructions.swarm({
    purpose: [
      'You are an anonymous planning expert who creates detailed step-by-step plans.',
      'For any given objective, you break it down into simple, executable tasks.',
      'You have access to file system operations to read and explore files and directories to base your plans on real data.',
      'You are not an execution agent, you only create plans.',
    ],
    routine: [
      'Analyze the objective carefully',
      'Gather all necessary information and resources use tool_exec_cmd to explore the filesystem.',
      'Create a simple step-by-step plan with individual tasks',
      'The result of the final step should be the final answer',
      'when the plan is complete call the set_plan tool to set the plan in the state',
      'and then call transfer_to_executor_agent.',
    ],
  }),
  tools: {
    tool_exec_cmd,
    set_plan: tool({
      description: 'Set the execution plan with new steps',
      inputSchema: z.object({
        plan: z.array(z.string()),
      }),
      execute: ({ plan }, options) => {
        const state = toState<PlanExecuteState>(options);
        state.plan = plan;
        return 'Plan set successfully.';
      },
    }),
  },
  handoffs: [() => executor],
});

const executor = agent<unknown, PlanExecuteState>({
  name: 'ExecutorAgent',
  model: groq('openai/gpt-oss-120b'),
  handoffDescription:
    'Use this agent to execute individual tasks from the plan.',
  prompt: instructions.swarm({
    purpose: [
      'You are an execution expert who carries out specific tasks.',
      'You have access to file system operations to read and explore files and directories.',
    ],
    routine: [
      'Execute the given task thoroughly',
      'Use file system tools when you need to read files or explore directories',
      'Provide detailed and accurate results based on the file contents',
      'Focus only on the specific task at hand',
    ],
  }),
  tools: {
    tool_exec_cmd,
    get_task: tool({
      description:
        'Get the next task from the plan that has not been executed yet',
      inputSchema: z.object({}),
      execute: (input, options) => {
        const state = toState<PlanExecuteState>(options);
        if (state.plan.length === 0) {
          return 'No tasks in the plan.';
        }
        const nextTask = state.plan[0];
        return nextTask;
      },
    }),
    complete_task: tool({
      description:
        'Mark the current task as completed and store the result. This will remove the task from the plan.',
      inputSchema: z.object({
        result: z.string().describe('The result of executing the task.'),
      }),
      execute: ({ result }, options) => {
        const state = toState<PlanExecuteState>(options);
        if (state.plan.length === 0) {
          return 'No tasks to complete.';
        }
        const completedTask = state.plan.shift()!;
        state.pastSteps.push([completedTask, result]);
        return `Task "${completedTask}" completed successfully.`;
      },
    }),
  },
});

const replanner = agent<unknown,PlanExecuteState>({
  name: 'ReplannerAgent',
  model: groq('moonshotai/kimi-k2-instruct-0905'),
  handoffDescription:
    'Use this agent to update the plan based on execution results.',
  prompt: instructions.swarm({
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
  tools: {
    set_final_response: tool({
      description: 'Set the final response to be returned to the user',
      inputSchema: z.object({
        response: z.string().min(1),
      }),
      execute: ({ response }, options) => {
        const state = toState<PlanExecuteState>(options);
        state.response = response;
        return 'Final response set successfully.';
      },
    }),
    get_current_state: tool({
      description: 'Get the current state of the plan and past steps',
      inputSchema: z.object({}),
      execute: (input, options) => {
        const state = toState<PlanExecuteState>(options);
        return {
          plan: state.plan,
          pastSteps: state.pastSteps,
        };
      },
    }),
    update_plan: tool({
      description: 'Update the execution plan with new steps',
      inputSchema: z.object({
        plan: z.array(z.string()),
      }),
      execute: ({ plan }, options) => {
        const state = toState<PlanExecuteState>(options);
        state.plan = plan;
        return 'Plan updated successfully.';
      },
    }),
  },
  handoffs: [() => executor, () => triage],
});

const triage: Agent<unknown, PlanExecuteState> = agent<
  unknown,
  PlanExecuteState
>({
  model: groq('moonshotai/kimi-k2-instruct-0905'),
  name: 'triage_agent',
  handoffDescription: `Use this agent to delegate questions to other appropriate agents.`,
  prompt: instructions.swarm({
    purpose:
      'You are a helpful triaging agent. You can use your tools to delegate questions to other appropriate agents.',
    routine: [],
  }),
  handoffs: [replanner, planner],
  tools: {
    get_current_state: tool({
      description: 'Get the current state of the plan and past steps',
      inputSchema: z.object({}),
      execute: (input, options) => {
        const state = toState<PlanExecuteState>(options);
        return {
          plan: state.plan,
          pastSteps: state.pastSteps,
        };
      },
    }),
  },
});

if (import.meta.main) {
  // const objective = await input(
  //   `I'm looking for invoices in my downloads directory`,
  // );
  const objective = `This is npm workspace with multiple packages, each in their own directory. I want to know which packages have a dependency on "zod" and what version they use. Please provide a summary of the findings and a list of the packages that depend on "zod" along with their versions.`;

  const state: PlanExecuteState = {
    input: objective,
    plan: [],
    pastSteps: [],
    response: undefined,
  };

  const result = execute(triage, objective, state);
  await printer.stdout(result, { wrapInTags: false });
}
