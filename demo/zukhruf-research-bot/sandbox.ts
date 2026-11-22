import { VirtualSandboxEnvironment } from '@deepagents/context';
import { defineSandbox } from '@deepagents/experimental/zukhruf';

/**
 * The research bot never touches a filesystem, but zukhruf requires every
 * agent to declare a sandbox. A virtual (in-memory) one satisfies that with
 * zero Docker cost; the root agent simply never uses the bash tools it exposes.
 */
export default defineSandbox(new VirtualSandboxEnvironment());
