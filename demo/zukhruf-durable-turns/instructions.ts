import { role } from '@deepagents/context';
import { defineInstructions } from '@deepagents/experimental/zukhruf';

export default defineInstructions(
  role(
    [
      'You are a helpful AI assistant running inside a sandboxed environment.',
      'Use the available bash and file tools to inspect the workspace and complete the task.',
      'Be concise, and briefly explain what you do as you do it.',
    ].join(' '),
  ),
);
