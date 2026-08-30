import { QueryClient, skipToken, useQuery } from '@tanstack/react-query';
import { validateUIMessages } from 'ai';

import type { HistoryRecord } from '@deepagents/devtool-history';

const ZUKHRUF_INFO_URL = '/zukhruf/v1/info';
const ZUKHRUF_HEALTH_URL = '/zukhruf/v1/health';

type Discovery = {
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

export function useRuntimeData() {
  const discovery = useQuery({
    queryKey: ['runtime', 'discovery'],
    queryFn: async ({ signal }) => {
      const response = await fetch(ZUKHRUF_INFO_URL, { signal });
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
            discovery.data.capabilities.history.href,
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
    discoveryPending: discovery.isPending,
    history: history.data ?? [],
    historyError: discovery.isError || history.isError,
  };
}

export function useSessionMessages(
  api: string | undefined,
  sessionId?: string,
) {
  return useQuery({
    queryKey: ['runtime', 'session', sessionId],
    queryFn:
      api && sessionId
        ? async ({ signal }) => {
            const response = await fetch(
              `${api}/${encodeURIComponent(sessionId)}`,
              { signal },
            );
            if (!response.ok) {
              throw new Error(`Session request failed: ${response.status}`);
            }
            const body = (await response.json()) as {
              messages?: unknown;
            };
            if (!Array.isArray(body.messages)) {
              throw new Error('Session response did not include messages');
            }
            return validateUIMessages({ messages: body.messages });
          }
        : skipToken,
  });
}

export function useHealth() {
  return useQuery({
    queryKey: ['runtime', 'health'],
    queryFn: async ({ signal }) =>
      (await fetch(ZUKHRUF_HEALTH_URL, { signal })).ok,
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
