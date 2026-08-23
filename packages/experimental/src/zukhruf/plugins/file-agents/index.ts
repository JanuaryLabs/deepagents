import { readFileSync, readdirSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseFrontmatter, role } from '@deepagents/context';

import {
  type AgentDeclaration,
  type AgentPluginDefinition,
} from '../../index.ts';

export function fileAgents({
  directory,
}: {
  directory: string | URL;
}): AgentPluginDefinition {
  return {
    name: 'file-agents',
    create: () => ({
      configure(root) {
        const path =
          directory instanceof URL ? fileURLToPath(directory) : directory;
        const discovered = readdirSync(path, { withFileTypes: true })
          .filter(
            (entry) =>
              entry.isFile() &&
              !entry.name.startsWith('.') &&
              extname(entry.name) === '.md',
          )
          .toSorted((left, right) => left.name.localeCompare(right.name))
          .map((entry) => loadAgent(join(path, entry.name), root));

        return {
          ...root,
          subagents: [...(root.subagents ?? []), ...discovered],
        };
      },
    }),
  };
}

function loadAgent(file: string, root: AgentDeclaration): AgentDeclaration {
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
    name: parsed.frontmatter.name,
    description: parsed.frontmatter.description,
    model: root.model,
    sandbox: root.sandbox,
    instructions: [role(parsed.body)],
  };
}
