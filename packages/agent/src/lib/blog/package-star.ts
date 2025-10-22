import { groq } from '@ai-sdk/groq';
import { tool } from 'ai';
import fs, { glob } from 'node:fs/promises';
import path from 'node:path';
import z from 'zod';

import { type Agent, agent, instructions } from '../agent.ts';
import { messageToUiMessage, printer } from '../stream_utils.ts';
import { execute } from '../swarm.ts';

export const SYSTEM_PROMPT = `
You are a multifunctional package.json analysis swarm arranged in a star topology.
Your job is to collaborate through a structured, multi-step process to discover, analyze, and report on all package.json files in this monorepo. Follow the instructions of the currently active agent precisely.

Strict rules:
- Read-only only. Never install, publish, or make network calls unless the user explicitly requests it.
- Prefer concise, actionable findings.
- When a sub-agent returns without producing the required tagged output, the manager must send it back to produce results.
`.trim();

// ---------- Shared FS helpers (read-only) ----------
const ROOT_DIR = path.resolve(process.cwd());

function ensureInsideRoot(p: string) {
  const abs = path.resolve(p);
  if (!abs.startsWith(ROOT_DIR)) {
    throw new Error('Path escapes repository root');
  }
  return abs;
}

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.turbo',
  '.next',
  '.output',
  'coverage',
  'out',
  'target',
  'tmp',
  'tmp/',
  'temp',
  '.cache',
  '.husky',
  '.swc',
]);

// walker removed; using fs.promises.glob instead

// ---------- Tools (read-only) ----------
const list_packages_tool = tool({
  description:
    'Discover all package.json files and return compact metadata for analysis (read-only).',
  inputSchema: z.object({
    baseDir: z
      .string()
      .default('.')
      .describe('Base directory to start discovery, relative to repo root.'),
    includePrivate: z
      .boolean()
      .default(true)
      .describe('Whether to include private packages.'),
    limit: z
      .number()
      .int()
      .positive()
      .max(5000)
      .default(5000)
      .describe('Safety cap on number of packages to return.'),
  }),
  execute: async ({ baseDir, includePrivate, limit }) => {
    const start = ensureInsideRoot(path.resolve(ROOT_DIR, baseDir));
    const pattern = path.join(start, '**/package.json');
    const results: any[] = [];
    for await (const abs of glob(pattern)) {
      // Manual ignore for common build/vendor folders
      const parts = abs.split(path.sep);
      let skip = false;
      for (const ign of IGNORED_DIRS) {
        if (parts.includes(ign)) {
          skip = true;
          break;
        }
      }
      if (skip) continue;
      try {
        const raw = await fs.readFile(abs, 'utf8');
        const json = JSON.parse(raw);
        if (includePrivate === false && json?.private) continue;
        const rel = path.relative(ROOT_DIR, abs);
        results.push({
          path: rel,
          name: json?.name,
          version: json?.version,
          private: !!json?.private,
          packageManager: json?.packageManager,
          engines: json?.engines,
          type: json?.type,
          main: json?.main,
          module: json?.module,
          types: json?.types,
          exports: json?.exports,
          sideEffects: json?.sideEffects,
          publishConfig: json?.publishConfig,
          workspaces: json?.workspaces,
          scripts: json?.scripts ? Object.keys(json.scripts) : undefined,
          deps: json?.dependencies ? Object.keys(json.dependencies) : undefined,
          devDeps: json?.devDependencies
            ? Object.keys(json.devDependencies)
            : undefined,
          peerDeps: json?.peerDependencies
            ? Object.keys(json.peerDependencies)
            : undefined,
          optionalDeps: json?.optionalDependencies
            ? Object.keys(json.optionalDependencies)
            : undefined,
        });
        if (results.length >= limit) break;
      } catch {
        // ignore invalid json files
      }
    }
    return { json: results } as any;
  },
});

const read_package_json_tool = tool({
  description:
    'Read and return the full JSON of a specific package.json (read-only).',
  inputSchema: z.object({
    packageJsonPath: z
      .string()
      .describe('Path to package.json relative to repo root.'),
  }),
  execute: async ({ packageJsonPath }) => {
    const abs = ensureInsideRoot(path.resolve(ROOT_DIR, packageJsonPath));
    if (!abs.endsWith('package.json')) {
      throw new Error('Only package.json files can be read.');
    }
    const raw = await fs.readFile(abs, 'utf8');
    const json = JSON.parse(raw);
    const rel = path.relative(ROOT_DIR, abs);
    return { json: { path: rel, json } } as any;
  },
});

// ---------- Sub-agents ----------
const discoveryAgent = agent({
  model: groq('openai/gpt-oss-20b'),
  name: 'pkg_discovery_agent',
  handoffDescription:
    'Finds all package.json files and returns a compact list for further analysis.',
  prompt: instructions.supervisor_subagent({
    purpose: [
      SYSTEM_PROMPT,
      'Discover all package.json files in the repository and output a compact list for downstream agents.',
    ],
    routine: [
      'Use list_packages to gather data.',
      'Output the results in <packages></packages> as JSON array.',
      'transfer_to_manager_agent',
    ],
  }),
  tools: {
    list_packages: list_packages_tool,
    read_package_json: read_package_json_tool,
  },
  handoffs: [() => managerAgent],
});

