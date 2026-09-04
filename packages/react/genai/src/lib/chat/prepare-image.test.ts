import { expect, test } from 'vitest';

import { prepareImageFile } from '@deepagents/react-genai';

test('returns the same file when the browser cannot draw to a canvas', async () => {
  const file = new File(
    [new Uint8Array([0x89, 0x50, 0x4e, 0x47])],
    'shot.png',
    {
      type: 'image/png',
    },
  );
  expect(document.createElement('canvas').getContext('2d')).toBeNull();

  await expect(prepareImageFile(file, { maxDimension: 1 })).resolves.toBe(file);
});
