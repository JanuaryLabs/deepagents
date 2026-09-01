import { QueryClient } from '@tanstack/react-query';

import type { HistoryRecord } from '@deepagents/devtool-history';

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
  const infoPath = document.querySelector<HTMLMetaElement>(
    'meta[name="deepagents-zukhruf-info"]',
  )?.content;
  if (!infoPath) {
    throw new Error('DevTool host did not configure the Zukhruf protocol path');
  }
  let discovery: Discovery | undefined;
  try {
    const loadedDiscovery = await queryClient.fetchQuery({
      queryKey: ['runtime', 'discovery', infoPath],
      queryFn: () => read<Discovery>(infoPath, signal),
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

async function read<T>(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json() as Promise<T>;
}
