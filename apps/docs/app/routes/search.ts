import { createFromSource } from 'fumadocs-core/search/server';

import { source } from '../source.ts';
import type { Route } from './+types/search.ts';

const server = createFromSource(source, {
  // https://docs.orama.com/docs/orama-js/supported-languages
  language: 'english',
});

export async function loader(_args: Route.LoaderArgs) {
  return server.staticGET();
}
