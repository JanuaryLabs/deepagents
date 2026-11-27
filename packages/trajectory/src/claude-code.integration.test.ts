import { TemporaryFiles } from '@zukhruf/fs';
import { test } from '@zukhruf/parameterized-test';
import assert from 'node:assert/strict';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  ClaudeCodeAdapter,
  ClaudeCodeSession,
  ClaudeCodeSubagent,
  SessionReadError,
} from '@deepagents/trajectory';

/** chmod 000 cannot make a file unreadable to root, so these run only as another user. */
const runsAsRoot =
  process.getuid?.() === 0 &&
  'root reads every file, so chmod 000 cannot lock one';

test('a missing transcript throws SessionReadError with its path and the ENOENT cause', async () => {
  await using dir = await new TemporaryFiles().directory('trajectory-');
  const path = join(
    dir.path,
    'projects',
    '-work',
    '7f1c2a90-0000-4000-8000-000000000001.jsonl',
  );

  const session = ClaudeCodeSession.fromTranscriptPath(path);

  await assert.rejects(
    () => new ClaudeCodeAdapter().read(session),
    (error: unknown) => {
      assert.ok(error instanceof SessionReadError);
      assert.equal(error.path, path);
      assert.equal(codeOf(error.cause), 'ENOENT');
      return true;
    },
  );
});

test(
  'a transcript the process cannot read throws SessionReadError with the EACCES cause',
  { skip: runsAsRoot },
  async () => {
    await using dir = await new TemporaryFiles().directory('trajectory-');
    const path = join(dir.path, '7f1c2a90-0000-4000-8000-000000000002.jsonl');
    await writeFile(path, `${JSON.stringify(typed('hello'))}\n`);
    await chmod(path, 0o000);

    try {
      await assert.rejects(
        () =>
          new ClaudeCodeAdapter().read(
            ClaudeCodeSession.fromTranscriptPath(path),
          ),
        (error: unknown) => {
          assert.ok(error instanceof SessionReadError);
          assert.equal(error.path, path);
          assert.equal(codeOf(error.cause), 'EACCES');
          return true;
        },
      );
    } finally {
      await chmod(path, 0o600);
    }
  },
);

test('a directory where the transcript should be throws SessionReadError with the EISDIR cause', async () => {
  await using dir = await new TemporaryFiles().directory('trajectory-');
  const path = join(dir.path, '7f1c2a90-0000-4000-8000-000000000003.jsonl');
  await mkdir(path);

  await assert.rejects(
    () =>
      new ClaudeCodeAdapter().read(ClaudeCodeSession.fromTranscriptPath(path)),
    (error: unknown) => {
      assert.ok(error instanceof SessionReadError);
      assert.equal(codeOf(error.cause), 'EISDIR');
      return true;
    },
  );
});

void test.each(
  [
    { name: 'an empty transcript', content: '' },
    {
      name: 'a transcript of only bookkeeping',
      content:
        [
          { type: 'permission-mode', permissionMode: 'auto', sessionId: 'x' },
          { type: 'last-prompt', lastPrompt: 'hello', sessionId: 'x' },
        ]
          .map((entry) => JSON.stringify(entry))
          .join('\n') + '\n',
    },
  ],
  ({ name, content }) =>
    test(`${name} throws SessionReadError because ATIF needs a step`, async () => {
      await using dir = await new TemporaryFiles().directory('trajectory-');
      const path = join(dir.path, '7f1c2a90-0000-4000-8000-000000000004.jsonl');
      await writeFile(path, content);

      await assert.rejects(
        () =>
          new ClaudeCodeAdapter().read(
            ClaudeCodeSession.fromTranscriptPath(path),
          ),
        (error: unknown) =>
          error instanceof SessionReadError && error.path === path,
      );
    }),
);

test('a half-written last line is a partial_last_line diagnostic and the steps before it stay', async () => {
  await using dir = await new TemporaryFiles().directory('trajectory-');
  const path = join(dir.path, '7f1c2a90-0000-4000-8000-000000000006.jsonl');
  const written = JSON.stringify(typed('second prompt', { uuid: 'u-typed-2' }));
  await writeFile(
    path,
    `${JSON.stringify(typed('first prompt'))}\n${written.slice(0, written.length / 2)}`,
  );

  const { trajectory, diagnostics } = await new ClaudeCodeAdapter().read(
    ClaudeCodeSession.fromTranscriptPath(path),
  );

  assert.deepEqual(
    trajectory.steps.map((step) => step.message),
    ['first prompt'],
  );
  assert.deepEqual(
    diagnostics.map(({ code, line }) => ({ code, line })),
    [{ code: 'partial_last_line', line: 2 }],
  );
});

