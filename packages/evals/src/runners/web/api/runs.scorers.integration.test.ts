import { Hono } from 'hono';
import assert from 'node:assert';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { RunStore as DistRunStore } from '@deepagents/evals/store';

import type { RunStore as LocalRunStore } from '../../../store/index.ts';
import { evalManager } from '../services/eval-manager.ts';
import type { WebBindings } from '../types.ts';
import runsApi from './runs.ts';

const DATASETS_DIR = '.evals/datasets';
const createdDatasetPaths: string[] = [];
let store: LocalRunStore;

function createDatasetFile(content: unknown): string {
  mkdirSync(DATASETS_DIR, { recursive: true });
  const name = `test-${crypto.randomUUID()}.json`;
  const filePath = join(DATASETS_DIR, name);
  writeFileSync(filePath, JSON.stringify(content), 'utf-8');
  createdDatasetPaths.push(filePath);
  return name;
}

describe('runs api scorer selection', () => {
  beforeEach(() => {
    store = new DistRunStore(
      new DatabaseSync(':memory:'),
    ) as unknown as LocalRunStore;
    evalManager.resetForTesting();
  });

  afterEach(() => {
    evalManager.resetForTesting();
    while (createdDatasetPaths.length > 0) {
      const next = createdDatasetPaths.pop();
      if (!next) break;
      rmSync(next, { force: true });
    }
  });

  it('rejects llmJudge scorer', async () => {
    const datasetName = createDatasetFile([]);

    const app = new Hono<WebBindings>();
    app.use('*', async (c, next) => {
      c.set('store', store);
      await next();
    });
    app.route('/', runsApi);

    const form = new FormData();
    form.set('name', 'reject-llmjudge');
    form.set('taskMode', 'http');
    form.set('endpointUrl', 'http://localhost:9999');
    form.set('dataset', datasetName);
    form.append('models', 'openai/gpt-4o');
    form.append('scorers', 'llmJudge');
    form.set('scorerModel', 'gpt-4.1-mini');

    const response = await app.request('http://localhost/', {
      method: 'POST',
      body: form,
    });

    assert.strictEqual(response.status, 400);
    const body = await response.text();
    assert.match(body, /Unknown scorer "llmJudge"\./);
  });

  it('accepts factuality scorer with OpenAI-compatible model id', async () => {
    const datasetName = createDatasetFile([]);

    const app = new Hono<WebBindings>();
    app.use('*', async (c, next) => {
      c.set('store', store);
      await next();
    });
    app.route('/', runsApi);

    const form = new FormData();
    form.set('name', 'accept-factuality');
    form.set('taskMode', 'http');
    form.set('endpointUrl', 'http://localhost:9999');
    form.set('dataset', datasetName);
    form.append('models', 'openai/gpt-4o');
    form.append('scorers', 'factuality');
    form.set('scorerModel', 'gpt-4.1-mini');

    const response = await app.request('http://localhost/', {
      method: 'POST',
      body: form,
    });

    assert.strictEqual(response.status, 302);
    const location = response.headers.get('location');
    assert.ok(location?.startsWith('/suites/'));
  });

  it('rejects factuality scorer model in provider/model-id format', async () => {
    const datasetName = createDatasetFile([]);

    const app = new Hono<WebBindings>();
    app.use('*', async (c, next) => {
      c.set('store', store);
      await next();
    });
    app.route('/', runsApi);

    const form = new FormData();
    form.set('name', 'reject-factuality-provider-model');
    form.set('taskMode', 'http');
    form.set('endpointUrl', 'http://localhost:9999');
    form.set('dataset', datasetName);
    form.append('models', 'openai/gpt-4o');
    form.append('scorers', 'factuality');
    form.set('scorerModel', 'openai/gpt-4o');

    const response = await app.request('http://localhost/', {
      method: 'POST',
      body: form,
    });

    assert.strictEqual(response.status, 400);
    const body = await response.text();
    assert.match(
      body,
      /Scorer model must be an OpenAI-compatible model id \(for example: gpt-4\.1-mini\)\./,
    );
  });
});
