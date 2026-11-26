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

const MAX_SKILL_NAME_LENGTH = 64;

/** A SKILL.md whose frontmatter Codex's skill parser rejects, with Codex's error text. */
export class SkillParseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SkillParseError';
  }
}

/** The model-facing name and description a SKILL.md declares. */
export interface SkillFrontmatter {
  name: string;
  description: string;
}

/**
 * Parse a SKILL.md's frontmatter as Codex's skill parser does
 * (codex-rs/skills/src/parser.rs): unquoted values that break the YAML are
 * repaired, the name and description are collapsed to one line, a missing or
 * empty name becomes `defaultName`, the name has at most 64 characters, and
 * the description is required.
 *
 * @throws {SkillParseError} with Codex's error text when the file is no skill.
 */
export function parseSkillFrontmatter(
  content: string,
  defaultName: string,
): SkillFrontmatter {
  const frontmatter = extractSkillFrontmatter(content);
  if (frontmatter === undefined) {
    throw new SkillParseError('missing YAML frontmatter delimited by ---');
  }

  const fields = deserializeOrRepair(frontmatter);
  const name = oneLine(fields.name ?? '') || defaultName;
  const description = oneLine(fields.description ?? '');

  if (name === '') {
    throw new SkillParseError('missing field `name`');
  }
  if ([...name].length > MAX_SKILL_NAME_LENGTH) {
    throw new SkillParseError(
      `invalid name: exceeds maximum length of ${MAX_SKILL_NAME_LENGTH} characters`,
    );
  }
  if (description === '') {
    throw new SkillParseError('missing field `description`');
  }

  return { name, description };
}

function extractSkillFrontmatter(content: string): string | undefined {
  const [first, ...rest] = content
    .split('\n')
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  if (first?.trim() !== '---') return undefined;
  const closing = rest.findIndex((line) => line.trim() === '---');
  if (closing <= 0) return undefined;
  return rest.slice(0, closing).join('\n');
}

interface DeserializedSkillFrontmatter {
  name?: string;
  description?: string;
}

/**
 * Some third-party skills use prose like `description: Build for AWS: ECS` or
 * `argument-hint: <duration: e.g. 7d>`. When the frontmatter does not
 * deserialize, Codex quotes such values line by line and retries, and reports
 * the original error when the repaired frontmatter fails too.
 */
function deserializeOrRepair(
  frontmatter: string,
): DeserializedSkillFrontmatter {
  try {
    return deserialize(frontmatter);
  } catch (originalError) {
    if (!(originalError instanceof SkillParseError)) throw originalError;
    const repaired = repairFrontmatterScalarFields(frontmatter);
    if (repaired === undefined) throw originalError;
    try {
      return deserialize(repaired);
    } catch (error) {
      if (!(error instanceof SkillParseError)) throw error;
      throw originalError;
    }
  }
}

function deserialize(frontmatter: string): DeserializedSkillFrontmatter {
  let parsed: unknown;
  try {
    parsed = YAML.parse(frontmatter);
  } catch (error) {
    if (!(error instanceof YAML.YAMLError)) throw error;
    throw new SkillParseError(`invalid YAML: ${error.message}`, {
      cause: error,
    });
  }
  const fields = parsed ?? {};
  if (typeof fields !== 'object' || Array.isArray(fields)) {
    throw new SkillParseError(
      `invalid YAML: invalid type: ${yamlKind(fields)}, expected struct SkillFrontmatter`,
    );
  }
  return {
    name: optionalString(fields, 'name'),
    description: optionalString(fields, 'description'),
  };
}

const WHITESPACE = /^\s$/u;

function repairFrontmatterScalarFields(
  frontmatter: string,
): string | undefined {
  let changed = false;
  let blockScalarIndent: number | undefined;
  const repairedLines: string[] = [];
  for (const line of frontmatter.split('\n')) {
    const indent = /^ */.exec(line)?.[0].length ?? 0;
    if (blockScalarIndent !== undefined) {
      if (line.trim() === '' || indent > blockScalarIndent) {
        repairedLines.push(line);
        continue;
      }
      blockScalarIndent = undefined;
    }

    const colon = line.indexOf(':');
    if (colon === -1) {
      repairedLines.push(line);
      continue;
    }
    const key = line.slice(0, colon);
    const value = line.slice(colon + 1);
    if (key.trim() === '' || (value !== '' && !WHITESPACE.test(value[0]))) {
      repairedLines.push(line);
      continue;
    }

    const trimmedStart = value.trimStart();
    const leadingWhitespace = value.slice(
      0,
      value.length - trimmedStart.length,
    );
    let scalar = trimmedStart;
    let comment = '';
    const commentMarker = /(?<=^|\s)#/u.exec(trimmedStart);
    if (commentMarker !== null) {
      const commentStart = trimmedStart
        .slice(0, commentMarker.index)
        .trimEnd().length;
      scalar = trimmedStart.slice(0, commentStart);
      comment = trimmedStart.slice(commentStart);
    }

    scalar = scalar.trimEnd();
    const firstChar = scalar[0];
    if (firstChar === undefined) {
      repairedLines.push(line);
      continue;
    }
    if (firstChar === '|' || firstChar === '>') {
      blockScalarIndent = indent;
      repairedLines.push(line);
      continue;
    }
    if (firstChar === "'" || firstChar === '"') {
      repairedLines.push(line);
      continue;
    }
    const hasColonSeparator = /:\s/u.test(scalar);
    const invalidFlowLikeScalar =
      '[{@`'.includes(firstChar) && !isValidYaml(scalar);
    if (!hasColonSeparator && !invalidFlowLikeScalar) {
      repairedLines.push(line);
      continue;
    }

    const quotedScalar = `'${scalar.replaceAll("'", "''")}'`;
    repairedLines.push(`${key}:${leadingWhitespace}${quotedScalar}${comment}`);
    changed = true;
  }
  return changed ? repairedLines.join('\n') : undefined;
}

function isValidYaml(source: string): boolean {
  try {
    YAML.parse(source);
    return true;
  } catch (error) {
    if (!(error instanceof YAML.YAMLError)) throw error;
    return false;
  }
}

function optionalString(
  fields: object,
  key: 'name' | 'description',
): string | undefined {
  const value: unknown = Object.getOwnPropertyDescriptor(fields, key)?.value;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new SkillParseError(
      `invalid YAML: ${key}: invalid type: ${yamlKind(value)}, expected a string`,
    );
  }
  return value;
}

function yamlKind(value: unknown): string {
  if (Array.isArray(value)) return 'sequence';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string') return 'string';
  return 'map';
}

function oneLine(raw: string): string {
  return raw.split(/\s+/).filter(Boolean).join(' ');
}

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
