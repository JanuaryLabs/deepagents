import { TemporaryFiles } from '@zukhruf/fs';
import { test } from '@zukhruf/parameterized-test';
import assert from 'node:assert/strict';
import { chmod, mkdir, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { ClaudeCodeAdapter, ClaudeCodeStore } from '@deepagents/trajectory';

/** chmod 000 cannot make a file unreadable to root, so these run only as another user. */
const runsAsRoot =
  process.getuid?.() === 0 &&
  'root reads every file, so chmod 000 cannot lock one';

const A = '7f1c2a90-0000-4000-8000-0000000000a1';
const B = '7f1c2a90-0000-4000-8000-0000000000b2';
const C = '7f1c2a90-0000-4000-8000-0000000000c3';

test('session(id) returns undefined for an id no project holds', async () => {
  await using dir = await new TemporaryFiles().directory('trajectory-');
  await transcript(dir.path, '-work-one', A);

  const store = new ClaudeCodeStore({ root: dir.path });

  assert.equal(await store.session(B), undefined);
});

test('session(id) finds the transcript in whichever project holds it', async () => {
  await using dir = await new TemporaryFiles().directory('trajectory-');
  await transcript(dir.path, '-work-one', A);
  const path = await transcript(dir.path, '-work-two', B);

  const session = await new ClaudeCodeStore({ root: dir.path }).session(B);

  assert.equal(session?.sessionId, B);
  assert.equal(session?.transcriptPath, path);
});

test('sessions({ since }) lists main transcripts changed since the date, newest first, with no subagent files', async () => {
  await using dir = await new TemporaryFiles().directory('trajectory-');
  const old = await transcript(dir.path, '-work-one', A);
  const middle = await transcript(dir.path, '-work-one', B);
  const newest = await transcript(dir.path, '-work-two', C);
  const subagent = join(
    dir.path,
    'projects',
    '-work-one',
    B,
    'subagents',
    'agent-x1.jsonl',
  );
  await mkdir(dirname(subagent), { recursive: true });
  await writeFile(subagent, `${JSON.stringify(typed(B, 'sub'))}\n`);
  await touch(old, '2026-11-20T00:00:00Z');
  await touch(middle, '2026-11-25T00:00:00Z');
  await touch(newest, '2026-11-26T00:00:00Z');
  await touch(subagent, '2026-11-26T12:00:00Z');

  const listed = await Array.fromAsync(
    new ClaudeCodeStore({ root: dir.path }).sessions({
      since: new Date('2026-11-24T00:00:00Z'),
    }),
    (session) => session.sessionId,
  );

  assert.deepEqual(listed, [C, B]);
});

test(
  'listing reads no transcript content, so a transcript the process cannot read is still listed',
  { skip: runsAsRoot },
  async () => {
    await using dir = await new TemporaryFiles().directory('trajectory-');
    const locked = await transcript(dir.path, '-work-one', A);
    await touch(locked, '2026-11-26T00:00:00Z');
    await chmod(locked, 0o000);

    try {
      const listed = await Array.fromAsync(
        new ClaudeCodeStore({
          root: dir.path,
        }).sessions({
          since: new Date('2026-11-01T00:00:00Z'),
        }),
        (session) => session.sessionId,
      );

      assert.deepEqual(listed, [A]);
    } finally {
      await chmod(locked, 0o600);
    }
  },
);

test('a store whose root holds no projects folder lists nothing', async () => {
  await using dir = await new TemporaryFiles().directory('trajectory-');

  const listed = await Array.fromAsync(
    new ClaudeCodeStore({ root: dir.path }).sessions({
      since: new Date('2026-11-01T00:00:00Z'),
    }),
    (session) => session.sessionId,
  );

  assert.deepEqual(listed, []);
});

test('chain() follows derived-from back across projects whatever its via, oldest first, and a resume that names itself ends it', async () => {
  await using dir = await new TemporaryFiles().directory('trajectory-');
  const first = await transcript(dir.path, '-work-one', A);
  const second = await transcript(dir.path, '-work-two', B, [
    derivedFrom(B, A, 'resume'),
  ]);
  const third = await transcript(dir.path, '-work-two', C, [
    derivedFrom(C, B, 'clear'),
    derivedFrom(C, C, 'resume'),
  ]);
  const store = new ClaudeCodeStore({ root: dir.path });

  const latest = await store.session(C);
  assert.ok(latest);
  const { sessions, missing } = await store.chain(latest);

  assert.deepEqual(missing, []);
  assert.deepEqual(
    sessions.map((session) => session.transcriptPath),
    [first, second, third],
  );
  const adapter = new ClaudeCodeAdapter();
  const read = await Promise.all(
    sessions.map((session) => adapter.read(session)),
  );
  assert.deepEqual(
    read.map(({ trajectory }) => [
      trajectory.session_id,
      trajectory.continued_trajectory_ref,
    ]),
    [
      [A, second],
      [A, third],
      [A, undefined],
    ],
  );
});

test('chain() of a session with no derived-from is that session alone', async () => {
  await using dir = await new TemporaryFiles().directory('trajectory-');
  const path = await transcript(dir.path, '-work-one', A);
  const store = new ClaudeCodeStore({ root: dir.path });
  const session = await store.session(A);
  assert.ok(session);

  const { sessions, missing } = await store.chain(session);

  assert.deepEqual(
    sessions.map((segment) => segment.transcriptPath),
    [path],
  );
  assert.deepEqual(missing, []);
});

test('chain().missing names each id the chain points to whose transcript is gone', async () => {
  await using dir = await new TemporaryFiles().directory('trajectory-');
  const path = await transcript(dir.path, '-work-one', B, [
    derivedFrom(B, A, 'clear'),
  ]);
  const store = new ClaudeCodeStore({ root: dir.path });
  const session = await store.session(B);
  assert.ok(session);

  const { sessions, missing } = await store.chain(session);

  assert.deepEqual(
    sessions.map((segment) => segment.transcriptPath),
    [path],
  );
  assert.deepEqual(missing, [A]);
});

/** Writes `<root>/projects/<project>/<id>.jsonl` with one typed prompt and the given entries before it. */
async function transcript(
  root: string,
  project: string,
  id: string,
  before: Record<string, unknown>[] = [],
): Promise<string> {
  const path = join(root, 'projects', project, `${id}.jsonl`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    [...before, typed(id, `prompt of ${id}`)]
      .map((entry) => JSON.stringify(entry))
      .join('\n') + '\n',
  );
  return path;
}

/** The link Claude Code writes into a new transcript after a /clear or a resume. */
function derivedFrom(sessionId: string, from: string, via: string) {
  return {
    type: 'derived-from',
    v: 1,
    sessionId,
    sessions: [{ type: 'claude_code_session', id: from, via }],
  };
}

/** A prompt the user typed, as Claude Code 2.1.332 writes it. */
function typed(sessionId: string, text: string) {
  return {
    parentUuid: null,
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content: text },
    uuid: `u-${sessionId}`,
    timestamp: '2026-11-27T10:00:00.000Z',
    origin: { kind: 'human' },
    entrypoint: 'cli',
    cwd: '/work',
    sessionId,
    version: '2.1.332',
  };
}

