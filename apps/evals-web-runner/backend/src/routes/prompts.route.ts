import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

import * as inputs from '../core/inputs.ts';
import { validate } from '../middlewares/validator.ts';
import type { AppBindings } from '../store.ts';

export default function (router: Hono<AppBindings>) {
  /**
   * @openapi listPrompts
   * @tags prompts
   * @description List all saved prompts
   */
  router.get(
    '/prompts',
    validate(() => ({})),
    (c) => {
      const store = c.get('store');
      return c.json(store.listPrompts());
    },
  );

  /**
   * @openapi createPrompt
   * @tags prompts
   * @description Create a new prompt
   */
  router.post(
    '/prompts',
    validate((payload) => ({
      name: { select: payload.body.name, against: inputs.nameSchema },
      content: {
        select: payload.body.content,
        against: z.string().min(1).trim(),
      },
    })),
    (c) => {
      const { name, content } = c.var.input;
      const store = c.get('store');

      try {
        const prompt = store.createPrompt(name, content);
        return c.json(prompt, 201);
      } catch (err) {
        throw new HTTPException(400, {
          message: err instanceof Error ? err.message : 'Failed to save',
        });
      }
    },
  );

  /**
   * @openapi getPrompt
   * @tags prompts
   * @description Get a single prompt by ID
   */
  router.get(
    '/prompts/:id',
    validate((payload) => ({
      id: { select: payload.params.id, against: z.string() },
    })),
    (c) => {
      const { id } = c.var.input;
      const store = c.get('store');
      const prompt = store.getPrompt(id);
      if (!prompt) {
        throw new HTTPException(404, { message: 'Prompt not found' });
      }
      return c.json(prompt);
    },
  );

  /**
   * @openapi deletePrompt
   * @tags prompts
   * @description Delete a prompt by ID
   */
  router.delete(
    '/prompts/:id',
    validate((payload) => ({
      id: { select: payload.params.id, against: z.string() },
    })),
    (c) => {
      const { id } = c.var.input;
      const store = c.get('store');
      store.deletePrompt(id);
      return c.body(null, 204);
    },
  );
}
