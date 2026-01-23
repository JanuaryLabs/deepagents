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
 * Individual skill mount with name.
 * Output from getSkillMounts().
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
 * Options for the skills() fragment helper.
 */
export interface SkillsFragmentOptions {
  /**
   * Skill directories to scan, with host-to-sandbox path mapping.
   *
   * @example
   * ```ts
   * skills({
   *   paths: [
   *     { host: 'apps/backend/dist/skills', sandbox: '/skills/skills' }
   *   ]
   * })
   * ```
   */
  paths: { host: string; sandbox: string }[];
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
