import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

import { agent, generate } from '@deepagents/agent';
import {
  dataset,
  filterRecordsByIndex,
  parseRecordSelection,
} from '@deepagents/evals/dataset';
import type { TaskFn } from '@deepagents/evals/engine';
import { EvalEmitter, runEval } from '@deepagents/evals/engine';
import type { Scorer } from '@deepagents/evals/scorers';
import {
  exactMatch,
  factuality,
  includes,
  jsonMatch,
  levenshtein,
} from '@deepagents/evals/scorers';
import type { CaseWithScores } from '@deepagents/evals/store';

import * as inputs from '../core/inputs.ts';
import { validate } from '../middlewares/validator.ts';
import { datasetPath } from '../services/dataset-store.ts';
import evalManager from '../services/eval-manager.ts';
import { resolveModel } from '../services/model-resolver.ts';
import type { AppBindings } from '../store.ts';

const SCORER_MAP: Record<string, Scorer> = {
  exactMatch,
  includes,
  levenshtein,
  jsonMatch,
};

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
    if (name !== 'factuality') {
      throw new Error(`Unknown scorer "${name}".`);
    }
    if (!scorerModelString) {
      throw new Error('LLM scorer "factuality" requires a scorer model.');
    }
    if (scorerModelString.includes('/')) {
      throw new Error(
        'Scorer model must be an OpenAI-compatible model id (for example: gpt-4.1-mini).',
      );
    }
    scorers[name] = factuality({ model: scorerModelString });
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

