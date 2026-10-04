import command, { SubprocessError } from 'nano-spawn';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

test('Docker reuse waits for a reserved name to become inspectable', async (t) => {
  const name = `deepagents-acquisition-${randomUUID()}`;
  let missing: SubprocessError;
  try {
    await command('docker', ['container', 'inspect', name]);
    assert.fail('the unique container must not exist yet');
  } catch (error) {
    assert.ok(error instanceof SubprocessError);
    assert.match(error.stderr, /No such (object|container):/i);
    missing = error;
  }
  const inspect = t.mock.fn(() =>
    command('docker', ['container', 'inspect', name]),
  );
  t.mock.module('nano-spawn', {
    namedExports: { SubprocessError },
    defaultExport: (executable: string, argv: readonly string[]) => {
      if (
        executable === 'docker' &&
        argv.join(' ') === `container inspect ${name}`
      ) {
        return inspect();
      }
      return command(executable, argv);
    },
  });
  const { Docker } = await import('@deepagents/test');
  const docker = new Docker();
  const options = {
    name,
    image: 'postgres:18-alpine',
    internalPort: 5432,
    env: { POSTGRES_PASSWORD: 'testpassword' },
  };
  await using server = await docker.reuse(options);

  // The real daemon can reserve the name before inspect sees the container.
  // Keep the real create conflict, but replay the observed 404 at both the
  // initial lookup and the first lookup after that conflict.
  const before = inspect.mock.callCount();
  inspect.mock.mockImplementationOnce(() => {
    throw missing;
  });
  inspect.mock.mockImplementationOnce(() => {
    throw missing;
  }, before + 1);
  const acquired = await docker.reuse(options);
  assert.equal(inspect.mock.callCount(), before + 3);
  assert.equal(acquired.containerId, server.containerId);
  const { stdout } = await acquired.exec(['printenv', 'POSTGRES_PASSWORD']);
  assert.equal(stdout, 'testpassword');

  const failure = new Error('Docker daemon unavailable during inspection');
  const beforeFailure = inspect.mock.callCount();
  inspect.mock.mockImplementationOnce(() => {
    throw missing;
  });
  inspect.mock.mockImplementationOnce(() => {
    throw failure;
  }, beforeFailure + 1);
  await assert.rejects(docker.reuse(options), (error) => error === failure);
  assert.equal(inspect.mock.callCount(), beforeFailure + 2);
});