async function touch(path: string, iso: string): Promise<void> {
  const time = new Date(iso);
  await utimes(path, time, time);
}

test('chain() follows every session one derived-from entry names', async () => {
  await using dir = await new TemporaryFiles().directory('trajectory-');
  const a = await transcript(dir.path, '-work-one', A);
  const b = await transcript(dir.path, '-work-one', B);
  const c = await transcript(dir.path, '-work-one', C, [
    {
      type: 'derived-from',
      v: 1,
      sessionId: C,
      sessions: [
        { type: 'claude_code_session', id: A, via: 'clear' },
        { type: 'claude_code_session', id: B, via: 'clear' },
      ],
    },
  ]);
  const store = new ClaudeCodeStore({ root: dir.path });
  const latest = await store.session(C);
  assert.ok(latest);

  const { sessions, missing } = await store.chain(latest);

  assert.deepEqual(missing, []);
  assert.deepEqual(
    sessions.map((session) => session.transcriptPath).toSorted(),
    [a, b, c].toSorted(),
  );
  assert.equal(sessions.at(-1)?.transcriptPath, c);
});

test('chain() takes the transcript beside the current one when two projects hold the same id', async () => {
  await using dir = await new TemporaryFiles().directory('trajectory-');
  await transcript(dir.path, '-work-one', A);
  const beside = await transcript(dir.path, '-work-two', A);
  await transcript(dir.path, '-work-two', B, [derivedFrom(B, A, 'clear')]);
  const store = new ClaudeCodeStore({ root: dir.path });
  const latest = await store.session(B);
  assert.ok(latest);
  assert.ok(latest.transcriptPath.includes('-work-two'));

  const { sessions } = await store.chain(latest);

  assert.equal(sessions[0]?.transcriptPath, beside);
});
