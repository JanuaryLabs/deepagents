import { AgentRuntime } from '@deepagents/experimental/zukhruf';

import declaration from './agent.ts';

const runtime = new AgentRuntime(declaration);

export default runtime;
