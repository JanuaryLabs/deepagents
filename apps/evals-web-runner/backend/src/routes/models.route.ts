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

/** The models.dev catalog, cached for an hour; a non-OK refresh serves the stale copy. */
class ModelCatalog {
  #cached: { data: ModelEntry[]; expiry: number } | undefined;

  async list(): Promise<ModelEntry[]> {
    if (this.#cached && Date.now() < this.#cached.expiry) {
      return this.#cached.data;
    }

    const res = await fetch('https://models.dev/api.json');
    if (!res.ok) {
      if (this.#cached) return this.#cached.data;
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

    this.#cached = { data: models, expiry: Date.now() + CACHE_TTL };
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
