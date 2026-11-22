import { defineOpenApi } from '@sdk-it/openapi';

// Every reader of frontend/src/evals.openapi (content mapper, Vite, Node)
// derives the document from this definition in memory and writes nothing;
// @sdk-it/nx's openapi-sync (nx sync, the pre-commit hook) writes the copy.
export default defineOpenApi({
  tsconfig: new URL('./tsconfig.app.json', import.meta.url),
  document: {
    openapi: '3.1.0',
    info: { title: 'Agent API', version: '1.0.0' },
  },
  types: { UIMessage: { type: 'object' } },
});
