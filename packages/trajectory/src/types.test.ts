import { TemporaryFiles } from '@zukhruf/fs';
import { test } from '@zukhruf/parameterized-test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  ATIF_SCHEMA_VERSION,
  type Adapter,
  ClaudeCodeAdapter,
  ClaudeCodeSession,
  ClaudeCodeStore,
  CodexStore,
  CodexThread,
  type ReadResult,
  type Step,
  type SystemStep,
  type Trajectory,
  type UserStep,
} from '@deepagents/trajectory';

/** A store of an agent the package does not cover, read by an adapter its host writes. */
class GooseSession {
  readonly id: string;
  readonly prompts: readonly string[];
  constructor(id: string, prompts: readonly string[]) {
    this.id = id;
    this.prompts = prompts;
  }
}

class GooseAdapter implements Adapter<GooseSession> {
  readonly agent = 'goose';

  async read(session: GooseSession): Promise<ReadResult> {
    const steps = session.prompts.map((prompt, index): Step => ({
      step_id: index + 1,
      source: 'user',
      message: prompt,
    }));
    const [first, ...rest] = steps;
    assert.ok(first);
    const trajectory: Trajectory = {
      schema_version: ATIF_SCHEMA_VERSION,
      session_id: session.id,
      agent: { name: this.agent, version: '1.0.0' },
      steps: [first, ...rest],
    };
    return { trajectory, diagnostics: [] };
  }
}

/** Reads any session through the port alone, as a host's miner does. */
async function typedPrompts<Session>(
  adapter: Adapter<Session>,
  session: Session,
) {
  const { trajectory } = await adapter.read(session);
  return trajectory.steps
    .filter((step) => step.source === 'user')
    .map((step) => step.message);
}

test('a host writes an adapter for an agent the package does not cover, and reads it through the port', async () => {
  const prompts = await typedPrompts(
    new GooseAdapter(),
    new GooseSession('g-1', ['plan the trip', 'book it']),
  );

  assert.deepEqual(prompts, ['plan the trip', 'book it']);
});

test('the same port reader reads the Claude Code adapter this package ships', async () => {
  await using dir = await new TemporaryFiles().directory('trajectory-');
  const path = join(dir.path, '7f1c2a90-0000-4000-8000-000000000031.jsonl');
  await writeFile(
    path,
    `${JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'ship it' },
      uuid: 'u-1',
      timestamp: '2026-11-27T10:00:00.000Z',
      origin: { kind: 'human' },
      sessionId: '7f1c2a90-0000-4000-8000-000000000031',
      version: '2.1.332',
    })}\n`,
  );

  const prompts = await typedPrompts(
    new ClaudeCodeAdapter(),
    ClaudeCodeSession.fromTranscriptPath(path),
  );

  assert.deepEqual(prompts, ['ship it']);
});

/** Never called: each line must fail to compile, and the typecheck target proves it. */
export function claimsTheTypeCheckerProves(user: UserStep, system: SystemStep) {
  // @ts-expect-error a store needs its root; the package never finds one in HOME
  void new ClaudeCodeStore({});
  // @ts-expect-error a store needs its root; the package never finds one in HOME
  void new CodexStore({});

  // @ts-expect-error a Claude Code adapter cannot be handed a Codex thread
  void new ClaudeCodeAdapter().read(new CodexThread('t-1', []));

  const toolCalls = [
    { tool_call_id: 'c-1', function_name: 'Bash', arguments: {} },
  ];
  // @ts-expect-error only an agent step has tool calls
  user = { ...user, tool_calls: toolCalls };
  // @ts-expect-error only an agent step has tool calls
  system = { ...system, tool_calls: toolCalls };
  // @ts-expect-error only an agent step names a model
  user = { ...user, model_name: 'claude-opus-5-5' };
  // @ts-expect-error only an agent step names a model
  system = { ...system, model_name: 'claude-opus-5-5' };
  // @ts-expect-error only an agent step has reasoning
  user = { ...user, reasoning_content: 'because' };
  // @ts-expect-error only an agent step has reasoning
  system = { ...system, reasoning_content: 'because' };
  // @ts-expect-error only an agent step has a reasoning effort
  user = { ...user, reasoning_effort: 'high' };
  // @ts-expect-error only an agent step has a reasoning effort
  system = { ...system, reasoning_effort: 'high' };
  // @ts-expect-error only an agent step has metrics
  user = { ...user, metrics: { prompt_tokens: 1 } };
  // @ts-expect-error only an agent step has metrics
  system = { ...system, metrics: { prompt_tokens: 1 } };
  return [user, system];
}
