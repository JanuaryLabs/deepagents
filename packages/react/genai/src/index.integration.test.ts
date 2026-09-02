import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { it } from 'vitest';

it('loads production JSX artifacts with the React production runtime', async () => {
  for (const artifact of [
    resolve(import.meta.dirname, '../../shadcn/dist/index.js'),
    resolve(import.meta.dirname, '../dist/index.js'),
  ]) {
    const source = await readFile(artifact, 'utf8');
    assert.match(source, /react\/jsx-runtime/);
    assert.doesNotMatch(source, /react\/jsx-dev-runtime|\bjsxDEV\b/);
  }

  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      "await import('@deepagents/react-shadcn'); await import('@deepagents/react-genai')",
    ],
    {
      cwd: import.meta.dirname,
      env: { ...process.env, NODE_ENV: 'production' },
    },
  );
}, 10_000);
