import { LinearClient } from '@linear/sdk';

export function linear(apiKey: string) {
  const linearClient = new LinearClient({ apiKey });
  const sourceId = 'linear:workspace';
  return {
    sourceId,
    instructions:
      'You answer questions about Linear issues assigned to the user.',
    sources: async () => {
      const user = await linearClient.viewer;
      const issues = await user.assignedIssues();
      return Promise.all(
        issues.nodes.map(async (it) => {
          const state = await it.state;
          return {
            id: it.id,
            content: async () =>
              `Issue: ${it.title}\nDescription: ${it.description || 'No description'}\nStatus: ${state?.name || 'Unknown'}\nID: ${it.id}`,
          };
        }),
      );
    },
  };
}
