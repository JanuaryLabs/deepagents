import { plan, role, toolCallCount } from '@deepagents/context';
import { defineInstructions } from '@deepagents/experimental/zukhruf';

export default defineInstructions(
  role('You are a concise, helpful assistant.'),
  plan.instructions(),
  plan.review({
    when: toolCallCount(() => true, { gte: 5 }),
  }),
);
