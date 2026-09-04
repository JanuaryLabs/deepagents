import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { parse } from 'node:path';

import { createDockerSandbox, pkg } from '@deepagents/context';
import { defineSandbox } from '@deepagents/experimental/zukhruf';

export interface WorkspaceSandboxOptions {
  workspaceDirectory: string;
}

/** Give one durable agent chat an isolated container over the shared host workspace. */
export function createWorkspaceSandbox(options: WorkspaceSandboxOptions) {
  const workspaceDirectory = existingDirectory(
    options.workspaceDirectory,
    'workspaceDirectory',
  );

  return defineSandbox(
    ({ chatId }) =>
      createDockerSandbox({
        name: `zukhruf-dynamic-subagents-${createHash('sha256')
          .update(chatId)
          .digest('hex')
          .slice(0, 16)}`,
        image: 'bash:5.3-alpine3.24',
        init: true,
        installers: [pkg(['git', 'nodejs', 'npm', 'ripgrep'])],
        security: { securityOpt: ['no-new-privileges'] },
        volumes: [
          {
            type: 'bind',
            hostPath: workspaceDirectory,
            containerPath: '/agent/workspace',
            readOnly: false,
          },
        ],
      }),
    { destination: '/agent' },
  );
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
