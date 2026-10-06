import assert from 'node:assert';
import { describe, it } from 'node:test';
import { z } from 'zod';

import { BigQuery, info } from '@deepagents/text2sql/bigquery';

const dialectInfoData = z.object({
  dialect: z.string(),
  database: z.string().optional(),
  details: z.object({
    identifiers: z.object({ qualifiedTable: z.string() }),
  }),
});

describe('BigQueryInfoGrounding', () => {
  it('produces dialect info without projectId', async () => {
    const adapter = new BigQuery({
      datasets: ['analytics'],
      execute: async () => [],
      validate: async () => undefined,
      grounding: [info()],
    });

    const fragments = await adapter.introspect();
    const dialect = fragments.find((f) => f.name === 'dialectInfo');

    assert.ok(dialect);
    const data = dialectInfoData.parse(dialect.data);
    assert.strictEqual(data.dialect, 'bigquery');
    assert.strictEqual(data.database, undefined);
    assert.strictEqual(
      data.details.identifiers.qualifiedTable,
      'dataset.table',
    );
  });

  it('includes projectId in qualifiedTable and database when set', async () => {
    const adapter = new BigQuery({
      datasets: ['analytics'],
      execute: async () => [],
      validate: async () => undefined,
      grounding: [info()],
      projectId: 'my-project',
    });

    const fragments = await adapter.introspect();
    const dialect = fragments.find((f) => f.name === 'dialectInfo');

    assert.ok(dialect);
    const data = dialectInfoData.parse(dialect.data);
    assert.strictEqual(data.database, 'my-project');
    assert.strictEqual(
      data.details.identifiers.qualifiedTable,
      'project.dataset.table',
    );
  });
});
