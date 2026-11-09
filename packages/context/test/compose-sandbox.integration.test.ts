import { DockerTestbed } from '@zukhruf/testing/docker';
import { TemporaryFiles } from '@zukhruf/testing/fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { it } from 'node:test';

import { createDockerSandbox } from '@deepagents/context';

it('Compose uses the existing YAML-derived project name for execution and disposal', async () => {
  const testbed = new DockerTestbed({ environment: process.env });
  await using directory = await new TemporaryFiles().directory(
    'context-compose-',
  );
  const composeFile = join(directory.path, 'compose.json');
  const compose = JSON.stringify({
    services: {
      app: {
        image: 'bash:5.3-alpine3.24',
        command: ['tail', '-f', '/dev/null'],
        labels: testbed.defaults.Labels,
      },
    },
  });
  // Lock compatibility with the existing project identity, independently of
  // the production one-shot hash API. Run labels make each fixture unique.
  const project = `sandbox-${createHash('sha256').update(compose).digest('hex').slice(0, 8)}`;
  await writeFile(composeFile, compose);
  const client = await testbed.client();
  const filters = { label: [`com.docker.compose.project=${project}`] };
  assert.deepEqual(await client.containers.list({ all: true, filters }), []);
  {
    await using sandbox = await createDockerSandbox({
      compose: composeFile,
      service: 'app',
    });
    const result = await sandbox.run({ command: 'printf compose-ready' });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'compose-ready');
    const containers = await client.containers.list({ filters });
    assert.equal(containers.length, 1);
    assert.ok(containers[0].Labels);
    assert.equal(containers[0].Labels['com.docker.compose.project'], project);
  }
  assert.deepEqual(await client.containers.list({ all: true, filters }), []);
});