test('a malformed middle line is an invalid_json_line diagnostic with its line, and later lines are read', async () => {
  await using dir = await new TemporaryFiles().directory('trajectory-');
  const path = join(dir.path, '7f1c2a90-0000-4000-8000-000000000007.jsonl');
  await writeFile(
    path,
    [
      JSON.stringify(typed('first prompt')),
      '{"type":"user", broken',
      '[1, 2, 3]',
      JSON.stringify(typed('third prompt', { uuid: 'u-typed-3' })),
    ].join('\n') + '\n',
  );

  const { trajectory, diagnostics } = await new ClaudeCodeAdapter().read(
    ClaudeCodeSession.fromTranscriptPath(path),
  );

  assert.deepEqual(
    trajectory.steps.map((step) => step.message),
    ['first prompt', 'third prompt'],
  );
  assert.deepEqual(
    diagnostics.map(({ code, line, path: file }) => ({ code, line, file })),
    [
      { code: 'invalid_json_line', line: 2, file: path },
      { code: 'invalid_json_line', line: 3, file: path },
    ],
  );
});

void test.each(
  [
    {
      name: 'a typed prompt is a user step whose origin is human',
      entry: typed('fix the build'),
      step: {
        source: 'user',
        origin: 'human',
        is_meta: undefined,
        message: 'fix the build',
      },
    },
    {
      name: 'a prompt typed mid-turn (queued_command) is a user step whose origin is human',
      entry: queued('also run the tests', { kind: 'human' }),
      step: {
        source: 'user',
        origin: 'human',
        is_meta: undefined,
        message: 'also run the tests',
      },
    },
    {
      name: 'a peer message queued mid-turn is a user step whose origin is peer',
      entry: queued('<cross-session-message>done</cross-session-message>', {
        kind: 'peer',
      }),
      step: {
        source: 'user',
        origin: 'peer',
        is_meta: undefined,
        message: '<cross-session-message>done</cross-session-message>',
      },
    },
    {
      name: 'a peer message stored with isMeta is a user step whose origin is peer',
      entry: typed('<cross-session-message>ready</cross-session-message>', {
        isMeta: true,
        origin: { kind: 'peer' },
        promptSource: undefined,
      }),
      step: {
        source: 'user',
        origin: 'peer',
        is_meta: true,
        message: '<cross-session-message>ready</cross-session-message>',
      },
    },
    {
      name: 'a task notification is a user step whose origin is task-notification',
      entry: typed('<task-notification>done</task-notification>', {
        origin: { kind: 'task-notification' },
        promptSource: undefined,
      }),
      step: {
        source: 'user',
        origin: 'task-notification',
        is_meta: undefined,
        message: '<task-notification>done</task-notification>',
      },
    },
    {
      name: 'a coordinator hand-back is a user step whose origin is coordinator',
      entry: typed('report: all green', {
        origin: { kind: 'coordinator' },
        promptSource: undefined,
      }),
      step: {
        source: 'user',
        origin: 'coordinator',
        is_meta: undefined,
        message: 'report: all green',
      },
    },
    {
      name: 'a skill body (isMeta, no origin) is a system step marked is_meta',
      entry: typed('', {
        isMeta: true,
        origin: undefined,
        promptSource: undefined,
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'Base directory for this skill: /skills/x' },
          ],
        },
      }),
      step: {
        source: 'system',
        origin: undefined,
        is_meta: true,
        message: 'Base directory for this skill: /skills/x',
      },
    },
    {
      name: 'a prompt from a build before origin is a user step with no origin, so it never counts as typed',
      entry: typed('old prompt', {
        origin: undefined,
        promptSource: undefined,
      }),
      step: {
        source: 'user',
        origin: undefined,
        is_meta: undefined,
        message: 'old prompt',
      },
    },
  ],
  ({ name, entry, step }) =>
    test(name, async () => {
      await using dir = await new TemporaryFiles().directory('trajectory-');
      const path = join(dir.path, '7f1c2a90-0000-4000-8000-000000000008.jsonl');
      await writeFile(path, `${JSON.stringify(entry)}\n`);

      const { trajectory } = await new ClaudeCodeAdapter().read(
        ClaudeCodeSession.fromTranscriptPath(path),
      );

      const [only, ...rest] = trajectory.steps;
      assert.equal(rest.length, 0);
      const claudeCode = claudeCodeOf(only.extra);
      assert.deepEqual(
        {
          source: only.source,
          origin: claudeCode.origin,
          is_meta: claudeCode.is_meta,
          message: only.message,
        },
        step,
      );
    }),
);

