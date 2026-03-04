import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

import * as inputs from '../core/inputs.ts';
import { validate } from '../middlewares/validator.ts';
import type { AppBindings } from '../store.ts';

export default function (router: Hono<AppBindings>) {
  /**
   * @openapi listSuites
   * @tags suites
   * @description List all evaluation suites with run counts
   */
  router.get(
    '/suites',
    validate(() => ({})),
    (c) => {
      const store = c.get('store');
      const suites = store.listSuites();
      const result = suites.map((suite) => {
        const runs = store.listRuns(suite.id);
        return {
          ...suite,
          runCount: runs.length,
          runningCount: runs.filter((r) => r.status === 'running').length,
          completedCount: runs.filter((r) => r.status === 'completed').length,
          failedCount: runs.filter((r) => r.status === 'failed').length,
          lastStartedAt:
            runs.length > 0 ? runs[runs.length - 1]!.started_at : null,
        };
      });
      return c.json(result);
    },
  );

  /**
   * @openapi getSuite
   * @tags suites
   * @description Get a single suite with its runs and aggregate stats
   */
  router.get(
    '/suites/:id',
    validate((payload) => ({
      id: { select: payload.params.id, against: z.string() },
    })),
    (c) => {
      const { id } = c.var.input;
      const store = c.get('store');
      const suite = store.getSuite(id);
      if (!suite) {
        throw new HTTPException(404, { message: 'Suite not found' });
      }

      const runs = store.listRuns(id).reverse();
      const completedRuns = runs.filter(
        (r) => r.status === 'completed' && r.summary,
      );

      const stats =
        completedRuns.length > 0
          ? {
              totalCases: completedRuns.reduce(
                (s, r) => s + (r.summary?.totalCases ?? 0),
                0,
              ),
              totalPass: completedRuns.reduce(
                (s, r) => s + (r.summary?.passCount ?? 0),
                0,
              ),
              totalFail: completedRuns.reduce(
                (s, r) => s + (r.summary?.failCount ?? 0),
                0,
              ),
              totalLatency: completedRuns.reduce(
                (s, r) => s + (r.summary?.totalLatencyMs ?? 0),
                0,
              ),
              totalTokens: completedRuns.reduce(
                (s, r) =>
                  s +
                  (r.summary?.totalTokensIn ?? 0) +
                  (r.summary?.totalTokensOut ?? 0),
                0,
              ),
            }
          : null;

      return c.json({ suite, runs, stats });
    },
  );

  /**
   * @openapi compareSuiteRuns
   * @tags suites
   * @description Compare multiple runs within a suite
   */
  router.get(
    '/suites/:id/compare',
    validate((payload) => ({
      id: { select: payload.params.id, against: z.string() },
      runIds: {
        select: payload.query.runIds,
        against: z.string().min(1),
      },
    })),
    (c) => {
      const { id, runIds: runIdsParam } = c.var.input;
      const store = c.get('store');

      const suite = store.getSuite(id);
      if (!suite) {
        throw new HTTPException(404, { message: 'Suite not found' });
      }

      const runIds = runIdsParam.split(',').filter(Boolean);
      if (runIds.length < 2) {
        throw new HTTPException(400, {
          message: 'At least 2 run IDs required',
        });
      }

      const runs = runIds.map((runId) => {
        const run = store.getRun(runId);
        if (!run) {
          throw new HTTPException(404, {
            message: `Run "${runId}" not found`,
          });
        }
        if (run.suite_id !== id) {
          throw new HTTPException(400, {
            message: `Run "${runId}" does not belong to this suite`,
          });
        }
        const summary = run.summary ?? store.getRunSummary(runId);
        return { id: run.id, name: run.name, model: run.model, summary };
      });

      const allScorerNames = new Set<string>();
      const runScoreMaps = new Map<
        string,
        Map<number, Record<string, number>>
      >();

      for (const run of runs) {
        const cases = store.getCases(run.id);
        const withScores = store.getFailingCases(run.id, Infinity);
        const scoredMap = new Map(withScores.map((cs) => [cs.id, cs]));
        const allCases = cases.map(
          (cs) => scoredMap.get(cs.id) ?? { ...cs, scores: [] },
        );

        const scoreMap = new Map<number, Record<string, number>>();
        for (const cs of allCases) {
          const scores: Record<string, number> = {};
          for (const s of cs.scores) {
            scores[s.scorer_name] = s.score;
            allScorerNames.add(s.scorer_name);
          }
          scoreMap.set(cs.idx, scores);
        }
        runScoreMaps.set(run.id, scoreMap);
      }

      const allIndices = new Set<number>();
      for (const scoreMap of runScoreMaps.values()) {
        for (const idx of scoreMap.keys()) allIndices.add(idx);
      }
      const sortedIndices = [...allIndices].sort((a, b) => a - b);

      const scorerNames = [...allScorerNames];

      const caseDiffs = sortedIndices.map((idx) => {
        const scores: Record<string, Record<string, number>> = {};
        for (const scorer of scorerNames) {
          scores[scorer] = {};
          for (const run of runs) {
            const scoreMap = runScoreMaps.get(run.id)!;
            const caseScores = scoreMap.get(idx);
            scores[scorer]![run.id] = caseScores?.[scorer] ?? 0;
          }
        }
        return { index: idx, scores };
      });

      return c.json({ runs, scorerNames, caseDiffs });
    },
  );

  /**
   * @openapi renameSuite
   * @tags suites
   * @description Rename an existing suite
   */
  router.patch(
    '/suites/:id',
    validate((payload) => ({
      id: { select: payload.params.id, against: z.string() },
      name: { select: payload.body.name, against: inputs.nameSchema },
    })),
    (c) => {
      const { id, name } = c.var.input;
      const store = c.get('store');

      if (!store.getSuite(id)) {
        throw new HTTPException(404, { message: 'Suite not found' });
      }

      store.renameSuite(id, name);
      return c.json({ success: true });
    },
  );

  /**
   * @openapi deleteSuite
   * @tags suites
   * @description Delete a suite and all its runs
   */
  router.delete(
    '/suites/:id',
    validate((payload) => ({
      id: { select: payload.params.id, against: z.string() },
    })),
    (c) => {
      const { id } = c.var.input;
      const store = c.get('store');
      if (!store.getSuite(id)) {
        throw new HTTPException(404, { message: 'Suite not found' });
      }
      store.deleteSuite(id);
      return c.body(null, 204);
    },
  );
}
