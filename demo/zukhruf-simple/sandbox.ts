import { MicrosandboxSandboxEnvironment } from '@deepagents/context';
import { defineSandbox } from '@deepagents/experimental/zukhruf';

export default defineSandbox(
  new MicrosandboxSandboxEnvironment({
    namespace: 'zukhruf-simple',
    image: 'node:lts',
  }),
  {
    uploadDirectory: {
      source: import.meta.dirname,
      include: 'skills/**/*',
    },
  },
);