test('assistant entries of one message become one agent step with its text, reasoning, tool calls, metrics and model', async () => {
  await using dir = await new TemporaryFiles().directory('trajectory-');
  const path = join(dir.path, '7f1c2a90-0000-4000-8000-000000000009.jsonl');
  await writeFile(
    path,
    [
      typed('list the files'),
      assistant(
        'msg-1',
        { type: 'thinking', thinking: 'I should run ls.' },
        { uuid: 'u-a-1' },
      ),
      assistant(
        'msg-1',
        { type: 'text', text: 'Listing them now.' },
        { uuid: 'u-a-2' },
      ),
      assistant(
        'msg-1',
        {
          type: 'tool_use',
          id: 'toolu-1',
          name: 'Bash',
          input: { command: 'ls' },
        },
        { uuid: 'u-a-3' },
      ),
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n') + '\n',
  );

  const { trajectory } = await new ClaudeCodeAdapter().read(
    ClaudeCodeSession.fromTranscriptPath(path),
  );

  const [, agent, ...rest] = trajectory.steps;
  assert.equal(rest.length, 0);
  assert.ok(agent?.source === 'agent');
  assert.equal(agent.message, 'Listing them now.');
  assert.equal(agent.reasoning_content, 'I should run ls.');
  assert.equal(agent.model_name, 'claude-opus-5-5');
  assert.deepEqual(agent.tool_calls, [
    {
      tool_call_id: 'toolu-1',
      function_name: 'Bash',
      arguments: { command: 'ls' },
    },
  ]);
  assert.deepEqual(agent.metrics, {
    prompt_tokens: 2 + 300 + 4000,
    completion_tokens: 50,
    cached_tokens: 4000,
    extra: {
      input_tokens: 2,
      cache_creation_input_tokens: 300,
      cache_read_input_tokens: 4000,
    },
  });
  const claudeCode = claudeCodeOf(agent.extra);
  assert.equal(claudeCode.message_id, 'msg-1');
  assert.equal(claudeCode.request_id, 'req-msg-1');
  assert.equal(claudeCode.stop_reason, 'tool_use');
});

test('a tool result lands on the step that made the call, with toolUseResult in its extra', async () => {
  await using dir = await new TemporaryFiles().directory('trajectory-');
  const path = join(dir.path, '7f1c2a90-0000-4000-8000-000000000010.jsonl');
  const answers = { 'Which design?': 'ATIF' };
  await writeFile(
    path,
    [
      typed('pick a design'),
      assistant('msg-1', {
        type: 'tool_use',
        id: 'toolu-ask',
        name: 'AskUserQuestion',
        input: { questions: [] },
      }),
      toolResult('toolu-ask', 'User answered: ATIF', {
        questions: [],
        answers,
      }),
      assistant(
        'msg-2',
        { type: 'text', text: 'Going with ATIF.' },
        { uuid: 'u-a-2' },
      ),
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n') + '\n',
  );

  const { trajectory, diagnostics } = await new ClaudeCodeAdapter().read(
    ClaudeCodeSession.fromTranscriptPath(path),
  );

  assert.deepEqual(diagnostics, []);
  assert.deepEqual(
    trajectory.steps.map((step) => step.source),
    ['user', 'agent', 'agent'],
  );
  const results = trajectory.steps[1].observation?.results ?? [];
  assert.equal(results.length, 1);
  assert.equal(results[0].source_call_id, 'toolu-ask');
  assert.equal(results[0].content, 'User answered: ATIF');
  const claudeCode = claudeCodeOf(results[0].extra);
  assert.deepEqual(claudeCode.tool_use_result, { questions: [], answers });
  assert.equal(claudeCode.is_error, false);
});

test('a tool result whose call is not in the transcript is an orphan_tool_result diagnostic', async () => {
  await using dir = await new TemporaryFiles().directory('trajectory-');
  const path = join(dir.path, '7f1c2a90-0000-4000-8000-000000000011.jsonl');
  await writeFile(
    path,
    [
      typed('hello'),
      toolResult('toolu-gone', 'output of a call before a rewind'),
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n') + '\n',
  );

  const { trajectory, diagnostics } = await new ClaudeCodeAdapter().read(
    ClaudeCodeSession.fromTranscriptPath(path),
  );

  assert.equal(trajectory.steps.length, 1);
  assert.deepEqual(
    diagnostics.map(({ code, line }) => ({ code, line })),
    [{ code: 'orphan_tool_result', line: 2 }],
  );
});

void test.each(
  [
    {
      name: 'a hook_additional_context attachment',
      attachment: {
        type: 'hook_additional_context',
        content: [
          '[prompt:session-harvest]',
          'SESSION HARVEST: scan recent messages.',
        ],
        hookName: 'UserPromptSubmit',
        toolUseID: 'UserPromptSubmit',
        hookEvent: 'UserPromptSubmit',
      },
      message:
        '[prompt:session-harvest]\nSESSION HARVEST: scan recent messages.',
    },
    {
      name: 'a hook_success attachment',
      attachment: {
        type: 'hook_success',
        hookName: 'PostToolUse:Bash',
        toolUseID: 'toolu-1',
        hookEvent: 'PostToolUse',
        content: '',
      },
      message: '',
    },
    {
      name: 'a prompt_snapshot attachment',
      attachment: { type: 'prompt_snapshot', snapshot: { id: 'snap-1' } },
      message: '',
    },
  ],
  ({ name, attachment, message }) =>
    test(`${name} is a system step that carries the attachment`, async () => {
      await using dir = await new TemporaryFiles().directory('trajectory-');
      const path = join(dir.path, '7f1c2a90-0000-4000-8000-000000000012.jsonl');
      await writeFile(path, `${JSON.stringify(attached(attachment))}\n`);

      const { trajectory } = await new ClaudeCodeAdapter().read(
        ClaudeCodeSession.fromTranscriptPath(path),
      );

      const [only, ...rest] = trajectory.steps;
      assert.equal(rest.length, 0);
      assert.equal(only.source, 'system');
      assert.equal(only.message, message);
      assert.deepEqual(claudeCodeOf(only.extra).attachment, attachment);
    }),
);

void test.each(
  [
    {
      name: 'a stop_hook_summary row',
      row: {
        subtype: 'stop_hook_summary',
        hookCount: 2,
        hookInfos: [],
        hookErrors: [],
        preventedContinuation: false,
      },
      message: '',
    },
    {
      name: 'a turn_duration row',
      row: { subtype: 'turn_duration', durationMs: 206042, isMeta: false },
      message: '',
    },
    {
      name: 'a compact_boundary row',
      row: {
        subtype: 'compact_boundary',
        content: 'Conversation compacted',
        compactMetadata: {
          trigger: 'manual',
          preTokens: 975777,
          postTokens: 40948,
        },
        level: 'info',
      },
      message: 'Conversation compacted',
    },
  ],
  ({ name, row, message }) =>
    test(`${name} is a system step that carries the row`, async () => {
      await using dir = await new TemporaryFiles().directory('trajectory-');
      const path = join(dir.path, '7f1c2a90-0000-4000-8000-000000000013.jsonl');
      const entry = systemRow(row);
      await writeFile(path, `${JSON.stringify(entry)}\n`);

      const { trajectory } = await new ClaudeCodeAdapter().read(
        ClaudeCodeSession.fromTranscriptPath(path),
      );

      const [only, ...rest] = trajectory.steps;
      assert.equal(rest.length, 0);
      assert.equal(only.source, 'system');
      assert.equal(only.message, message);
      assert.deepEqual(claudeCodeOf(only.extra).system, entry);
    }),
);

test('bookkeeping entries are no steps and are counted by entry type as unmapped_entry', async () => {
  await using dir = await new TemporaryFiles().directory('trajectory-');
  const path = join(dir.path, '7f1c2a90-0000-4000-8000-000000000014.jsonl');
  await writeFile(
    path,
    [
      typed('hello'),
      { type: 'api-request', requestId: 'r-1', sessionId: 'x' },
      { type: 'permission-mode', permissionMode: 'auto', sessionId: 'x' },
      { type: 'api-request', requestId: 'r-2', sessionId: 'x' },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n') + '\n',
  );

  const { trajectory, diagnostics } = await new ClaudeCodeAdapter().read(
    ClaudeCodeSession.fromTranscriptPath(path),
  );

  assert.equal(trajectory.steps.length, 1);
  assert.deepEqual(
    diagnostics
      .map(({ code, entryType, count }) => ({ code, entryType, count }))
      .toSorted((a, b) =>
        String(a.entryType).localeCompare(String(b.entryType)),
      ),
    [
      { code: 'unmapped_entry', entryType: 'api-request', count: 2 },
      { code: 'unmapped_entry', entryType: 'permission-mode', count: 1 },
    ],
  );
});

test('an isSidechain row in a main transcript is a sidechain_entry diagnostic, not a step', async () => {
  await using dir = await new TemporaryFiles().directory('trajectory-');
  const path = join(dir.path, '7f1c2a90-0000-4000-8000-000000000015.jsonl');
  await writeFile(
    path,
    [
      typed('hello'),
      typed('a subagent prompt', { isSidechain: true, uuid: 'u-side' }),
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n') + '\n',
  );

  const { trajectory, diagnostics } = await new ClaudeCodeAdapter().read(
    ClaudeCodeSession.fromTranscriptPath(path),
  );

  assert.deepEqual(
    trajectory.steps.map((step) => step.message),
    ['hello'],
  );
  assert.deepEqual(
    diagnostics.map(({ code, line }) => ({ code, line })),
    [{ code: 'sidechain_entry', line: 2 }],
  );
});

test('derived-from, titles, summaries and PR links go to the trajectory extra', async () => {
  await using dir = await new TemporaryFiles().directory('trajectory-');
  const id = '7f1c2a90-0000-4000-8000-000000000016';
  const path = join(dir.path, `${id}.jsonl`);
  const sessions = [
    {
      type: 'claude_code_session',
      id: '7f1c2a90-0000-4000-8000-0000000000aa',
      via: 'clear',
    },
  ];
  const prLink = {
    type: 'pr-link',
    url: 'https://github.com/o/r/pull/7',
    sessionId: id,
  };
  await writeFile(
    path,
    [
      { type: 'derived-from', v: 1, sessionId: id, sessions },
      typed('hello'),
      { type: 'ai-title', aiTitle: 'First title', sessionId: id },
      { type: 'ai-title', aiTitle: 'Better title', sessionId: id },
      { type: 'custom-title', customTitle: 'mine', sessionId: id },
      { type: 'summary', summary: 'Fixed the build', leafUuid: 'u-typed-1' },
      prLink,
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n') + '\n',
  );

  const { trajectory, diagnostics } = await new ClaudeCodeAdapter().read(
    ClaudeCodeSession.fromTranscriptPath(path),
  );

  assert.deepEqual(diagnostics, []);
  assert.equal(trajectory.steps.length, 1);
  const claudeCode = claudeCodeOf(trajectory.extra);
  assert.deepEqual(claudeCode.derived_from, sessions);
  assert.equal(claudeCode.ai_title, 'Better title');
  assert.equal(claudeCode.custom_title, 'mine');
  assert.deepEqual(claudeCode.summaries, ['Fixed the build']);
  assert.deepEqual(claudeCode.pr_links, [prLink]);
});

test('steps follow file order, so a rewound branch stays next to the branch that replaced it', async () => {
  await using dir = await new TemporaryFiles().directory('trajectory-');
  const path = join(dir.path, '7f1c2a90-0000-4000-8000-000000000017.jsonl');
  await writeFile(
    path,
    [
      typed('first try', { uuid: 'u-1', parentUuid: 'u-0' }),
      assistant(
        'msg-1',
        { type: 'text', text: 'Doing the first try.' },
        { uuid: 'u-2', parentUuid: 'u-1' },
      ),
      typed('second try', { uuid: 'u-3', parentUuid: 'u-0' }),
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n') + '\n',
  );

  const { trajectory } = await new ClaudeCodeAdapter().read(
    ClaudeCodeSession.fromTranscriptPath(path),
  );

  assert.deepEqual(
    trajectory.steps.map((step) => [
      step.message,
      claudeCodeOf(step.extra).parent_uuid,
    ]),
    [
      ['first try', 'u-0'],
      ['Doing the first try.', 'u-1'],
      ['second try', 'u-0'],
    ],
  );
});

test('every step keeps the keys that join it back to its raw line', async () => {
  await using dir = await new TemporaryFiles().directory('trajectory-');
  const path = join(dir.path, '7f1c2a90-0000-4000-8000-000000000018.jsonl');
  await writeFile(
    path,
    `${JSON.stringify(typed('hello', { uuid: 'u-9', parentUuid: 'u-8', promptId: 'p-9' }))}\n`,
  );

  const { trajectory } = await new ClaudeCodeAdapter().read(
    ClaudeCodeSession.fromTranscriptPath(path),
  );

  const claudeCode = claudeCodeOf(trajectory.steps[0].extra);
  assert.deepEqual(
    {
      uuid: claudeCode.uuid,
      parent_uuid: claudeCode.parent_uuid,
      timestamp: claudeCode.timestamp,
      cwd: claudeCode.cwd,
      entrypoint: claudeCode.entrypoint,
      prompt_id: claudeCode.prompt_id,
    },
    {
      uuid: 'u-9',
      parent_uuid: 'u-8',
      timestamp: '2026-11-27T10:00:00.000Z',
      cwd: '/work',
      entrypoint: 'cli',
      prompt_id: 'p-9',
    },
  );
});

test('a session read alone is ATIF-v1.8 with its own id, the Claude Code version, sequential steps and ISO times', async () => {
  await using dir = await new TemporaryFiles().directory('trajectory-');
  const id = '7f1c2a90-0000-4000-8000-000000000019';
  const path = join(dir.path, `${id}.jsonl`);
  await writeFile(
    path,
    [
      typed('hello'),
      assistant('msg-1', { type: 'text', text: 'Hi.' }),
      attached({ type: 'hook_success', hookName: 'Stop', content: '' }),
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n') + '\n',
  );

  const { trajectory } = await new ClaudeCodeAdapter().read(
    ClaudeCodeSession.fromTranscriptPath(path),
  );

  assert.equal(trajectory.schema_version, 'ATIF-v1.8');
  assert.equal(trajectory.session_id, id);
  assert.equal(trajectory.continued_trajectory_ref, undefined);
  assert.deepEqual(trajectory.agent, {
    name: 'claude-code',
    version: '2.1.332',
    model_name: 'claude-opus-5-5',
  });
  assert.deepEqual(
    trajectory.steps.map((step) => step.step_id),
    [1, 2, 3],
  );
  assert.deepEqual(
    trajectory.steps.map((step) => step.timestamp),
    [
      '2026-11-27T10:00:00.000Z',
      '2026-11-27T10:00:01.000Z',
      '2026-11-27T10:00:03.000Z',
    ],
  );
});

test('final_metrics sums the agent steps tokens and counts the steps', async () => {
  await using dir = await new TemporaryFiles().directory('trajectory-');
  const path = join(dir.path, '7f1c2a90-0000-4000-8000-000000000020.jsonl');
  await writeFile(
    path,
    [
      typed('hello'),
      assistant('msg-1', { type: 'text', text: 'One.' }),
      assistant('msg-2', { type: 'text', text: 'Two.' }, { uuid: 'u-a-2' }),
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n') + '\n',
  );

  const { trajectory } = await new ClaudeCodeAdapter().read(
    ClaudeCodeSession.fromTranscriptPath(path),
  );

  assert.deepEqual(trajectory.final_metrics, {
    total_prompt_tokens: 2 * (2 + 300 + 4000),
    total_completion_tokens: 2 * 50,
    total_cached_tokens: 2 * 4000,
    total_steps: 3,
  });
});

/** Writes a main transcript that starts one subagent, and that subagent's transcript, as Claude Code lays them out. */
async function sessionWithSubagent(root: string, { meta }: { meta: boolean }) {
  const id = '7f1c2a90-0000-4000-8000-000000000021';
  const main = join(root, `${id}.jsonl`);
  const subagents = join(root, id, 'subagents');
  const subagent = join(subagents, 'agent-a1b2c3.jsonl');
  await mkdir(subagents, { recursive: true });
  await writeFile(
    main,
    [
      typed('explore the repo'),
      assistant('msg-1', {
        type: 'tool_use',
        id: 'toolu-agent',
        name: 'Agent',
        input: { description: 'Explore', prompt: 'map the repo' },
      }),
      toolResult('toolu-agent', 'The repo has two packages.'),
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n') + '\n',
  );
  await writeFile(
    subagent,
    [
      typed('map the repo', {
        isSidechain: true,
        agentId: 'a1b2c3',
        origin: undefined,
        uuid: 's-1',
      }),
      assistant(
        'msg-s1',
        { type: 'text', text: 'The repo has two packages.' },
        { isSidechain: true, agentId: 'a1b2c3', uuid: 's-2' },
      ),
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n') + '\n',
  );
  if (meta) {
    await writeFile(
      join(subagents, 'agent-a1b2c3.meta.json'),
      JSON.stringify({
        agentType: 'Explore',
        description: 'Explore',
        toolUseId: 'toolu-agent',
        spawnDepth: 1,
      }),
    );
  }
  return { id, main, subagent };
}

test('a subagent becomes an embedded trajectory that the result of its spawning call refers to', async () => {
  await using dir = await new TemporaryFiles().directory('trajectory-');
  const { id, main } = await sessionWithSubagent(dir.path, { meta: true });

  const { trajectory, diagnostics } = await new ClaudeCodeAdapter().read(
    ClaudeCodeSession.fromTranscriptPath(main),
  );

  assert.deepEqual(diagnostics, []);
  const [embedded, ...others] = trajectory.subagent_trajectories ?? [];
  assert.equal(others.length, 0);
  assert.equal(embedded?.trajectory_id, 'agent-a1b2c3');
  assert.equal(embedded?.session_id, id);
  assert.deepEqual(
    embedded?.steps.map((step) => [step.source, step.message]),
    [
      ['user', 'map the repo'],
      ['agent', 'The repo has two packages.'],
    ],
  );
  const result = trajectory.steps[1].observation?.results[0];
  assert.deepEqual(result?.subagent_trajectory_ref, [
    { trajectory_id: 'agent-a1b2c3', session_id: id },
  ]);
});

test('reading with subagents false embeds no subagent', async () => {
  await using dir = await new TemporaryFiles().directory('trajectory-');
  const { main } = await sessionWithSubagent(dir.path, { meta: true });

  const { trajectory } = await new ClaudeCodeAdapter().read(
    ClaudeCodeSession.fromTranscriptPath(main),
    { subagents: false },
  );

  assert.equal(trajectory.subagent_trajectories, undefined);
  assert.equal(
    trajectory.steps[1].observation?.results[0].subagent_trajectory_ref,
    undefined,
  );
});

test('a subagent with no meta file is embedded but unlinked, with an unlinked_subagent diagnostic', async () => {
  await using dir = await new TemporaryFiles().directory('trajectory-');
  const { main, subagent } = await sessionWithSubagent(dir.path, {
    meta: false,
  });

  const { trajectory, diagnostics } = await new ClaudeCodeAdapter().read(
    ClaudeCodeSession.fromTranscriptPath(main),
  );

  assert.deepEqual(
    trajectory.subagent_trajectories?.map((sub) => sub.trajectory_id),
    ['agent-a1b2c3'],
  );
  assert.equal(
    trajectory.steps[1].observation?.results[0].subagent_trajectory_ref,
    undefined,
  );
  assert.deepEqual(
    diagnostics.map(({ code, path }) => ({ code, path })),
    [{ code: 'unlinked_subagent', path: subagent }],
  );
});

test(
  'a subagent transcript that cannot be read is an unreadable_subagent diagnostic, and the session still reads',
  { skip: runsAsRoot },
  async () => {
    await using dir = await new TemporaryFiles().directory('trajectory-');
    const { main, subagent } = await sessionWithSubagent(dir.path, {
      meta: true,
    });
    await chmod(subagent, 0o000);

    try {
      const { trajectory, diagnostics } = await new ClaudeCodeAdapter().read(
        ClaudeCodeSession.fromTranscriptPath(main),
      );

      assert.equal(trajectory.steps.length, 2);
      assert.equal(trajectory.subagent_trajectories, undefined);
      assert.deepEqual(
        diagnostics.map(({ code, path }) => ({ code, path })),
        [{ code: 'unreadable_subagent', path: subagent }],
      );
    } finally {
      await chmod(subagent, 0o600);
    }
  },
);

test('a SubagentStop hook reads the subagent transcript as the root, under its parent session', async () => {
  await using dir = await new TemporaryFiles().directory('trajectory-');
  const { id, subagent } = await sessionWithSubagent(dir.path, { meta: true });

  const { trajectory, diagnostics } = await new ClaudeCodeAdapter().read(
    ClaudeCodeSubagent.fromTranscriptPath(subagent),
  );

  assert.deepEqual(diagnostics, []);
  assert.equal(trajectory.trajectory_id, 'agent-a1b2c3');
  assert.equal(trajectory.session_id, id);
  assert.deepEqual(
    trajectory.steps.map((step) => step.message),
    ['map the repo', 'The repo has two packages.'],
  );
});

test('building a session from a path touches no disk, so a path that does not exist builds and fails only on read', async () => {
  await using dir = await new TemporaryFiles().directory('trajectory-');
  const path = join(
    dir.path,
    '7f1c2a90-0000-4000-8000-000000000022',
    'subagents',
    'agent-z9.jsonl',
  );

  const subagent = ClaudeCodeSubagent.fromTranscriptPath(path);

  assert.equal(subagent.agentId, 'z9');
  assert.equal(subagent.sessionId, '7f1c2a90-0000-4000-8000-000000000022');
  await assert.rejects(
    () => new ClaudeCodeAdapter().read(subagent),
    (error: unknown) =>
      error instanceof SessionReadError && error.path === path,
  );
});

test('the latest usage of a message becomes its metrics (synthetic: usage that grows while one message streams)', async () => {
  await using dir = await new TemporaryFiles().directory('trajectory-');
  const path = join(dir.path, '7f1c2a90-0000-4000-8000-000000000023.jsonl');
  const first = assistant('msg-1', { type: 'text', text: 'Part one.' });
  const second = assistant(
    'msg-1',
    { type: 'text', text: 'Part two.' },
    { uuid: 'u-a-2' },
  );
  second.message.usage.output_tokens = 80;
  await writeFile(
    path,
    [typed('hello'), first, second]
      .map((entry) => JSON.stringify(entry))
      .join('\n') + '\n',
  );

  const { trajectory } = await new ClaudeCodeAdapter().read(
    ClaudeCodeSession.fromTranscriptPath(path),
  );

  const agent = trajectory.steps[1];
  assert.ok(agent.source === 'agent');
  assert.equal(agent.message, 'Part one.\nPart two.');
  assert.equal(agent.metrics?.completion_tokens, 80);
});

test('parallel calls of one message each get their own result by id, in the order the results arrive, with is_error kept', async () => {
  await using dir = await new TemporaryFiles().directory('trajectory-');
  const path = join(dir.path, '7f1c2a90-0000-4000-8000-000000000024.jsonl');
  const failed = toolResult('toolu-b', 'grep: no such file');
  failed.message.content[0].is_error = true;
  await writeFile(
    path,
    [
      typed('look around'),
      assistant('msg-1', {
        type: 'tool_use',
        id: 'toolu-a',
        name: 'Bash',
        input: { command: 'ls' },
      }),
      assistant(
        'msg-1',
        {
          type: 'tool_use',
          id: 'toolu-b',
          name: 'Bash',
          input: { command: 'grep x y' },
        },
        { uuid: 'u-a-2' },
      ),
      failed,
      toolResult('toolu-a', 'README.md'),
      assistant('msg-2', { type: 'text', text: 'Done.' }, { uuid: 'u-a-3' }),
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n') + '\n',
  );

  const { trajectory, diagnostics } = await new ClaudeCodeAdapter().read(
    ClaudeCodeSession.fromTranscriptPath(path),
  );

  assert.deepEqual(diagnostics, []);
  const calling = trajectory.steps[1];
  assert.ok(calling.source === 'agent');
  assert.deepEqual(
    calling.tool_calls?.map((call) => call.tool_call_id),
    ['toolu-a', 'toolu-b'],
  );
  assert.deepEqual(
    calling.observation?.results.map((result) => [
      result.source_call_id,
      result.content,
      claudeCodeOf(result.extra).is_error,
    ]),
    [
      ['toolu-b', 'grep: no such file', true],
      ['toolu-a', 'README.md', false],
    ],
  );
  assert.equal(trajectory.steps[2].observation, undefined);
});

test('every summary and every PR link is kept, in file order', async () => {
  await using dir = await new TemporaryFiles().directory('trajectory-');
  const id = '7f1c2a90-0000-4000-8000-000000000025';
  const path = join(dir.path, `${id}.jsonl`);
  const links = [
    { type: 'pr-link', url: 'https://github.com/o/r/pull/7', sessionId: id },
    { type: 'pr-link', url: 'https://github.com/o/r/pull/8', sessionId: id },
  ];
  await writeFile(
    path,
    [
      typed('hello'),
      { type: 'summary', summary: 'First part', leafUuid: 'u-typed-1' },
      links[0],
      { type: 'summary', summary: 'Second part', leafUuid: 'u-typed-1' },
      links[1],
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n') + '\n',
  );

  const { trajectory } = await new ClaudeCodeAdapter().read(
    ClaudeCodeSession.fromTranscriptPath(path),
  );

  const claudeCode = claudeCodeOf(trajectory.extra);
  assert.deepEqual(claudeCode.summaries, ['First part', 'Second part']);
  assert.deepEqual(claudeCode.pr_links, links);
});

test('building a main session from a path touches no disk, so a missing transcript builds and fails only on read', async () => {
  await using dir = await new TemporaryFiles().directory('trajectory-');
  const path = join(
    dir.path,
    'projects',
    '-gone',
    '7f1c2a90-0000-4000-8000-000000000026.jsonl',
  );

  const session = ClaudeCodeSession.fromTranscriptPath(path);

  assert.equal(session.sessionId, '7f1c2a90-0000-4000-8000-000000000026');
  assert.equal(session.transcriptPath, path);
  await assert.rejects(
    () => new ClaudeCodeAdapter().read(session),
    (error: unknown) =>
      error instanceof SessionReadError && error.path === path,
  );
});

/** A prompt the user typed, as Claude Code 2.1.332 writes it. */
function typed(text: string, overrides: Record<string, unknown> = {}) {
  return {
    parentUuid: null,
    isSidechain: false,
    promptId: 'p-1',
    type: 'user',
    message: { role: 'user', content: text },
    uuid: 'u-typed-1',
    timestamp: '2026-11-27T10:00:00.000Z',
    permissionMode: 'auto',
    origin: { kind: 'human' },
    promptSource: 'typed',
    userType: 'external',
    entrypoint: 'cli',
    cwd: '/work',
    sessionId: '7f1c2a90-0000-4000-8000-000000000002',
    version: '2.1.332',
    gitBranch: 'main',
    ...overrides,
  };
}

/** A prompt delivered while the agent works, as Claude Code 2.1.332 writes the attachment. */
function queued(prompt: string, origin: { kind: string }) {
  return {
    parentUuid: 'u-typed-1',
    isSidechain: false,
    attachment: {
      type: 'queued_command',
      prompt,
      commandMode: 'prompt',
      origin,
      timestamp: '2026-11-27T10:00:05.000Z',
    },
    type: 'attachment',
    uuid: 'u-queued-1',
    timestamp: '2026-11-27T10:00:05.000Z',
    userType: 'external',
    entrypoint: 'cli',
    cwd: '/work',
    sessionId: '7f1c2a90-0000-4000-8000-000000000002',
    version: '2.1.332',
    gitBranch: 'main',
  };
}

/** One content block of an assistant message, as Claude Code writes each block as its own entry. */
function assistant(
  messageId: string,
  block: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  return {
    parentUuid: 'u-typed-1',
    isSidechain: false,
    message: {
      model: 'claude-opus-5-5',
      id: messageId,
      type: 'message',
      role: 'assistant',
      content: [block],
      stop_reason: block.type === 'tool_use' ? 'tool_use' : 'end_turn',
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 300,
        cache_read_input_tokens: 4000,
        output_tokens: 50,
      },
    },
    requestId: `req-${messageId}`,
    type: 'assistant',
    uuid: 'u-a-1',
    timestamp: '2026-11-27T10:00:01.000Z',
    userType: 'external',
    entrypoint: 'cli',
    cwd: '/work',
    sessionId: '7f1c2a90-0000-4000-8000-000000000002',
    version: '2.1.332',
    gitBranch: 'main',
    ...overrides,
  };
}

/** The user entry that carries one tool's result, with the structured result Claude Code keeps beside it. */
function toolResult(
  toolUseId: string,
  content: string,
  toolUseResult: unknown = { stdout: content },
) {
  return {
    parentUuid: 'u-a-1',
    isSidechain: false,
    promptId: 'p-1',
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          tool_use_id: toolUseId,
          type: 'tool_result',
          content,
          is_error: false,
        },
      ],
    },
    uuid: `u-result-${toolUseId}`,
    timestamp: '2026-11-27T10:00:02.000Z',
    toolUseResult,
    sourceToolAssistantUUID: 'u-a-1',
    userType: 'external',
    entrypoint: 'cli',
    cwd: '/work',
    sessionId: '7f1c2a90-0000-4000-8000-000000000002',
    version: '2.1.332',
    gitBranch: 'main',
  };
}

/** An attachment entry, as Claude Code 2.1.332 writes it. */
function attached(attachment: Record<string, unknown>) {
  return {
    parentUuid: 'u-typed-1',
    isSidechain: false,
    attachment,
    type: 'attachment',
    uuid: 'u-attachment-1',
    timestamp: '2026-11-27T10:00:03.000Z',
    userType: 'external',
    entrypoint: 'cli',
    cwd: '/work',
    sessionId: '7f1c2a90-0000-4000-8000-000000000002',
    version: '2.1.332',
    gitBranch: 'main',
  };
}

/** A system row, as Claude Code 2.1.332 writes it. */
function systemRow(row: Record<string, unknown>) {
  return {
    parentUuid: 'u-typed-1',
    isSidechain: false,
    type: 'system',
    ...row,
    timestamp: '2026-11-27T10:00:04.000Z',
    uuid: 'u-system-1',
    userType: 'external',
    entrypoint: 'cli',
    cwd: '/work',
    sessionId: '7f1c2a90-0000-4000-8000-000000000002',
    version: '2.1.332',
    gitBranch: 'main',
  };
}

/** The `extra.claude_code` record of a step, a result or a trajectory. */
function claudeCodeOf(
  extra: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const value = extra?.claude_code;
  assert.ok(isRecord(value), 'extra.claude_code is a record');
  return value;
}

function codeOf(error: unknown): unknown {
  return isRecord(error) ? error.code : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
