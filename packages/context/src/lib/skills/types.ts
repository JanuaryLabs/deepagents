/**
 * Skill metadata parsed from SKILL.md frontmatter.
 * This is what gets loaded into context at startup.
 * Full skill content is read by LLM when needed (progressive disclosure).
 */
export interface SkillMetadata {
  /** Skill name from frontmatter */
  name: string;
  /** Skill description from frontmatter */
  description: string;
  /** Full path to the skill directory */
  path: string;
  /** Full path to the SKILL.md file */
  skillMdPath: string;
}

/**
 * Individual skill mount emitted by sandbox factories and consumed by the
 * `skills()` fragment.
 */
export interface SkillPathMapping {
  name: string;
  description: string;
  /** Host filesystem path to SKILL.md */
  host: string;
  /** Sandbox path to SKILL.md */
  sandbox: string;
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
