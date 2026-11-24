import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'vitest';

test('exported styles name only the package dist as a Tailwind source', async () => {
  const styles = await readFile(
    path.join(process.cwd(), 'src/styles.css'),
    'utf8',
  );

  assert.deepStrictEqual(
    [...styles.matchAll(/@source\s+([^;]+);/g)].map(([, source]) => source),
    ['"../dist"'],
  );
});
