/** `wait_agent` timeout bounds in milliseconds: min <= default <= max. */
export class WaitBounds {
  readonly minMs: number;
  readonly defaultMs: number;
  readonly maxMs: number;

  constructor({
    minMs = 10_000,
    defaultMs = 30_000,
    maxMs = 3_600_000,
  }: { minMs?: number; defaultMs?: number; maxMs?: number } = {}) {
    assertTimeout('minWaitTimeoutMs', minMs);
    assertTimeout('defaultWaitTimeoutMs', defaultMs);
    assertTimeout('maxWaitTimeoutMs', maxMs);
    if (minMs > maxMs) {
      throw new Error(
        'AgentRuntime: multiAgent.minWaitTimeoutMs must be at most maxWaitTimeoutMs',
      );
    }
    if (defaultMs < minMs) {
      throw new Error(
        'AgentRuntime: multiAgent.defaultWaitTimeoutMs must be at least minWaitTimeoutMs',
      );
    }
    if (defaultMs > maxMs) {
      throw new Error(
        'AgentRuntime: multiAgent.defaultWaitTimeoutMs must be at most maxWaitTimeoutMs',
      );
    }
    this.minMs = minMs;
    this.defaultMs = defaultMs;
    this.maxMs = maxMs;
  }
}

function assertTimeout(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `AgentRuntime: multiAgent.${name} must be a non-negative safe integer`,
    );
  }
}
