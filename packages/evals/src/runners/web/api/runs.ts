import { Hono } from 'hono';

import { agent, generate } from '@deepagents/agent';

import { hf } from '../../../dataset/hf.ts';
import { dataset } from '../../../dataset/index.ts';
import { EvalEmitter, runEval } from '../../../engine/index.ts';
import type { TaskFn } from '../../../engine/index.ts';
import {
  exactMatch,
  factuality,
  includes,
  jsonMatch,
  levenshtein,
  llmJudge,
} from '../../../scorers/index.ts';
import type { Scorer } from '../../../scorers/index.ts';
import {
  datasetPath,
  isHfDataset,
  readHfConfig,
} from '../services/dataset-store.ts';
import { evalManager } from '../services/eval-manager.ts';
import { resolveModel } from '../services/model-resolver.ts';
import {
  filterRecordsByIndex,
  parseRecordSelection,
} from '../services/record-selection.ts';
import type { WebBindings } from '../types.ts';

const SCORER_MAP: Record<string, Scorer> = {
  exactMatch,
  includes,
  levenshtein,
  jsonMatch,
};

function parseModels(raw: unknown): string[] {
  const values = Array.isArray(raw)
    ? raw.map((v) => String(v))
    : raw == null
      ? []
      : [String(raw)];

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    if (!/^[^\s/]+\/[^\s/].+$/.test(normalized)) {
      throw new Error(
        `Invalid model "${normalized}". Expected "provider/model-id" format.`,
      );
    }
    seen.add(normalized);
    deduped.push(normalized);
  }
  return deduped;
}

function buildScorerModelMap(
  names: string[],
  scorerModelString?: string,
): Record<string, Scorer> {
  const scorers: Record<string, Scorer> = {};
  for (const name of names) {
    if (SCORER_MAP[name]) {
      scorers[name] = SCORER_MAP[name];
      continue;
    }
    if (!scorerModelString) {
      throw new Error(`LLM scorer "${name}" requires a scorer model.`);
    }
    const model = resolveModel(scorerModelString);
    if (name === 'llmJudge')
      scorers[name] = llmJudge({
        model,
        criteria: 'Is the output correct and helpful?',
      });
    else if (name === 'factuality') scorers[name] = factuality({ model });
  }
  return scorers;
}

function buildPromptTask(
  modelString: string,
  systemPrompt: string,
): TaskFn<Record<string, unknown>> {
  const model = resolveModel(modelString);
  const evalAgent = agent({
    name: 'eval_task',
    model,
    prompt: systemPrompt,
  });

  return async (input) => {
    const userMessage =
      typeof input.input === 'string' ? input.input : JSON.stringify(input);
    const result = await generate(evalAgent, userMessage, {});
    return {
      output: result.text,
      usage: result.usage
        ? {
            inputTokens: result.usage.inputTokens ?? 0,
            outputTokens: result.usage.outputTokens ?? 0,
          }
        : undefined,
    };
  };
}

function buildHttpTask(endpointUrl: string): TaskFn<Record<string, unknown>> {
  return async (input) => {
    const response = await fetch(endpointUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }
    const body = (await response.json()) as { output: string };
    return { output: body.output };
  };
}

const app = new Hono<WebBindings>();

