import { QueryClient, skipToken, useQuery } from '@tanstack/react-query';

import type { HistoryRecord } from '@deepagents/devtool-history';

type Discovery = {
  traces?: { path: string };
  capabilities: {
    history: { href: string };
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

export function useRuntimeData() {
  const discovery = useQuery({
    queryKey: ['runtime', 'discovery'],
    queryFn: async ({ signal }) => {
      const response = await fetch('/zukhruf/v1/info', { signal });
      if (!response.ok) {
        throw new Error(`Discovery request failed: ${response.status}`);
      }
      return response.json() as Promise<Discovery>;
    },
  });
  const history = useQuery<HistoryRecord[]>({
    queryKey: ['runtime', 'history', discovery.data?.capabilities.history.href],
    queryFn: discovery.data
      ? async ({ signal }) => {
          const response = await fetch(
            new URL(
              discovery.data.capabilities.history.href,
              window.location.href,
            ),
            { signal },
          );
          if (!response.ok) {
            throw new Error(`History request failed: ${response.status}`);
          }
          return response.json() as Promise<HistoryRecord[]>;
        }
      : skipToken,
    refetchInterval: 3_000,
    refetchIntervalInBackground: true,
  });
  return {
    discovery: discovery.data,
    history: history.data ?? [],
    historyError: discovery.isError || history.isError,
  };
}

export function useHealth() {
  return useQuery({
    queryKey: ['runtime', 'health'],
    queryFn: async ({ signal }) => (await fetch('/health', { signal })).ok,
  });
}

export function selectConversation(
  history: HistoryRecord[],
  route: { chatId?: string; userId?: string },
) {
  return (
    history.find(
      ({ chatId, userId }) =>
        chatId === route.chatId && userId === route.userId,
    ) ?? history[0]
  );
}
