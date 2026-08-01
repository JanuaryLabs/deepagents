import assert from 'node:assert/strict';
import { it } from 'node:test';

import {
  type PostHogMetadataResponse,
  type PostHogQueryResponse,
  type PostHogSchemaResponse,
  createPostHogTransport,
} from '@deepagents/text2sql/posthog';

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
      metadata,
      schema,
      events,
      eventProperties,
      personProperties,
      sessionProperties,
    ] = await Promise.all([
      transport.query<PostHogMetadataResponse>({
        query: {
          kind: 'HogQLMetadata',
          language: 'hogQL',
          query: 'SELECT 1 AS value',
        },
        name: 'deepagents_text2sql_live_metadata',
      }),
      transport.query<PostHogSchemaResponse>({
        query: { kind: 'DatabaseSchemaQuery' },
        name: 'deepagents_text2sql_live_schema',
      }),
      transport.listEventDefinitions(),
      transport.listPropertyDefinitions({ type: 'event' }),
      transport.listPropertyDefinitions({ type: 'person' }),
      transport.listPropertyDefinitions({ type: 'session' }),
    ]);
    const result = await transport.query<PostHogQueryResponse>({
      query: { kind: 'HogQLQuery', query: 'SELECT 1 AS value' },
      name: 'deepagents_text2sql_live_execute',
    });

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
