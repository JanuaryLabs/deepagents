import type { Sandbox } from 'bash-tool';
import * as path from 'node:path';

import { discoverSkillsInDirectory } from '../skills/loader.ts';
import type { SkillPathMapping } from '../skills/types.ts';
import type { SkillUploadInput } from './types.ts';
import { walkDirectory } from './walk.ts';

function expandHome(input: string): string {
  if (!input.startsWith('~')) return input;
  const home = process.env.HOME ?? '';
  return path.join(home, input.slice(1));
}

function joinSandbox(base: string, relative: string): string {
  if (!relative) return base;
  const normalizedBase = base.endsWith('/') ? base.slice(0, -1) : base;
  return `${normalizedBase}/${relative}`;
}

/**
 * Discover skills under each host directory, write all non-dotfile, non-symlink
 * files into the sandbox under the mapped path, and return the discovered
 * skill metadata with sandbox paths.
 *
 * Later inputs override earlier ones when the same skill name appears twice.
 * Files with the same sandbox path are overwritten in order, so the last
 * writer wins.
 */
export async function uploadSkills(
  sandbox: Sandbox,
  inputs: SkillUploadInput[],
): Promise<SkillPathMapping[]> {
  if (inputs.length === 0) return [];

  const discoveredByName = new Map<string, SkillPathMapping>();
  const filesToUpload: { path: string; content: string | Buffer }[] = [];

  for (const { host, sandbox: sandboxBase } of inputs) {
    const absoluteHost = path.resolve(expandHome(host));

    for (const skill of discoverSkillsInDirectory(host)) {
      const absoluteSkillMd = path.resolve(skill.skillMdPath);
      const relative = path
        .relative(absoluteHost, absoluteSkillMd)
        .split(path.sep)
        .join('/');
      discoveredByName.set(skill.name, {
        name: skill.name,
        description: skill.description,
        host: skill.skillMdPath,
        sandbox: joinSandbox(sandboxBase, relative),
      });
    }

    const walked = await walkDirectory(host);
    for (const file of walked) {
      filesToUpload.push({
        path: joinSandbox(sandboxBase, file.relativePath),
        content: file.content,
      });
    }
  }

  if (filesToUpload.length > 0) {
    await sandbox.writeFiles(filesToUpload);
  }

  return Array.from(discoveredByName.values());
}
