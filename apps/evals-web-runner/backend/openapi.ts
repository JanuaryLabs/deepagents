import type { OpenAPIDocument } from '@sdk-it/core';
import { defaultTypesMap } from '@sdk-it/core/deriver.js';
import { openAnalysisProject } from '@sdk-it/core/program.js';
import { analyze } from '@sdk-it/generic';
import { responseAnalyzer } from '@sdk-it/hono';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cwd } from 'node:process';

using project = openAnalysisProject(
  'apps/evals-web-runner/backend/tsconfig.app.json',
);
const { paths, components, tags } = await analyze(project, {
  responseAnalyzer,
  imports: [
    {
      import: 'inputs',
      from: join(cwd(), 'apps/evals-web-runner/backend/src/core/inputs.ts'),
    },
  ],
  typesMap: {
    ...defaultTypesMap,
    Decimal: 'string',
    UIMessage: '#/components/schemas/JsonObject',
    JsonValue: '#/components/schemas/JsonValue',
    JsonObject: '#/components/schemas/JsonObject',
    JsonArray: '#/components/schemas/JsonArray',
  },
});

const spec: OpenAPIDocument = {
  openapi: '3.1.0',
  info: { title: 'Agent API', version: '1.0.0' },
  tags: tags.map((tag) => ({ name: tag })),
  paths,
  components: {
    ...components,
    schemas: {
      ...components.schemas,
      JsonValue: {
        oneOf: [
          { type: 'string' },
          { type: 'number' },
          { type: 'boolean' },
          { type: 'null' },
          { $ref: '#/components/schemas/JsonObject' },
          { $ref: '#/components/schemas/JsonArray' },
        ],
      } as const,
      JsonObject: {
        type: 'object',
        additionalProperties: { $ref: '#/components/schemas/JsonValue' },
      } as const,
      JsonArray: {
        type: 'array',
        items: { $ref: '#/components/schemas/JsonValue' },
      } as const,
    },
  },
};

await writeFile(
  new URL('../frontend/src/evals.openapi', import.meta.url),
  JSON.stringify(spec, null, 2),
);
