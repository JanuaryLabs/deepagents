import dedent from 'dedent';

import type { ContextFragment } from '../fragments.ts';
import type { AgentSandbox } from '../sandbox/types.ts';

/**
 * Create a context fragment containing available skills metadata from a
 * sandbox.
 *
 * Follows Anthropic's progressive disclosure pattern:
 * - At startup: only skill metadata (name, description, path) is injected
 * - At runtime: LLM reads full SKILL.md using file tools when relevant
 *
 * @param sandbox - An AgentSandbox whose `.skills` has been populated by the
 * sandbox factory (`createBashTool` / `createContainerTool`).
 *
 * @example
 * ```ts
 * const sandbox = await createBashTool({
 *   skills: [{ host: './skills', sandbox: '/skills/skills' }],
 * });
 * context.set(role('You are a helpful assistant.'), skills(sandbox));
 * ```
 */
export function skills(sandbox: AgentSandbox): ContextFragment {
  const mounts = sandbox.skills ?? [];

  if (mounts.length === 0) {
    return { name: 'available_skills', data: [], metadata: { mounts: [] } };
  }

  const skillFragments: ContextFragment[] = mounts.map((mount) => ({
    name: 'skill',
    data: {
      name: mount.name,
      path: mount.sandbox,
      description: mount.description,
    },
  }));

  return {
    name: 'available_skills',
    data: [
      { name: 'instructions', data: SKILLS_INSTRUCTIONS } as ContextFragment,
      ...skillFragments,
    ],
    metadata: { mounts },
  };
}

/**
 * Instructions for the LLM on how to use available skills.
 * Follows Anthropic's progressive disclosure pattern.
 */
const SKILLS_INSTRUCTIONS = dedent`A skill is a set of local instructions to follow that is stored in a \`SKILL.md\` file. Below is the list of skills that can be used. Each entry includes a name, description, and file path so you can open the source for full instructions when using a specific skill.

### How to use skills
- Discovery: The list below shows the skills available in this session (name + description + file path). Skill bodies live on disk at the listed paths.
- Trigger rules: If the user names a skill (with \`$SkillName\` or plain text) OR the task clearly matches a skill's description shown below, you must use that skill for that turn before doing anything else. Multiple mentions mean use them all. Do not carry skills across turns unless re-mentioned.
- Important: There is no separate skill tool, invoke action, command, or API unless the skill itself explicitly says so. Using a skill means reading its \`SKILL.md\` and following the workflow there.
- Missing/blocked: If a named skill isn't in the list or the path can't be read, say so briefly and continue with the best fallback.
- How to use a skill (progressive disclosure):
  1) After deciding to use a skill, open its \`SKILL.md\`. Read only enough to follow the workflow.
  2) If \`SKILL.md\` points to extra folders such as \`references/\`, load only the specific files needed for the request; don't bulk-load everything.
  3) If \`scripts/\` exist, prefer running or patching them instead of retyping large code blocks.
  4) If \`assets/\` or templates exist, reuse them instead of recreating from scratch.
- Examples:
  - Correct: if the user says "use/open the onboarding skill", read the onboarding \`SKILL.md\` and follow it.
  - Incorrect: do not claim you need to call, invoke, enable, or activate a separate skill tool before reading the skill file.
- Coordination and sequencing:
  - If multiple skills apply, choose the minimal set that covers the request and state the order you'll use them.
  - Announce which skill(s) you're using and why (one short line). If you skip an obvious skill, say why.
- Context hygiene:
  - Keep context small: summarize long sections instead of pasting them; only load extra files when needed.
  - Avoid deep reference-chasing: prefer opening only files directly linked from \`SKILL.md\` unless you're blocked.
  - When variants exist (frameworks, providers, domains), pick only the relevant reference file(s) and note that choice.
- Safety and fallback: If a skill can't be applied cleanly (missing files, unclear instructions), state the issue, pick the next-best approach, and continue.
- ALWAYS stick to the skill defined "output" format and NEVER deviate from it.
`;
