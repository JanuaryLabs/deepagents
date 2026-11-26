import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type AvailableSkill,
  type ContextFragment,
  SkillParseError,
  parseSkillFrontmatter,
  skillInstructions,
  skills,
} from '@deepagents/context';

import type { AgentDeclaration, ZukhrufSandbox } from '../../agent.ts';

export interface AgentSkills {
  /** The catalog: the sandbox's skills, then the plugin skills selected for the agent. */
  available: readonly AvailableSkill[];
  /** The plugin skills of `available`, whose injected `SKILL.md` Codex cuts to its prompt limit. */
  plugin: ReadonlySet<AvailableSkill>;
  fragments: readonly ContextFragment[];
  /** Codex's skills budget warning when the catalog left skills out. */
  warning: string | undefined;
}

/** The `<skill>` texts of the selected skills that loaded, and Codex's warning for each that did not or was cut. */
export interface SkillPrompts {
  prompts: { name: string; path: string; text: string }[];
  warnings: string[];
}

export interface PluginSkills {
  available: readonly AvailableSkill[];
  files: readonly { path: string; content: Buffer }[];
}

const EMPTY_SKILLS: AgentSkills = {
  available: [],
  plugin: new Set(),
  fragments: [],
  warning: undefined,
};
/** Codex's `MAX_SKILL_PROMPT_BYTES` (`codex-rs/ext/skills/src/render.rs`). */
const MAX_SKILL_PROMPT_BYTES = 8000;
const EMPTY_PLUGIN_SKILLS: PluginSkills = { available: [], files: [] };

/** A SKILL.md failed to load, so the skills list leaves that skill out. */
class SkillLoadWarning extends Error {
  readonly code = 'DEEPAGENTS_ZUKHRUF_SKILL_LOAD_FAILED';
  readonly detail: string;

  constructor(failure: unknown, skillPath: string) {
    super(
      `Loading skill ${skillPath} failed, and the skills list leaves it out: ${Error.isError(failure) ? failure.message : String(failure)}`,
      { cause: failure },
    );
    this.name = 'SkillLoadWarning';
    this.detail = `skill: ${skillPath}`;
  }
}

/** Collects plugin skill sources and composes validated selections per agent. */
export class PluginSkillComposition {
  readonly #directories: (string | URL)[] = [];

  add(directories: readonly (string | URL)[]): void {
    this.#directories.push(...directories);
  }

  compose(
    declarations: Iterable<AgentDeclaration>,
  ): ReadonlyMap<string, PluginSkills> {
    const catalog = this.#loadPluginSkills();
    return new Map(
      Array.from(declarations, (declaration) => [
        declaration.name,
        this.#selectPluginSkills(
          catalog,
          declaration.skills ?? [],
          declaration.name,
        ),
      ]),
    );
  }

  #loadPluginSkills(): PluginSkills {
    const skillsByName = new Map<string, AvailableSkill>();
    const files: { path: string; content: Buffer }[] = [];

    for (const directory of this.#directories) {
      const directoryPath =
        directory instanceof URL ? fileURLToPath(directory) : directory;
      const directoryName = path.basename(directoryPath);
      const skillPath = path.join(directoryPath, 'SKILL.md');
      let available: AvailableSkill;
      try {
        available = availableSkill(
          readFileSync(skillPath, 'utf8'),
          directoryName,
        );
      } catch (error) {
        if (!(error instanceof SkillParseError) && !isSystemError(error)) {
          throw error;
        }
        process.emitWarning(new SkillLoadWarning(error, skillPath));
        continue;
      }
      if (skillsByName.has(available.name)) {
        throw new Error(
          `AgentRuntime: duplicate plugin skill "${available.name}"`,
        );
      }
      skillsByName.set(available.name, available);

      for (const entry of readdirSync(directoryPath, {
        recursive: true,
        withFileTypes: true,
      })) {
        if (!entry.isFile()) continue;
        const source = path.join(entry.parentPath, entry.name);
        files.push({
          path: path.posix.join(
            'skills',
            directoryName,
            ...path.relative(directoryPath, source).split(path.sep),
          ),
          content: readFileSync(source),
        });
      }
    }

    return {
      available: [...skillsByName.values()],
      files: files.toSorted((left, right) =>
        left.path.localeCompare(right.path),
      ),
    };
  }

  #selectPluginSkills(
    catalog: PluginSkills,
    names: readonly string[],
    agentName: string,
  ): PluginSkills {
    if (names.length === 0) return EMPTY_PLUGIN_SKILLS;
    const selectedNames = new Set(names);
    if (selectedNames.size !== names.length) {
      throw new Error(
        `AgentRuntime: agent "${agentName}" cannot select the same plugin skill more than once`,
      );
    }
    const availableByName = new Map(
      catalog.available.map((available) => [available.name, available]),
    );
    for (const name of names) {
      if (!availableByName.has(name)) {
        throw new Error(
          `AgentRuntime: agent "${agentName}" references unknown plugin skill "${name}"`,
        );
      }
    }
    const available = catalog.available.filter(({ name }) =>
      selectedNames.has(name),
    );
    const directories = new Set(
      available.map(({ path: skillPath }) => path.posix.dirname(skillPath)),
    );
    return {
      available,
      files: catalog.files.filter(({ path: file }) =>
        directories.has(file.split('/', 2).join('/')),
      ),
    };
  }
}

