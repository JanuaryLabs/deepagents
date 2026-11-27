import { TemporaryFiles } from '@zukhruf/fs';
import { test } from '@zukhruf/parameterized-test';
import assert from 'node:assert/strict';
import { mkdir, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

import {
  CodexAdapter,
  CodexStore,
  SessionReadError,
} from '@deepagents/trajectory';

const PARENT = '01a1c0a0-17fa-7391-bf50-b4ae0fb14929';
const CHILD = '01a1c0a0-17fa-7391-bf50-b4ae0fb14930';
const ARCHIVED = '01a0fbf7-0000-7000-8000-000000000001';
const OLD = '01a0aaaa-0000-7000-8000-000000000002';

test('threads({ since }) lists rollouts from sessions and archived_sessions, .jsonl.zst and .jsonl, newest first', async () => {
  await using dir = await new TemporaryFiles().directory('trajectory-');
  const recent = await rollout(
    dir.path,
    'sessions',
    PARENT,
    conversation(PARENT),
    { zst: true },
  );
  const archived = await rollout(
    dir.path,
    'archived_sessions',
    ARCHIVED,
    conversation(ARCHIVED),
    {
      zst: false,
    },
  );
  const old = await rollout(dir.path, 'sessions', OLD, conversation(OLD), {
    zst: true,
  });
  await touch(recent, '2026-11-26T00:00:00Z');
  await touch(archived, '2026-11-25T00:00:00Z');
  await touch(old, '2026-11-01T00:00:00Z');

  const listed = await Array.fromAsync(
    new CodexStore({ root: dir.path }).threads({
      since: new Date('2026-11-20T00:00:00Z'),
    }),
    (thread) => thread.threadId,
  );

  assert.deepEqual(listed, [PARENT, ARCHIVED]);
});

test('a Codex thread reads as ATIF-v1.8: the typed prompt is a user step, injected context is dropped, and the call pairs with its output', async () => {
  await using dir = await new TemporaryFiles().directory('trajectory-');
  await rollout(dir.path, 'sessions', PARENT, conversation(PARENT), {
    zst: true,
  });
  const [thread] = await threads(dir.path);
  assert.ok(thread);

  const { trajectory } = await new CodexAdapter().read(thread);

  assert.equal(trajectory.schema_version, 'ATIF-v1.8');
  assert.equal(trajectory.agent.name, 'codex');
  assert.deepEqual(
    trajectory.steps.map((step) => [step.source, step.message]),
    [
      ['user', 'fix the failing test'],
      ['agent', 'Running the tests.'],
    ],
  );
  const agent = trajectory.steps[1];
  assert.ok(agent.source === 'agent');
  assert.deepEqual(
    agent.tool_calls?.map((call) => [call.tool_call_id, call.function_name]),
    [['call-exec', 'exec']],
  );
  assert.deepEqual(
    agent.observation?.results.map((result) => result.source_call_id),
    ['call-exec'],
  );
});

test('a rollout that names a parent thread groups under it and embeds as a linked subagent', async () => {
  await using dir = await new TemporaryFiles().directory('trajectory-');
  await rollout(
    dir.path,
    'sessions',
    PARENT,
    [...conversation(PARENT), ...spawn(CHILD)],
    { zst: true },
  );
  await rollout(
    dir.path,
    'sessions',
    CHILD,
    conversation(CHILD, { parent: PARENT, prompt: 'check the docs' }),
    { zst: true },
  );

  const listed = await threads(dir.path);
  assert.deepEqual(
    listed.map((thread) => thread.threadId),
    [PARENT],
  );

  const { trajectory } = await new CodexAdapter().read(listed[0]);
  const [embedded, ...others] = trajectory.subagent_trajectories ?? [];
  assert.equal(others.length, 0);
  assert.ok(embedded?.trajectory_id);
  assert.deepEqual(
    embedded.steps
      .filter((step) => step.source === 'user')
      .map((step) => step.message),
    ['check the docs'],
  );
  const refs = trajectory.steps.flatMap((step) =>
    (step.observation?.results ?? []).flatMap(
      (result) => result.subagent_trajectory_ref ?? [],
    ),
  );
  assert.deepEqual(
    refs.map((ref) => ref.trajectory_id),
    [embedded.trajectory_id],
  );

  const { trajectory: alone } = await new CodexAdapter().read(listed[0], {
    subagents: false,
  });
  assert.equal(alone.subagent_trajectories, undefined);
});

test('a .jsonl.zst rollout that does not decode throws SessionReadError naming it', async () => {
  await using dir = await new TemporaryFiles().directory('trajectory-');
  const path = await rollout(
    dir.path,
    'sessions',
    PARENT,
    conversation(PARENT),
    { zst: true },
  );
  const [thread] = await threads(dir.path);
  assert.ok(thread);
  await writeFile(path, Buffer.from('not zstd at all'));

  await assert.rejects(
    () => new CodexAdapter().read(thread),
    (error: unknown) =>
      error instanceof SessionReadError && error.path === path,
  );
});

async function threads(root: string) {
  const listed = await Array.fromAsync(
    new CodexStore({ root }).threads({
      since: new Date('2026-01-01T00:00:00Z'),
    }),
  );
  return listed;
}

/** Writes a rollout where Codex keeps it: `<root>/<folder>/2026/11/20/rollout-<time>-<thread id>.jsonl[.zst]`. */
async function rollout(
  root: string,
  folder: 'sessions' | 'archived_sessions',
  threadId: string,
  lines: Record<string, unknown>[],
  { zst }: { zst: boolean },
): Promise<string> {
  const name = `rollout-2026-11-20T10-00-00-${threadId}.jsonl${zst ? '.zst' : ''}`;
  const path = join(root, folder, '2026', '11', '20', name);
  await mkdir(dirname(path), { recursive: true });
  const text = lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
  await writeFile(path, zst ? zstdCompressSync(Buffer.from(text)) : text);
  return path;
}

/** One turn as Codex 0.167 writes it: meta, injected AGENTS.md, a typed prompt, a reply, a tool call and its output. */
function conversation(
  threadId: string,
  {
    parent,
    prompt = 'fix the failing test',
  }: { parent?: string; prompt?: string } = {},
) {
  let ordinal = 0;
  const line = (type: string, payload: Record<string, unknown>) => ({
    timestamp: `2026-11-20T10:00:${String(ordinal).padStart(2, '0')}.000Z`,
    ordinal: ordinal++,
    type,
    payload,
  });
  const turn = { turn_id: `turn-${threadId}` };
  return [
    line('session_meta', {
      session_id: parent ?? threadId,
      id: threadId,
      ...(parent
        ? {
            parent_thread_id: parent,
            source: { subagent: { other: 'worker' } },
          }
        : { source: 'cli' }),
      timestamp: '2026-11-20T10:00:00.000Z',
      cwd: '/work',
      originator: 'codex_cli_rs',
      cli_version: '0.167.0',
      model_provider: 'openai',
    }),
    line('turn_context', {
      ...turn,
      cwd: '/work',
      approval_policy: 'on-request',
      model: 'gpt-6-astra',
    }),
    line('response_item', {
      type: 'message',
      id: `m-ctx-${threadId}`,
      role: 'user',
      content: [
        { type: 'input_text', text: '# AGENTS.md instructions for /work' },
      ],
      internal_chat_message_metadata_passthrough: {
        ...turn,
        content_item_kinds: ['agents_md.instructions'],
      },
    }),
    line('response_item', {
      type: 'message',
      id: `m-user-${threadId}`,
      role: 'user',
      content: [{ type: 'input_text', text: prompt }],
      internal_chat_message_metadata_passthrough: {
        ...turn,
        content_item_kinds: ['user.text'],
      },
    }),
    line('response_item', {
      type: 'message',
      status: 'completed',
      id: `m-assistant-${threadId}`,
      role: 'assistant',
      content: [
        { type: 'output_text', text: 'Running the tests.', annotations: [] },
      ],
      phase: 'commentary',
      internal_chat_message_metadata_passthrough: {
        ...turn,
        content_item_kinds: ['unknown'],
      },
    }),
    line('response_item', {
      type: 'custom_tool_call',
      id: `ct-${threadId}`,
      status: 'completed',
      call_id: 'call-exec',
      name: 'exec',
      input: 'npm test',
      internal_chat_message_metadata_passthrough: turn,
    }),
    line('response_item', {
      type: 'custom_tool_call_output',
      id: `cto-${threadId}`,
      call_id: 'call-exec',
      output: [{ type: 'input_text', text: '1 test failed' }],
      internal_chat_message_metadata_passthrough: turn,
    }),
  ];
}

/** The parent's call that starts a subagent thread, its output, and the event that names the new thread. */
function spawn(childId: string) {
  const turn = { turn_id: 'turn-spawn' };
  return [
    {
      timestamp: '2026-11-20T10:01:00.000Z',
      ordinal: 50,
      type: 'response_item',
      payload: {
        type: 'function_call',
        id: 'fc-spawn',
        call_id: 'call-spawn',
        name: 'spawn_agent',
        arguments: JSON.stringify({ message: 'check the docs' }),
        internal_chat_message_metadata_passthrough: turn,
      },
    },
    {
      timestamp: '2026-11-20T10:01:01.000Z',
      ordinal: 51,
      type: 'event_msg',
      payload: {
        type: 'collab_agent_spawn_end',
        new_thread_id: childId,
        call_id: 'call-spawn',
      },
    },
    {
      timestamp: '2026-11-20T10:01:02.000Z',
      ordinal: 52,
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        id: 'fco-spawn',
        call_id: 'call-spawn',
        output: JSON.stringify({ agent_id: childId }),
        internal_chat_message_metadata_passthrough: turn,
      },
    },
  ];
}

async function touch(path: string, iso: string): Promise<void> {
  const time = new Date(iso);
  await utimes(path, time, time);
}
