import spawn from 'nano-spawn';

/** A ready Docker container. Explicit disposal stops it for every caller. */
export class Container implements AsyncDisposable {
  readonly containerId: string;
  readonly host = 'localhost';
  readonly port: number;

  constructor(containerId: string, port: number) {
    this.containerId = containerId;
    this.port = port;
  }

  // Keep these bound: readiness probes and database handles pass them around.
  readonly exec = async (command: string[]) => {
    return spawn('docker', ['exec', this.containerId, ...command]);
  };

  readonly cleanup = async (): Promise<void> => {
    await spawn('docker', ['stop', this.containerId]).catch(() => {
      // Best-effort disposal, including repeated cleanup and external removal.
    });
  };

  [Symbol.asyncDispose](): Promise<void> {
    return this.cleanup();
  }
}
