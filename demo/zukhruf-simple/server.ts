import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { styleText } from 'node:util';

import { devtool } from '@deepagents/devtool';
import { tracesHttp } from '@deepagents/devtool-traces/http';
import { type HttpEnv, http } from '@deepagents/experimental/zukhruf/http';
import { uploadsHttp } from '@deepagents/experimental/zukhruf/uploads/http';

import { imageUploads, traceTelemetry } from './agent.ts';
import runtime, { resources } from './run.ts';

await using runtimeResources = resources;

const app = new Hono<HttpEnv>();
const devtoolPath = '/devtool';
app.use('/zukhruf/v1/*', (context, next) => {
  context.set('userId', 'demo');
  return next();
});
app.route(
  '/zukhruf/v1',
  http(runtime, uploadsHttp(imageUploads), tracesHttp(traceTelemetry)),
);
app.route(devtoolPath, devtool());

const started = Promise.withResolvers<URL>();
runtimeResources.use(
  serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 4317 }, ({ port }) =>
    started.resolve(new URL(devtoolPath, `http://127.0.0.1:${port}`)),
  ),
);
console.log(styleText('bold', `Open ${(await started.promise).href}`));
console.log(styleText('dim', 'Press Ctrl+C to stop.'));

const stopped = Promise.withResolvers<void>();
process.once('SIGINT', () => stopped.resolve());
process.once('SIGTERM', () => stopped.resolve());
await stopped.promise;
