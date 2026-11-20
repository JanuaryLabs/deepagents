import { expect, it } from 'vitest';

import { client } from './use-client.ts';

it('builds a run rename as PATCH /api/runs/<id> with the new name as its JSON body', async () => {
  const { url, init } = await client.prepare('PATCH /runs/{id}', {
    id: 'run-42',
    name: 'Nightly regression',
  });

  expect(new URL(url).pathname).toBe('/api/runs/run-42');
  expect(init.method).toBe('PATCH');
  expect(new Headers(init.headers).get('content-type')).toMatch(
    /^application\/json/,
  );
  expect(JSON.parse(String(init.body))).toEqual({ name: 'Nightly regression' });
});
