import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { timing } from 'hono/timing';
import { serveStatic } from '@hono/node-server/serve-static';
import { RunStore } from '@deepagents/evals/store';

import datasetsApi from './api/datasets.ts';
import eventsApi from './api/events.ts';
import promptsApi from './api/prompts.ts';
import runsApi from './api/runs.ts';
import { renderer } from './renderer.tsx';
import compareRoute from './routes/compare.tsx';
import datasetsRoute from './routes/datasets.tsx';
import newEvalRoute from './routes/new-eval.tsx';
import promptsRoute from './routes/prompts.tsx';
import runDetailRoute from './routes/run-detail.tsx';
import runsRoute from './routes/runs.tsx';
import suiteRoute from './routes/suite.tsx';
import type { WebBindings } from './types.ts';

export function createWebApp(store: RunStore): Hono<WebBindings> {
  const app = new Hono<WebBindings>();

  app.use('*', async (c, next) => {
    c.set('store', store);
    await next();
  });
  app.use(logger(), timing());

  if (import.meta.env.PROD) {
    app.use('/assets/*', serveStatic({ root: import.meta.dirname }));
  }

  app.use(renderer);

  app.get('/api/health', (c) => c.json({ status: 'ok' }));
  app.get('/', (c) => c.redirect('/suites'));

  app.route('/runs', runsRoute);
  app.route('/runs', runDetailRoute);
  app.route('/compare', compareRoute);
  app.route('/suites', suiteRoute);
  app.route('/datasets', datasetsRoute);
  app.route('/prompts', promptsRoute);
  app.route('/evals/new', newEvalRoute);

  app.route('/api/runs', runsApi);
  app.route('/api/runs', eventsApi);
  app.route('/api/datasets', datasetsApi);
  app.route('/api/prompts', promptsApi);

  return app;
}

const app = createWebApp(new RunStore());

export default app;
