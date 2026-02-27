import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

import { compareRuns } from '@deepagents/evals/comparison';

import { validate } from '../middlewares/validator.ts';
import type { AppBindings } from '../store.ts';

export default function (router: Hono<AppBindings>) {
  /**
   * @openapi listCompletedRuns
   * @tags compare
   * @description List completed runs available for comparison
   */
  router.get(
    '/compare/runs',
    validate(() => ({})),
    (c) => {
      const store = c.get('store');
      const runs = store.listRuns().reverse();
      const completedRuns = runs.filter((r) => r.status === 'completed');
      return c.json(completedRuns);
    },
  );

  /**
   * @openapi compareRuns
   * @tags compare
   * @description Compare two runs side by side
   */
  router.get(
    '/compare',
    validate((payload) => ({
      baseline: { select: payload.query.baseline, against: z.string().min(1) },
      candidate: {
        select: payload.query.candidate,
        against: z.string().min(1),
      },
    })),
    (c) => {
      const { baseline, candidate } = c.var.input;
      const store = c.get('store');

      const baselineRun = store.getRun(baseline);
      const candidateRun = store.getRun(candidate);

      if (!baselineRun || !candidateRun) {
        throw new HTTPException(404, {
          message: 'One or both runs not found',
        });
      }

      const result = compareRuns(store, baseline, candidate);

      return c.json({
        baseline: baselineRun,
        candidate: candidateRun,
        result,
      });
    },
  );
}
