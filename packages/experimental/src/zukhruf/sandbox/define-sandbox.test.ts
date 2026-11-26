import { test } from '@zukhruf/parameterized-test';
import assert from 'node:assert/strict';

import {
  DockerSandboxEnvironment,
  VirtualSandboxEnvironment,
} from '@deepagents/context';
import { defineSandbox } from '@deepagents/experimental/zukhruf';

void test.each([-1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1], (idleTimeoutMs) =>
  test(`defineSandbox rejects the idle time ${idleTimeoutMs}, which is not a non-negative safe integer or false`, () => {
    const environment = new DockerSandboxEnvironment({ namespace: 'app' });

    assert.throws(
      () => defineSandbox(environment, { idleTimeoutMs }),
      {
        name: 'RangeError',
        message: 'idleTimeoutMs must be a non-negative safe integer or false.',
      },
      `idleTimeoutMs ${idleTimeoutMs}`,
    );
  }),
);

test('defineSandbox declares the idle time of a stoppable environment', () => {
  const environment = new DockerSandboxEnvironment({ namespace: 'app' });
  const idleTimes: Array<number | false> = [0, 1000, false];

  assert.deepStrictEqual(
    idleTimes.map((idleTimeoutMs) => {
      const declaration = defineSandbox(environment, { idleTimeoutMs });
      return {
        environment: declaration.environment,
        idleTimeoutMs: declaration.idleTimeoutMs,
        open: typeof declaration.open,
      };
    }),
    idleTimes.map((idleTimeoutMs) => ({
      environment,
      idleTimeoutMs,
      open: 'function',
    })),
  );
});

test('defineSandbox declares no idle time for an environment that cannot stop its sandboxes', () => {
  const environment = new VirtualSandboxEnvironment();
  const declaration = defineSandbox(environment);

  assert.deepStrictEqual(
    { keys: Object.keys(declaration), environment: declaration.environment },
    { keys: ['environment', 'open'], environment },
  );
});
