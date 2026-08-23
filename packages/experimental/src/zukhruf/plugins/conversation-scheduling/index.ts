import {
  AgentPluginCapability,
  type AgentPluginDefinition,
  type AgentPluginHost,
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

export const conversationSchedulingCapabilities = {
  scheduler: new AgentPluginCapability<WakeScheduler<SchedulingWake>>(
    'conversation-scheduling.scheduler',
  ),
  timezone: new AgentPluginCapability<string>(
    'conversation-scheduling.timezone',
  ),
} as const;

/** Install durable agent-created schedules into every agent in one runtime. */
export function conversationScheduling(): AgentPluginDefinition {
  return {
    name: 'conversation-scheduling',
    capabilities: [
      conversationSchedulingCapabilities.scheduler,
      conversationSchedulingCapabilities.timezone,
    ],
    create(bindings) {
      let host: AgentPluginHost | undefined;
      const scheduler = new ConversationScheduler({
        scheduler: bindings.get(conversationSchedulingCapabilities.scheduler),
        host: () => {
          if (!host) {
            throw new Error(
              'conversation-scheduling plugin must be initialized before use',
            );
          }
          return host;
        },
        timezone: bindings.get(conversationSchedulingCapabilities.timezone),
      });

      return {
        tools: createSchedulingTools(scheduler),
        async initialize(runtimeHost) {
          host = runtimeHost;
        },
        work: () => scheduler.work(),
        conversationAvailable: (_host, conversation) =>
          scheduler.materializeDueIfEligible(conversation),
      };
    },
  };
}
