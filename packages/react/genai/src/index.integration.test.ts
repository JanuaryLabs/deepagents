import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { it } from 'vitest';

const run = promisify(execFile);

// Importing both packages loads about 4,500 modules, which takes several
// seconds cold and more on a busy CI runner, so the budget is the repo's 60 s.
it('loads production JSX artifacts with the React production runtime', async ({
  signal,
}) => {
  for (const artifact of [
    resolve(import.meta.dirname, '../../shadcn/dist/index.js'),
    resolve(import.meta.dirname, '../dist/index.js'),
  ]) {
    const source = await readFile(artifact, 'utf8');
    assert.match(source, /react\/jsx-runtime/);
    assert.doesNotMatch(source, /react\/jsx-dev-runtime|\bjsxDEV\b/);
  }

  await run(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      "await import('@deepagents/react-shadcn'); await import('@deepagents/react-genai')",
    ],
    {
      cwd: import.meta.dirname,
      env: { ...process.env, NODE_ENV: 'production' },
      signal,
    },
  );
}, 60_000);
