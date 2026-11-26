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
 * The lines follow Codex's CoreCompatible policy: ordered by name, then path;
 * each description cut to 1024 characters (1021 and `...`); and all lines
 * held to Codex's 8000-character budget. Over the budget the descriptions are
 * shortened, then dropped, then skills are left out, and `metadata.warning`
 * carries Codex's warning. `metadata.skills` keeps every skill as given.
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
export function skills(availableSkills: AvailableSkill[]): SkillsFragment {
  const skillSnapshot = availableSkills.map(({ name, description, path }) => ({
    name,
    description,
    path,
  }));
  const { skillLines, omittedCount } = allocateSkillLines(
    skillSnapshot
      .toSorted(
        (left, right) =>
          compareCodeUnits(left.name, right.name) ||
          compareCodeUnits(left.path, right.path),
      )
      .map(({ name, description, path }) => ({
        name,
        description: [...truncateDescription(description)],
        path,
      })),
  );
  const metadata: SkillsFragment['metadata'] = {
    skills: skillSnapshot,
    ...(omittedCount > 0 ? { warning: budgetWarning(omittedCount) } : {}),
  };

  if (skillLines.length === 0) {
    return { name: 'skills_instructions', data: [], metadata };
  }

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
    metadata,
  };
}

/** The fragment skills() returns, with the catalog it was given. */
export interface SkillsFragment extends ContextFragment {
  metadata: {
    /** Every skill skills() was given, in the order given, uncut. */
    skills: AvailableSkill[];
    /** Codex's budget warning, present when the catalog left skills out. */
    warning?: string;
  };
}

/**
 * Codex's character budget for the skill lines when the model's context
 * window is unknown (codex-rs/ext/skills/src/render.rs
 * DEFAULT_SKILL_METADATA_CHAR_BUDGET).
 */
const SKILL_LINES_CHARACTER_BUDGET = 8_000;
const MAX_DESCRIPTION_CHARACTERS = 1_024;
const TRUNCATED_DESCRIPTION_SUFFIX = '...';

interface SkillLine {
  name: string;
  /** The description, one Unicode scalar per element. */
  description: string[];
  path: string;
}

function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function truncateDescription(description: string): string {
  const characters = [...description];
  if (characters.length <= MAX_DESCRIPTION_CHARACTERS) return description;
  return (
    characters
      .slice(
        0,
        MAX_DESCRIPTION_CHARACTERS - TRUNCATED_DESCRIPTION_SUFFIX.length,
      )
      .join('') + TRUNCATED_DESCRIPTION_SUFFIX
  );
}

function renderSkillLine(
  { name, path }: SkillLine,
  description: string,
): string {
  return description === ''
    ? `- ${name}: (file: ${path})`
    : `- ${name}: ${description} (file: ${path})`;
}

/** A line costs its characters and its newline (render.rs metadata_line_cost). */
function lineCost(line: string): number {
  return [...line].length + 1;
}

/**
 * Codex's allocation of the skill lines to the budget (render.rs
 * allocate_skill_lines): every full line when they fit; else every bare line,
 * with the rest of the budget shared over the descriptions one character at
 * a time, round-robin; else bare lines in order while they fit, and the rest
 * left out.
 */
function allocateSkillLines(lines: SkillLine[]): {
  skillLines: string[];
  omittedCount: number;
} {
  const fullLines = lines.map((line) =>
    renderSkillLine(line, line.description.join('')),
  );
  const fullCost = fullLines.reduce((used, line) => used + lineCost(line), 0);
  if (fullCost <= SKILL_LINES_CHARACTER_BUDGET) {
    return { skillLines: fullLines, omittedCount: 0 };
  }

  const bareCosts = lines.map((line) => lineCost(renderSkillLine(line, '')));
  const bareCost = bareCosts.reduce((used, cost) => used + cost, 0);
  if (bareCost <= SKILL_LINES_CHARACTER_BUDGET) {
    const allocated = allocateDescriptionCharacters(
      lines,
      SKILL_LINES_CHARACTER_BUDGET - bareCost,
    );
    return {
      skillLines: lines.map((line, index) =>
        renderSkillLine(
          line,
          line.description.slice(0, allocated[index]).join(''),
        ),
      ),
      omittedCount: 0,
    };
  }

  const skillLines: string[] = [];
  let used = 0;
  for (const [index, line] of lines.entries()) {
    if (used + bareCosts[index] > SKILL_LINES_CHARACTER_BUDGET) continue;
    used += bareCosts[index];
    skillLines.push(renderSkillLine(line, ''));
  }
  return { skillLines, omittedCount: lines.length - skillLines.length };
}

/**
 * render.rs allocate_description_chars: the first character of a description
 * also pays for the space before it.
 */
function allocateDescriptionCharacters(
  lines: SkillLine[],
  budget: number,
): number[] {
  const allocated = lines.map(() => 0);
  let remaining = budget;
  let changed = true;
  while (changed) {
    changed = false;
    for (const [index, line] of lines.entries()) {
      if (allocated[index] >= line.description.length) continue;
      const delta = allocated[index] === 0 ? 2 : 1;
      if (delta > remaining) continue;
      allocated[index] += 1;
      remaining -= delta;
      changed = true;
    }
  }
  return allocated;
}

/** render.rs SkillRenderReport::warning_message. */
function budgetWarning(omittedCount: number): string {
  const skillsWere = omittedCount === 1 ? 'skill was' : 'skills were';
  return `Exceeded skills context budget. All skill descriptions were removed and ${omittedCount} additional ${skillsWere} not included in the model-visible skills list.`;
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
