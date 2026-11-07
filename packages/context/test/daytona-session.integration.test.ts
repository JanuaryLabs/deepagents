import { Daytona, Process } from '@daytona/sdk';
import { Msw } from '@zukhruf/testing/msw';
import { HttpResponse, http, ws } from 'msw';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { text } from 'node:stream/consumers';
import { it } from 'node:test';
import { promisify } from 'node:util';
import { z } from 'zod';

import { createDaytonaSandbox } from '@deepagents/context';

for (const outcome of ['abort', 'delayed', 'timeout'] as const) {
  it(`Daytona session: ${outcome}`, async (t) => {
    const sessions = new Set<string>();
    const cwd = await realpath(tmpdir());
    const connected = Promise.withResolvers<void>();
    const logsClosed = Promise.withResolvers<void>();
    let output = '';
    let polls = 0;
    const pollTimes: number[] = [];
    const events = ws.link('wss://daytona.test/api/socket.io/');
    // The real SDK serializes all HTTP operations. Control only the public log
    // callback seam so cancellation and delayed exit status are deterministic.
    t.mock.method(
      Process.prototype,
      'getSessionCommandLogs',
      async (
        sessionId: string,
        commandId: string,
        onStdout: (chunk: string) => void,
        onStderr: (chunk: string) => void,
      ) => {
        connected.resolve();
        assert.ok(sessions.has(sessionId));
        assert.equal(commandId, 'command-test');
        if (outcome === 'abort') await logsClosed.promise;
        else {
          onStdout(output);
          onStderr('warning\n');
        }
      },
    );
    using interception = new Msw().intercept(
      events.addEventListener('connection', ({ client }) => {
        client.send(
          '0{"sid":"events","upgrades":[],"pingInterval":25000,"pingTimeout":20000}',
        );
        client.addEventListener('message', ({ data }) => {
          if (String(data).startsWith('40')) client.send('40{"sid":"events"}');
        });
      }),
      http.get('https://daytona.test/api/sandbox/session-test', () =>
        HttpResponse.json({
          id: 'sandbox-test',
          name: 'session-test',
          state: 'started',
          toolboxProxyUrl: 'https://daytona.test/toolbox',
        }),
      ),
      http.post(
        'https://daytona.test/toolbox/sandbox-test/process/execute',
        () => HttpResponse.json({ exitCode: 0, result: '' }),
      ),
      http.post(
        'https://daytona.test/toolbox/sandbox-test/process/session',
        async ({ request }) => {
          const { sessionId } = z
            .object({ sessionId: z.string() })
            .parse(await request.json());
          sessions.add(sessionId);
          return new HttpResponse(null, { status: 201 });
        },
      ),
      http.post(
        'https://daytona.test/toolbox/sandbox-test/process/session/:sessionId/exec',
        async ({ request, params }) => {
          assert.ok(sessions.has(String(params.sessionId)));
          const body = z
            .object({
              command: z.string(),
              runAsync: z.literal(true),
              suppressInputEcho: z.literal(true),
            })
            .parse(await request.json());
          if (outcome === 'abort')
            assert.equal(body.command, "bash -lc 'sleep 60'");
          else
            output = (await promisify(execFile)('sh', ['-c', body.command]))
              .stdout;
          return HttpResponse.json({ cmdId: 'command-test' });
        },
      ),
      http.get(
        'https://daytona.test/toolbox/sandbox-test/process/session/:sessionId/command/command-test',
        ({ params }) => {
          assert.ok(sessions.has(String(params.sessionId)));
          polls++;
          pollTimes.push(performance.now());
          if (outcome === 'timeout') {
            t.mock.timers.tick(31_000);
            return HttpResponse.json({ id: 'command-test' });
          }
          return HttpResponse.json(
            polls === 1
              ? { id: 'command-test' }
              : { id: 'command-test', exitCode: 7 },
          );
        },
      ),
      http.delete(
        'https://daytona.test/toolbox/sandbox-test/process/session/:sessionId',
        ({ params }) => {
          sessions.delete(String(params.sessionId));
          return new HttpResponse(null, { status: 204 });
        },
      ),
    );
    await using client = new Daytona({
      apiUrl: 'https://daytona.test/api',
      apiKey: 'test',
      target: 'test',
    });
    await using sandbox = await createDaytonaSandbox(client, {
      sandboxId: 'session-test',
      commandTimeout: 60,
    });
    assert.ok(sandbox.spawn);
    if (outcome === 'timeout') t.mock.timers.enable({ apis: ['Date'], now: 0 });
    const controller = new AbortController();
    const process = await sandbox.spawn(
      outcome === 'abort' ? 'sleep 60' : 'printf "%s:%s" "$PWD" "$VALUE"',
      {
        signal: controller.signal,
        ...(outcome !== 'abort' ? { cwd, env: { VALUE: 'hello world' } } : {}),
      },
    );
    const stdout = text(process.stdout);
    const stderr = text(process.stderr);
    try {
      await connected.promise;
      if (outcome === 'abort') {
        controller.abort();
        assert.deepEqual(await process.exit, {
          code: null,
          signal: 'SIGKILL',
          success: false,
        });
        assert.equal(await stdout, '');
        assert.equal(await stderr, '');
      } else if (outcome === 'timeout') {
        await Promise.all([
          assert.rejects(process.exit, /logs closed before an exit code/),
          assert.rejects(stdout, /logs closed before an exit code/),
          assert.rejects(stderr, /logs closed before an exit code/),
        ]);
        assert.equal(
          polls,
          2,
          'the configured 60-second timeout must allow the first 31-second poll',
        );
      } else {
        assert.deepEqual(await process.exit, {
          code: 7,
          signal: null,
          success: false,
        });
        assert.equal(await stdout, `${cwd}:hello world`);
        assert.equal(await stderr, 'warning\n');
        assert.ok(polls > 1);
      }
      if (outcome !== 'abort')
        assert.ok(
          pollTimes[1] - pollTimes[0] >= 225,
          'exit polling must wait between requests',
        );
      assert.equal(sessions.size, 0);
    } finally {
      // Session deletion need not immediately close the SDK log socket. Abort
      // must settle the public process before that independent socket closes.
      logsClosed.resolve();
    }
  });
}
