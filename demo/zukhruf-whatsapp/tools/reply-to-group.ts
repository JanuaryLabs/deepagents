import { z } from 'zod';

import { defineTool } from '@deepagents/experimental/zukhruf';

export function replyToGroup(post: (message: string) => void) {
  return defineTool({
    description: 'Post one useful contribution to the public group chat.',
    inputSchema: z.object({ message: z.string().trim().min(1) }),
    execute: async ({ message }) => {
      post(message);
      return { posted: true };
    },
  });
}