app.post('/', async (c) => {
  const store = c.get('store');
  const body = await c.req.parseBody({ all: true });

  const name = String(body.name || '').trim();
  let models: string[] = [];
  try {
    models = parseModels(body.models);
  } catch (err) {
    return c.text(
      err instanceof Error ? err.message : 'Invalid model list.',
      400,
    );
  }
  const taskMode = String(body.taskMode || 'prompt');
  const datasetName = String(body.dataset || '').trim();
  const recordSelectionInput = String(body.recordSelection || '').trim();
  const scorerNames = Array.isArray(body.scorers)
    ? body.scorers.map(String)
    : body.scorers
      ? [String(body.scorers)]
      : [];

  if (
    !name ||
    models.length === 0 ||
    !datasetName ||
    scorerNames.length === 0
  ) {
    return c.text(
      'Missing required fields: name, models, dataset, and at least one scorer.',
      400,
    );
  }

  let promptMeta: { id: string; name: string; version: number } | undefined;
  let systemPrompt: string | undefined;
  let endpointUrl: string | undefined;
  if (taskMode === 'http') {
    endpointUrl = String(body.endpointUrl || '').trim();
    if (!endpointUrl) {
      return c.text('HTTP mode requires an endpoint URL.', 400);
    }
  } else {
    const promptId = String(body.promptId || '').trim();
    if (!promptId) {
      return c.text('Prompt mode requires selecting a saved prompt.', 400);
    }
    const prompt = store.getPrompt(promptId);
    if (!prompt) return c.text('Selected prompt was not found.', 404);
    promptMeta = { id: prompt.id, name: prompt.name, version: prompt.version };
    systemPrompt = prompt.content;
  }

  const scorerModelString = String(body.scorerModel || '').trim() || undefined;
  let scorers: Record<string, Scorer>;
  try {
    scorers = buildScorerModelMap(scorerNames, scorerModelString);
  } catch (err) {
    return c.text(
      err instanceof Error ? err.message : 'Invalid scorer config',
      400,
    );
  }

  let hfRef: ReturnType<typeof readHfConfig> | undefined;
  if (isHfDataset(datasetName)) {
    hfRef = readHfConfig(datasetName);
    if (!hfRef) return c.text('Invalid HuggingFace dataset reference', 400);
  }

  const createDataset = (): AsyncIterable<Record<string, unknown>> => {
    if (hfRef) {
      return dataset<Record<string, unknown>>(hf(hfRef));
    }
    return dataset<Record<string, unknown>>(datasetPath(datasetName));
  };

  let recordSelection: ReturnType<typeof parseRecordSelection> | undefined;
  if (recordSelectionInput) {
    try {
      recordSelection = parseRecordSelection(recordSelectionInput);
    } catch (err) {
      return c.text(
        err instanceof Error
          ? err.message
          : 'Invalid record selection. Use formats like "1,3,5-8".',
        400,
      );
    }
  }

  const createFilteredDataset = (): AsyncIterable<Record<string, unknown>> => {
    const ds = createDataset();
    return recordSelection
      ? filterRecordsByIndex(ds, recordSelection.indexes)
      : ds;
  };

  const suite = store.createSuite(name);

  const maxConcurrency = Number(body.maxConcurrency) || 10;
  const batchSize = Number(body.batchSize) || undefined;
  const timeout = Number(body.timeout) || 30_000;
  const trials = Number(body.trials) || 1;
  const threshold = Number(body.threshold) || 0.5;

  for (const model of models) {
    let task: TaskFn<Record<string, unknown>>;
    if (taskMode === 'http') {
      task = buildHttpTask(endpointUrl!);
    } else {
      task = buildPromptTask(model, systemPrompt!);
    }

    const emitter = new EvalEmitter();
    emitter.on('run:start', (data) => {
      evalManager.register(data.runId, emitter, data.totalCases);
    });

    runEval({
      name: `${name} [${model}]`,
      model,
      dataset: createFilteredDataset(),
      task,
      scorers,
      store,
      emitter,
      suiteId: suite.id,
      maxConcurrency,
      batchSize,
      timeout,
      trials,
      threshold,
      config: {
        taskMode,
        ...(taskMode === 'prompt'
          ? {
              promptId: promptMeta!.id,
              promptName: promptMeta!.name,
              promptVersion: promptMeta!.version,
            }
          : { endpointUrl }),
        dataset: datasetName,
        suiteId: suite.id,
        suiteName: suite.name,
        model,
        recordSelection: recordSelection?.normalized ?? null,
        scorers: scorerNames,
        scorerModel: scorerModelString,
        maxConcurrency,
        batchSize,
        timeout,
        trials,
        threshold,
      },
    }).catch((err) => {
      console.error(`Eval "${name}" for model "${model}" failed:`, err);
    });
  }

  return c.redirect(`/suites/${suite.id}`);
});

export default app;
