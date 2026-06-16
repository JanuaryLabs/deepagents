import { generateText, stepCountIs } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import spawn from 'nano-spawn';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  type FileChange,
  StraceUnavailableError,
  createBashTool,
  createDockerSandbox,
} from '@deepagents/context';

async function isDockerAvailable(): Promise<boolean> {
  try {
    await spawn('docker', ['info']);
    return true;
  } catch {
    return false;
  }
}

// Native-arch image with strace + python3 baked in. DockerfileStrategy
// content-hash-caches the build, so the apt install runs once per machine.
const STRACE_IMAGE =
  'FROM debian:stable-slim\n' +
  'RUN apt-get update && apt-get install -y --no-install-recommends strace python3 ' +
  '&& rm -rf /var/lib/apt/lists/*\n';

const dockerAvailable = await isDockerAvailable();
const dockerSuite = dockerAvailable ? describe : describe.skip;

const ops = (changes: FileChange[]) =>
  changes.map((c) => ({
    op: c.op,
    path: c.path,
    ...(c.from ? { from: c.from } : {}),
  }));

interface Recorder {
  /** Flatten + clear changes seen via onFileChanges since the last drain. */
  drain(): FileChange[];
  /** Per-command groups (one entry per executeCommand/spawn that emitted). */
  readonly calls: FileChange[][];
}

