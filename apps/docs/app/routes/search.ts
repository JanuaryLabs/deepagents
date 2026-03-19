import { createFromSource } from 'fumadocs-core/search/server';
import type { Route } from '~routes/routes/+types/search.ts';

import { source } from '../source.ts';

const server = createFromSource(source, {
  // https://docs.orama.com/docs/orama-js/supported-languages
  language: 'english',
});

export async function loader(_args: Route.LoaderArgs) {
  return server.staticGET();
}
