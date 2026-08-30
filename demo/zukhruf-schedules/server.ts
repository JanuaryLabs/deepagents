import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { styleText } from 'node:util';

import { devtool } from '@deepagents/devtool';
import { type HttpEnv, http } from '@deepagents/experimental/zukhruf/http';
import { schedulesHttp } from '@deepagents/experimental/zukhruf/schedules/http';

import { scheduled } from './agent.ts';
import runtime, { resources } from './run.ts';

await using runtimeResources = resources;

/** `--no-schedules` omits the projection so DevTool hides Scheduled navigation. */
const withSchedules = !process.argv.includes('--no-schedules');
const ownerId = process.env.USER ?? 'local';

const app = new Hono<HttpEnv>();
const devtoolPath = '/devtool';
app.use('/zukhruf/v1/*', (context, next) => {
  context.set('userId', ownerId);
  return next();
});
app.route(
  '/zukhruf/v1',
  withSchedules ? http(runtime, schedulesHttp(scheduled)) : http(runtime),
);
app.route(devtoolPath, devtool());

const started = Promise.withResolvers<URL>();
runtimeResources.use(
  serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 4318 }, ({ port }) =>
    started.resolve(new URL(devtoolPath, `http://127.0.0.1:${port}`)),
  ),
);
console.log(styleText('bold', `Open ${(await started.promise).href}`));
console.log(
  styleText(
    'dim',
    withSchedules
      ? 'Scheduled tasks are managed from the browser. Press Ctrl+C to stop.'
      : 'Started without schedulesHttp(); Scheduled navigation is hidden.',
  ),
);

const stopped = Promise.withResolvers<void>();
process.once('SIGINT', () => stopped.resolve());
process.once('SIGTERM', () => stopped.resolve());
await stopped.promise;
