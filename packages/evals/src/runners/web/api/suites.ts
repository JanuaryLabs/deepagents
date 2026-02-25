import { Hono } from 'hono';

import type { WebBindings } from '../types.ts';

const app = new Hono<WebBindings>();

app.post('/:id/rename', async (c) => {
  const store = c.get('store');
  const id = c.req.param('id');
  const body = await c.req.parseBody();
  const name = String(body.name || '').trim();

  if (!name) {
    return c.text('Name is required', 400);
  }

  if (!store.getSuite(id)) {
    return c.text('Suite not found', 404);
  }

  store.renameSuite(id, name);
  return c.redirect(`/suites/${id}`);
});

export default app;
