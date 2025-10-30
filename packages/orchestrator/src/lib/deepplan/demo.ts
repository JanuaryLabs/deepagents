import { writeFile } from 'node:fs/promises';

import { generate, user } from '@deepagents/agent';

import { hackerNewsExecutor } from './executors/hackernews-executor.ts';
import { planAndSolve } from './plan-and-solve.ts';

const input = `
As a technology analyst, display a list products that have received investment funding within the past month. Format the output as a structured table with the following columns: Tool Name, Tool Website, Funding announcement link, Description, Funding Amount, Investor(s), and Date of Investment.

if no tool has received funding in the past month, simply respond with "No new developer tool funding announcements in the past month with explanation on how you got there."
`;

const state = {
  repo_path: '/Users/ezzabuzaid/Desktop/mo/cold-ambulance',
  environment: {
    executor_type: 'hackernews_search',
    available_tools: hackerNewsExecutor.toolsNames,
  },
};

// const final = await planAndSolve({
//   input,
//   executor: hackerNewsExecutor,
//   state: state,
//   hooks: {
//     onInitialPlan: async (context) => {
//       await writeFile('ps_initial_plan.json', JSON.stringify(context, null, 2));
//     },
//     afterReplan: async (context) => {
//       await writeFile(
//         `ps_replanned_context-${Date.now()}.json`,
//         JSON.stringify(context, null, 2),
//       );
//     },
//   },
// });

if (import.meta.main) {
  const final = await generate(hackerNewsExecutor, [user(input)], state);
  await writeFile('state.json', JSON.stringify(state, null, 2));
  await writeFile('final.md', final.text);
}
