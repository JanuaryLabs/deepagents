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
 * Options for the skills() fragment helper.
 */
export interface SkillsFragmentOptions {
  /** Directories to scan for skills (required) */
  paths: string[];
  /** Skill names to exclude from the fragment */
  exclude?: string[];
  /** Skill names to include (if set, only these are included) */
  include?: string[];
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
