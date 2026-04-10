import { createBashTool } from 'bash-tool';
import { Bash, defineCommand } from 'just-bash';
import assert from 'node:assert';
import { describe, it } from 'node:test';

describe('createBashTool abort handling', () => {
  it('stops at the next statement boundary after abort', async () => {
    const abortController = new AbortController();
    const abortNow = defineCommand('abort-now', async () => {
      abortController.abort(new Error('stop after this statement'));

      return {
        stdout: '',
        stderr: '',
        exitCode: 0,
      };
    });

    const bashEnv = new Bash({
      cwd: '/',
      customCommands: [abortNow],
    });

    const { bash, sandbox } = await createBashTool({
      sandbox: bashEnv,
      destination: '/',
    });

    const execute = bash.execute;
    assert.ok(execute, 'bash tool execution should be available');
    type BashExecuteOptions = Parameters<typeof execute>[1];

    const execOptions: BashExecuteOptions = {
      abortSignal: abortController.signal,
      messages: [],
      toolCallId: 'call-1',
    };

    await execute(
      { command: 'abort-now; echo reached >/marker.txt' },
      execOptions,
    );

    await assert.rejects(sandbox.readFile('/marker.txt'));
  });
});
