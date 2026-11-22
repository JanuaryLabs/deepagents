import { VirtualSandboxEnvironment } from '@deepagents/context';
import { defineSandbox } from '@deepagents/experimental/zukhruf';

export default defineSandbox(
  new VirtualSandboxEnvironment({ javascript: true }),
  {
    extraInstructions: 'Run JavaScript with js-exec. There is no node command.',
  },
);
