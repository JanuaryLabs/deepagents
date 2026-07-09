import type { ClaudeHookOutput } from './types.ts';

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function writeOutput(output: ClaudeHookOutput): void {
  process.stdout.write(`${JSON.stringify(output)}\n`);
}
