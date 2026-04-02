import assert from 'node:assert';
import { after, before, describe, it } from 'node:test';

import {
  AgentOsCreationError,
  AgentOsNotAvailableError,
  type AgentOsSandbox,
  AgentOsSandboxError,
  createAgentOsSandbox,
  useAgentOsSandbox,
} from '@deepagents/context';

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
    let common: unknown;

    before(async () => {
      const mod = await import('@rivet-dev/agent-os-common');
      common = mod.default;
    });

    describe('instance creation', () => {
      it('creates sandbox with software packages', async () => {
        const sandbox = await createAgentOsSandbox({
          software: [common],
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
      let sandbox: AgentOsSandbox;

      before(async () => {
        sandbox = await createAgentOsSandbox({
          software: [common],
        });
      });

      after(async () => {
        await sandbox.dispose();
      });

      it('captures stdout correctly', async () => {
        const result = await sandbox.executeCommand('echo "test output"');
        assert.strictEqual(result.exitCode, 0);
        assert.strictEqual(result.stdout.trim(), 'test output');
      });

      it('captures stderr correctly', async () => {
        const result = await sandbox.executeCommand('echo "error" >&2');
        assert.strictEqual(result.exitCode, 0);
        assert.strictEqual(result.stderr.trim(), 'error');
      });

      it('preserves exit codes', async () => {
        const result = await sandbox.executeCommand('exit 42');
        assert.strictEqual(result.exitCode, 42);
      });

      it('handles multi-line output', async () => {
        const result = await sandbox.executeCommand(
          'echo "line1"; echo "line2"; echo "line3"',
        );
        assert.strictEqual(result.exitCode, 0);
        const lines = result.stdout.trim().split('\n');
        assert.deepStrictEqual(lines, ['line1', 'line2', 'line3']);
      });
    });

    describe('file operations', () => {
      let sandbox: AgentOsSandbox;

      before(async () => {
        sandbox = await createAgentOsSandbox({
          software: [common],
        });
      });

      after(async () => {
        await sandbox.dispose();
      });

      it('writes and reads a file', async () => {
        await sandbox.writeFiles([
          { path: '/tmp/test.txt', content: 'hello world' },
        ]);

        const content = await sandbox.readFile('/tmp/test.txt');
        assert.strictEqual(content, 'hello world');
      });

      it('writes multiple files', async () => {
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
        const specialContent = 'line1\nline2\ttab\n';
        await sandbox.writeFiles([
          { path: '/tmp/special.txt', content: specialContent },
        ]);

        const content = await sandbox.readFile('/tmp/special.txt');
        assert.strictEqual(content, specialContent);
      });
    });

    describe('cleanup', () => {
      it('dispose is idempotent', async () => {
        const sandbox = await createAgentOsSandbox({
          software: [common],
        });

        await sandbox.dispose();
        await sandbox.dispose();
      });
    });
  });

  describe('useAgentOsSandbox', { skip: !available }, () => {
    let common: unknown;

    before(async () => {
      const mod = await import('@rivet-dev/agent-os-common');
      common = mod.default;
    });

    it('auto-disposes on successful completion', async () => {
      const result = await useAgentOsSandbox(
        { software: [common] },
        async (sandbox) => {
          const output = await sandbox.executeCommand('echo "auto-dispose"');
          return output.stdout.trim();
        },
      );

      assert.strictEqual(result, 'auto-dispose');
    });

    it('auto-disposes even when function throws', async () => {
      await assert.rejects(
        useAgentOsSandbox({ software: [common] }, async (sandbox) => {
          await sandbox.executeCommand('echo alive');
          throw new Error('intentional test error');
        }),
        /intentional test error/,
      );
    });

    it('returns the value from the callback', async () => {
      const result = await useAgentOsSandbox(
        { software: [common] },
        async (sandbox) => {
          const output = await sandbox.executeCommand('ls /');
          return {
            exitCode: output.exitCode,
            hasOutput: output.stdout.length > 0,
          };
        },
      );

      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(result.hasOutput, true);
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
