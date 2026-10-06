import assert from 'node:assert/strict';
import { it } from 'node:test';
import { z } from 'zod';

import { createPostHogTransport } from '@deepagents/text2sql/posthog';

const metadataResponse = z.object({
  isValid: z.boolean(),
  errors: z.array(z.unknown()),
});
const schemaResponse = z.object({
  tables: z.record(z.string(), z.unknown()),
  joins: z.array(z.unknown()),
});
const queryResponse = z.object({
  columns: z.array(z.string()),
  results: z.array(z.array(z.unknown())),
});

const host = process.env.POSTHOG_HOST;
const projectId = process.env.POSTHOG_PROJECT_ID;
const accessToken =
  process.env.POSTHOG_ACCESS_TOKEN ?? process.env.POSTHOG_PERSONAL_API_KEY;
const configured = Boolean(host && projectId && accessToken);

it(
  'matches the live PostHog query, schema, and definition contracts',
  { skip: !configured },
  async () => {
    if (!host || !projectId || !accessToken) {
      throw new Error('PostHog live test credentials are not configured.');
    }
    const transport = createPostHogTransport({
      host,
      projectId,
      getAccessToken: () => accessToken,
    });

    const [
      metadataPayload,
      schemaPayload,
      events,
      eventProperties,
      personProperties,
      sessionProperties,
    ] = await Promise.all([
      transport.query({
        query: {
          kind: 'HogQLMetadata',
          language: 'hogQL',
          query: 'SELECT 1 AS value',
        },
        name: 'deepagents_text2sql_live_metadata',
      }),
      transport.query({
        query: { kind: 'DatabaseSchemaQuery' },
        name: 'deepagents_text2sql_live_schema',
      }),
      transport.listEventDefinitions(),
      transport.listPropertyDefinitions({ type: 'event' }),
      transport.listPropertyDefinitions({ type: 'person' }),
      transport.listPropertyDefinitions({ type: 'session' }),
    ]);
    const metadata = metadataResponse.parse(metadataPayload);
    const schema = schemaResponse.parse(schemaPayload);
    const result = queryResponse.parse(
      await transport.query({
        query: { kind: 'HogQLQuery', query: 'SELECT 1 AS value' },
        name: 'deepagents_text2sql_live_execute',
      }),
    );

    assert.equal(metadata.isValid, true);
    assert.ok(Array.isArray(metadata.errors));
    assert.equal(typeof schema.tables, 'object');
    assert.ok(Array.isArray(schema.joins));
    assert.ok(Array.isArray(events));
    assert.ok(Array.isArray(eventProperties));
    assert.ok(Array.isArray(personProperties));
    assert.ok(Array.isArray(sessionProperties));
    assert.deepEqual(result.columns, ['value']);
    assert.deepEqual(result.results, [[1]]);
  },
);