dockerSuite('strace file-change tracking (docker backend)', () => {
  const ROOT = `/work-${process.pid}`;

  // The public surface is the onFileChanges callback (fired per command); the
  // recorder accumulates it and exposes a drain() for per-command assertions.
  async function withSandbox<T>(
    fn: (
      s: Awaited<ReturnType<typeof createBashTool>>,
      rec: Recorder,
    ) => Promise<T>,
  ): Promise<T> {
    const calls: FileChange[][] = [];
    const rec: Recorder = {
      drain() {
        const flat = calls.flat();
        calls.length = 0;
        return flat;
      },
      calls,
    };
    const backend = await createDockerSandbox({ dockerfile: STRACE_IMAGE });
    const s = await createBashTool({
      sandbox: backend,
      destination: ROOT,
      onFileChanges: (changes) => {
        calls.push([...changes]);
      },
    });
    try {
      await s.sandbox.executeCommand(`mkdir -p ${ROOT}`);
      rec.drain();
      return await fn(s, rec);
    } finally {
      await s.sandbox.dispose();
    }
  }

  it('reports write for a new file', async () => {
    await withSandbox(async (s, rec) => {
      const r = await s.sandbox.executeCommand(`echo hi > ${ROOT}/a.txt`);
      assert.strictEqual(r.exitCode, 0, r.stderr);
      const changes = rec.drain();
      assert.ok(
        changes.some((c) => c.op === 'write' && c.path === `${ROOT}/a.txt`),
        JSON.stringify(changes),
      );
    });
  });

  it('reports delete for rm', async () => {
    await withSandbox(async (s, rec) => {
      await s.sandbox.executeCommand(`echo hi > ${ROOT}/a.txt`);
      rec.drain();
      const r = await s.sandbox.executeCommand(`rm ${ROOT}/a.txt`);
      assert.strictEqual(r.exitCode, 0, r.stderr);
      assert.deepStrictEqual(ops(rec.drain()), [
        { op: 'delete', path: `${ROOT}/a.txt` },
      ]);
    });
  });

  it('reports rename for mv', async () => {
    await withSandbox(async (s, rec) => {
      await s.sandbox.executeCommand(`echo hi > ${ROOT}/a.txt`);
      rec.drain();
      const r = await s.sandbox.executeCommand(
        `mv ${ROOT}/a.txt ${ROOT}/b.txt`,
      );
      assert.strictEqual(r.exitCode, 0, r.stderr);
      assert.ok(
        rec
          .drain()
          .some(
            (c) =>
              c.op === 'rename' &&
              c.from === `${ROOT}/a.txt` &&
              c.path === `${ROOT}/b.txt`,
          ),
      );
    });
  });

  it('reports write for mkdir', async () => {
    await withSandbox(async (s, rec) => {
      const r = await s.sandbox.executeCommand(`mkdir ${ROOT}/sub`);
      assert.strictEqual(r.exitCode, 0, r.stderr);
      assert.ok(
        rec.drain().some((c) => c.op === 'write' && c.path === `${ROOT}/sub`),
      );
    });
  });

  it('drops a file written then deleted within one command', async () => {
    await withSandbox(async (s, rec) => {
      const r = await s.sandbox.executeCommand(
        `sh -c 'echo x > ${ROOT}/t.txt; rm ${ROOT}/t.txt'`,
      );
      assert.strictEqual(r.exitCode, 0, r.stderr);
      assert.deepStrictEqual(
        rec.drain().filter((c) => c.path === `${ROOT}/t.txt`),
        [],
      );
    });
  });

  it('excludes the trace directory from the manifest', async () => {
    await withSandbox(async (s, rec) => {
      await s.sandbox.executeCommand(`echo hi > ${ROOT}/a.txt`);
      assert.ok(!rec.drain().some((c) => c.path.startsWith('/tmp/dat-trace')));
    });
  });

  it('fires onFileChanges per command with only that call’s changes', async () => {
    await withSandbox(async (s, rec) => {
      await Promise.all([
        s.sandbox.executeCommand(`echo one > ${ROOT}/one.txt`),
        s.sandbox.executeCommand(`echo two > ${ROOT}/two.txt`),
      ]);
      const paths = rec.calls.map((group) => group.map((c) => c.path));
      const isolatedOne = paths.some(
        (p) => p.includes(`${ROOT}/one.txt`) && !p.includes(`${ROOT}/two.txt`),
      );
      const isolatedTwo = paths.some(
        (p) => p.includes(`${ROOT}/two.txt`) && !p.includes(`${ROOT}/one.txt`),
      );
      assert.ok(isolatedOne && isolatedTwo, JSON.stringify(paths));
    });
  });

  it('decodes octal-escaped non-ASCII filenames (café.txt)', async () => {
    await withSandbox(async (s, rec) => {
      const r = await s.sandbox.executeCommand(`echo hi > ${ROOT}/café.txt`);
      assert.strictEqual(r.exitCode, 0, r.stderr);
      assert.ok(
        rec
          .drain()
          .some((c) => c.op === 'write' && c.path === `${ROOT}/café.txt`),
      );
    });
  });

  it('collapses rename-then-recreate to a single rename (no duplicate)', async () => {
    await withSandbox(async (s, rec) => {
      await s.sandbox.executeCommand(`echo a > ${ROOT}/a.txt`);
      rec.drain();
      const r = await s.sandbox.executeCommand(
        `sh -c 'mv ${ROOT}/a.txt ${ROOT}/b.txt && echo c > ${ROOT}/b.txt'`,
      );
      assert.strictEqual(r.exitCode, 0, r.stderr);
      assert.deepStrictEqual(
        ops(rec.drain()).filter((c) => c.path === `${ROOT}/b.txt`),
        [{ op: 'rename', path: `${ROOT}/b.txt`, from: `${ROOT}/a.txt` }],
      );
    });
  });

  it('does NOT report a write for an O_RDWR open that only reads', async () => {
    await withSandbox(async (s, rec) => {
      await s.sandbox.executeCommand(`printf data > ${ROOT}/db`);
      rec.drain();
      // python open(path, 'r+') is O_RDWR with no O_CREAT/O_TRUNC; reading emits
      // no write() syscall, so the fix must not record a phantom write.
      const r = await s.sandbox.executeCommand(
        `python3 -c "f=open('${ROOT}/db','r+'); f.read(); f.close()"`,
      );
      assert.strictEqual(r.exitCode, 0, r.stderr);
      assert.deepStrictEqual(
        rec.drain().filter((c) => c.path === `${ROOT}/db`),
        [],
      );
    });
  });

  it('reports a write when an O_RDWR open actually writes', async () => {
    await withSandbox(async (s, rec) => {
      await s.sandbox.executeCommand(`printf data > ${ROOT}/db2`);
      rec.drain();
      const r = await s.sandbox.executeCommand(
        `python3 -c "f=open('${ROOT}/db2','r+'); f.write('x'); f.close()"`,
      );
      assert.strictEqual(r.exitCode, 0, r.stderr);
      assert.ok(
        rec.drain().some((c) => c.op === 'write' && c.path === `${ROOT}/db2`),
        'expected a write for the O_RDWR file that was written',
      );
    });
  });

  it('preserves the command exit code under strace (not masked)', async () => {
    await withSandbox(async (s) => {
      const r = await s.sandbox.executeCommand(`sh -c 'exit 7'`);
      assert.strictEqual(r.exitCode, 7, r.stderr);
    });
  });

  it('exposes each tool call’s changes on its tool result (per-message aggregation via meta, hidden from the model)', async () => {
    await withSandbox(async (s) => {
      // One assistant turn issuing two bash tool calls; aggregating a message's
      // file changes = traversing its tool results and flattening output.meta.
      const model = new MockLanguageModelV3({
        doGenerate: async () => ({
          finishReason: { unified: 'tool-calls', raw: undefined },
          usage: {
            inputTokens: {
              total: 1,
              noCache: 1,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
          content: [
            {
              type: 'tool-call',
              toolCallId: 'c1',
              toolName: 'bash',
              input: JSON.stringify({
                command: `echo one > ${ROOT}/agg1.txt`,
                reasoning: 'r',
              }),
            },
            {
              type: 'tool-call',
              toolCallId: 'c2',
              toolName: 'bash',
              input: JSON.stringify({
                command: `echo two > ${ROOT}/agg2.txt`,
                reasoning: 'r',
              }),
            },
          ],
          warnings: [],
        }),
      });

      const res = await generateText({
        model,
        tools: s.tools,
        prompt: 'go',
        stopWhen: stepCountIs(1),
      });

      const aggregated = res.toolResults.flatMap(
        (tr) =>
          ((tr.output as { meta?: { fileChanges?: FileChange[] } }).meta
            ?.fileChanges ?? []) as FileChange[],
      );
      assert.deepStrictEqual(aggregated.map((c) => c.path).sort(), [
        `${ROOT}/agg1.txt`,
        `${ROOT}/agg2.txt`,
      ]);

      // The model never sees `meta`: toModelOutput strips it.
      const modelView = (
        s.bash as unknown as {
          toModelOutput?: (a: { output: unknown }) => { value: unknown };
        }
      ).toModelOutput?.({ output: res.toolResults[0].output });
      assert.ok(
        modelView && !('meta' in (modelView.value as object)),
        `meta must be stripped from the model view, got ${JSON.stringify(modelView)}`,
      );
    });
  });

  it('traces spawn — change reported when the process exits', async () => {
    await withSandbox(async (s, rec) => {
      assert.ok(s.sandbox.spawn, 'docker sandbox should expose spawn');
      const child = s.sandbox.spawn(`echo spawned > ${ROOT}/sp.txt`);
      const drainStream = async (stream: ReadableStream<Uint8Array>) => {
        const reader = stream.getReader();
        for (;;) {
          const { done } = await reader.read();
          if (done) break;
        }
      };
      await Promise.all([drainStream(child.stdout), drainStream(child.stderr)]);
      const info = await child.exit;
      assert.strictEqual(info.success, true);
      assert.ok(
        rec
          .drain()
          .some((c) => c.op === 'write' && c.path === `${ROOT}/sp.txt`),
      );
    });
  });
});

dockerSuite('strace self-test hard-fail', () => {
  it('throws StraceUnavailableError(strace-missing) when strace is absent', async () => {
    const backend = await createDockerSandbox({ image: 'alpine:latest' });
    try {
      await assert.rejects(
        () => createBashTool({ sandbox: backend, destination: '/work' }),
        (err: unknown) =>
          err instanceof StraceUnavailableError &&
          err.reason === 'strace-missing',
      );
    } finally {
      await backend.dispose();
    }
  });
});
