import { Hono } from 'hono';
import assert from 'node:assert';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { RunStore } from '@deepagents/evals/store';

import suiteRoute from '../routes/suite.tsx';
import { evalManager } from '../services/eval-manager.ts';
import type { WebBindings } from '../types.ts';
import runsApi from './runs.ts';

const DATASETS_DIR = '.evals/datasets';
const createdDatasetPaths: string[] = [];
let store: RunStore;

function createDatasetFile(content: unknown): string {
  mkdirSync(DATASETS_DIR, { recursive: true });
  const name = `test-${crypto.randomUUID()}.json`;
  const filePath = join(DATASETS_DIR, name);
  writeFileSync(filePath, JSON.stringify(content), 'utf-8');
  createdDatasetPaths.push(filePath);
  return name;
}

async function waitFor(
  condition: () => boolean,
  timeoutMs = 3000,
  intervalMs = 25,
): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition.');
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function startStubServer(): Promise<{ server: Server; url: string }> {
  const server = createServer((_req, res) => {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ output: 'ok' }));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to start stub HTTP server.');
  }

  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
  };
}

describe('web runs api integration', () => {
  beforeEach(() => {
    store = new RunStore(new DatabaseSync(':memory:'));
    evalManager.resetForTesting();
  });

  afterEach(() => {
    evalManager.resetForTesting();
    while (createdDatasetPaths.length > 0) {
      const next = createdDatasetPaths.pop()!;
      rmSync(next, { force: true });
    }
  });

  it('creates one suite and one run per unique model, then redirects to suite detail', async () => {
    const { server, url } = await startStubServer();
    try {
      const datasetName = createDatasetFile([
        { input: 'q1', expected: 'a1' },
        { input: 'q2', expected: 'a2' },
        { input: 'q3', expected: 'a3' },
        { input: 'q4', expected: 'a4' },
      ]);

      const app = new Hono<WebBindings>();
      app.use('*', async (c, next) => {
        c.set('store', store);
        await next();
      });
      app.route('/', runsApi);

      const form = new FormData();
      form.set('name', 'multi-model-http');
      form.set('taskMode', 'http');
      form.set('endpointUrl', `${url}/predict`);
      form.set('dataset', datasetName);
      form.append('models', ' openai/gpt-4o ');
      form.append('models', 'openai/gpt-4o');
      form.append('models', 'anthropic/claude-3-5-sonnet');
      form.append('scorers', 'exactMatch');
      form.set('trials', '3');
      form.set('recordSelection', '1,3-4');

      const response = await app.request('http://localhost/', {
        method: 'POST',
        body: form,
      });

      assert.strictEqual(response.status, 302);
      const location = response.headers.get('location');
      assert.ok(location?.startsWith('/suites/'));
      const suiteId = location!.split('/').at(-1)!;

      assert.strictEqual(store.listSuites().length, 1);

      await waitFor(() => store.listRuns(suiteId).length === 2);
      const runs = store.listRuns(suiteId);
      assert.strictEqual(runs.length, 2);
      assert.deepStrictEqual(
        new Set(runs.map((run) => run.model)),
        new Set(['openai/gpt-4o', 'anthropic/claude-3-5-sonnet']),
      );
      assert.ok(runs.every((run) => run.suite_id === suiteId));

      for (const run of runs) {
        assert.strictEqual(run.config?.['trials'], 3);
        assert.strictEqual(run.config?.['recordSelection'], '1,3,4');
        assert.strictEqual(run.config?.['suiteId'], suiteId);
        assert.strictEqual(run.config?.['model'], run.model);
      }
    } finally {
      server.close();
    }
  });

  it('enforces prompt selection and propagates prompt metadata to all model runs', async () => {
    const datasetName = createDatasetFile([]);
    const app = new Hono<WebBindings>();
    app.use('*', async (c, next) => {
      c.set('store', store);
      await next();
    });
    app.route('/', runsApi);

    const missingPrompt = new FormData();
    missingPrompt.set('name', 'missing-prompt');
    missingPrompt.set('taskMode', 'prompt');
    missingPrompt.set('dataset', datasetName);
    missingPrompt.append('models', 'openai/gpt-4o');
    missingPrompt.append('scorers', 'exactMatch');

    const missingPromptResponse = await app.request('http://localhost/', {
      method: 'POST',
      body: missingPrompt,
    });
    assert.strictEqual(missingPromptResponse.status, 400);

    const unknownPrompt = new FormData();
    unknownPrompt.set('name', 'unknown-prompt');
    unknownPrompt.set('taskMode', 'prompt');
    unknownPrompt.set('dataset', datasetName);
    unknownPrompt.append('models', 'openai/gpt-4o');
    unknownPrompt.append('scorers', 'exactMatch');
    unknownPrompt.set('promptId', crypto.randomUUID());

    const unknownPromptResponse = await app.request('http://localhost/', {
      method: 'POST',
      body: unknownPrompt,
    });
    assert.strictEqual(unknownPromptResponse.status, 404);

    const prompt = store.createPrompt('test-prompt', 'You are a test prompt');

    const validPromptForm = new FormData();
    validPromptForm.set('name', 'valid-prompt');
    validPromptForm.set('taskMode', 'prompt');
    validPromptForm.set('dataset', datasetName);
    validPromptForm.append('models', 'openai/gpt-4o');
    validPromptForm.append('models', 'anthropic/claude-3-5-sonnet');
    validPromptForm.append('scorers', 'exactMatch');
    validPromptForm.set('promptId', prompt.id);

    const validPromptResponse = await app.request('http://localhost/', {
      method: 'POST',
      body: validPromptForm,
    });
    assert.strictEqual(validPromptResponse.status, 302);
    const location = validPromptResponse.headers.get('location');
    assert.ok(location?.startsWith('/suites/'));
    const suiteId = location!.split('/').at(-1)!;

    await waitFor(() => store.listRuns(suiteId).length === 2);
    const runs = store.listRuns(suiteId);
    for (const run of runs) {
      assert.strictEqual(run.config?.['promptId'], prompt.id);
      assert.strictEqual(run.config?.['promptName'], prompt.name);
      assert.strictEqual(run.config?.['promptVersion'], prompt.version);
    }
  });

  it('suite detail route renders running progress and SSE wiring for each running run', async () => {
    const suite = store.createSuite('suite-live');
    const runningRunId = store.createRun({
      suite_id: suite.id,
      name: 'suite-live [openai/gpt-4o]',
      model: 'openai/gpt-4o',
    });
    const completedRunId = store.createRun({
      suite_id: suite.id,
      name: 'suite-live [anthropic/claude-3-5-sonnet]',
      model: 'anthropic/claude-3-5-sonnet',
    });
    store.finishRun(completedRunId, 'completed', {
      totalCases: 2,
      passCount: 2,
      failCount: 0,
      meanScores: { exactMatch: 1 },
      totalLatencyMs: 10,
      totalTokensIn: 20,
      totalTokensOut: 20,
    });
    const failedRunId = store.createRun({
      suite_id: suite.id,
      name: 'suite-live [google/gemini-2.5-pro]',
      model: 'google/gemini-2.5-pro',
    });
    store.finishRun(failedRunId, 'failed');

    const app = new Hono<WebBindings>();
    app.use('*', async (c, next) => {
      c.set('store', store);
      await next();
    });
    app.route('/suites', suiteRoute);

    const response = await app.request(`http://localhost/suites/${suite.id}`);
    assert.strictEqual(response.status, 200);
    const html = await response.text();

    assert.match(
      html,
      /new EventSource\('\/api\/runs\/' \+ runId \+ '\/events'\)/,
    );
    assert.match(html, new RegExp(`id="progress-${runningRunId}"`));
    assert.match(html, /window\.location\.reload\(\)/);
    assert.match(html, />running</);
    assert.match(html, />completed</);
    assert.match(html, />errored</);
  });
});
