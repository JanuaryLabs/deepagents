import type spawn from 'nano-spawn';
import { SubprocessError } from 'nano-spawn';

/** A ready Docker container. Explicit disposal stops it for every caller. */
export class Container implements AsyncDisposable {
  readonly containerId: string;
  readonly host = '127.0.0.1';
  readonly port: number;

  constructor(
    containerId: string,
    port: number,
    readonly command: (
      args: string[],
    ) => Promise<Awaited<ReturnType<typeof spawn>>>,
    readonly disconnect: () => Promise<void>,
  ) {
    this.containerId = containerId;
    this.port = port;
  }

  // Keep these bound: readiness probes and database handles pass them around.
  readonly exec = async (command: string[]) => {
    return this.command(['exec', this.containerId, ...command]);
  };

  readonly cleanup = async (): Promise<void> => {
    try {
      await this.command(['rm', '--force', this.containerId]).catch((error) => {
        if (
          !(error instanceof SubprocessError) ||
          !/No such container/i.test(error.stderr)
        )
          throw error;
      });
    } finally {
      await this.disconnect();
    }
  };

  [Symbol.asyncDispose](): Promise<void> {
    return this.cleanup();
  }
}
