import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';

import { evalManager } from '../services/eval-manager.ts';
import type { WebBindings } from '../types.ts';

const app = new Hono<WebBindings>();

app.get('/:id/events', async (c) => {
  const store = c.get('store');
  const runId = c.req.param('id');
  const entry = evalManager.get(runId);

  if (!entry) {
    const run = store.getRun(runId);
    if (run?.status === 'running') {
      store.finishRun(runId, 'failed');
    }
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({
        event: 'run:end',
        data: JSON.stringify({ runId, summary: run?.summary }),
      });
    });
  }

  return streamSSE(c, async (stream) => {
    let closed = false;

    const cleanup = () => {
      closed = true;
      entry.emitter.off('case:scored', onCaseScored);
      entry.emitter.off('run:end', onRunEnd);
    };

    const onCaseScored = async (data: unknown) => {
      if (closed) return;
      try {
        await stream.writeSSE({
          event: 'case:scored',
          data: JSON.stringify({
            ...(data as Record<string, unknown>),
            completed: entry.completed,
            totalCases: entry.totalCases,
          }),
        });
      } catch {
        cleanup();
      }
    };

    const onRunEnd = async (data: unknown) => {
      if (closed) return;
      try {
        await stream.writeSSE({
          event: 'run:end',
          data: JSON.stringify(data),
        });
      } catch {
        /* empty — stream write failed */
      }
      cleanup();
    };

    entry.emitter.on('case:scored', onCaseScored);
    entry.emitter.on('run:end', onRunEnd);

    stream.onAbort(cleanup);

    await new Promise<void>((resolve) => {
      const checkClosed = setInterval(() => {
        if (closed) {
          clearInterval(checkClosed);
          resolve();
        }
      }, 1000);
    });
  });
});

export default app;
