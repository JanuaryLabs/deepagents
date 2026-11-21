import type { ResolvedMultiAgentHostConfig } from '../multi-agent-config.ts';

export function createCollaborationSurface(
  config: ResolvedMultiAgentHostConfig,
) {
  return config.team.surface;
}
