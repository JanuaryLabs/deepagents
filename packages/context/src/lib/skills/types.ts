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
 * A skill path mapping from host filesystem to sandbox mount.
 */
export interface SkillPathMapping {
  /** Original filesystem path where skills are located */
  host: string;
  /** Sandbox mount path that the LLM will use to access skills */
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
   * // Result: skill.data.path = '/skills/skills/dev/SKILL.md'
   * //         skill.metadata.originalPath = 'apps/backend/dist/skills/dev/SKILL.md'
   * ```
   */
  paths: SkillPathMapping[];
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
