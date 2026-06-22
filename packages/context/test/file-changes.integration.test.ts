import { generateText, stepCountIs } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import type { CommandResult } from 'bash-tool';
import { build } from 'esbuild';
import spawn from 'nano-spawn';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  BashException,
  type FileChange,
  createBashTool,
  createDockerSandbox,
  withStraceFileChanges,
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

// `selfTestStrace` runs in-process (nano-spawn + node:fs), so the probe tests
// exercise it the way the real consumer does: a node process inside the
// container. That needs node AND the probe code in the image. `node:24-slim` is
// debian-based, so apt adds strace; the strace-less variant reuses the same base
// minus that layer.
const NODE_BASE = 'node:24-slim';
const NODE_STRACE_IMAGE =
  `FROM ${NODE_BASE}\n` +
  'RUN apt-get update && apt-get install -y --no-install-recommends strace ' +
  '&& rm -rf /var/lib/apt/lists/*\n';

// The probe imports a workspace package + nano-spawn, neither of which exists
// inside the container, so we esbuild it (plus a thin driver) into one
// self-contained ESM file, drop it in via `writeFiles`, and run it with `node`.
// The driver maps the probe's outcome onto stdout: `OK` on success, or
// `REASON:<reason>` when it throws StraceUnavailableError — the same
// classification the host-side assertions used to read off the thrown error.
async function buildProbeBundle(): Promise<string> {
  const driver = [
    `import { selfTestStrace, StraceUnavailableError } from '@deepagents/context/sandbox/strace';`,
    'try {',
    '  await selfTestStrace();',
    `  process.stdout.write('OK');`,
    '} catch (err) {',
    '  if (err instanceof StraceUnavailableError) process.stdout.write(`REASON:${err.reason}`);',
    '  else throw err;',
    '}',
  ].join('\n');
  const result = await build({
    stdin: { contents: driver, resolveDir: import.meta.dirname, loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    write: false,
  });
  return result.outputFiles[0].text;
}

const probeBundle = dockerAvailable ? await buildProbeBundle() : '';

type DockerBackend = Awaited<ReturnType<typeof createDockerSandbox>>;

async function runProbe(backend: DockerBackend): Promise<CommandResult> {
  await backend.writeFiles([{ path: '/probe.mjs', content: probeBundle }]);
  return backend.executeCommand('node /probe.mjs');
}

const ops = (changes: FileChange[]) =>
  changes.map((c) => ({
    op: c.op,
    path: c.path,
    ...(c.from ? { from: c.from } : {}),
  }));

const drainStream = async (
  stream: ReadableStream<Uint8Array>,
): Promise<void> => {
  const reader = stream.getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) break;
  }
};

const toolCall = (
  toolName: string,
  toolCallId: string,
  input: Record<string, unknown>,
) => ({
  type: 'tool-call' as const,
  toolCallId,
  toolName,
  input: JSON.stringify(input),
});

const bashToolCall = (toolCallId: string, command: string) =>
  toolCall('bash', toolCallId, { command, reasoning: 'r' });

const writeFileToolCall = (toolCallId: string, path: string, content: string) =>
  toolCall('writeFile', toolCallId, { path, content });

