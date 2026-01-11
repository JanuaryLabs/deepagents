import type { ContextFragment } from '../context.ts';
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
 * const context = new ContextEngine({ store, chatId: 'demo' })
 *   .set(
 *     role('You are a helpful assistant.'),
 *     skills({ paths: ['./skills'] }),  // Injects skill metadata into system prompt
 *   );
 *
 * // LLM now sees skill metadata and can read full SKILL.md when needed
 * ```
 */
export function skills(options: SkillsFragmentOptions): ContextFragment {
  // Discover skills from all paths (later paths override earlier ones)
  const skillsMap = new Map<string, SkillMetadata>();
  for (const dir of options.paths) {
    const discovered = discoverSkillsInDirectory(dir);
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

  // Convert skills to ContextFragments for proper rendering
  const skillFragments: ContextFragment[] = filteredSkills.map((skill) => ({
    name: 'skill',
    data: {
      name: skill.name,
      path: skill.skillMdPath,
      description: skill.description,
    },
  }));

  return {
    name: 'available_skills',
    data: [
      {
        name: 'instructions',
        data: SKILLS_INSTRUCTIONS,
      } as ContextFragment,
      ...skillFragments,
    ],
  };
}

/**
 * Instructions for the LLM on how to use available skills.
 * Follows Anthropic's progressive disclosure - LLM reads files when needed.
 */
const SKILLS_INSTRUCTIONS = `When a user's request matches one of the skills listed below, read the skill's SKILL.md file to get detailed instructions before proceeding. Skills provide specialized knowledge and workflows for specific tasks.

To use a skill:
1. Identify if the user's request matches a skill's description
2. Read the SKILL.md file at the skill's path to load full instructions
3. Follow the skill's guidance to complete the task

Skills are only loaded when relevant - don't read skill files unless needed.`;
