#!/usr/bin/env node
import { parseArgs } from 'node:util';

import {
  ClaudeCodeAdapter,
  ClaudeCodeSession,
  SessionReadError,
} from '../index.ts';

const USAGE = 'usage: trajectory read claude-code <transcript.jsonl>';

/**
 * Prints one session as `{ trajectory, diagnostics }` JSON for a caller in
 * another language (ADR 0010). The agent comes before the path, named as
 * `Adapter.agent` names it, so another agent is another word here.
 */
async function main(args: string[]): Promise<number> {
  let positionals: string[];
  try {
    ({ positionals } = parseArgs({ args, allowPositionals: true }));
  } catch (error) {
    if (!isParseArgsError(error)) throw error;
    return fail(USAGE);
  }
  const [command, agent, path, ...rest] = positionals;
  if (command !== 'read' || agent !== 'claude-code' || !path || rest.length) {
    return fail(USAGE);
  }

  let session: ClaudeCodeSession;
  try {
    session = ClaudeCodeSession.fromTranscriptPath(path);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return fail(`trajectory: ${error.message}`);
  }
  try {
    const { trajectory, diagnostics } = await new ClaudeCodeAdapter().read(
      session,
    );
    process.stdout.write(`${JSON.stringify({ trajectory, diagnostics })}\n`);
    return 0;
  } catch (error) {
    if (!(error instanceof SessionReadError)) throw error;
    return fail(`trajectory: ${error.message}`);
  }
}

function fail(line: string): number {
  process.stderr.write(`${line}\n`);
  return 2;
}

function isParseArgsError(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('ERR_PARSE_ARGS_')
  );
}

process.exitCode = await main(process.argv.slice(2));
