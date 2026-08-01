import path from 'node:path';

import {
  type AvailableSkill,
  type ContextFragment,
  parseFrontmatter,
  skills,
} from '@deepagents/context';

import type { ZukhrufSandbox } from '../agent.ts';

export interface AgentSkills {
  available: readonly AvailableSkill[];
  fragments: readonly ContextFragment[];
}

const EMPTY_SKILLS: AgentSkills = { available: [], fragments: [] };

export async function discoverAgentSkills(
  sandbox: ZukhrufSandbox,
  signal?: AbortSignal,
): Promise<AgentSkills> {
  if (sandbox.workingDirectory === undefined) return EMPTY_SKILLS;
  const skillsDirectory = path.posix.join(sandbox.workingDirectory, 'skills');
  const quotedSkillsDirectory = shellQuote(skillsDirectory);
  const result = await sandbox.sandbox.executeCommand(
    `if [ -d ${quotedSkillsDirectory} ]; then find ${quotedSkillsDirectory} -mindepth 1 -maxdepth 1 -type d -print; fi`,
    { signal },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `AgentRuntime: failed to discover sandbox skills: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
    );
  }

  const skillDirectories = result.stdout
    .split('\n')
    .filter(Boolean)
    .filter((directory) => !path.posix.basename(directory).startsWith('.'))
    .toSorted();
  if (skillDirectories.length === 0) return EMPTY_SKILLS;

  const discovered = await Promise.all(
    skillDirectories.map((directory) => loadSkill(sandbox, directory)),
  );

  return createAgentSkills(discovered);
}

export function createAgentSkills(
  available: readonly AvailableSkill[],
): AgentSkills {
  if (available.length === 0) return EMPTY_SKILLS;
  const snapshot = [...available];
  return { available: snapshot, fragments: [skills(snapshot)] };
}

async function loadSkill(
  sandbox: ZukhrufSandbox,
  directory: string,
): Promise<AvailableSkill> {
  const directoryName = path.posix.basename(directory);
  const skillMd = await sandbox.sandbox.readFile(
    path.posix.join(directory, 'SKILL.md'),
  );
  const { frontmatter } = parseFrontmatter(skillMd);
  if (frontmatter.name !== directoryName) {
    throw new Error(
      `AgentRuntime: skill "${frontmatter.name}" must use matching directory "${directoryName}"`,
    );
  }

  return {
    name: frontmatter.name,
    description: frontmatter.description,
    path: path.posix.join('skills', directoryName, 'SKILL.md'),
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
