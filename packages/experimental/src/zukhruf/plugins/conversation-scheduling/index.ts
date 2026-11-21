import {
  AgentPluginCapability,
  type AgentPluginDefinition,
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
  /** An entry binds `globalThis`; a test binds `createClock()`. */
  clock: new AgentPluginCapability<{ Date: { now(): number } }>(
    'conversation-scheduling.clock',
  ),
} as const;

/** Install durable agent-created schedules into every agent in one runtime. */
export function conversationScheduling(): AgentPluginDefinition {
  return {
    name: 'conversation-scheduling',
    capabilities: [
      conversationSchedulingCapabilities.scheduler,
      conversationSchedulingCapabilities.timezone,
      conversationSchedulingCapabilities.clock,
    ],
    create(bindings) {
      const scheduler = bindings.get(
        conversationSchedulingCapabilities.scheduler,
      );
      const timezone = bindings.get(
        conversationSchedulingCapabilities.timezone,
      );
      const clock = bindings.get(conversationSchedulingCapabilities.clock);
      return {
        async initialize(host) {
          const conversationScheduler = new ConversationScheduler({
            scheduler,
            host,
            timezone,
            clock,
          });
          return {
            tools: createSchedulingTools(conversationScheduler),
            work: () => conversationScheduler.work(),
            conversationAvailable: (conversation) =>
              conversationScheduler.materializeDueIfEligible(conversation),
          };
        },
      };
    },
  };
}
