import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { parse } from 'node:path';

import { createDockerSandbox, pkg } from '@deepagents/context';
import { defineSandbox } from '@deepagents/experimental/zukhruf';

export function createTreeSandboxes(options: {
  workspaceDirectory: string;
  skillsDirectory: string;
}) {
  const workspaceDirectory = existingDirectory(
    options.workspaceDirectory,
    'workspaceDirectory',
  );
  const skillsDirectory = existingDirectory(
    options.skillsDirectory,
    'skillsDirectory',
  );

  const sandbox = (role: string, volumes: ReturnType<typeof bind>[]) =>
    defineSandbox(
      ({ chatId }) =>
        createDockerSandbox({
          name: `zukhruf-agent-tree-${role}-${createHash('sha256')
            .update(chatId)
            .digest('hex')
            .slice(0, 16)}`,
          image: 'bash:5.3-alpine3.24',
          init: true,
          installers: [pkg(['git', 'nodejs', 'npm', 'ripgrep'])],
          security: { securityOpt: ['no-new-privileges'] },
          volumes,
        }),
      { destination: '/agent' },
    );

  return {
    root: sandbox('root', [
      bind(workspaceDirectory, '/agent/workspace', true),
      bind(skillsDirectory, '/agent/skills', true),
    ]),
    skillAuthority: sandbox('skill-authority', [
      bind(skillsDirectory, '/agent/skills', false),
    ]),
    generalTask: sandbox('general-task', [
      bind(workspaceDirectory, '/agent/workspace', false),
      bind(skillsDirectory, '/agent/skills', true),
    ]),
  };
}

function bind(hostPath: string, containerPath: string, readOnly: boolean) {
  return {
    type: 'bind' as const,
    hostPath,
    containerPath,
    readOnly,
  };
}

function existingDirectory(value: string, name: string): string {
  const directory = realpathSync(value);
  if (!statSync(directory).isDirectory()) {
    throw new Error(`${name} must be a directory`);
  }
  if (directory === parse(directory).root) {
    throw new Error(`${name} cannot be the filesystem root`);
  }
  return directory;
}
