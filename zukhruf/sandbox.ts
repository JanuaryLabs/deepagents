import { createDockerSandbox } from '@deepagents/context';

import { defineSandbox } from './.framework/sandbox/define.ts';

export default defineSandbox(({ chatId }) =>
  createDockerSandbox({ name: chatId }),
);
