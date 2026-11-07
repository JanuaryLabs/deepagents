import { TemporaryFiles } from '@zukhruf/testing/fs';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  copyFile,
  mkdir,
  readFile,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { it } from 'node:test';
import { promisify } from 'node:util';

it('generates model types beside the script when launched from another directory', async () => {
  await using directory = await new TemporaryFiles().directory(
    'context-models-',
  );
  const scripts = join(directory.path, 'package/scripts');
  const output = join(directory.path, 'package/src/lib');
  const cwd = join(directory.path, 'unrelated');
  await Promise.all(
    [scripts, output, cwd].map((path) => mkdir(path, { recursive: true })),
  );
  await symlink(
    new URL('../../../node_modules', import.meta.url),
    join(directory.path, 'node_modules'),
  );
  const script = join(scripts, 'generate-models-type.ts');
  await copyFile(
    new URL('../scripts/generate-models-type.ts', import.meta.url),
    script,
  );
  const preload = join(directory.path, 'models-api.mjs');
  await writeFile(
    preload,
    `
    import { Msw } from '@zukhruf/testing/msw';
    import { http, HttpResponse } from 'msw';
    const interception = new Msw().intercept(http.get('https://models.dev/api.json', () =>
      HttpResponse.json({ zeta: { models: { last: {} } }, alpha: { models: { second: {}, first: {} } } })
    ));
    process.on('exit', () => interception.cleanup());
  `,
  );
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    ['--no-warnings', '--import', preload, script],
    {
      cwd,
      signal: AbortSignal.timeout(10_000),
    },
  );
  assert.equal(stderr, '');
  const generated = await readFile(join(output, 'models.generated.ts'), 'utf8');
  assert.match(generated, /Total models: 3/);
  assert.ok(
    generated.includes(
      "export type KnownModels =\n  | 'alpha:first'\n  | 'alpha:second'\n  | 'zeta:last';",
    ),
  );
  assert.ok(
    generated.includes('export type Models = KnownModels | (string & {});'),
  );
  assert.ok(stdout.includes(`Output: ${join(output, 'models.generated.ts')}`));
});
