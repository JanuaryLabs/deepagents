import { Hono } from 'hono';

import type { WebBindings } from '../types.ts';

const app = new Hono<WebBindings>();

app.get('/', (c) => {
  const store = c.get('store');
  return c.json(store.listPrompts());
});

app.post('/', async (c) => {
  const store = c.get('store');
  const body = await c.req.parseBody();
  const name = String(body.name || '').trim();
  const content = String(body.content || '').trim();

  if (!name || !content) {
    return c.text('Name and content are required', 400);
  }

  try {
    store.createPrompt(name, content);
  } catch (err) {
    return c.text(err instanceof Error ? err.message : 'Failed to save', 400);
  }

  return c.redirect('/prompts');
});

app.get('/:id', (c) => {
  const store = c.get('store');
  const prompt = store.getPrompt(c.req.param('id'));
  if (!prompt) return c.text('Prompt not found', 404);
  return c.json(prompt);
});

app.post('/:id/delete', (c) => {
  const store = c.get('store');
  store.deletePrompt(c.req.param('id'));
  return c.redirect('/prompts');
});

export default app;
