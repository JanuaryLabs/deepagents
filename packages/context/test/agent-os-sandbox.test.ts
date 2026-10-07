import { StreamHarness } from '@zukhruf/testing/streams';
import assert from 'node:assert';
import { describe, it } from 'node:test';
import { scheduler } from 'node:timers/promises';

import {
  AgentOsCreationError,
  AgentOsNotAvailableError,
  AgentOsSandboxError,
  createAgentOsSandbox,
  useAgentOsSandbox,
} from '@deepagents/context';

const streamHarness = new StreamHarness();

async function agentOsSoftware(): Promise<unknown> {
  const { default: software } = await import('@rivet-dev/agent-os-common');
  return software;
}

async function isAgentOsAvailable(): Promise<boolean> {
  try {
    await import('@rivet-dev/agent-os-core');
    await import('@rivet-dev/agent-os-common');
    return true;
  } catch {
    return false;
  }
}

/**
 * Integration tests for Agent OS (WASM) sandbox.
 *
 * Requires @rivet-dev/agent-os-core and @rivet-dev/agent-os-common to be installed.
 * Tests are skipped gracefully if packages are not available.
 */
describe('Agent OS Sandbox', async () => {
  const available = await isAgentOsAvailable();

  if (!available) {
    console.log(
      'Skipping Agent OS sandbox tests: @rivet-dev/agent-os-core or @rivet-dev/agent-os-common not installed',
    );
  }

  describe('createAgentOsSandbox', { skip: !available }, () => {
    describe('instance creation', () => {
      it('creates sandbox with software packages', async () => {
        const sandbox = await createAgentOsSandbox({
          software: [await agentOsSoftware()],
        });

        try {
          const result = await sandbox.executeCommand('echo hello');
          assert.strictEqual(result.exitCode, 0);
          assert.strictEqual(result.stdout.trim(), 'hello');
        } finally {
          await sandbox.dispose();
        }
      });
    });

    describe('command execution', () => {
      it('captures stdout correctly', async () => {
        await using sandbox = await createAgentOsSandbox({
          software: [await agentOsSoftware()],
        });
        const result = await sandbox.executeCommand('echo "test output"');
        assert.strictEqual(result.exitCode, 0);
        assert.strictEqual(result.stdout.trim(), 'test output');
      });

      it('captures stderr correctly', async () => {
        await using sandbox = await createAgentOsSandbox({
          software: [await agentOsSoftware()],
        });
        const result = await sandbox.executeCommand('echo "error" >&2');
        assert.strictEqual(result.exitCode, 0);
        assert.strictEqual(result.stderr.trim(), 'error');
      });

      it('preserves exit codes', async () => {
        await using sandbox = await createAgentOsSandbox({
          software: [await agentOsSoftware()],
        });
        const result = await sandbox.executeCommand('exit 42');
        assert.strictEqual(result.exitCode, 42);
      });

      it('handles multi-line output', async () => {
        await using sandbox = await createAgentOsSandbox({
          software: [await agentOsSoftware()],
        });
        const result = await sandbox.executeCommand(
          'echo "line1"; echo "line2"; echo "line3"',
        );
        assert.strictEqual(result.exitCode, 0);
        const lines = result.stdout.trim().split('\n');
        assert.deepStrictEqual(lines, ['line1', 'line2', 'line3']);
      });

      it('executes Bash-only array syntax', async () => {
        await using sandbox = await createAgentOsSandbox({
          software: [await agentOsSoftware()],
        });
        const result = await sandbox.executeCommand(
          'values=(one two); printf \'%s\\n\' "${values[1]}"',
        );
        assert.strictEqual(result.exitCode, 0);
        assert.strictEqual(result.stdout, 'two\n');
      });
    });

    describe('abort signal', () => {
      it('returns a partial result when signal aborts mid-run', async () => {
        await using sandbox = await createAgentOsSandbox({
          software: [await agentOsSoftware()],
        });
        const controller = new AbortController();
        const readyPath = '/tmp/execute-command-abort-ready';
        const resultPromise = sandbox.executeCommand(
          `echo before; printf ready > ${readyPath}; sleep 5; echo after`,
          { signal: controller.signal },
        );

        const readinessTimeout = AbortSignal.timeout(5_000);
        for (;;) {
          readinessTimeout.throwIfAborted();
          try {
            if ((await sandbox.readFile(readyPath)) === 'ready') break;
          } catch {
            await scheduler.yield();
          }
        }

        controller.abort();
        const result = await resultPromise;

        assert.notStrictEqual(result.exitCode, 0);
        assert.match(result.stdout, /before/);
        assert.doesNotMatch(result.stdout, /after/);
      });

      it('short-circuits when signal is already aborted', async () => {
        await using sandbox = await createAgentOsSandbox({
          software: [await agentOsSoftware()],
        });
        const controller = new AbortController();
        controller.abort();
        const start = Date.now();
        const result = await sandbox.executeCommand('echo unreached', {
          signal: controller.signal,
        });
        const elapsed = Date.now() - start;
        assert.ok(elapsed < 50, `short-circuit took ${elapsed}ms`);
        assert.strictEqual(result.exitCode, 9);
        assert.strictEqual(result.stdout, '');
        assert.strictEqual(result.stderr, '');
      });

      it('runs to completion when signal is never aborted', async () => {
        await using sandbox = await createAgentOsSandbox({
          software: [await agentOsSoftware()],
        });
        const controller = new AbortController();
        const result = await sandbox.executeCommand('echo ok', {
          signal: controller.signal,
        });
        assert.strictEqual(result.exitCode, 0);
        assert.strictEqual(result.stdout.trim(), 'ok');
      });
    });

    describe('spawn (streaming)', () => {
      it('exposes spawn on the sandbox', async () => {
        await using sandbox = await createAgentOsSandbox({
          software: [await agentOsSoftware()],
        });
        assert.strictEqual(typeof sandbox.spawn, 'function');
      });

      it('streams stdout chunks via Web ReadableStream and exits cleanly', async () => {
        await using sandbox = await createAgentOsSandbox({
          software: [await agentOsSoftware()],
        });
        assert.ok(sandbox.spawn);
        const proc = sandbox.spawn('echo a; echo b; echo c');
        const decoder = new TextDecoder();
        const chunks: string[] = [];
        for await (const chunk of proc.stdout) {
          chunks.push(decoder.decode(chunk));
        }
        const exit = await proc.exit;

        assert.deepStrictEqual(exit, { code: 0, signal: null, success: true });
        assert.ok(
          chunks.length >= 2,
          `expected multiple stdout chunks, got ${chunks.length}`,
        );
        const combined = chunks.join('');
        assert.match(combined, /a/);
        assert.match(combined, /b/);
        assert.match(combined, /c/);
      });

      it('captures output emitted without a trailing newline', async () => {
        await using sandbox = await createAgentOsSandbox({
          software: [await agentOsSoftware()],
        });
        assert.ok(sandbox.spawn);
        const proc = sandbox.spawn('printf %s "no-newline-output-payload"');
        const decoder = new TextDecoder();
        let out = '';
        for await (const chunk of proc.stdout) {
          out += decoder.decode(chunk, { stream: true });
        }
        out += decoder.decode();
        await proc.exit;
        assert.strictEqual(out, 'no-newline-output-payload');
      });

      it('forwards env to the spawned process', async () => {
        await using sandbox = await createAgentOsSandbox({
          software: [await agentOsSoftware()],
        });
        assert.ok(sandbox.spawn);
        const proc = sandbox.spawn('echo $GREETING', {
          env: { GREETING: 'hello-spawn' },
        });
        const decoder = new TextDecoder();
        let out = '';
        for await (const chunk of proc.stdout) {
          out += decoder.decode(chunk);
        }
        await proc.exit;
        assert.match(out, /hello-spawn/);
      });

      it('returns a short-circuited process when signal is already aborted', async () => {
        await using sandbox = await createAgentOsSandbox({
          software: [await agentOsSoftware()],
        });
        assert.ok(sandbox.spawn);
        const controller = new AbortController();
        controller.abort();
        const proc = sandbox.spawn('echo unreached', {
          signal: controller.signal,
        });
        await using reader = streamHarness.reader(proc.stdout);
        const first = await reader.read();
        assert.strictEqual(first.done, true);
        const exit = await proc.exit;
        assert.deepStrictEqual(exit, {
          code: null,
          signal: 'SIGKILL',
          success: false,
        });
      });

      it('on abort, kills the process and exit reports SIGKILL', async () => {
        await using sandbox = await createAgentOsSandbox({
          software: [await agentOsSoftware()],
        });
        assert.ok(sandbox.spawn);
        const controller = new AbortController();
        const proc = sandbox.spawn('echo before; sleep 5; echo after', {
          signal: controller.signal,
        });

        const decoder = new TextDecoder();
        await using reader = streamHarness.reader(proc.stdout);
        const first = await reader.read();
        assert.strictEqual(first.done, false);
        assert.match(decoder.decode(first.value), /before/);

        controller.abort();
        const remaining: string[] = [];
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          remaining.push(decoder.decode(chunk.value));
        }
        const exit = await proc.exit;

        assert.deepStrictEqual(exit, {
          code: null,
          signal: 'SIGKILL',
          success: false,
        });
        assert.doesNotMatch(remaining.join(''), /after/);
      });
    });

    describe('file operations', () => {
      it('writes and reads a file', async () => {
        await using sandbox = await createAgentOsSandbox({
          software: [await agentOsSoftware()],
        });
        await sandbox.writeFiles([
          { path: '/tmp/test.txt', content: 'hello world' },
        ]);

        const content = await sandbox.readFile('/tmp/test.txt');
        assert.strictEqual(content, 'hello world');
      });

      it('writes multiple files', async () => {
        await using sandbox = await createAgentOsSandbox({
          software: [await agentOsSoftware()],
        });
        await sandbox.writeFiles([
          { path: '/tmp/file1.txt', content: 'content1' },
          { path: '/tmp/file2.txt', content: 'content2' },
        ]);

        const content1 = await sandbox.readFile('/tmp/file1.txt');
        const content2 = await sandbox.readFile('/tmp/file2.txt');
        assert.strictEqual(content1, 'content1');
        assert.strictEqual(content2, 'content2');
      });

      it('preserves newlines and special characters', async () => {
        await using sandbox = await createAgentOsSandbox({
          software: [await agentOsSoftware()],
        });
        const specialContent = 'line1\nline2\ttab\n';
        await sandbox.writeFiles([
          { path: '/tmp/special.txt', content: specialContent },
        ]);

        const content = await sandbox.readFile('/tmp/special.txt');
        assert.strictEqual(content, specialContent);
      });
    });

    describe('binary reads and existence checks', () => {
      it('reads raw bytes with the binary encoding', async () => {
        const { default: software } =
          await import('@rivet-dev/agent-os-common');
        const sandbox = await createAgentOsSandbox({ software: [software] });
        try {
          const bytes = Buffer.from([0x89, 0x50, 0x00, 0xff]);
          await sandbox.writeFiles([{ path: '/tmp/blob.bin', content: bytes }]);

          const content = await sandbox.readFile('/tmp/blob.bin', {
            encoding: 'binary',
          });

          assert.deepStrictEqual(Array.from(content), [0x89, 0x50, 0x00, 0xff]);
        } finally {
          await sandbox.dispose();
        }
      });

      it('reports whether a path exists', async () => {
        const { default: software } =
          await import('@rivet-dev/agent-os-common');
        const sandbox = await createAgentOsSandbox({ software: [software] });
        try {
          await sandbox.writeFiles([
            { path: '/tmp/present.txt', content: 'x' },
          ]);

          assert.strictEqual(await sandbox.exists('/tmp/present.txt'), true);
          assert.strictEqual(await sandbox.exists('/tmp'), true);
          assert.strictEqual(await sandbox.exists('/tmp/missing.txt'), false);
        } finally {
          await sandbox.dispose();
        }
      });
    });

    describe('cleanup', () => {
      it('dispose is idempotent', async () => {
        const sandbox = await createAgentOsSandbox({
          software: [await agentOsSoftware()],
        });

        await sandbox.dispose();
        await sandbox.dispose();
      });
    });
  });

  describe('useAgentOsSandbox', { skip: !available }, () => {
    it('auto-disposes on successful completion', async () => {
      const result = await useAgentOsSandbox(
        { software: [await agentOsSoftware()] },
        async (sandbox) => {
          const output = await sandbox.executeCommand('echo "auto-dispose"');
          return output.stdout.trim();
        },
      );

      assert.strictEqual(result, 'auto-dispose');
    });

    it('auto-disposes even when function throws', async () => {
      await assert.rejects(
        useAgentOsSandbox(
          { software: [await agentOsSoftware()] },
          async (sandbox) => {
            await sandbox.executeCommand('echo alive');
            throw new Error('intentional test error');
          },
        ),
        /intentional test error/,
      );
    });

    it('returns the value from the callback', async () => {
      const result = await useAgentOsSandbox(
        { software: [await agentOsSoftware()] },
        async (sandbox) => {
          const output = await sandbox.executeCommand('echo callback-value');
          return {
            exitCode: output.exitCode,
            stdout: output.stdout.trim(),
          };
        },
      );

      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(result.stdout, 'callback-value');
    });
  });

  describe('error classes', () => {
    it('AgentOsNotAvailableError extends AgentOsSandboxError', () => {
      const err = new AgentOsNotAvailableError();
      assert.ok(err instanceof AgentOsSandboxError);
      assert.ok(err instanceof Error);
      assert.strictEqual(err.name, 'AgentOsNotAvailableError');
      assert.match(err.message, /@rivet-dev\/agent-os-core/);
    });

    it('AgentOsCreationError extends AgentOsSandboxError', () => {
      const cause = new Error('test cause');
      const err = new AgentOsCreationError('something broke', cause);
      assert.ok(err instanceof AgentOsSandboxError);
      assert.ok(err instanceof Error);
      assert.strictEqual(err.name, 'AgentOsCreationError');
      assert.match(err.message, /Failed to create Agent OS instance/);
      assert.strictEqual(err.cause, cause);
    });

    it('AgentOsNotAvailableError preserves cause', () => {
      const cause = new Error('MODULE_NOT_FOUND');
      const err = new AgentOsNotAvailableError(cause);
      assert.strictEqual(err.cause, cause);
    });
  });
});
