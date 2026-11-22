import { defineOpenApi } from '@sdk-it/openapi';

// Every reader of frontend/src/evals.openapi (content mapper, Vite, Node)
// regenerates the document from this definition.
export default defineOpenApi({
  tsconfig: new URL('./tsconfig.app.json', import.meta.url),
  document: {
    openapi: '3.1.0',
    info: { title: 'Agent API', version: '1.0.0' },
  },
  types: { UIMessage: { type: 'object' } },
});
