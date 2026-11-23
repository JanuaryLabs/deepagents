import { join } from 'node:path';

import { MicrosandboxSandboxEnvironment } from '@deepagents/context';
import { defineSandbox } from '@deepagents/experimental/zukhruf';

export default defineSandbox(
  new MicrosandboxSandboxEnvironment({
    namespace: 'zukhruf-self-extending-agent-tree',
    image: 'node:lts',
    workdir: '/agent',
    volumes: () => [
      {
        type: 'bind',
        hostPath: join(import.meta.dirname, '..', '..', 'workspace'),
        containerPath: '/agent/workspace',
        readOnly: false,
      },
      {
        type: 'bind',
        hostPath: join(import.meta.dirname, '..', '..', 'skills'),
        containerPath: '/agent/skills',
        readOnly: false,
      },
    ],
  }),
  { workingDirectory: '/agent', idleTimeoutMs: 30_000 },
);