const scriptsAgent = agent({
  model: groq('openai/gpt-oss-20b'),
  name: 'pkg_scripts_agent',
  handoffDescription:
    'Analyzes scripts across all packages, flags duplicates, risks, and dead scripts.',
  prompt: instructions.supervisor_subagent({
    purpose: [
      SYSTEM_PROMPT,
      'Analyze scripts from discovered packages; detect duplicates, conflicts, and suspicious lifecycle hooks. Suggest concise improvements.',
    ],
    routine: [
      'If <packages> is missing, ask manager_agent to first route to pkg_discovery_agent.',
      'Rely solely on the previously returned <packages> JSON for analysis; do not use tools.',
      'Produce findings in <scripts_report></scripts_report>.',
      'transfer_to_manager_agent',
    ],
  }),

  handoffs: [() => managerAgent],
});

const depsAgent = agent({
  model: groq('openai/gpt-oss-20b'),
  name: 'pkg_deps_agent',
  handoffDescription:
    'Audits dependencies, devDependencies, peerDependencies across the workspace.',
  prompt: instructions.supervisor_subagent({
    purpose: [
      SYSTEM_PROMPT,
      'Detect version skew, duplicate ranges, peer mismatches, and misplaced deps vs devDeps. Propose minimal alignment steps.',
    ],
    routine: [
      'Use <packages> JSON to compare versions across packages and detect skew.',
      'Do not use any tools; if details are missing, ask manager_agent to route discovery again.',
      'Output <deps_report></deps_report> with concrete suggestions.',
      'transfer_to_manager_agent',
    ],
  }),

  handoffs: [() => managerAgent],
});

const metadataAgent = agent({
  model: groq('openai/gpt-oss-20b'),
  name: 'pkg_metadata_agent',
  handoffDescription:
    'Checks metadata hygiene: license, repository, bugs, author, engines, packageManager.',
  prompt: instructions.supervisor_subagent({
    purpose: [
      SYSTEM_PROMPT,
      'Ensure each package has appropriate metadata fields and that packageManager/engines align with the toolchain.',
    ],
    routine: [
      'Use <packages> overview; if gaps exist, ask manager_agent to re-run discovery.',
      'Report issues and suggested patches in <metadata_report></metadata_report>.',
      'transfer_to_manager_agent',
    ],
  }),

  handoffs: [() => managerAgent],
});

const publishabilityAgent = agent({
  model: groq('openai/gpt-oss-20b'),
  name: 'pkg_publishability_agent',
  handoffDescription:
    'Evaluates library publish readiness: exports map, types, files, sideEffects, publishConfig.',
  prompt: instructions.supervisor_subagent({
    purpose: [
      SYSTEM_PROMPT,
      'Assess which packages are publishable and what is missing for clean publishing. Keep suggestions minimal and safe.',
    ],
    routine: [
      'Use <packages> JSON produced by discovery; do not use tools.',
      'Output <publishability_report></publishability_report> with missing fields and proposed minimal diffs (descriptive only).',
      'transfer_to_manager_agent',
    ],
  }),

  handoffs: [() => managerAgent],
});

const reporterAgent = agent({
  model: groq('openai/gpt-oss-20b'),
  name: 'pkg_reporter_agent',
  handoffDescription:
    'Compiles sub-agent outputs into a final, concise report for the user.',
  prompt: instructions.supervisor_subagent({
    purpose: [
      'Aggregate all previous reports into a single final report with prioritized actions.',
    ],
    routine: [
      'Merge <scripts_report>, <deps_report>, <metadata_report>, <publishability_report>.',
      'Produce <final></final> with a short executive summary and a checklist.',
      'transfer_to_manager_agent',
    ],
  }),
  handoffs: [() => managerAgent],
});

// ---------- Manager (star center) ----------
export const managerAgent: Agent = agent({
  model: groq('openai/gpt-oss-20b'),
  name: 'pkg_manager_agent',
  prompt: instructions.supervisor({
    purpose: [
      SYSTEM_PROMPT,
      'Coordinate the package.json analysis by delegating to specialized agents based on the mandatory sequence.',
      'Do not perform the analysis yourself; only orchestrate and ensure each step yields the required tagged output.',
    ],
    routine: [
      'MANDATORY EXECUTION SEQUENCE:',
      'pkg_manager_agent → pkg_discovery_agent (MUST complete)',
      'pkg_discovery_agent → pkg_manager_agent (MUST return)',
      'pkg_manager_agent → pkg_scripts_agent (MUST forward)',
      'pkg_scripts_agent → pkg_manager_agent (MUST return)',
      'pkg_manager_agent → pkg_deps_agent (MUST forward)',
      'pkg_deps_agent → pkg_manager_agent (MUST return)',
      'pkg_manager_agent → pkg_metadata_agent (MUST forward)',
      'pkg_metadata_agent → pkg_manager_agent (MUST return)',
      'pkg_manager_agent → pkg_publishability_agent (MUST forward)',
      'pkg_publishability_agent → pkg_manager_agent (MUST return)',
      'pkg_manager_agent → pkg_reporter_agent (MUST forward)',
      'pkg_reporter_agent → pkg_manager_agent (MUST return)',
      'IF pkg_reporter_agent returns <final>…</final>: pkg_manager_agent → user (deliver final report)',
      'If any sub-agent returns without producing the required tag, send it back with explicit instruction to produce it.',
    ],
  }),
  handoffs: [
    discoveryAgent,
    scriptsAgent,
    depsAgent,
    metadataAgent,
    publishabilityAgent,
    reporterAgent,
  ],
});

const response = execute(
  managerAgent,
  [messageToUiMessage(`“Which packages miss license or repository fields?”`)],
  {},
);

await printer.stdout(response);
