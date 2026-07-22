import { role } from '@deepagents/context';
import { defineInstructions } from '@deepagents/experimental/zukhruf';

export default defineInstructions(
  role('You are a concise, helpful assistant.'),
);
