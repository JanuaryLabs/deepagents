import type { Capability, Guidance } from './capability.ts';
import { createWaitAgentTool } from './wait-agent.ts';
import { WaitBounds } from './wait-bounds.ts';

/** Verbatim Codex guidance (`core/src/session/multi_agents.rs`). */
const PREFER_LONGER_WAITS =
  'When calling `wait_agent`, prefer longer waits (minutes) to avoid busy polling.';

/** Waits for mail from other agents: `wait_agent`, within its bounds. */
export class Waiting implements Capability {
  readonly bounds: WaitBounds;
  readonly tools;

  constructor(bounds = new WaitBounds()) {
    this.bounds = bounds;
    this.tools = {
      wait_agent: createWaitAgentTool({
        minTimeoutMs: bounds.minMs,
        defaultTimeoutMs: bounds.defaultMs,
        maxTimeoutMs: bounds.maxMs,
      }),
    };
  }

  guidance(): Guidance {
    return { outro: PREFER_LONGER_WAITS };
  }
}