export async function discoverAgentSkills(
  sandbox: ZukhrufSandbox,
  signal?: AbortSignal,
): Promise<AvailableSkill[]> {
  if (sandbox.workingDirectory === undefined) return [];
  const skillsDirectory = path.posix.join(sandbox.workingDirectory, 'skills');
  const entries = await sandbox.sandbox.listDirectory({
    path: skillsDirectory,
    abortSignal: signal,
  });
  if (entries === null) return [];

  const skillDirectories = entries
    .filter(({ type, name }) => type === 'directory' && !name.startsWith('.'))
    .map(({ name }) => path.posix.join(skillsDirectory, name))
    .toSorted();
  const discovered = await Promise.all(
    skillDirectories.map((directory) => loadSkill(sandbox, directory)),
  );
  return discovered.filter((skill) => skill !== undefined);
}

export function createAgentSkills(
  sandboxSkills: readonly AvailableSkill[],
  pluginSkills: readonly AvailableSkill[],
): AgentSkills {
  const snapshot = [...sandboxSkills, ...pluginSkills];
  if (snapshot.length === 0) return EMPTY_SKILLS;
  const fragment = skills(snapshot);
  return {
    available: snapshot,
    plugin: new Set(pluginSkills),
    fragments: [fragment],
    warning: fragment.metadata.warning,
  };
}

/**
 * Read the selected skills' `SKILL.md` from the sandbox, as Codex's
 * `load_skill_prompts` does (`codex-rs/ext/skills/src/host_prompt.rs`): a
 * plugin skill is cut to 8000 bytes with Codex's warning, and a `SKILL.md`
 * that is gone leaves its skill out with Codex's warning. A sandbox that
 * fails to read rejects.
 */
export async function loadSkillPrompts(
  agentSkills: AgentSkills,
  selected: readonly AvailableSkill[],
  sandbox: ZukhrufSandbox,
): Promise<SkillPrompts> {
  const loaded: SkillPrompts = { prompts: [], warnings: [] };
  if (selected.length === 0) return loaded;
  const workingDirectory = sandbox.workingDirectory;
  if (workingDirectory === undefined) {
    throw new Error('AgentRuntime: skills require a sandbox workingDirectory');
  }
  const contents = await Promise.all(
    selected.map((skill) =>
      sandbox.sandbox.readTextFile({
        path: path.posix.join(workingDirectory, skill.path),
      }),
    ),
  );
  for (const [index, skill] of selected.entries()) {
    const skillMd = contents[index];
    if (skillMd === null || skillMd === undefined) {
      loaded.warnings.push(
        `Failed to load skill ${skill.name} at ${skill.path}: No such file or directory (os error 2)`,
      );
      continue;
    }
    const prompt = agentSkills.plugin.has(skill)
      ? truncateUtf8ToBytes(skillMd, MAX_SKILL_PROMPT_BYTES)
      : skillMd;
    if (prompt.length < skillMd.length) {
      loaded.warnings.push(
        `Skill \`${skill.name}\` exceeded the main prompt context limit and was truncated.`,
      );
    }
    loaded.prompts.push({
      name: skill.name,
      path: skill.path,
      text: skillInstructions({
        name: skill.name,
        path: skill.path,
        contents: prompt,
      }),
    });
  }
  return loaded;
}

/** Codex's `truncate_utf8_to_bytes`: the longest prefix of at most `maxBytes` UTF-8 bytes that ends on a character boundary. */
function truncateUtf8ToBytes(contents: string, maxBytes: number): string {
  const bytes = Buffer.from(contents);
  if (bytes.length <= maxBytes) return contents;
  let end = maxBytes;
  while (((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

/** Codex discovers a skill by its SKILL.md, so a directory without one is no skill. */
async function loadSkill(
  sandbox: ZukhrufSandbox,
  directory: string,
): Promise<AvailableSkill | undefined> {
  const skillPath = path.posix.join(directory, 'SKILL.md');
  const skillMd = await sandbox.sandbox.readTextFile({ path: skillPath });
  if (skillMd === null) return undefined;
  try {
    return availableSkill(skillMd, path.posix.basename(directory));
  } catch (error) {
    if (!(error instanceof SkillParseError)) throw error;
    process.emitWarning(new SkillLoadWarning(error, skillPath));
    return undefined;
  }
}

/** A failed read of a SKILL.md, which Codex skips as a load failure (ext/skills/src/loader/host.rs). */
function isSystemError(error: unknown): error is NodeJS.ErrnoException {
  return Error.isError(error) && 'syscall' in error;
}

function availableSkill(
  skillMd: string,
  directoryName: string,
): AvailableSkill {
  const { name, description } = parseSkillFrontmatter(
    skillMd,
    defaultSkillName(directoryName),
  );
  return {
    name,
    description,
    path: path.posix.join('skills', directoryName, 'SKILL.md'),
  };
}

/** ext/skills/src/loader/host.rs default_skill_name. */
function defaultSkillName(directoryName: string): string {
  return directoryName.split(/\s+/).filter(Boolean).join(' ') || 'skill';
}
