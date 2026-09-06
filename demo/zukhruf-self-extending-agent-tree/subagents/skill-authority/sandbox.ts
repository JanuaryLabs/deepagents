import { join } from 'node:path';

import { createMicrosandboxSandbox } from '@deepagents/context';
import { defineSandbox } from '@deepagents/experimental/zukhruf';

export default defineSandbox(
  () =>
    createMicrosandboxSandbox({
      name: 'zukhruf-self-extending-skill-authority',
      workdir: '/agent',
      configure: (sandbox) =>
        sandbox
          .image('node:lts')
          .detached(true)
          .volume('/agent/workspace', (volume) =>
            volume.bind(join(import.meta.dirname, '..', '..', 'workspace')),
          )
          .volume('/agent/skills', (volume) =>
            volume.bind(join(import.meta.dirname, '..', '..', 'skills')),
          ),
    }),
  { destination: '/agent' },
);
