import YAML from 'yaml';
import { z } from 'zod';

import type { ParsedSkillMd } from './types.ts';

const MISSING_NAME = 'Invalid SKILL.md: frontmatter must have a "name" field';
const MISSING_DESCRIPTION =
  'Invalid SKILL.md: frontmatter must have a "description" field';

const frontmatterSchema = z.looseObject(
  {
    name: z.string({ error: MISSING_NAME }).min(1, { error: MISSING_NAME }),
    description: z
      .string({ error: MISSING_DESCRIPTION })
      .min(1, { error: MISSING_DESCRIPTION }),
  },
  { error: MISSING_NAME },
);

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
  const parsed = frontmatterSchema.safeParse(YAML.parse(yamlContent));
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0].message);
  }

  return {
    frontmatter: parsed.data,
    body: body.trim(),
  };
}
