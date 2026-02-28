import { defaultTypesMap } from '@sdk-it/core';
import { analyze } from '@sdk-it/generic';
import { responseAnalyzer } from '@sdk-it/hono';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cwd } from 'node:process';
import type { OpenAPIObject } from 'openapi3-ts/oas31';

const { paths, components, tags } = await analyze(
  'apps/evals-web-runner/backend/tsconfig.app.json',
  {
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
  },
);

const spec: OpenAPIObject = {
  openapi: '3.1.0',
  info: { title: 'Agent API', version: '1.0.0' },
  tags: tags.map((tag) => ({ name: tag })),
  security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
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
    securitySchemes: {
      BearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description:
          'Use Authorization: Bearer <token> for session tokens or API keys.',
      } as const,
      ApiKeyAuth: {
        type: 'apiKey',
        in: 'header',
        name: 'X-API-Key',
        description: 'Use X-API-Key: <key>.',
      } as const,
    },
  },
};

await writeFile('.evals-sdk-it/openapi.json', JSON.stringify(spec, null, 2));
