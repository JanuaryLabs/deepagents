import type { CommandResult, Sandbox } from 'bash-tool';
import { InMemoryFs } from 'just-bash';

import { createVirtualSandbox } from '@deepagents/context';

/**
 * Returns a real virtual sandbox presented as a plain `Sandbox` — the
 * `install` capability is hidden, so the routing sandbox falls through to
 * its shallow-dispatch path. No mocks, no ad-hoc fakes: the I/O underneath
 * is the same just-bash backend that production uses.
 */
export async function createShallowBackend(): Promise<Sandbox> {
  const virtual = await createVirtualSandbox({ fs: new InMemoryFs() });
  await virtual.install({ commands: [], plugins: [], env: {} });
  return {
    executeCommand: virtual.executeCommand.bind(virtual),
    readFile: virtual.readFile.bind(virtual),
    writeFiles: virtual.writeFiles.bind(virtual),
  };
}

/**
 * Wraps any sandbox with a call-recording proxy. Every method delegates to
 * the inner sandbox; `calls` records only the command strings that reached
 * `executeCommand`. Not a fake — it observes real behavior.
 */
export function recordingBackend(inner: Sandbox): {
  sandbox: Sandbox;
  calls: string[];
} {
  const calls: string[] = [];
  const sandbox: Sandbox = {
    async executeCommand(cmd: string): Promise<CommandResult> {
      calls.push(cmd);
      return inner.executeCommand(cmd);
    },
    readFile: inner.readFile.bind(inner),
    writeFiles: inner.writeFiles.bind(inner),
  };
  return { sandbox, calls };
}
