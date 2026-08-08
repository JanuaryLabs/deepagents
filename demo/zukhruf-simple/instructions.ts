import {
  everyNToolCalls,
  or,
  role,
  socraticPlan,
  toolCalled,
} from '@deepagents/context';
import { defineInstructions } from '@deepagents/experimental/zukhruf';

export default defineInstructions(
  role('You are a concise, helpful assistant.'),
  socraticPlan.instructions(),
  socraticPlan.review({
    when: or(everyNToolCalls(3), toolCalled('writeFile')),
  }),
);
