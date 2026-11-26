import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type AvailableSkill,
  type ContextFragment,
  SkillParseError,
  parseSkillFrontmatter,
  skills,
} from '@deepagents/context';

import type { AgentDeclaration, ZukhrufSandbox } from '../../agent.ts';

export interface AgentSkills {
  available: readonly AvailableSkill[];
  fragments: readonly ContextFragment[];
  /** Codex's skills budget warning when the catalog left skills out. */
  warning: string | undefined;
}

export interface PluginSkills {
  available: readonly AvailableSkill[];
  files: readonly { path: string; content: Buffer }[];
}

const EMPTY_SKILLS: AgentSkills = {
  available: [],
  fragments: [],
  warning: undefined,
};
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
): Promise<AgentSkills> {
  if (sandbox.workingDirectory === undefined) return EMPTY_SKILLS;
  const skillsDirectory = path.posix.join(sandbox.workingDirectory, 'skills');
  const entries = await sandbox.sandbox.listDirectory({
    path: skillsDirectory,
    abortSignal: signal,
  });
  if (entries === null) return EMPTY_SKILLS;

  const skillDirectories = entries
    .filter(({ type, name }) => type === 'directory' && !name.startsWith('.'))
    .map(({ name }) => path.posix.join(skillsDirectory, name))
    .toSorted();
  if (skillDirectories.length === 0) return EMPTY_SKILLS;

  const discovered = await Promise.all(
    skillDirectories.map((directory) => loadSkill(sandbox, directory)),
  );

  return createAgentSkills(discovered.filter((skill) => skill !== undefined));
}

export function createAgentSkills(
  available: readonly AvailableSkill[],
): AgentSkills {
  if (available.length === 0) return EMPTY_SKILLS;
  const snapshot = [...available];
  const fragment = skills(snapshot);
  return {
    available: snapshot,
    fragments: [fragment],
    warning: fragment.metadata.warning,
  };
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
