/** Model-facing metadata for a skill the application has made available. */
export interface AvailableSkill {
  /** Skill name shown to the model. */
  name: string;
  /** Short description used to decide when the skill applies. */
  description: string;
  /** Path to the SKILL.md file as seen by the model's file tools. */
  path: string;
}

/**
 * Result of parsing a SKILL.md file.
 */
export interface ParsedSkillMd {
  /** Parsed frontmatter */
  frontmatter: {
    name: string;
    description: string;
    [key: string]: unknown;
  };
  /** Markdown body after frontmatter */
  body: string;
}
