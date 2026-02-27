import { useMemo } from 'react';

import { useData } from './use-client.ts';

export interface ModelGroup {
  provider: string;
  providerName: string;
  models: Array<{
    id: string;
    name: string;
    family: string;
  }>;
}

export function useModels() {
  const query = useData('GET /models');

  const grouped = useMemo(() => {
    if (!query.data) return [];
    const map = new Map<string, ModelGroup>();
    for (const m of query.data) {
      let group = map.get(m.provider);
      if (!group) {
        group = {
          provider: m.provider,
          providerName: m.providerName,
          models: [],
        };
        map.set(m.provider, group);
      }
      group.models.push({ id: m.id, name: m.name, family: m.family });
    }
    return [...map.values()];
  }, [query.data]);

  return { ...query, grouped };
}
