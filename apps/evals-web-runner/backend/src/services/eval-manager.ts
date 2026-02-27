import { EvalEmitter } from '@deepagents/evals/engine';

class EvalManager {
  #emitters = new Map<
    string,
    { emitter: EvalEmitter; totalCases: number; completed: number }
  >();

  register(runId: string, emitter: EvalEmitter, totalCases: number): void {
    const entry = { emitter, totalCases, completed: 0 };
    this.#emitters.set(runId, entry);

    emitter.on('case:scored', () => {
      entry.completed++;
    });

    emitter.on('run:end', () => {
      setTimeout(() => this.#emitters.delete(runId), 10_000);
    });
  }

  get(runId: string) {
    return this.#emitters.get(runId);
  }

  isRunning(runId: string): boolean {
    return this.#emitters.has(runId);
  }

  resetForTesting(): void {
    this.#emitters.clear();
  }
}

export default new EvalManager();
