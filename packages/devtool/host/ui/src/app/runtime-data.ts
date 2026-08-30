import { QueryClient, useQuery } from '@tanstack/react-query';

import type { HistoryRecord } from '@deepagents/devtool-history';

const ZUKHRUF_INFO_URL = '/zukhruf/v1/info';
const ZUKHRUF_HEALTH_URL = '/zukhruf/v1/health';

export type Discovery = {
  capabilities: {
    chat: { href: string };
    history: { href: string };
    traces?: { href: string };
    schedules?: { href: string };
  };
};

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: false,
    },
  },
});

export async function loadRuntime(signal: AbortSignal) {
  let discovery: Discovery | undefined;
  try {
    const loadedDiscovery = await queryClient.fetchQuery({
      queryKey: ['runtime', 'discovery'],
      queryFn: () => read<Discovery>(ZUKHRUF_INFO_URL, signal),
    });
    discovery = loadedDiscovery;
    const history = await queryClient.fetchQuery({
      queryKey: [
        'runtime',
        'history',
        loadedDiscovery.capabilities.history.href,
      ],
      queryFn: () =>
        read<HistoryRecord[]>(
          loadedDiscovery.capabilities.history.href,
          signal,
        ),
    });
    return { discovery, history, historyError: false };
  } catch {
    return { discovery, history: [], historyError: true };
  }
}

export function useHealth() {
  return useQuery({
    queryKey: ['runtime', 'health'],
    queryFn: async ({ signal }) =>
      (await fetch(ZUKHRUF_HEALTH_URL, { signal })).ok,
  });
}

async function read<T>(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json() as Promise<T>;
}
