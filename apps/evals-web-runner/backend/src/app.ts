import { Hono } from 'hono';
import { contextStorage } from 'hono/context-storage';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { logger } from 'hono/logger';
import { requestId } from 'hono/request-id';
import { timing } from 'hono/timing';

import type { AppBindings } from './store.ts';
import store from './store.ts';

const app = new Hono<AppBindings>()
  .use(async (c, next) => {
    c.set('store', store);
    await next();
  })
  .use(
    logger(),
    timing(),
    cors({
      origin: (origin) => {
        if (process.env.NODE_ENV === 'development') return origin;
        if (!origin) return '';
        return process.env.ALLOWED_ORIGINS.includes(origin) ? origin : '';
      },
    }),
    requestId(),
    contextStorage(),
  );

for await (const route of [
  import('./routes/suits.route.ts'),
  import('./routes/events.route.ts'),
  import('./routes/runs.route.ts'),
  import('./routes/datasets.route.ts'),
  import('./routes/prompts.route.ts'),
  import('./routes/compare.route.ts'),
  import('./routes/models.route.ts'),
  import('./routes/sql-agent.route.ts'),
]) {
  route.default(app.basePath('/api'));
}

(await import('./routes/ui.route.ts')).default(app);

app.notFound((c) => {
  throw new HTTPException(404, {
    message: 'Not Found',
    cause: {
      code: 'api/not-found',
      detail: 'The requested resource was not found',
      instance: c.req.url,
    },
  });
});

app.onError((error, context) => {
  if (process.env.DEBUG_HTTP_ERRORS) {
    console.dir(error, { depth: Infinity });
    console.error(error);
  }
  if (error instanceof HTTPException) {
    return context.json(
      {
        error: error.message,
        cause: error.cause,
      },
      error.status,
    );
  }

  return context.json(
    {
      error: 'Internal Server Error',
      cause: error,
    },
    500,
  );
});

export default app;
