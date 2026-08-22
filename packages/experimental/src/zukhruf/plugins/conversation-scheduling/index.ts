import type {
  AgentPluginHost,
  AgentRuntimePlugin,
} from '../../runtime/agent-runtime.ts';
import {
  ConversationScheduler,
  type SchedulingWake,
} from './conversation-scheduler.ts';
import { createSchedulingTools } from './tools.ts';
import type { WakeScheduler } from './wake-scheduler.ts';

export * from './pg-boss.wake-scheduler.ts';
export * from './wake-scheduler.ts';
export type { SchedulingWake } from './conversation-scheduler.ts';

export interface ConversationSchedulingOptions {
  scheduler: WakeScheduler<SchedulingWake>;
  timezone: string;
}

/** Install durable agent-created schedules into every agent in one runtime. */
export function conversationScheduling(
  options: ConversationSchedulingOptions,
): AgentRuntimePlugin {
  let host: AgentPluginHost | undefined;
  const requireHost = (): AgentPluginHost => {
    if (!host) {
      throw new Error(
        'conversation-scheduling plugin must be initialized before use',
      );
    }
    return host;
  };
  const scheduler = new ConversationScheduler({
    scheduler: options.scheduler,
    host: requireHost,
    timezone: options.timezone,
  });

  return {
    name: 'conversation-scheduling',
    tools: createSchedulingTools(scheduler),
    async initialize(runtimeHost) {
      if (host && host !== runtimeHost) {
        throw new Error(
          'conversation-scheduling plugin cannot be shared by AgentRuntime instances',
        );
      }
      host = runtimeHost;
    },
    work: () => scheduler.work(),
    conversationAvailable: (_host, conversation) =>
      scheduler.materializeDueIfEligible(conversation),
  };
}
