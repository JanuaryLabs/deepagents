import { realpathSync, statSync } from 'node:fs';
import { join, parse } from 'node:path';

import { DockerSandboxEnvironment } from '@deepagents/context';
import { defineSandbox } from '@deepagents/experimental/zukhruf';

export interface WorkspaceSandboxOptions {
  workspaceDirectory: string;
}

/** Give one durable agent chat an isolated container over the shared host workspace. */
export default function createWorkspaceSandbox(
  options: WorkspaceSandboxOptions,
) {
  const workspaceDirectory = existingDirectory(
    options.workspaceDirectory,
    'workspaceDirectory',
  );

  return defineSandbox(
    new DockerSandboxEnvironment({
      namespace: 'zukhruf-dynamic-subagents',
      dockerfile: join(import.meta.dirname, 'Dockerfile'),
      context: import.meta.dirname,
      container: {
        HostConfig: {
          Memory: 1024 ** 3,
          NanoCpus: 2e9,
          SecurityOpt: ['no-new-privileges'],
        },
      },
      volumes: () => [
        {
          type: 'bind',
          hostPath: workspaceDirectory,
          containerPath: '/agent/workspace',
          readOnly: false,
        },
      ],
    }),
    { workingDirectory: '/agent' },
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
