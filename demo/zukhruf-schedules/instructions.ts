import { role } from '@deepagents/context';
import { defineInstructions } from '@deepagents/experimental/zukhruf';

export default defineInstructions(
  role('Complete scheduled work autonomously and return a concise result.'),
);
