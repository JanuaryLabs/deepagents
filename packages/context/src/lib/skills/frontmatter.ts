import YAML from 'yaml';

import type { ParsedSkillMd } from './types.ts';

/**
 * Parse YAML frontmatter from a SKILL.md file content.
 *
 * Frontmatter format:
 * ```
 * ---
 * name: skill-name
 * description: Skill description here
 * ---
 *
 * # Markdown body
 * ```
 */
export function parseFrontmatter(content: string): ParsedSkillMd {
  const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    throw new Error('Invalid SKILL.md: missing or malformed frontmatter');
  }

  const [, yamlContent, body] = match;
  const frontmatter = YAML.parse(yamlContent) as Record<string, unknown>;

  if (!frontmatter.name || typeof frontmatter.name !== 'string') {
    throw new Error('Invalid SKILL.md: frontmatter must have a "name" field');
  }

  if (!frontmatter.description || typeof frontmatter.description !== 'string') {
    throw new Error(
      'Invalid SKILL.md: frontmatter must have a "description" field',
    );
  }

  return {
    frontmatter: frontmatter as ParsedSkillMd['frontmatter'],
    body: body.trim(),
  };
}
