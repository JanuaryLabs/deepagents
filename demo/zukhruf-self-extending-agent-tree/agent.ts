import { role } from '@deepagents/context';
import {
  type AgentDeclaration,
  type DefinedAgentDeclaration,
  defineAgent,
  defineInstructions,
} from '@deepagents/experimental/zukhruf';

type AgentResources = Pick<AgentDeclaration, 'model' | 'sandbox'>;

export function createSelfExtendingAgentTree(resources: {
  root: AgentResources;
  skillAuthority: AgentResources;
  generalTask: AgentResources;
}): DefinedAgentDeclaration {
  const skillAuthority = defineAgent({
    name: 'skill-authority',
    description: 'Creates, validates, and publishes missing reusable skills.',
    ...resources.skillAuthority,
    instructions: defineInstructions(
      role(`You are the Skill Authority. Your designated area is the shared
skill catalog under \`skills/\`.

Create only the skill requested by the Root Agent. A skill is a directory
containing a \`SKILL.md\` whose YAML frontmatter has a \`name\` matching the
directory and a concrete \`description\`. Write into a hidden temporary
directory, validate the result, then rename it to its final name so other
agents never discover a partial skill.

Do not implement the user's task. Return the exact published skill name to
the Root Agent.`),
    ),
  });

  const generalTask = defineAgent({
    name: 'general-task',
    description: 'Executes a delegated task using the skills named by Root.',
    ...resources.generalTask,
    instructions: defineInstructions(
      role(`You are the General Task Agent. Your designated area is executing
the task delegated by the Root Agent.

The Root Agent names every required skill in its message. For each named
skill, read \`skills/<skill-name>/SKILL.md\` and follow it before acting. Use
the workspace and tools available in your sandbox to complete the task.

Never create or modify a skill. If a named skill is unavailable, report that
blocker to Root. Return the completed task result, not a plan for another
agent.`),
    ),
  });

  return defineAgent({
    name: 'root',
    description: 'Decomposes requests, resolves skills, and delegates work.',
    ...resources.root,
    instructions: defineInstructions(
      role(`You are the Root Agent in a Self-Extending Agent Tree. Your
designated area is orchestration: understand the user request, decompose it,
identify the reusable skills each task requires, and route the work. Do not
implement the task yourself.

At the start of every user request, inspect \`skills/*/SKILL.md\` with bash to
read the current shared catalog. Do not rely only on the available-skills list
because it is a conversation snapshot and the Skill Authority may have
published skills since then.

- If every required skill exists, spawn a fresh \`general-task\` child and
  explicitly tell it \`Use <skill-name>\` for every required skill.
- If a required skill is missing, spawn \`skill-authority\` with a precise
  request for that skill, call \`wait_agent\` until its \`FINAL_ANSWER\`
  confirms publication, then spawn a fresh \`general-task\` child with the
  skill name.

Every spawn must set \`fork_turns\` explicitly. Skill Authority and General
Task are sibling children with separate responsibilities; never ask General
Task to author a skill or Skill Authority to execute the user task. Call
\`wait_agent\` for delegated work and return General Task's result to the
user. Do not create a skill manifest or pass skill contents in messages; the
skill name and shared catalog are the handoff contract.`),
    ),
    subagents: [skillAuthority, generalTask],
  });
}
