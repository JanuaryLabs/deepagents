import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'vitest';

test('exported styles do not contain workspace-relative Tailwind sources', async () => {
  const styles = await readFile(
    path.join(process.cwd(), 'src/styles.css'),
    'utf8',
  );

  assert.doesNotMatch(styles, /@source\s/);
});
