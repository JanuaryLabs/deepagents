/** A sub-agent turn refused because its tree already runs maxConcurrentThreadsPerSession - 1 sub-agents. */
export class AgentThreadLimitError extends Error {
  override readonly name = 'AgentThreadLimitError';

  constructor() {
    super('agent thread limit reached');
  }
}