// One assistant turn issuing the given tool calls, wrapped in the V3 usage /
// finishReason envelope the mock model requires (an easy fixture to get wrong —
// see the agent-testing notes on V3 shapes).
const toolCallsResponse = (content: ReturnType<typeof toolCall>[]) => ({
  finishReason: { unified: 'tool-calls' as const, raw: undefined },
  usage: {
    inputTokens: {
      total: 1,
      noCache: 1,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: 1, text: 1, reasoning: undefined },
  },
  content,
  warnings: [],
});

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
    const tracked = await withStraceFileChanges(backend, {
      include: [ROOT, `${ROOT}/**`],
      onFileChanges: (changes) => {
        calls.push([...changes]);
      },
    });
    const s = await createBashTool({ sandbox: tracked, destination: ROOT });
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

  it('reports write for a file written via writeFiles (not just bash)', async () => {
    await withSandbox(async (s, rec) => {
      await s.sandbox.writeFiles([
        { path: `${ROOT}/via-write.txt`, content: 'hi' },
      ]);
      const changes = rec.drain();
      assert.ok(
        changes.some(
          (c) => c.op === 'write' && c.path === `${ROOT}/via-write.txt`,
        ),
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
        doGenerate: async () =>
          toolCallsResponse([
            bashToolCall('c1', `echo one > ${ROOT}/agg1.txt`),
            bashToolCall('c2', `echo two > ${ROOT}/agg2.txt`),
          ]),
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

  it('drops changes matching an exclude glob (e.g. uploaded skills) but keeps siblings', async () => {
    const seen: FileChange[] = [];
    const backend = await createDockerSandbox({ dockerfile: STRACE_IMAGE });
    const tracked = await withStraceFileChanges(backend, {
      include: [ROOT, `${ROOT}/**`],
      exclude: ['**/skills/**'],
      onFileChanges: (changes) => {
        seen.push(...changes);
      },
    });
    const s = await createBashTool({ sandbox: tracked, destination: ROOT });
    try {
      await s.sandbox.executeCommand(`mkdir -p ${ROOT}/skills`);
      seen.length = 0;
      const r = await s.sandbox.executeCommand(
        `sh -c 'echo a > ${ROOT}/skills/SKILL.md; echo b > ${ROOT}/keep.txt'`,
      );
      assert.strictEqual(r.exitCode, 0, r.stderr);
      const paths = seen.map((c) => c.path);
      assert.ok(
        paths.includes(`${ROOT}/keep.txt`),
        `included sibling must be reported: ${JSON.stringify(paths)}`,
      );
      assert.ok(
        !paths.some((p) => p.includes('/skills/')),
        `excluded skills writes must be dropped: ${JSON.stringify(paths)}`,
      );
    } finally {
      await s.sandbox.dispose();
    }
  });
});

dockerSuite('onFileChanges failure handling (docker backend)', () => {
  const ROOT = `/iso-${process.pid}`;

  const throwBoom = () => {
    throw new Error('boom');
  };

  // A caller-defined BashException with a distinctive format(); if it reaches the
  // result, the caller controlled it (nothing else produces exitCode 42).
  class RejectChange extends BashException {
    format(): CommandResult {
      return {
        stdout: '',
        stderr: `rejected: ${this.message}\n`,
        exitCode: 42,
      };
    }
  }

  it('renders a thrown BashException via the caller’s own format(), and still runs the command', async () => {
    const errors: unknown[] = [];
    const backend = await createDockerSandbox({ dockerfile: STRACE_IMAGE });
    const tracked = await withStraceFileChanges(backend, {
      include: [ROOT, `${ROOT}/**`],
      onFileChanges: () => {
        throw new RejectChange('no writes allowed');
      },
      onError: (error) => errors.push(error),
    });
    const s = await createBashTool({ sandbox: tracked, destination: ROOT });
    try {
      // The setup mkdir trips the tripwire too — swallow its failed call.
      await s.sandbox.executeCommand(`mkdir -p ${ROOT}`).catch(() => {});
      const r = await s.sandbox.executeCommand(`echo hi > ${ROOT}/a.txt`);
      // withBashExceptionCatch one level up used the caller's format() verbatim.
      assert.deepStrictEqual(r, {
        stdout: '',
        stderr: 'rejected: no writes allowed\n',
        exitCode: 42,
      });
      // onError is spawn-only — the command path never reaches it.
      assert.strictEqual(errors.length, 0);

      // The command itself still ran — reading a.txt (no write → no throw)
      // confirms the side effect landed despite the failed tool result.
      const read = await s.sandbox.executeCommand(`cat ${ROOT}/a.txt`);
      assert.strictEqual(read.exitCode, 0, read.stderr);
      assert.match(read.stdout, /hi/);
    } finally {
      await s.sandbox.dispose();
    }
  });

  it('fails the tool call when onFileChanges throws a plain Error (and does not reach onError)', async () => {
    const errors: unknown[] = [];
    const backend = await createDockerSandbox({ dockerfile: STRACE_IMAGE });
    const tracked = await withStraceFileChanges(backend, {
      include: [ROOT, `${ROOT}/**`],
      onFileChanges: throwBoom,
      onError: (error) => errors.push(error),
    });
    const s = await createBashTool({ sandbox: tracked, destination: ROOT });
    try {
      await s.sandbox.executeCommand(`mkdir -p ${ROOT}`).catch(() => {});
      // A non-BashException isn't caught up the chain, so the call rejects.
      await assert.rejects(
        () => s.sandbox.executeCommand(`echo hi > ${ROOT}/b.txt`),
        /boom/,
      );
      assert.strictEqual(errors.length, 0);

      const read = await s.sandbox.executeCommand(`cat ${ROOT}/b.txt`);
      assert.strictEqual(read.exitCode, 0, read.stderr);
      assert.match(read.stdout, /hi/);
    } finally {
      await s.sandbox.dispose();
    }
  });

  it('propagates a throwing onFileChanges out of sandbox.writeFiles (post-hoc gate)', async () => {
    const backend = await createDockerSandbox({ dockerfile: STRACE_IMAGE });
    const tracked = await withStraceFileChanges(backend, {
      include: [ROOT, `${ROOT}/**`],
      onFileChanges: throwBoom,
    });
    const s = await createBashTool({ sandbox: tracked, destination: ROOT });
    try {
      await s.sandbox.executeCommand(`mkdir -p ${ROOT}`).catch(() => {});
      // The sandbox method itself rejects; the writeFile TOOL wraps this (next
      // test). A plain Error has no format(), so it simply propagates.
      await assert.rejects(
        () =>
          s.sandbox.writeFiles([{ path: `${ROOT}/blocked.txt`, content: 'x' }]),
        /boom/,
      );
      // Post-hoc gate, same as the bash path: the write already landed.
      const read = await s.sandbox.executeCommand(`cat ${ROOT}/blocked.txt`);
      assert.strictEqual(read.exitCode, 0, read.stderr);
      assert.match(read.stdout, /x/);
    } finally {
      await s.sandbox.dispose();
    }
  });

  it('renders a thrown BashException as the writeFile tool RESULT (not a rejected call)', async () => {
    const backend = await createDockerSandbox({ dockerfile: STRACE_IMAGE });
    const tracked = await withStraceFileChanges(backend, {
      include: [ROOT, `${ROOT}/**`],
      onFileChanges: () => {
        throw new RejectChange('no writes allowed');
      },
    });
    const s = await createBashTool({ sandbox: tracked, destination: ROOT });
    try {
      await s.sandbox.executeCommand(`mkdir -p ${ROOT}`).catch(() => {});
      const model = new MockLanguageModelV3({
        doGenerate: async () =>
          toolCallsResponse([
            writeFileToolCall('w1', `${ROOT}/blocked.json`, 'x'),
          ]),
      });

      const res = await generateText({
        model,
        tools: s.tools,
        prompt: 'go',
        stopWhen: stepCountIs(1),
      });

      // The model sees a failed RESULT (the caller's format()), not a thrown
      // tool call the agent/guardrail would swallow.
      const output = res.toolResults[0].output as {
        exitCode: number;
        stderr: string;
      };
      assert.strictEqual(output.exitCode, 42);
      assert.match(output.stderr, /rejected: no writes allowed/);
    } finally {
      await s.sandbox.dispose();
    }
  });

  it('surfaces the caller’s BashException format() to the model on its tool result', async () => {
    const backend = await createDockerSandbox({ dockerfile: STRACE_IMAGE });
    const tracked = await withStraceFileChanges(backend, {
      include: [ROOT, `${ROOT}/**`],
      onFileChanges: () => {
        throw new RejectChange('no writes allowed');
      },
    });
    const s = await createBashTool({ sandbox: tracked, destination: ROOT });
    try {
      await s.sandbox.executeCommand(`mkdir -p ${ROOT}`).catch(() => {});
      const model = new MockLanguageModelV3({
        doGenerate: async () =>
          toolCallsResponse([bashToolCall('c1', `echo hi > ${ROOT}/r.txt`)]),
      });

      const res = await generateText({
        model,
        tools: s.tools,
        prompt: 'go',
        stopWhen: stepCountIs(1),
      });

      const output = res.toolResults[0].output as {
        exitCode: number;
        stderr: string;
      };
      assert.strictEqual(output.exitCode, 42);
      assert.match(output.stderr, /rejected: no writes allowed/);
    } finally {
      await s.sandbox.dispose();
    }
  });

  it('still removes the per-command trace file when onFileChanges throws', async () => {
    const backend = await createDockerSandbox({ dockerfile: STRACE_IMAGE });
    const tracked = await withStraceFileChanges(backend, {
      include: [ROOT, `${ROOT}/**`],
      onFileChanges: throwBoom,
    });
    const s = await createBashTool({ sandbox: tracked, destination: ROOT });
    try {
      await s.sandbox.executeCommand(`mkdir -p ${ROOT}`).catch(() => {});
      // ls runs under strace too, so its own in-flight trace file is always
      // present (count 1). A leak from the throwing command would push this to
      // ≥2. removeTrace is fire-and-forget, so poll to absorb the async rm.
      const countTraces = async (): Promise<number> => {
        const r = await s.sandbox.executeCommand(
          `sh -c 'ls /tmp/dat-trace 2>/dev/null | grep -c "\\.strace$" || true'`,
        );
        return Number(r.stdout.trim());
      };
      // The plain-Error throw rejects this call; we only care that its trace
      // was swept, so swallow the rejection.
      await s.sandbox
        .executeCommand(`echo hi > ${ROOT}/leak.txt`)
        .catch(() => {});
      let count = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 20 && count > 1; i++) {
        count = await countTraces();
      }
      assert.ok(count <= 1, `expected ≤1 trace file, saw ${count}`);
    } finally {
      await s.sandbox.dispose();
    }
  });

  it('isolates a throwing onFileChanges on the spawn path (exit still resolves)', async () => {
    const errors: unknown[] = [];
    const backend = await createDockerSandbox({ dockerfile: STRACE_IMAGE });
    const tracked = await withStraceFileChanges(backend, {
      include: [ROOT, `${ROOT}/**`],
      onFileChanges: throwBoom,
      onError: (error) => errors.push(error),
    });
    const s = await createBashTool({ sandbox: tracked, destination: ROOT });
    try {
      await s.sandbox.executeCommand(`mkdir -p ${ROOT}`).catch(() => {});
      assert.ok(s.sandbox.spawn, 'docker sandbox should expose spawn');
      const child = s.sandbox.spawn(`echo hi > ${ROOT}/sp.txt`);
      await Promise.all([drainStream(child.stdout), drainStream(child.stderr)]);
      const info = await child.exit;
      assert.strictEqual(info.success, true);
      // Spawn is onError's only signal — the isolated throw landed here.
      assert.strictEqual(errors.length, 1);
      assert.match((errors[0] as Error).message, /boom/);
    } finally {
      await s.sandbox.dispose();
    }
  });

  it('keeps the spawn exit resolving even when onError itself throws', async () => {
    const backend = await createDockerSandbox({ dockerfile: STRACE_IMAGE });
    const tracked = await withStraceFileChanges(backend, {
      include: [ROOT, `${ROOT}/**`],
      onFileChanges: throwBoom,
      onError: () => {
        throw new Error('onError exploded');
      },
    });
    const s = await createBashTool({ sandbox: tracked, destination: ROOT });
    try {
      await s.sandbox.executeCommand(`mkdir -p ${ROOT}`).catch(() => {});
      assert.ok(s.sandbox.spawn, 'docker sandbox should expose spawn');
      const child = s.sandbox.spawn(`echo hi > ${ROOT}/sp-err.txt`);
      await Promise.all([drainStream(child.stdout), drainStream(child.stderr)]);
      // onError throws inside collectSpawn's catch; the isolation boundary must
      // swallow it so the exit still resolves rather than reject.
      const info = await child.exit;
      assert.strictEqual(info.success, true);
    } finally {
      await s.sandbox.dispose();
    }
  });
});

// trace-unparseable only manifests when strace runs under a non-native
// (emulated) arch. On an arm64 host `--platform linux/amd64` runs under
// emulation and garbles the trace; on an amd64 host that platform is native and
// the probe would pass, so the case is only reproducible — and only asserted —
// on arm64.
const emulatesAmd64 = process.arch === 'arm64';

dockerSuite('selfTestStrace (in-container)', () => {
  it('reports OK on a real strace-capable container', async () => {
    const backend = await createDockerSandbox({
      dockerfile: NODE_STRACE_IMAGE,
    });
    try {
      const result = await runProbe(backend);
      assert.equal(result.stdout.trim(), 'OK', result.stderr);
    } finally {
      await backend.dispose();
    }
  });

  it('reports strace-missing when strace is absent', async () => {
    const backend = await createDockerSandbox({ image: NODE_BASE });
    try {
      const result = await runProbe(backend);
      assert.equal(
        result.stdout.trim(),
        'REASON:strace-missing',
        result.stderr,
      );
    } finally {
      await backend.dispose();
    }
  });

  it('reports ptrace-blocked when ptrace is denied', async () => {
    // Real ptrace denial: a default-allow seccomp profile that errnos `ptrace`,
    // so strace's PTRACE_TRACEME fails exactly as a hardened runtime would.
    const dir = mkdtempSync(join(tmpdir(), 'strace-seccomp-'));
    const seccomp = join(dir, 'deny-ptrace.json');
    writeFileSync(
      seccomp,
      JSON.stringify({
        defaultAction: 'SCMP_ACT_ALLOW',
        syscalls: [
          { names: ['ptrace'], action: 'SCMP_ACT_ERRNO', errnoRet: 1 },
        ],
      }),
    );
    const backend = await createDockerSandbox({
      dockerfile: NODE_STRACE_IMAGE,
      securityOpt: [`seccomp=${seccomp}`],
    });
    try {
      const result = await runProbe(backend);
      assert.equal(
        result.stdout.trim(),
        'REASON:ptrace-blocked',
        result.stderr,
      );
    } finally {
      await backend.dispose();
    }
  });

  (emulatesAmd64 ? it : it.skip)(
    'reports trace-unparseable under an emulated arch',
    async () => {
      // amd64 under emulation on an arm64 host: strace runs but the trace is
      // garbled (qemu renders syscalls as raw `syscall_0x…`), which the parser
      // rejects.
      const backend = await createDockerSandbox({
        dockerfile: NODE_STRACE_IMAGE,
        platform: 'linux/amd64',
      });
      try {
        const result = await runProbe(backend);
        assert.equal(
          result.stdout.trim(),
          'REASON:trace-unparseable',
          result.stderr,
        );
      } finally {
        await backend.dispose();
      }
    },
  );
});
