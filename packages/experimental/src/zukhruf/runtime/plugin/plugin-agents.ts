import { readFileSync, readdirSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseFrontmatter, role } from '@deepagents/context';

import type { AgentDeclaration } from '../../agent.ts';
import { AgentDeclarationRegistry } from '../../control-plane/agent-declaration-registry.ts';
import type {
  AgentPluginDefinition,
  AgentPluginInstance,
} from '../agent-runtime.ts';

/** Owns plugin-contributed agents, their provenance, and the combined graph. */
export class PluginAgentComposition {
  readonly declarations: AgentDeclarationRegistry;
  readonly owners: ReadonlyMap<string, string>;

  constructor(
    root: AgentDeclaration,
    configuredRoot: AgentDeclaration,
    plugins: readonly {
      readonly definition: AgentPluginDefinition;
      readonly instance: AgentPluginInstance;
    }[],
  ) {
    this.#assertRootPluginComposition(root, configuredRoot);
    this.#assertNoSubagentPlugins(configuredRoot);
    const pluginAgents = this.#loadPluginAgents(
      configuredRoot,
      plugins.flatMap(({ definition, instance }) =>
        instance.agents
          ? [{ plugin: definition.name, directories: instance.agents }]
          : [],
      ),
    );
    if (pluginAgents.declarations.length > 0) {
      configuredRoot = {
        ...configuredRoot,
        subagents: [
          ...(configuredRoot.subagents ?? []),
          ...pluginAgents.declarations,
        ],
      };
    }
    this.declarations = new AgentDeclarationRegistry(configuredRoot);
    this.owners = pluginAgents.owners;
  }

  #assertRootPluginComposition(
    declared: AgentDeclaration,
    configured: AgentDeclaration,
  ): void {
    if (declared.plugins === configured.plugins) return;
    if (
      !declared.plugins ||
      !configured.plugins ||
      declared.plugins.length !== configured.plugins.length ||
      declared.plugins.some(
        (definition, index) => configured.plugins?.[index] !== definition,
      )
    ) {
      throw new Error(
        'AgentRuntime: plugins cannot change the root plugin composition',
      );
    }
  }

  #assertNoSubagentPlugins(root: AgentDeclaration): void {
    const visit = (declaration: AgentDeclaration): void => {
      if (declaration.plugins && declaration.plugins.length > 0) {
        throw new Error(
          `AgentRuntime: subagent "${declaration.name}" cannot declare runtime plugins`,
        );
      }
      for (const subagent of declaration.subagents ?? []) visit(subagent);
    };
    for (const subagent of root.subagents ?? []) visit(subagent);
  }

  #loadPluginAgents(
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
          const declaration = this.#loadAgent(
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

  #loadAgent(
    file: string,
    plugin: string,
    root: AgentDeclaration,
  ): AgentDeclaration {
    const fileName = basename(file);
    let parsed: ReturnType<typeof parseFrontmatter>;
    try {
      parsed = parseFrontmatter(readFileSync(file, 'utf8'));
    } catch (error) {
      throw new Error(`Invalid agent declaration ${fileName}`, {
        cause: error,
      });
    }

    const unknownField = Object.keys(parsed.frontmatter).find(
      (field) =>
        field !== 'name' && field !== 'description' && field !== 'skills',
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
    const skills = parsed.frontmatter.skills;
    if (
      skills !== undefined &&
      (!Array.isArray(skills) ||
        skills.some((skill) => typeof skill !== 'string' || !skill.trim()))
    ) {
      throw new Error(
        `Invalid agent declaration ${fileName}: frontmatter skills must be a list of non-empty strings`,
      );
    }
    if (skills && new Set(skills).size !== skills.length) {
      throw new Error(
        `Invalid agent declaration ${fileName}: frontmatter skills must not contain duplicates`,
      );
    }

    return {
      name: `${plugin}:${parsed.frontmatter.name}`,
      description: parsed.frontmatter.description,
      model: root.model,
      sandbox: root.sandbox,
      instructions: [role(parsed.body)],
      ...(skills ? { skills } : {}),
    };
  }
}
