import { createDockerSandbox } from '@deepagents/context';
import { defineSandbox } from '@deepagents/experimental/zukhruf';

export default defineSandbox(({ chatId }) =>
  createDockerSandbox({ name: chatId }),
);
