import { writeFile } from 'node:fs/promises';

import { planAndSolve } from './plan-and-solve.ts';
import { productManagerExecutor } from './product-manager-executor.ts';

const input = `
Create ONLY user stories for "add admin approval before customer or vendor can use the system"

Requirements:
- When user is successfully created, they can login as normal but have a pending status until an admin approves them
- They cannot do any "write" action until admin approval
- They can view the system with banner "Your account is pending admin approval"

IMPORTANT CONSTRAINTS:
- Output ONLY user stories in standard format ("As a [role], I want [action], so that [benefit]")
- Include acceptance criteria for each story
- DO NOT include: technical roadmaps, time estimates, implementation plans, stakeholder analysis, risk mitigations, or detailed recommendations
- Keep it simple and focused on user stories only

DO NOT ADD: introduction, stakeholder analysis, technical insights, recommendations, etc.
`;

const final = await planAndSolve({
  input: input,
  executor: productManagerExecutor,
  state: {
    repo_path: '/Users/ezzabuzaid/Desktop/mo/cold-ambulance',
  },
  hooks: {
    onInitialPlan: async (context) => {
      await writeFile('ps_initial_plan.json', JSON.stringify(context, null, 2));
    },
    afterReplan: async (context) => {
      await writeFile(
        `ps_replanned_context-${Date.now()}.json`,
        JSON.stringify(context, null, 2),
      );
    },
  },
});

await writeFile('final.md', final);
