import { type ContextFragment, verbatim } from '../fragments.ts';
import type { AvailableSkill } from './types.ts';

/**
 * Create a context fragment from skills the application has made available.
 *
 * Renders Codex's `<skills_instructions>` catalog as written, in every
 * renderer: one `- name: description (file: path)` line per skill, followed by
 * the instructions for reading a skill's `SKILL.md` when it applies. With no
 * skills it renders nothing.
 *
 * Provisioning and discovery belong to the application. This fragment only
 * renders the explicit model-facing metadata it receives. Like every verbatim
 * fragment it renders only at the top level of a context.
 *
 * @example
 * ```ts
 * const availableSkills = [{
 *   name: 'deploy',
 *   description: 'Deploy services to production.',
 *   path: '/skills/deploy/SKILL.md',
 * }];
 * context.set(role('You are a helpful assistant.'), skills(availableSkills));
 * ```
 */
export function skills(availableSkills: AvailableSkill[]): ContextFragment {
  const skillSnapshot = availableSkills.map(({ name, description, path }) => ({
    name,
    description,
    path,
  }));

  if (skillSnapshot.length === 0) {
    return { name: 'skills_instructions', data: [] };
  }

  const skillLines = skillSnapshot.map(({ name, description, path }) =>
    description === ''
      ? `- ${name}: (file: ${path})`
      : `- ${name}: ${description} (file: ${path})`,
  );
  const body = [
    '## Skills',
    SKILLS_INTRO,
    '### Available skills',
    ...skillLines,
    '### How to use skills',
    SKILLS_HOW_TO_USE,
  ].join('\n');

  return {
    ...verbatim(`<skills_instructions>\n${body}\n</skills_instructions>`),
    metadata: { skills: skillSnapshot },
  };
}

/**
 * Codex's `SKILLS_INTRO_WITH_SOURCE_LOCATORS`
 * (codex-rs/ext/skills/src/catalog_prompt.rs), without the locator kinds this
 * catalog never lists (executor package, cloud package, custom resource).
 */
const SKILLS_INTRO =
  'A skill is a set of instructions provided through a `SKILL.md` source. Below is the list of skills that can be used. Each entry includes a name, description, and source locator. `file` locators are on the host filesystem.';

/**
 * Codex's `SKILLS_HOW_TO_USE_WITH_SOURCE_LOCATORS`
 * (codex-rs/ext/skills/src/catalog_prompt.rs), without the clauses that name
 * `skills.read`, `skills.list`, `next_cursor`, package skills or custom
 * resources, none of which this catalog offers.
 */
const SKILLS_HOW_TO_USE = `- Discovery: The list above is the skills available in this session (name + description + source locator). \`file\` entries live on the host filesystem.
- Trigger rules: If the user names a skill (with \`$SkillName\` or plain text) OR the task clearly matches a skill's description shown above, you must use that skill for that turn. Multiple mentions mean use them all. Do not carry skills across turns unless re-mentioned.
- Missing/blocked: If a named skill isn't in the list or its source can't be read, say so briefly and continue with the best fallback.
- How to use a skill (progressive disclosure):
  1) After deciding to use a skill, the main agent must read its \`SKILL.md\` completely before taking task actions. For a \`file\` entry, open the listed path.
  2) When \`SKILL.md\` references another resource, use the same access mechanism.
  3) If \`SKILL.md\` points to extra folders such as \`references/\`, use its routing instructions to identify the resources required for the task. The main agent must read each required instruction or reference file itself before acting on it. Do not delegate reading, summarizing, or interpreting skill instructions to a subagent. Subagents may still perform task work when the selected skill allows it.
  4) For filesystem-backed skills, prefer running or patching provided scripts instead of retyping large code blocks.
  5) Reuse provided assets or templates through the same source access mechanism instead of recreating them.
- Coordination and sequencing:
  - If multiple skills apply, choose the minimal set that covers the request and state the order you'll use them.
  - Announce which skill(s) you're using and why (one short line). If you skip an obvious skill, say why.
- Context hygiene:
  - Progressive disclosure applies to selecting relevant files, not partially reading a selected instruction file. Do not load unrelated references, scripts, or assets.
  - Avoid deep reference-chasing: prefer opening only files directly linked from \`SKILL.md\` unless you're blocked.
  - When variants exist (frameworks, providers, domains), pick only the relevant reference file(s) and note that choice.
- Safety and fallback: If a skill can't be applied cleanly (missing files, unclear instructions), state the issue, pick the next-best approach, and continue.`;
