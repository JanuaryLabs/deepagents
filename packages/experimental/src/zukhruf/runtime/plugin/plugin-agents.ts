import { readFileSync, readdirSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseFrontmatter, role } from '@deepagents/context';

import type { AgentDeclaration } from '../../agent.ts';

export function loadPluginAgents(
  root: AgentDeclaration,
  sources: readonly {
    readonly plugin: string;
    readonly directories: readonly (string | URL)[];
  }[],
) {
  const declarations: AgentDeclaration[] = [];
  const owners = new Map<string, string>();

  for (const { plugin, directories } of sources) {
    if (directories.length > 0 && plugin.includes(':')) {
      throw new Error(
        `AgentRuntime: plugin "${plugin}" cannot contribute agents because its name contains ":"`,
      );
    }
    for (const directory of directories) {
      const directoryPath =
        directory instanceof URL ? fileURLToPath(directory) : directory;
      const files = readdirSync(directoryPath, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isFile() &&
            !entry.name.startsWith('.') &&
            extname(entry.name) === '.md',
        )
        .toSorted((left, right) => left.name.localeCompare(right.name));

      for (const entry of files) {
        const declaration = loadAgent(
          join(directoryPath, entry.name),
          plugin,
          root,
        );
        if (owners.has(declaration.name)) {
          throw new Error(
            `AgentRuntime: duplicate agent declaration name "${declaration.name}"`,
          );
        }
        owners.set(declaration.name, plugin);
        declarations.push(declaration);
      }
    }
  }

  return { declarations, owners };
}

function loadAgent(
  file: string,
  plugin: string,
  root: AgentDeclaration,
): AgentDeclaration {
  const fileName = basename(file);
  let parsed: ReturnType<typeof parseFrontmatter>;
  try {
    parsed = parseFrontmatter(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid agent declaration ${fileName}`, { cause: error });
  }

  const unknownField = Object.keys(parsed.frontmatter).find(
    (field) => field !== 'name' && field !== 'description',
  );
  if (unknownField) {
    throw new Error(
      `Invalid agent declaration ${fileName}: unknown frontmatter field "${unknownField}"`,
    );
  }
  if (parsed.frontmatter.name.includes(':')) {
    throw new Error(
      `Invalid agent declaration ${fileName}: frontmatter name must not contain ":"`,
    );
  }
  if (fileName !== `${parsed.frontmatter.name}.md`) {
    throw new Error(
      `Invalid agent declaration ${fileName}: frontmatter name must match the filename`,
    );
  }
  if (!parsed.body) {
    throw new Error(
      `Invalid agent declaration ${fileName}: instructions cannot be empty`,
    );
  }

  return {
    name: `${plugin}:${parsed.frontmatter.name}`,
    description: parsed.frontmatter.description,
    model: root.model,
    sandbox: root.sandbox,
    instructions: [role(parsed.body)],
  };
}
