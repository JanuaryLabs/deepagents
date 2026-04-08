import { lmstudio } from '@deepagents/agent';

import { runAgent } from './agent.ts';
import { Bridge } from './bridge.ts';

// Redirect console.log to stderr so stdout stays clean for JSON protocol.
// The agent() from @deepagents/context logs tool calls to stdout via console.log.
const originalLog = console.log;
console.log = (...args: unknown[]) => console.error(...args);

const bridge = new Bridge();
const start = await bridge.waitForStart();

const modelName = process.env['LMS_MODEL'] ?? 'qwen3.5-4b';
const model = lmstudio.chatModel(modelName);

await runAgent(start.instruction, bridge, model);
