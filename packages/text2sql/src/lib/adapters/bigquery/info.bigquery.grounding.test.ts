import assert from 'node:assert';
import { describe, it } from 'node:test';

import { BigQuery, info } from '@deepagents/text2sql/bigquery';

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
    assert.strictEqual(dialect.data.dialect, 'bigquery');
    assert.strictEqual(dialect.data.database, undefined);
    assert.strictEqual(
      dialect.data.details.identifiers.qualifiedTable,
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
    assert.strictEqual(dialect.data.database, 'my-project');
    assert.strictEqual(
      dialect.data.details.identifiers.qualifiedTable,
      'project.dataset.table',
    );
  });
});
