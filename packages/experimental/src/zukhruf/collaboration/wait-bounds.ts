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
    assertTimeout('minMs', minMs);
    assertTimeout('defaultMs', defaultMs);
    assertTimeout('maxMs', maxMs);
    if (minMs > maxMs) {
      throw new Error('AgentRuntime: WaitBounds minMs must be at most maxMs');
    }
    if (defaultMs < minMs) {
      throw new Error(
        'AgentRuntime: WaitBounds defaultMs must be at least minMs',
      );
    }
    if (defaultMs > maxMs) {
      throw new Error(
        'AgentRuntime: WaitBounds defaultMs must be at most maxMs',
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
      `AgentRuntime: WaitBounds ${name} must be a non-negative safe integer`,
    );
  }
}