export default function (router: Hono<AppBindings>) {
  /**
   * @openapi listRuns
   * @tags runs
   * @description List all runs grouped by suite
   */
  router.get(
    '/runs',
    validate(() => ({})),
    (c) => {
      const store = c.get('store');
      const runs = store.listRuns().reverse();
      const suites = store.listSuites();
      const suitesById = new Map(suites.map((s) => [s.id, s]));

      const groupMap = new Map<
        string,
        { suiteId: string; suiteName: string; runs: typeof runs }
      >();
      const groups: Array<{
        suiteId: string;
        suiteName: string;
        runs: typeof runs;
      }> = [];

      for (const run of runs) {
        let group = groupMap.get(run.suite_id);
        if (!group) {
          group = {
            suiteId: run.suite_id,
            suiteName: suitesById.get(run.suite_id)?.name ?? 'Unknown Suite',
            runs: [],
          };
          groupMap.set(run.suite_id, group);
          groups.push(group);
        }
        group.runs.push(run);
      }

      return c.json({ groups, totalRuns: runs.length });
    },
  );

  /**
   * @openapi getRun
   * @tags runs
   * @description Get a single run with cases and scores
   */
  router.get(
    '/runs/:id',
    validate((payload) => ({
      id: { select: payload.params.id, against: z.string() },
    })),
    (c) => {
      const { id } = c.var.input;
      const store = c.get('store');
      const run = store.getRun(id);
      if (!run) {
        throw new HTTPException(404, { message: 'Run not found' });
      }

      const summary = run.summary ?? store.getRunSummary(id);
      const allCases = store.getFailingCases(id, Infinity);
      const plainCases = store.getCases(id);
      const scoredMap = new Map(allCases.map((cs) => [cs.id, cs]));
      const cases: CaseWithScores[] = plainCases.map(
        (cs) => scoredMap.get(cs.id) ?? { ...cs, scores: [] },
      );

      const scorerNames = [
        ...new Set(cases.flatMap((cs) => cs.scores.map((s) => s.scorer_name))),
      ];

      const suite = store.getSuite(run.suite_id);
      if (!suite) {
        throw new HTTPException(500, { message: 'Suite not found for run' });
      }

      const runConfig = (run.config ?? {}) as Record<string, unknown>;

      return c.json({
        run,
        summary,
        cases,
        scorerNames,
        suite,
        config: runConfig,
      });
    },
  );

  /**
   * @openapi renameRun
   * @tags runs
   * @description Rename an existing run
   */
  router.patch(
    '/runs/:id',
    validate((payload) => ({
      id: { select: payload.params.id, against: z.string() },
      name: { select: payload.body.name, against: inputs.nameSchema },
    })),
    (c) => {
      const { id, name } = c.var.input;
      const store = c.get('store');

      const run = store.getRun(id);
      if (!run) {
        throw new HTTPException(404, { message: 'Run not found' });
      }

      store.renameRun(id, name);
      return c.json({ success: true });
    },
  );

  /**
   * @openapi deleteRun
   * @tags runs
   * @description Delete a run by ID
   */
  router.delete(
    '/runs/:id',
    validate((payload) => ({
      id: { select: payload.params.id, against: z.string() },
    })),
    (c) => {
      const { id } = c.var.input;
      const store = c.get('store');
      if (!store.getRun(id)) {
        throw new HTTPException(404, { message: 'Run not found' });
      }
      store.deleteRun(id);
      return c.body(null, 204);
    },
  );

  /**
   * @openapi retryRun
   * @tags runs
   * @description Retry a run in-place by resetting its cases and re-executing
   */
  router.post(
    '/runs/:id/retry',
    validate((payload) => ({
      id: { select: payload.params.id, against: z.string() },
    })),
    (c) => {
      const { id } = c.var.input;
      const store = c.get('store');

      const run = store.getRun(id);
      if (!run) {
        throw new HTTPException(404, { message: 'Run not found' });
      }
      if (run.status === 'running') {
        throw new HTTPException(409, { message: 'Run is already running' });
      }

      const cfg = (run.config ?? {}) as Record<string, unknown>;
      const taskMode =
        cfg.taskMode === 'http' ? ('http' as const) : ('prompt' as const);
      const datasetName = String(cfg.dataset ?? '');
      const scorerNames = Array.isArray(cfg.scorers)
        ? cfg.scorers.map(String)
        : [];
      const scorerModelString =
        typeof cfg.scorerModel === 'string' ? cfg.scorerModel : undefined;
      const endpointUrl =
        typeof cfg.endpointUrl === 'string' ? cfg.endpointUrl : undefined;
      const promptId =
        typeof cfg.promptId === 'string' ? cfg.promptId : undefined;
      const recordSelectionInput =
        typeof cfg.recordSelection === 'string'
          ? cfg.recordSelection
          : undefined;
      const inputField =
        typeof cfg.inputField === 'string' ? cfg.inputField : 'input';
      const expectedField =
        typeof cfg.expectedField === 'string' ? cfg.expectedField : 'expected';
      const maxConcurrency =
        typeof cfg.maxConcurrency === 'number' ? cfg.maxConcurrency : 10;
      const batchSize =
        typeof cfg.batchSize === 'number' ? cfg.batchSize : undefined;
      const timeout = typeof cfg.timeout === 'number' ? cfg.timeout : 30_000;
      const trials = typeof cfg.trials === 'number' ? cfg.trials : 1;
      const threshold = typeof cfg.threshold === 'number' ? cfg.threshold : 0.5;

      let systemPrompt: string | undefined;
      if (taskMode === 'http') {
        if (!endpointUrl) {
          throw new HTTPException(400, {
            message: 'Stored config missing endpoint URL.',
          });
        }
      } else {
        if (!promptId) {
          throw new HTTPException(400, {
            message: 'Stored config missing prompt ID.',
          });
        }
        const prompt = store.getPrompt(promptId);
        if (!prompt) {
          throw new HTTPException(404, {
            message: 'Prompt referenced by run no longer exists.',
          });
        }
        systemPrompt = prompt.content;
      }

      let scorers: Record<string, Scorer>;
      try {
        scorers = buildScorerModelMap(scorerNames, scorerModelString);
      } catch (err) {
        throw new HTTPException(400, {
          message: err instanceof Error ? err.message : 'Invalid scorer config',
        });
      }

      let recordSelection: ReturnType<typeof parseRecordSelection> | undefined;
      if (recordSelectionInput) {
        recordSelection = parseRecordSelection(recordSelectionInput);
      }

      const createFilteredDataset = (): AsyncIterable<
        Record<string, unknown>
      > => {
        const ds = dataset<Record<string, unknown>>(datasetPath(datasetName));
        const filtered = recordSelection
          ? filterRecordsByIndex(ds, recordSelection.indexes)
          : ds;
        return (async function* (source) {
          for await (const row of source) {
            yield {
              ...row,
              input: row[inputField],
              expected: row[expectedField],
            };
          }
        })(filtered);
      };

      let task: TaskFn<Record<string, unknown>>;
      if (taskMode === 'http') {
        task = buildHttpTask(endpointUrl!);
      } else {
        task = buildPromptTask(run.model, systemPrompt!);
      }

      store.resetRun(id);

      const emitter = new EvalEmitter();
      emitter.on('run:start', (data) => {
        evalManager.register(data.runId, emitter, data.totalCases);
      });

      runEval({
        runId: id,
        name: run.name,
        model: run.model,
        dataset: createFilteredDataset(),
        task,
        scorers,
        store,
        emitter,
        suiteId: run.suite_id,
        maxConcurrency,
        batchSize,
        timeout,
        trials,
        threshold,
        config: run.config ?? undefined,
      }).catch((err) => {
        console.error(`Retry of run "${run.name}" failed:`, err);
      });

      return c.json({ runId: id });
    },
  );

  /**
   * @openapi createRun
   * @tags runs
   * @description Start a new eval run across one or more models
   */
  router.post(
    '/runs',
    validate((payload) => ({
      suiteId: {
        select: payload.body.suiteId,
        against: z.string().optional(),
      },
      name: { select: payload.body.name, against: inputs.nameSchema },
      models: { select: payload.body.models, against: inputs.modelListSchema },
      taskMode: {
        select: payload.body.taskMode,
        against: z.enum(['prompt', 'http']).default('prompt'),
      },
      dataset: {
        select: payload.body.dataset,
        against: z.string().min(1).trim(),
      },
      scorers: {
        select: payload.body.scorers,
        against: z.array(z.string().min(1)).min(1),
      },
      scorerModel: {
        select: payload.body.scorerModel,
        against: z.string().trim().optional(),
      },
      endpointUrl: {
        select: payload.body.endpointUrl,
        against: z.string().url().optional(),
      },
      promptId: {
        select: payload.body.promptId,
        against: z.string().optional(),
      },
      recordSelection: {
        select: payload.body.recordSelection,
        against: z.string().trim().optional(),
      },
      maxConcurrency: {
        select: payload.body.maxConcurrency,
        against: z.coerce.number().int().positive().default(10),
      },
      batchSize: {
        select: payload.body.batchSize,
        against: z.coerce.number().int().positive().optional(),
      },
      timeout: {
        select: payload.body.timeout,
        against: z.coerce.number().int().positive().default(30_000),
      },
      trials: {
        select: payload.body.trials,
        against: z.coerce.number().int().positive().default(1),
      },
      threshold: {
        select: payload.body.threshold,
        against: z.coerce.number().min(0).max(1).default(0.5),
      },
      inputField: {
        select: payload.body.inputField,
        against: z.string().trim().optional(),
      },
      expectedField: {
        select: payload.body.expectedField,
        against: z.string().trim().optional(),
      },
    })),
    (c) => {
      const {
        suiteId: existingSuiteId,
        name,
        models,
        taskMode,
        dataset: datasetName,
        scorers: scorerNames,
        scorerModel: scorerModelString,
        endpointUrl,
        promptId,
        recordSelection: recordSelectionInput,
        maxConcurrency,
        batchSize,
        timeout,
        trials,
        threshold,
        inputField: inputFieldRaw,
        expectedField: expectedFieldRaw,
      } = c.var.input;

      const inputField = inputFieldRaw || 'input';
      const expectedField = expectedFieldRaw || 'expected';
      const store = c.get('store');

      let promptMeta: { id: string; name: string; version: number } | undefined;
      let systemPrompt: string | undefined;

      if (taskMode === 'http') {
        if (!endpointUrl) {
          throw new HTTPException(400, {
            message: 'HTTP mode requires an endpoint URL.',
          });
        }
      } else {
        if (!promptId) {
          throw new HTTPException(400, {
            message: 'Prompt mode requires selecting a saved prompt.',
          });
        }
        const prompt = store.getPrompt(promptId);
        if (!prompt) {
          throw new HTTPException(404, {
            message: 'Selected prompt was not found.',
          });
        }
        promptMeta = {
          id: prompt.id,
          name: prompt.name,
          version: prompt.version,
        };
        systemPrompt = prompt.content;
      }

      let scorers: Record<string, Scorer>;
      try {
        scorers = buildScorerModelMap(scorerNames, scorerModelString);
      } catch (err) {
        throw new HTTPException(400, {
          message: err instanceof Error ? err.message : 'Invalid scorer config',
        });
      }

      const createDataset = (): AsyncIterable<Record<string, unknown>> => {
        return dataset<Record<string, unknown>>(datasetPath(datasetName));
      };

      let recordSelection: ReturnType<typeof parseRecordSelection> | undefined;
      if (recordSelectionInput) {
        try {
          recordSelection = parseRecordSelection(recordSelectionInput);
        } catch (err) {
          throw new HTTPException(400, {
            message:
              err instanceof Error
                ? err.message
                : 'Invalid record selection. Use formats like "1,3,5-8".',
          });
        }
      }

      const remapFields = async function* (
        source: AsyncIterable<Record<string, unknown>>,
      ): AsyncIterable<Record<string, unknown>> {
        for await (const row of source) {
          yield {
            ...row,
            input: row[inputField],
            expected: row[expectedField],
          };
        }
      };

      const createFilteredDataset = (): AsyncIterable<
        Record<string, unknown>
      > => {
        const ds = createDataset();
        const filtered = recordSelection
          ? filterRecordsByIndex(ds, recordSelection.indexes)
          : ds;
        return remapFields(filtered);
      };

      let suite;
      if (existingSuiteId) {
        suite = store.getSuite(existingSuiteId);
        if (!suite) {
          throw new HTTPException(404, { message: 'Suite not found' });
        }
      } else {
        suite = store.createSuite(name);
      }

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
            inputField,
            expectedField,
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

      return c.json({ suiteId: suite.id }, 201);
    },
  );
}
