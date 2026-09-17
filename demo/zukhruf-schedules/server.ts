import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { styleText } from 'node:util';

import { devtool } from '@deepagents/devtool';
import { tracesHttp } from '@deepagents/devtool/traces';
import { type HttpEnv, http } from '@deepagents/experimental/zukhruf/http';
import { schedulesHttp } from '@deepagents/experimental/zukhruf/schedules/http';

import { scheduled, traceTelemetry } from './agent.ts';
import runtime from './run.ts';
import stack from './stack.ts';

await using host = await runtime.initialize(stack);
await using worker = await host.work();

const ownerId = process.env.USER ?? 'local';

const app = new Hono<HttpEnv>();
const devtoolPath = '/devtool';
app.use('/zukhruf/v1/*', (context, next) => {
  context.set('userId', ownerId);
  return next();
});

app.route(
  '/zukhruf/v1',
  http(host, schedulesHttp(scheduled), tracesHttp(traceTelemetry)),
);
app.route(devtoolPath, devtool());

const started = Promise.withResolvers<URL>();
await using server = serve(
  { fetch: app.fetch, hostname: '127.0.0.1', port: 4318 },
  ({ port }) =>
    started.resolve(new URL(devtoolPath, `http://127.0.0.1:${port}`)),
);
console.log(styleText('bold', `Open ${(await started.promise).href}`));
console.log(
  styleText(
    'dim',
    'Scheduled tasks are managed from the browser. Press Ctrl+C to stop.',
  ),
);

const stopped = Promise.withResolvers<void>();
process.once('SIGINT', () => stopped.resolve());
process.once('SIGTERM', () => stopped.resolve());
await stopped.promise;
