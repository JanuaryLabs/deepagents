import type { AvailableSkill } from './types.ts';

/** The `$name` mentions of one text, as Codex reads them (`codex-rs/skills/src/mentions.rs`). */
export interface ToolMentions {
  /** Every name mentioned, plain or linked, except the names of app, MCP and plugin links. */
  names: ReadonlySet<string>;
  /** The trimmed path of every `[$name](path)` link. */
  paths: ReadonlySet<string>;
  /** The names mentioned as plain `$name`. */
  plainNames: ReadonlySet<string>;
}

const SIGIL = '$';
const SKILL_PATH_PREFIX = 'skill://';
const NON_SKILL_LINK_PREFIXES = ['app://', 'mcp://', 'plugin://'];
const COMMON_ENV_VARS = new Set([
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'PWD',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'TERM',
  'XDG_CONFIG_HOME',
]);

/**
 * Extract the `$name` mentions of one text, as Codex does.
 *
 * A name is `[A-Za-z0-9_:-]+` after `$`. A `[$name](path)` link also records
 * its trimmed path; a link without a path is read as a plain `$name`. Common
 * environment variable names (`$PATH`, `$HOME`, …) are dropped in any case,
 * and code spans get no special treatment.
 */
export function extractToolMentions(text: string): ToolMentions {
  const names = new Set<string>();
  const paths = new Set<string>();
  const plainNames = new Set<string>();

  let index = 0;
  while (index < text.length) {
    if (text[index] === '[') {
      const linked = parseLinkedMention(text, index);
      if (linked !== undefined) {
        if (!isCommonEnvVar(linked.name)) {
          if (!isNonSkillLink(linked.path)) names.add(linked.name);
          paths.add(linked.path);
        }
        index = linked.end;
        continue;
      }
    }

    if (text[index] !== SIGIL) {
      index += 1;
      continue;
    }
    const nameEnd = mentionNameEnd(text, index + 1);
    if (nameEnd === index + 1) {
      index += 1;
      continue;
    }
    const name = text.slice(index + 1, nameEnd);
    if (!isCommonEnvVar(name)) {
      names.add(name);
      plainNames.add(name);
    }
    index = nameEnd;
  }

  return { names, paths, plainNames };
}

/**
 * Select the skills the user mentioned explicitly, as Codex does
 * (`codex-rs/skills/src/selection.rs`).
 *
 * Each input is scanned in turn. Its linked paths select first, then its
 * plain names, both in the order of `skills`. A skill is selected once,
 * whether by path or by name. A plain name more than one skill uses selects
 * none of them, and a name no skill has is ignored.
 */
export function collectExplicitSkillMentions(
  inputs: readonly string[],
  skills: readonly AvailableSkill[],
): AvailableSkill[] {
  const nameCounts = new Map<string, number>();
  for (const { name } of skills) {
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }
  const selected: AvailableSkill[] = [];
  const seenPaths = new Set<string>();

  for (const input of inputs) {
    const mentions = extractToolMentions(input);
    const mentionedPaths = new Set(
      [...mentions.paths]
        .filter((path) => !isNonSkillLink(path))
        .map((path) =>
          path.startsWith(SKILL_PATH_PREFIX)
            ? path.slice(SKILL_PATH_PREFIX.length)
            : path,
        ),
    );

    for (const skill of skills) {
      if (seenPaths.has(skill.path) || !mentionedPaths.has(skill.path)) {
        continue;
      }
      seenPaths.add(skill.path);
      selected.push(skill);
    }

    for (const skill of skills) {
      if (
        seenPaths.has(skill.path) ||
        !mentions.plainNames.has(skill.name) ||
        nameCounts.get(skill.name) !== 1
      ) {
        continue;
      }
      seenPaths.add(skill.path);
      selected.push(skill);
    }
  }

  return selected;
}

/**
 * The model-visible text of a selected skill, Codex's `<skill>` block
 * (`codex-rs/ext/skills/src/fragments.rs`): its name, its path and the whole
 * `SKILL.md`, frontmatter included.
 */
export function skillInstructions(skill: {
  name: string;
  path: string;
  contents: string;
}): string {
  return `<skill>\n<name>${skill.name}</name>\n<path>${skill.path}</path>\n${skill.contents}\n</skill>`;
}

function parseLinkedMention(
  text: string,
  start: number,
): { name: string; path: string; end: number } | undefined {
  if (text[start + 1] !== SIGIL) return undefined;
  const nameStart = start + 2;
  const nameEnd = mentionNameEnd(text, nameStart);
  if (nameEnd === nameStart || text[nameEnd] !== ']') return undefined;

  let pathStart = nameEnd + 1;
  while (isAsciiWhitespace(text[pathStart])) pathStart += 1;
  if (text[pathStart] !== '(') return undefined;
  const pathEnd = text.indexOf(')', pathStart + 1);
  if (pathEnd === -1) return undefined;

  const path = text.slice(pathStart + 1, pathEnd).trim();
  if (path === '') return undefined;
  return { name: text.slice(nameStart, nameEnd), path, end: pathEnd + 1 };
}

function mentionNameEnd(text: string, start: number): number {
  let end = start;
  while (end < text.length && /[A-Za-z0-9_:-]/.test(text[end] ?? '')) {
    end += 1;
  }
  return end;
}

function isAsciiWhitespace(character: string | undefined): boolean {
  return (
    character === ' ' ||
    character === '\t' ||
    character === '\n' ||
    character === '\f' ||
    character === '\r'
  );
}

function isCommonEnvVar(name: string): boolean {
  return COMMON_ENV_VARS.has(name.toUpperCase());
}

function isNonSkillLink(path: string): boolean {
  return NON_SKILL_LINK_PREFIXES.some((prefix) => path.startsWith(prefix));
}
