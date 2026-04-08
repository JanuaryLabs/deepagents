import { createInterface } from 'node:readline';

export interface StartMessage {
  type: 'start';
  instruction: string;
  taskId: string;
}

export interface RunResultMessage {
  type: 'run_result';
  id: string;
  stdout: string;
  stderr: string;
  returnCode: number;
}

type InboundMessage = StartMessage | RunResultMessage;

interface RunRequest {
  type: 'run';
  id: string;
  command: string;
}

interface ContextUpdate {
  type: 'context';
  inputTokens: number;
  outputTokens: number;
}

interface CompleteMessage {
  type: 'complete';
}

type OutboundMessage = RunRequest | ContextUpdate | CompleteMessage;

export class Bridge {
  #rl: ReturnType<typeof createInterface>;
  #pending = new Map<
    string,
    {
      resolve: (msg: RunResultMessage) => void;
    }
  >();
  #startResolve?: (msg: StartMessage) => void;
  #requestId = 0;

  constructor() {
    this.#rl = createInterface({ input: process.stdin });
    this.#rl.on('line', (line) => {
      const msg: InboundMessage = JSON.parse(line);
      if (msg.type === 'start') {
        this.#startResolve?.(msg);
      } else if (msg.type === 'run_result') {
        const pending = this.#pending.get(msg.id);
        if (pending) {
          this.#pending.delete(msg.id);
          pending.resolve(msg);
        }
      }
    });
  }

  waitForStart(): Promise<StartMessage> {
    return new Promise((resolve) => {
      this.#startResolve = resolve;
    });
  }

  async runCommand(
    command: string,
    maxChars = 10_000,
  ): Promise<{ stdout: string; stderr: string; returnCode: number }> {
    const id = `req-${++this.#requestId}`;
    this.#send({ type: 'run', id, command });

    const result = await new Promise<RunResultMessage>((resolve) => {
      this.#pending.set(id, { resolve });
    });

    return {
      stdout:
        result.stdout.length > maxChars
          ? result.stdout.slice(0, maxChars) +
            `\n... (truncated at ${maxChars} chars)`
          : result.stdout,
      stderr:
        result.stderr.length > maxChars
          ? result.stderr.slice(0, maxChars) +
            `\n... (truncated at ${maxChars} chars)`
          : result.stderr,
      returnCode: result.returnCode,
    };
  }

  sendContext(inputTokens: number, outputTokens: number): void {
    this.#send({ type: 'context', inputTokens, outputTokens });
  }

  sendComplete(): void {
    this.#send({ type: 'complete' });
    this.#rl.close();
  }

  #send(msg: OutboundMessage): void {
    process.stdout.write(JSON.stringify(msg) + '\n');
  }
}
