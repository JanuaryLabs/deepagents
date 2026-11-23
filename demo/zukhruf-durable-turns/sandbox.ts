import { DockerSandboxEnvironment } from '@deepagents/context';
import { defineSandbox } from '@deepagents/experimental/zukhruf';

export default defineSandbox(
  new DockerSandboxEnvironment({ namespace: 'zukhruf-durable-turns' }),
  { idleTimeoutMs: 60_000 },
);
