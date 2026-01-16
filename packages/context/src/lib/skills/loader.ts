import * as fs from 'node:fs';
import * as path from 'node:path';
import YAML from 'yaml';

import type { ParsedSkillMd, SkillMetadata } from './types.ts';

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

/**
 * Load skill metadata from a SKILL.md file.
 * Only parses frontmatter, does not load full body into memory.
 * This is the core of progressive disclosure - metadata only at startup.
 */
export function loadSkillMetadata(skillMdPath: string): SkillMetadata {
  const content = fs.readFileSync(skillMdPath, 'utf-8');
  const parsed = parseFrontmatter(content);
  const skillDir = path.dirname(skillMdPath);

  return {
    name: parsed.frontmatter.name,
    description: parsed.frontmatter.description,
    path: skillDir,
    skillMdPath,
  };
}

/**
 * Discover all skills in a directory.
 * Looks for subdirectories containing SKILL.md files.
 * Only loads metadata - full content is read by LLM when needed.
 */
export function discoverSkillsInDirectory(directory: string): SkillMetadata[] {
  const skills: SkillMetadata[] = [];

  // Expand ~ to home directory
  const expandedDir = directory.startsWith('~')
    ? path.join(process.env.HOME || '', directory.slice(1))
    : directory;
  if (!fs.existsSync(expandedDir)) {
    return skills;
  }

  const entries = fs.readdirSync(expandedDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillMdPath = path.join(expandedDir, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) continue;

    try {
      const metadata = loadSkillMetadata(skillMdPath);
      skills.push(metadata);
    } catch (error) {
      // Skip invalid skills, log warning
      console.warn(`Warning: Failed to load skill at ${skillMdPath}:`, error);
    }
  }

  return skills;
}
