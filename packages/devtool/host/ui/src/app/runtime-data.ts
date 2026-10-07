import { QueryClient } from '@tanstack/react-query';
import { z } from 'zod';

import {
  type HistoryRecord,
  isHistoryRecord,
} from '@deepagents/devtool-history';

const capabilitySchema = z.object({ href: z.string() });

/** The runtime's `/info` response, as far as the DevTool reads it. */
const discoverySchema = z.object({
  capabilities: z.object({
    chat: capabilitySchema,
    history: capabilitySchema,
    events: capabilitySchema,
    traces: capabilitySchema.optional(),
    schedules: capabilitySchema.optional(),
    uploads: capabilitySchema
      .extend({ mediaTypes: z.array(z.string()).optional() })
      .optional(),
  }),
});

export type Discovery = z.infer<typeof discoverySchema>;

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
      queryFn: async () => discoverySchema.parse(await read(infoPath, signal)),
      staleTime: Infinity,
    });
    discovery = loadedDiscovery;
    const history = await queryClient.fetchQuery({
      queryKey: [
        'runtime',
        'history',
        loadedDiscovery.capabilities.history.href,
      ],
      queryFn: async () =>
        parseHistory(
          await read(loadedDiscovery.capabilities.history.href, signal),
        ),
    });
    return { discovery, history, historyError: false };
  } catch {
    return { discovery, history: [], historyError: true };
  }
}

async function read(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json();
}

function parseHistory(body: unknown): HistoryRecord[] {
  if (!Array.isArray(body) || !body.every(isHistoryRecord)) {
    throw new Error('History response is not a list of conversations');
  }
  return body;
}
