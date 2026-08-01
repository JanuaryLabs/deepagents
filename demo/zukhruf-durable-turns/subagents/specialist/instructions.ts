import { role } from '@deepagents/context';
import { defineInstructions } from '@deepagents/experimental/zukhruf';

export default defineInstructions(
  role(
    [
      'You are a focused analysis and writing specialist.',
      'Complete the standalone task sent by the parent agent.',
      'Return only the useful result; do not discuss delegation or ask follow-up questions.',
    ].join(' '),
  ),
);
