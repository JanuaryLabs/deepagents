import { validate } from '@sdk-it/hono/runtime';
import type { Hono } from 'hono';
import { z } from 'zod';

import type { AppBindings } from '../store.ts';

/** https://models.dev/api.json, as far as this route reads it. */
const modelsDevSchema = z.record(
  z.string(),
  z.object({
    name: z.string(),
    models: z.record(
      z.string(),
      z.object({
        id: z.string(),
        name: z.string(),
        family: z.string().optional(),
      }),
    ),
  }),
);

interface ModelEntry {
  id: string;
  name: string;
  provider: string;
  providerName: string;
  family: string;
}

const CACHE_TTL = 60 * 60 * 1000;
const MODELS_URL = 'https://models.dev/api.json';

/** The models.dev catalog, cached by URL for an hour; a non-OK refresh serves the stale copy. */
class ModelCatalog {
  readonly #responses = new Map<
    string,
    { data: ModelEntry[]; expiry: number }
  >();

  async list(): Promise<ModelEntry[]> {
    const cached = this.#responses.get(MODELS_URL);
    if (cached && Date.now() < cached.expiry) {
      return cached.data;
    }

    const res = await fetch(MODELS_URL);
    if (!res.ok) {
      if (cached) return cached.data;
      throw new Error(`models.dev responded with ${res.status}`);
    }

    const providers = modelsDevSchema.parse(await res.json());
    const models: ModelEntry[] = [];

    for (const [providerId, provider] of Object.entries(providers)) {
      for (const model of Object.values(provider.models)) {
        models.push({
          id: model.id,
          name: model.name,
          provider: providerId,
          providerName: provider.name,
          family: model.family ?? '',
        });
      }
    }

    this.#responses.set(MODELS_URL, {
      data: models,
      expiry: Date.now() + CACHE_TTL,
    });
    return models;
  }
}

const catalog = new ModelCatalog();

export default function (router: Hono<AppBindings>) {
  /**
   * @openapi listModels
   * @tags models
   * @description List all available AI models from models.dev
   */
  router.get(
    '/models',
    validate(() => ({})),
    async (c) => {
      const models = await catalog.list();
      return c.json(models);
    },
  );
}
