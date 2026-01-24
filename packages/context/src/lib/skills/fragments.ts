import dedent from 'dedent';

import type { ContextFragment } from '../fragments.ts';
import { discoverSkillsInDirectory } from './loader.ts';
import type { SkillMetadata, SkillsFragmentOptions } from './types.ts';

/**
 * Create a context fragment containing available skills metadata.
 *
 * Follows Anthropic's progressive disclosure pattern:
 * - At startup: only skill metadata (name, description, path) is injected
 * - At runtime: LLM reads full SKILL.md using file tools when relevant
 *
 * @param options - Configuration including paths to scan and optional filtering
 *
 * @example
 * ```ts
 * const context = new ContextEngine({ userId: 'demo-user', store, chatId: 'demo' })
 *   .set(
 *     role('You are a helpful assistant.'),
 *     skills({
 *       paths: [
 *         { host: './skills', sandbox: '/skills/skills' }
 *       ]
 *     }),
 *   );
 *
 * // LLM now sees skill metadata with sandbox paths and can read full SKILL.md
 * ```
 */
export function skills(options: SkillsFragmentOptions): ContextFragment {
  // Build host-to-sandbox mapping for path rewriting
  const pathMapping = new Map<string, string>();
  for (const { host, sandbox } of options.paths) {
    pathMapping.set(host, sandbox);
  }

  // Discover skills from all host paths (later paths override earlier ones)
  const skillsMap = new Map<string, SkillMetadata>();
  for (const { host } of options.paths) {
    const discovered = discoverSkillsInDirectory(host);
    for (const skill of discovered) {
      skillsMap.set(skill.name, skill);
    }
  }
  const allSkills = Array.from(skillsMap.values());

  // Apply filtering
  let filteredSkills = allSkills;
  if (options.include) {
    filteredSkills = allSkills.filter((s) => options.include!.includes(s.name));
  }
  if (options.exclude) {
    filteredSkills = filteredSkills.filter(
      (s) => !options.exclude!.includes(s.name),
    );
  }

  // Return empty fragment if no skills found
  // (renderers will output empty or skip gracefully)
  if (filteredSkills.length === 0) {
    return {
      name: 'available_skills',
      data: [],
      metadata: { mounts: [] },
    };
  }

  const mounts = filteredSkills.map((skill) => {
    const originalPath = skill.skillMdPath;
    let sandboxPath = originalPath;

    // Rewrite path from host to sandbox
    for (const [host, sandbox] of pathMapping) {
      if (originalPath.startsWith(host)) {
        const relativePath = originalPath.slice(host.length);
        sandboxPath = sandbox + relativePath;
        break;
      }
    }

    return {
      name: skill.name,
      description: skill.description,
      host: originalPath,
      sandbox: sandboxPath,
    } as const;
  });

  const skillFragments: ContextFragment[] = mounts.map((skill) => {
    return {
      name: 'skill',
      data: {
        name: skill.name,
        path: skill.sandbox,
        description: skill.description,
      },
    };
  });

  return {
    name: 'available_skills',
    data: [
      {
        name: 'instructions',
        data: SKILLS_INSTRUCTIONS,
      } as ContextFragment,
      ...skillFragments,
    ],
    metadata: {
      mounts,
    },
  };
}

/**
 * Instructions for the LLM on how to use available skills.
 * Follows Anthropic's progressive disclosure pattern.
 *
 * Structure:
 * - Intro explaining what skills are
 * - "How to use skills" section with detailed guidance
 * - Available skills section rendered separately as fragments
 */
const SKILLS_INSTRUCTIONS = dedent`A skill is a set of local instructions to follow that is stored in a \`SKILL.md\` file. Below is the list of skills that can be used. Each entry includes a name, description, and file path so you can open the source for full instructions when using a specific skill.

### How to use skills
- Discovery: The list below shows the skills available in this session (name + description + file path). Skill bodies live on disk at the listed paths.
- Trigger rules: If the user names a skill (with \`$SkillName\` or plain text) OR the task clearly matches a skill's description shown below, you must use that skill for that turn before doing anything else. Multiple mentions mean use them all. Do not carry skills across turns unless re-mentioned.
- Missing/blocked: If a named skill isn't in the list or the path can't be read, say so briefly and continue with the best fallback.
- How to use a skill (progressive disclosure):
  1) After deciding to use a skill, open its \`SKILL.md\`. Read only enough to follow the workflow.
  2) If \`SKILL.md\` points to extra folders such as \`references/\`, load only the specific files needed for the request; don't bulk-load everything.
  3) If \`scripts/\` exist, prefer running or patching them instead of retyping large code blocks.
  4) If \`assets/\` or templates exist, reuse them instead of recreating from scratch.
- Coordination and sequencing:
  - If multiple skills apply, choose the minimal set that covers the request and state the order you'll use them.
  - Announce which skill(s) you're using and why (one short line). If you skip an obvious skill, say why.
- Context hygiene:
  - Keep context small: summarize long sections instead of pasting them; only load extra files when needed.
  - Avoid deep reference-chasing: prefer opening only files directly linked from \`SKILL.md\` unless you're blocked.
  - When variants exist (frameworks, providers, domains), pick only the relevant reference file(s) and note that choice.
- Safety and fallback: If a skill can't be applied cleanly (missing files, unclear instructions), state the issue, pick the next-best approach, and continue.`;
