import { TemporaryFiles } from '@zukhruf/fs';
import { test } from '@zukhruf/parameterized-test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SESSION = '7f1c2a90-0000-4000-8000-0000000000a1';
const USAGE = 'usage: trajectory read claude-code <transcript.jsonl>\n';

test('a missing transcript prints the read error on stderr and exits 2', async () => {
  await using dir = await new TemporaryFiles().directory('trajectory-cli-');
  const path = join(dir.path, `${SESSION}.jsonl`);

  const result = await trajectory('read', 'claude-code', path);

  assert.deepEqual(result, {
    code: 2,
    stdout: '',
    stderr: `trajectory: could not read the transcript: ${path}\n`,
  });
});

test('a file that is not a main transcript prints why on stderr and exits 2', async () => {
  await using dir = await new TemporaryFiles().directory('trajectory-cli-');
  const path = join(dir.path, `${SESSION}.json`);

  const result = await trajectory('read', 'claude-code', path);

  assert.deepEqual(result, {
    code: 2,
    stdout: '',
    stderr: `trajectory: not a Claude Code main transcript (expected <session-id>.jsonl; a subagent file is a ClaudeCodeSubagent): ${path}\n`,
  });
});

void test.each(
  [
    { name: 'an unknown command', args: ['list', 'claude-code', 'x.jsonl'] },
    { name: 'an unknown agent', args: ['read', 'codex', 'x.jsonl'] },
    { name: 'no transcript path', args: ['read', 'claude-code'] },
    {
      name: 'a second path',
      args: ['read', 'claude-code', 'a.jsonl', 'b.jsonl'],
    },
    {
      name: 'an unknown option',
      args: ['read', 'claude-code', 'x.jsonl', '--all'],
    },
  ],
  ({ name, args }) =>
    test(`${name} prints the usage on stderr and exits 2`, async () => {
      const result = await trajectory(...args);

      assert.deepEqual(result, { code: 2, stdout: '', stderr: USAGE });
    }),
);

test('a transcript prints its trajectory and its bad line diagnostic as one JSON line and exits 0', async () => {
  await using dir = await new TemporaryFiles().directory('trajectory-cli-');
  const path = join(dir.path, `${SESSION}.jsonl`);
  await writeFile(
    path,
    `not json\n${JSON.stringify(typed(SESSION, 'fix the build'))}\n`,
  );

  const { code, stdout, stderr } = await trajectory(
    'read',
    'claude-code',
    path,
  );

  const lines = stdout.split('\n');
  const output = JSON.parse(lines[0]);
  assert.deepEqual(
    {
      code,
      stderr,
      afterJson: lines.slice(1),
      keys: Object.keys(output),
      sessionId: output.trajectory.session_id,
      firstStep: {
        source: output.trajectory.steps[0].source,
        message: output.trajectory.steps[0].message,
      },
      diagnostics: output.diagnostics.map(
        ({ code, line }: { code: string; line: number }) => ({ code, line }),
      ),
    },
    {
      code: 0,
      stderr: '',
      afterJson: [''],
      keys: ['trajectory', 'diagnostics'],
      sessionId: SESSION,
      firstStep: { source: 'user', message: 'fix the build' },
      diagnostics: [{ code: 'invalid_json_line', line: 1 }],
    },
  );
});

/** Runs the bin the package's manifest names, as an installed caller runs it. */
async function trajectory(...args: string[]) {
  const manifestPath = fileURLToPath(
    import.meta.resolve('@deepagents/trajectory/package.json'),
  );
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const bin = join(dirname(manifestPath), manifest.bin.trajectory);
  const { promise, resolve } = Promise.withResolvers<{
    code: number | string | null | undefined;
    stdout: string;
    stderr: string;
  }>();
  execFile(bin, args, (error, stdout, stderr) =>
    resolve({ code: error ? error.code : 0, stdout, stderr }),
  );
  return promise;
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
