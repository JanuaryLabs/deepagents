import { createMicrosandboxSandbox } from '@deepagents/context';
import { defineSandbox } from '@deepagents/experimental/zukhruf';

export default defineSandbox(
  ({ chatId }) =>
    createMicrosandboxSandbox({
      name: `zukhruf-simple-${chatId}`,
      configure: (builder) => builder.image('node:lts').detached(true),
    }),
  {
    uploadDirectory: {
      source: import.meta.dirname,
      include: 'skills/**/*',
    },
  },
);
