import type { Hono } from 'hono';

import { validate } from '../middlewares/validator.ts';
import type { AppBindings } from '../store.ts';

interface ModelsDevProvider {
  id: string;
  name: string;
  env?: string[];
  npm?: string;
  models: Record<
    string,
    {
      id: string;
      name: string;
      family?: string;
    }
  >;
}

interface ModelEntry {
  id: string;
  name: string;
  provider: string;
  providerName: string;
  family: string;
}

let cached: { data: ModelEntry[]; expiry: number } | null = null;

const CACHE_TTL = 60 * 60 * 1000;

async function fetchModels(): Promise<ModelEntry[]> {
  if (cached && Date.now() < cached.expiry) {
    return cached.data;
  }

  const res = await fetch('https://models.dev/api.json');
  if (!res.ok) {
    if (cached) return cached.data;
    throw new Error(`models.dev responded with ${res.status}`);
  }

  const providers = (await res.json()) as Record<string, ModelsDevProvider>;
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

  cached = { data: models, expiry: Date.now() + CACHE_TTL };
  return models;
}

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
      const models = await fetchModels();
      return c.json(models);
    },
  );
}
